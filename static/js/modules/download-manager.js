import { AsyncZipDeflate, Zip, zip } from 'https://esm.sh/fflate@0.8.2';
import {
  decryptBytes,
  keyFromCode,
  lookupKeyFromCode,
} from './crypto-utils.js';
import { createChunkCrypto } from './chunk-crypto-client.js';
import { downloadBlob, uniqueZipName } from './file-utils.js';
import { t } from '../i18n.js';

const MEMORY_DOWNLOAD_LIMIT = 512 * 1024 * 1024;
const STALE_DOWNLOAD_FILE_AGE_MS = 24 * 60 * 60 * 1000;
const PROGRESS_RENDER_INTERVAL_MS = 100;
const AES_GCM_TAG_SIZE_BYTES = 16;
const DOWNLOAD_CHUNK_SIZE_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_RETRY_DELAY_MS = 3000;
const CACHE_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const CACHE_CHECKPOINT_INTERVAL_MS = 1000;
const PARTIAL_DOWNLOAD_STATE = Symbol('partialDownloadState');

export class DownloadCancelledError extends Error {
  constructor() {
    super(t('runtime.downloadCancelled'));
    this.name = 'DownloadCancelledError';
  }
}

export function createDownloadManager({
  serverUrl,
  showToast = () => {},
  chooseDirectory,
}) {
  if (!serverUrl) {
    throw new Error(t('runtime.downloadServerRequired'));
  }

  async function api(path, options = {}) {
    const response = await fetch(serverUrl + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(body.error || t('runtime.serverResponseFailed'));
      error.status = response.status;
      throw error;
    }

    return body;
  }

  function downloadJsonWithProgress(path, payload, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', serverUrl + path);
      xhr.setRequestHeader('Content-Type', 'application/json');

      xhr.onprogress = (event) => {
        if (typeof onProgress === 'function') {
          onProgress(event);
        }
      };

      xhr.onerror = () => {
        reject(new Error(t('runtime.networkDownloadError')));
      };

      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText || '{}');
        } catch {
          body = {};
        }

        if (xhr.status < 200 || xhr.status >= 300) {
          const error = new Error(
            body.error || t('runtime.serverResponseFailed'),
          );
          error.status = xhr.status;
          reject(error);
          return;
        }

        resolve(body);
      };

      xhr.send(JSON.stringify(payload));
    });
  }

  async function readResponseBytes(
    response,
    onProgress,
    existingState,
    onCheckpoint,
  ) {
    const declaredLength = Number(response.headers.get('Content-Length'));
    const hasDeclaredLength =
      Number.isFinite(declaredLength) && declaredLength > 0;
    const initialReceived = existingState?.receivedBytes || 0;
    const expectedBytes =
      existingState?.expectedBytes ??
      (hasDeclaredLength ? initialReceived + declaredLength : null);
    let bytes =
      existingState?.bytes || new Uint8Array(expectedBytes || 64 * 1024);
    let received = initialReceived;

    const append = async (value) => {
      if (received + value.byteLength > bytes.byteLength) {
        const expanded = new Uint8Array(
          Math.max(received + value.byteLength, bytes.byteLength * 2),
        );
        expanded.set(bytes.subarray(0, received));
        bytes = expanded;
      }
      bytes.set(value, received);
      received += value.byteLength;
      onProgress?.(received, expectedBytes);
      await onCheckpoint?.(bytes, received, false);
    };
    const savePartialState = (error) => {
      const downloadError =
        error instanceof Error
          ? error
          : new Error(t('runtime.networkDownloadError'));
      downloadError[PARTIAL_DOWNLOAD_STATE] = {
        bytes,
        receivedBytes: received,
        expectedBytes,
      };
      return downloadError;
    };
    const finish = async () => {
      if (expectedBytes !== null && received !== expectedBytes) {
        const error = new Error(t('runtime.networkDownloadError'));
        error.name = 'NetworkError';
        throw savePartialState(error);
      }
      await onCheckpoint?.(bytes, received, true);
      return received === bytes.byteLength ? bytes : bytes.slice(0, received);
    };

    if (!response.body?.getReader) {
      await append(new Uint8Array(await response.arrayBuffer()));
      return finish();
    }

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await append(value);
      }
    } catch (error) {
      await onCheckpoint?.(bytes, received, true);
      if (expectedBytes !== null && received === expectedBytes) {
        return received === bytes.byteLength ? bytes : bytes.slice(0, received);
      }
      throw savePartialState(error);
    } finally {
      reader.releaseLock();
    }

    return finish();
  }

  function validatePartialContentRange(response, partialState) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
      response.headers.get('Content-Range') || '',
    );
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    return (
      start === partialState.receivedBytes &&
      end >= start &&
      total === partialState.expectedBytes
    );
  }

  function waitForDownloadRetry(delayMs) {
    return new Promise((resolve) => window.setTimeout(resolve, delayMs));
  }

  function isRetryableDownloadError(error) {
    if (error?.retryable === true) return true;
    return (
      error instanceof TypeError ||
      ['AbortError', 'NetworkError', 'TimeoutError'].includes(error?.name)
    );
  }

  async function fetchChunkWithRetry(
    url,
    headers,
    onProgress,
    onRetry,
    { initialState, onCheckpoint, onIv, onReset } = {},
  ) {
    let partialState = initialState;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const requestHeaders = {
          ...headers,
          ...(partialState?.receivedBytes > 0
            ? { Range: `bytes=${partialState.receivedBytes}-` }
            : {}),
        };
        const response = await fetch(url, { headers: requestHeaders });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          const error = new Error(
            body.error || t('runtime.encryptedChunkDownloadFailed'),
          );
          error.status = response.status;
          error.retryable =
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500;
          throw error;
        }

        if (partialState?.receivedBytes > 0) {
          if (response.status === 206) {
            if (!validatePartialContentRange(response, partialState)) {
              throw new Error(t('runtime.encryptedChunkDownloadFailed'));
            }
          } else {
            partialState = undefined;
            await onReset?.();
          }
        } else if (response.status === 206) {
          throw new Error(t('runtime.encryptedChunkDownloadFailed'));
        }

        const iv = response.headers.get('X-Chunk-IV');
        if (!iv) throw new Error(t('runtime.encryptedChunkIvMissing'));
        await onIv?.(iv);
        return {
          iv,
          ciphertext: await readResponseBytes(
            response,
            onProgress,
            partialState,
            onCheckpoint,
          ),
        };
      } catch (error) {
        if (!isRetryableDownloadError(error)) throw error;
        partialState = error?.[PARTIAL_DOWNLOAD_STATE] || partialState;
        const nextAttempt = attempt + 1;
        onRetry?.(
          nextAttempt,
          partialState?.receivedBytes || 0,
          partialState?.expectedBytes || null,
        );
        await waitForDownloadRetry(DOWNLOAD_RETRY_DELAY_MS);
      }
    }
  }

  function safeCacheId(value) {
    return String(value).replace(/[^A-Za-z0-9_-]/g, '_');
  }

  async function createDownloadChunkCache(downloadId) {
    if (!navigator.storage?.getDirectory) return null;

    try {
      navigator.storage.persist?.().catch(() => {});
      const root = await navigator.storage.getDirectory();
      const prefix = `drop-resume-${safeCacheId(downloadId)}-`;
      const namesFor = (fileId, chunkIndex) => {
        const base = `${prefix}${safeCacheId(fileId)}-${chunkIndex}`;
        return { data: `${base}.bin`, iv: `${base}.iv` };
      };

      return {
        async read(fileId, chunkIndex, expectedBytes) {
          const names = namesFor(fileId, chunkIndex);
          try {
            const dataHandle = await root.getFileHandle(names.data);
            const dataFile = await dataHandle.getFile();
            if (dataFile.size <= 0 || dataFile.size > expectedBytes) {
              await root.removeEntry(names.data).catch(() => {});
              await root.removeEntry(names.iv).catch(() => {});
              return null;
            }
            const ivHandle = await root.getFileHandle(names.iv);
            const iv = await (await ivHandle.getFile()).text();
            if (!iv) return null;
            return {
              bytes: new Uint8Array(await dataFile.arrayBuffer()),
              iv,
            };
          } catch (error) {
            if (error?.name === 'NotFoundError') return null;
            throw error;
          }
        },
        createCheckpoint(fileId, chunkIndex, initialPersistedBytes = 0) {
          const names = namesFor(fileId, chunkIndex);
          let persistedBytes = initialPersistedBytes;
          let lastCheckpointAt = performance.now();
          let disabled = false;

          return {
            async checkpoint(bytes, receivedBytes, force) {
              if (disabled || receivedBytes <= persistedBytes) return;
              const now = performance.now();
              if (
                !force &&
                receivedBytes - persistedBytes < CACHE_CHECKPOINT_BYTES &&
                now - lastCheckpointAt < CACHE_CHECKPOINT_INTERVAL_MS
              ) {
                return;
              }

              let writable;
              try {
                const handle = await root.getFileHandle(names.data, {
                  create: true,
                });
                writable = await handle.createWritable({
                  keepExistingData: true,
                });
                await writable.seek(persistedBytes);
                await writable.write(
                  bytes.subarray(persistedBytes, receivedBytes),
                );
                await writable.truncate(receivedBytes);
                await writable.close();
                writable = null;
                persistedBytes = receivedBytes;
                lastCheckpointAt = now;
              } catch {
                disabled = true;
                await writable?.abort().catch(() => {});
              }
            },
            async reset() {
              persistedBytes = 0;
              lastCheckpointAt = performance.now();
              await root.removeEntry(names.data).catch(() => {});
            },
            async writeIv(iv) {
              if (disabled) return;
              let writable;
              try {
                const handle = await root.getFileHandle(names.iv, {
                  create: true,
                });
                writable = await handle.createWritable();
                await writable.write(iv);
                await writable.close();
                writable = null;
              } catch {
                disabled = true;
                await writable?.abort().catch(() => {});
              }
            },
          };
        },
        async remove(fileId, chunkIndex) {
          const names = namesFor(fileId, chunkIndex);
          await root.removeEntry(names.data).catch(() => {});
          await root.removeEntry(names.iv).catch(() => {});
        },
        async removeAll() {
          for await (const [name] of root.entries()) {
            if (name.startsWith(prefix)) {
              await root.removeEntry(name).catch(() => {});
            }
          }
        },
      };
    } catch {
      return null;
    }
  }

  function supportsDirectoryDownloads() {
    return (
      window.isSecureContext && typeof window.showDirectoryPicker === 'function'
    );
  }

  async function createDownloadSink(name, mime, size) {
    if (navigator.storage?.getDirectory) {
      navigator.storage.persist?.().catch(() => {});
      const root = await navigator.storage.getDirectory();
      const tempName = 'drop-' + Date.now() + '-' + crypto.randomUUID();
      const handle = await root.getFileHandle(tempName, { create: true });
      const writable = await handle.createWritable();
      return {
        write: (bytes) => writable.write(bytes),
        async close() {
          await writable.close();
          const file = await handle.getFile();
          const cleanupDelay = 60 * 60 * 1000;
          downloadBlob(file, name, cleanupDelay);
          window.setTimeout(
            () => root.removeEntry(tempName).catch(() => {}),
            cleanupDelay,
          );
        },
        async abort() {
          await writable.abort().catch(() => {});
          await root.removeEntry(tempName).catch(() => {});
        },
      };
    }

    if (size > MEMORY_DOWNLOAD_LIMIT) {
      throw new Error(t('runtime.largeDownloadUnsupported'));
    }
    const parts = [];
    return {
      write(bytes) {
        parts.push(bytes);
      },
      async close() {
        downloadBlob(new Blob(parts, { type: mime }), name);
      },
      async abort() {
        parts.length = 0;
      },
    };
  }

  async function cleanupStaleDownloadFiles() {
    if (!navigator.storage?.getDirectory) return;
    try {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) {
        const match = /^drop-(\d+)-/.exec(name);
        let isStale =
          match && Date.now() - Number(match[1]) >= STALE_DOWNLOAD_FILE_AGE_MS;
        if (!isStale && name.startsWith('drop-resume-')) {
          try {
            const file = await (await root.getFileHandle(name)).getFile();
            isStale =
              Date.now() - file.lastModified >= STALE_DOWNLOAD_FILE_AGE_MS;
          } catch {}
        }
        if (isStale) {
          await root.removeEntry(name).catch(() => {});
        }
      }
    } catch {}
  }

  async function createStreamingZipSink(totalSize) {
    const output = await createDownloadSink(
      'drop-files.zip',
      'application/zip',
      totalSize + 1024 * 1024,
    );
    const entries = [];
    let outputWrites = Promise.resolve();
    let settleFinal;
    let rejectFinal;
    let aborted = false;
    const finished = new Promise((resolve, reject) => {
      settleFinal = resolve;
      rejectFinal = reject;
    });
    const archive = new Zip((error, data, final) => {
      if (aborted) return;
      if (error) {
        rejectFinal(error);
        return;
      }
      outputWrites = outputWrites.then(() => output.write(data));
      if (final) outputWrites.then(settleFinal, rejectFinal);
    });

    return {
      async openFile(name) {
        const entry = new AsyncZipDeflate(name, { level: 0 });
        entries.push(entry);
        archive.add(entry);
        let closed = false;
        return {
          async write(bytes) {
            if (closed) throw new Error(t('runtime.zipEntryClosed'));
            entry.push(bytes, false);
          },
          async close() {
            if (closed) return;
            closed = true;
            entry.push(new Uint8Array(0), true);
          },
        };
      },
      async close() {
        archive.end();
        await finished;
        await output.close();
      },
      async abort() {
        aborted = true;
        for (const entry of entries) entry.terminate?.();
        await output.abort();
      },
    };
  }

  async function directoryEntryExists(directory, name) {
    try {
      await directory.getFileHandle(name);
      return true;
    } catch (error) {
      if (error?.name === 'NotFoundError') return false;
      if (error?.name === 'TypeMismatchError') return true;
      throw error;
    }
  }

  async function createDirectoryFileSink(directory) {
    const probeName = '.drop-write-check-' + crypto.randomUUID();
    let probeWriter;
    try {
      const permission =
        typeof directory.queryPermission === 'function'
          ? await directory.queryPermission({ mode: 'readwrite' })
          : 'granted';
      if (permission !== 'granted') {
        throw new DOMException(
          t('runtime.folderNotWritable'),
          'NotAllowedError',
        );
      }
      const probe = await directory.getFileHandle(probeName, { create: true });
      probeWriter = await probe.createWritable();
      await probeWriter.close();
      probeWriter = null;
    } finally {
      await probeWriter?.abort().catch(() => {});
      await directory.removeEntry(probeName).catch(() => {});
    }

    const usedNames = new Set();
    const activeFiles = new Set();

    return {
      async openFile(name) {
        let finalName = uniqueZipName(name, usedNames);
        while (await directoryEntryExists(directory, finalName)) {
          finalName = uniqueZipName(name, usedNames);
        }

        const handle = await directory.getFileHandle(finalName, {
          create: true,
        });
        const writable = await handle.createWritable();
        const activeFile = { name: finalName, writable };
        activeFiles.add(activeFile);
        let closed = false;

        return {
          write: (bytes) => writable.write(bytes),
          async close() {
            if (closed) return;
            await writable.close();
            closed = true;
            activeFiles.delete(activeFile);
          },
        };
      },
      async close() {
        if (activeFiles.size !== 0) {
          throw new Error(t('runtime.destinationFileOpen'));
        }
      },
      async abort() {
        await Promise.all(
          [...activeFiles].map(async ({ name, writable }) => {
            await writable.abort().catch(() => {});
            await directory.removeEntry(name).catch(() => {});
          }),
        );
        activeFiles.clear();
      },
    };
  }

  async function createSingleFileSink(name, mime, size) {
    const output = await createDownloadSink(name, mime, size);
    let opened = false;
    return {
      async openFile() {
        if (opened) throw new Error(t('runtime.singleDestinationOpen'));
        opened = true;
        return output;
      },
      async close() {},
      abort: () => output.abort(),
    };
  }

  async function downloadChunkedFiles(
    key,
    lookupKey,
    chunkCrypto,
    { forceZip = false } = {},
  ) {
    const payload = await api('/api/chunked-download', {
      method: 'POST',
      body: JSON.stringify({ lookupKey }),
    });
    const chunkCache = await createDownloadChunkCache(payload.downloadId);
    const totalBytes = payload.files.reduce((sum, file) => sum + file.size, 0);
    let downloadedBytes = 0;
    let lastProgressRenderAt = 0;

    const renderProgress = (
      bytes,
      fileIndex,
      writesZip,
      force = false,
      allowComplete = false,
    ) => {
      const now = performance.now();
      if (!force && now - lastProgressRenderAt < PROGRESS_RENDER_INTERVAL_MS) {
        return;
      }
      lastProgressRenderAt = now;
      let progress =
        totalBytes === 0 ? 100 : Math.min(100, (bytes / totalBytes) * 100);
      if (!allowComplete && progress >= 100) progress = 99.9;
      const percent = Math.floor(progress);
      showToast(
        writesZip
          ? t('runtime.downloadingZipProgress', { percent })
          : t('runtime.downloadingFileProgress', {
              current: fileIndex + 1,
              total: payload.files.length,
              percent,
            }),
        { persist: true, progress },
      );
    };

    try {
      const files = [];
      for (const encryptedFile of payload.files) {
        const metaBytes = await decryptBytes(
          key,
          encryptedFile.metaIv,
          encryptedFile.metaCiphertext,
        );
        const meta = JSON.parse(new TextDecoder().decode(metaBytes));
        files.push({ encryptedFile, meta });
      }

      const multipleFiles = files.length > 1;
      const usedNames = new Set();
      let sink;
      let writesZip = false;
      if (forceZip) {
        sink = await createStreamingZipSink(totalBytes);
        writesZip = true;
      } else if (!multipleFiles) {
        sink = await createSingleFileSink(
          files[0].meta.name || 'drop-file',
          files[0].meta.mime || 'application/octet-stream',
          files[0].encryptedFile.size,
        );
      } else if (supportsDirectoryDownloads() && chooseDirectory) {
        try {
          sink = await createDirectoryFileSink(await chooseDirectory());
        } catch (error) {
          if (error instanceof DownloadCancelledError) throw error;
          showToast(t('runtime.folderUnavailableUsingZip'), {
            persist: true,
          });
          sink = await createStreamingZipSink(totalBytes);
          writesZip = true;
        }
      } else {
        sink = await createStreamingZipSink(totalBytes);
        writesZip = true;
      }

      renderProgress(downloadedBytes, 0, writesZip, true);

      try {
        for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
          const { encryptedFile, meta } = files[fileIndex];
          const fileOutput = await sink.openFile(
            writesZip
              ? uniqueZipName(meta.name || 'drop-file', usedNames)
              : meta.name || 'drop-file',
            meta.mime || 'application/octet-stream',
            encryptedFile.size,
          );
          for (
            let chunkIndex = 0;
            chunkIndex < encryptedFile.chunkCount;
            chunkIndex += 1
          ) {
            const bytesBeforeChunk = downloadedBytes;
            const plaintextChunkLength = Math.max(
              0,
              Math.min(
                DOWNLOAD_CHUNK_SIZE_BYTES,
                encryptedFile.size - chunkIndex * DOWNLOAD_CHUNK_SIZE_BYTES,
              ),
            );
            const expectedCiphertextBytes =
              plaintextChunkLength + AES_GCM_TAG_SIZE_BYTES;
            const cachedChunk = await chunkCache?.read(
              encryptedFile.id,
              chunkIndex,
              expectedCiphertextBytes,
            );
            const cachedBytes = cachedChunk?.bytes;
            const checkpoint = chunkCache?.createCheckpoint(
              encryptedFile.id,
              chunkIndex,
              cachedBytes?.byteLength || 0,
            );
            const estimateDownloadedBytes = (
              receivedBytes,
              encryptedLength,
            ) => {
              const estimatedPlaintextLength = encryptedLength
                ? Math.max(0, encryptedLength - AES_GCM_TAG_SIZE_BYTES)
                : Math.max(0, receivedBytes - AES_GCM_TAG_SIZE_BYTES);
              const receivedRatio = encryptedLength
                ? Math.min(1, receivedBytes / encryptedLength)
                : 1;
              return Math.min(
                totalBytes,
                bytesBeforeChunk + estimatedPlaintextLength * receivedRatio,
              );
            };
            const reportChunkProgress = (receivedBytes, encryptedLength) => {
              renderProgress(
                estimateDownloadedBytes(receivedBytes, encryptedLength),
                fileIndex,
                writesZip,
              );
            };

            let iv;
            let ciphertext;
            if (cachedBytes?.byteLength === expectedCiphertextBytes) {
              iv = cachedChunk.iv;
              ciphertext = cachedBytes;
              reportChunkProgress(
                expectedCiphertextBytes,
                expectedCiphertextBytes,
              );
            } else {
              if (cachedBytes?.byteLength) {
                reportChunkProgress(
                  cachedBytes.byteLength,
                  expectedCiphertextBytes,
                );
              }
              ({ iv, ciphertext } = await fetchChunkWithRetry(
                serverUrl +
                  '/api/chunked-download/' +
                  payload.downloadId +
                  '/files/' +
                  encryptedFile.id +
                  '/chunks/' +
                  chunkIndex,
                { Authorization: 'Bearer ' + payload.downloadToken },
                reportChunkProgress,
                (attempt, receivedBytes, encryptedLength) => {
                  const progress = totalBytes
                    ? Math.min(
                        99.9,
                        (estimateDownloadedBytes(
                          receivedBytes,
                          encryptedLength,
                        ) /
                          totalBytes) *
                          100,
                      )
                    : 0;
                  showToast(
                    t('runtime.downloadInterruptedRetrying', { attempt }),
                    { persist: true, progress },
                  );
                },
                {
                  initialState: cachedBytes
                    ? {
                        bytes: cachedBytes,
                        receivedBytes: cachedBytes.byteLength,
                        expectedBytes: expectedCiphertextBytes,
                      }
                    : undefined,
                  onCheckpoint: checkpoint?.checkpoint,
                  onIv: checkpoint?.writeIv,
                  onReset: checkpoint?.reset,
                },
              ));
            }

            let plaintext;
            try {
              plaintext = await chunkCrypto.decrypt(iv, ciphertext);
            } catch (error) {
              await chunkCache?.remove(encryptedFile.id, chunkIndex);
              throw error;
            }
            const plaintextLength = plaintext.byteLength;
            await fileOutput.write(plaintext);
            downloadedBytes += plaintextLength;
            renderProgress(downloadedBytes, fileIndex, writesZip, true, true);
          }
          await fileOutput.close();
        }
        await sink.close();
        await chunkCache?.removeAll();
      } catch (error) {
        await sink.abort();
        throw error;
      }
      let serverCopyDestroyed = true;
      try {
        await api('/api/chunked-download/' + payload.downloadId, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + payload.downloadToken },
        });
      } catch {
        serverCopyDestroyed = false;
      }
      return { fileCount: payload.files.length, serverCopyDestroyed };
    } catch (error) {
      if (error && typeof error === 'object') {
        error.chunkedDownloadStarted = true;
      }
      throw error;
    }
  }

  async function downloadLegacyFiles(
    key,
    lookupKey,
    { forceZip = false } = {},
  ) {
    const payload = await downloadJsonWithProgress(
      '/api/download',
      { lookupKey },
      (event) => {
        if (event.lengthComputable) {
          const percent = Math.min(
            100,
            Math.round((event.loaded / event.total) * 100),
          );
          showToast(t('runtime.downloadingProgress', { percent }), {
            persist: true,
            progress: percent,
          });
        } else {
          const mb = (event.loaded / (1024 * 1024)).toFixed(1);
          showToast(t('runtime.downloadingMegabytes', { mb }), {
            persist: true,
            progress: null,
          });
        }
      },
    );

    const encryptedFiles = Array.isArray(payload.files)
      ? payload.files
      : [
          {
            fileIv: payload.fileIv,
            fileCiphertext: payload.fileCiphertext,
            metaIv: payload.metaIv,
            metaCiphertext: payload.metaCiphertext,
          },
        ];
    const files = [];
    const totalFilesCount = encryptedFiles.length;
    let decryptedCount = 0;

    for (const encryptedFile of encryptedFiles) {
      showToast(
        t('runtime.decryptingFileProgress', {
          current: decryptedCount + 1,
          total: totalFilesCount,
        }),
        { persist: true },
      );
      const metaBytes = await decryptBytes(
        key,
        encryptedFile.metaIv,
        encryptedFile.metaCiphertext,
      );
      const meta = JSON.parse(new TextDecoder().decode(metaBytes));
      const fileBytes = await decryptBytes(
        key,
        encryptedFile.fileIv,
        encryptedFile.fileCiphertext,
      );
      files.push({
        bytes: fileBytes,
        mime: meta.mime || 'application/octet-stream',
        name: meta.name || 'drop-file',
      });
      decryptedCount += 1;
    }

    if (files.length === 1 && !forceZip) {
      const [file] = files;
      downloadBlob(new Blob([file.bytes], { type: file.mime }), file.name);
    } else {
      showToast(t('runtime.compressingFiles'), { persist: true });
      const usedNames = new Set();
      const zipEntries = {};
      for (const file of files) {
        zipEntries[uniqueZipName(file.name, usedNames)] = file.bytes;
      }

      const zipBytes = await new Promise((resolve, reject) => {
        zip(zipEntries, { level: 6 }, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });

      downloadBlob(
        new Blob([zipBytes], { type: 'application/zip' }),
        'drop-files.zip',
      );
    }

    return { fileCount: files.length, serverCopyDestroyed: true };
  }

  async function checkAvailability(code) {
    const lookupKey = await lookupKeyFromCode(code);
    return api('/api/chunked-download/status', {
      method: 'POST',
      body: JSON.stringify({ lookupKey }),
    });
  }

  async function downloadFiles(code, options = {}) {
    showToast(t('runtime.downloadingProgress', { percent: 0 }), {
      persist: true,
      progress: 0,
    });
    const key = await keyFromCode(code);
    const lookupKey = await lookupKeyFromCode(code);
    let chunkCrypto;
    try {
      try {
        chunkCrypto = await createChunkCrypto(code);
        return await downloadChunkedFiles(key, lookupKey, chunkCrypto, options);
      } catch (error) {
        if (error.status !== 404 || error.chunkedDownloadStarted) throw error;
        return await downloadLegacyFiles(key, lookupKey, options);
      }
    } finally {
      chunkCrypto?.terminate();
    }
  }

  return {
    checkAvailability,
    cleanupStaleDownloadFiles,
    downloadFiles,
  };
}
