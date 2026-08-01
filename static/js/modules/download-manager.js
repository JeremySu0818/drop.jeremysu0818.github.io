import { AsyncZipDeflate, Zip, zip } from 'https://esm.sh/fflate@0.8.2';
import {
  decryptBytes,
  keyFromCode,
  lookupKeyFromCode,
} from './crypto-utils.js';
import { createChunkCrypto } from './chunk-crypto-client.js';
import { downloadBlob, uniqueZipName } from './file-utils.js';

const MEMORY_DOWNLOAD_LIMIT = 512 * 1024 * 1024;
const STALE_DOWNLOAD_FILE_AGE_MS = 24 * 60 * 60 * 1000;

export class DownloadCancelledError extends Error {
  constructor() {
    super(
      'Download cancelled. The server copy was not deleted; use the same link to retry.',
    );
    this.name = 'DownloadCancelledError';
  }
}

export function createDownloadManager({
  serverUrl,
  showToast = () => {},
  chooseDirectory,
}) {
  if (!serverUrl) {
    throw new Error('A download server URL is required.');
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
      const error = new Error(body.error || 'Server response failed.');
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
        reject(new Error('Network error while downloading.'));
      };

      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText || '{}');
        } catch {
          body = {};
        }

        if (xhr.status < 200 || xhr.status >= 300) {
          const error = new Error(body.error || 'Server response failed.');
          error.status = xhr.status;
          reject(error);
          return;
        }

        resolve(body);
      };

      xhr.send(JSON.stringify(payload));
    });
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
      throw new Error(
        'This browser cannot stream large downloads to local storage. Use a current Chromium, Safari, or Firefox version.',
      );
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
        if (
          match &&
          Date.now() - Number(match[1]) >= STALE_DOWNLOAD_FILE_AGE_MS
        ) {
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
            if (closed) throw new Error('ZIP entry is already closed.');
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
          'The selected folder is not writable.',
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
          throw new Error('A destination file is still open.');
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
        if (opened) throw new Error('Single-file destination is already open.');
        opened = true;
        return output;
      },
      async close() {},
      abort: () => output.abort(),
    };
  }

  async function downloadChunkedFiles(key, lookupKey, chunkCrypto) {
    const payload = await api('/api/chunked-download', {
      method: 'POST',
      body: JSON.stringify({ lookupKey }),
    });
    const totalBytes = payload.files.reduce((sum, file) => sum + file.size, 0);
    let downloadedBytes = 0;

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
      let writesSeparateFiles = false;
      if (!multipleFiles) {
        sink = await createSingleFileSink(
          files[0].meta.name || 'drop-file',
          files[0].meta.mime || 'application/octet-stream',
          files[0].encryptedFile.size,
        );
      } else if (supportsDirectoryDownloads() && chooseDirectory) {
        try {
          sink = await createDirectoryFileSink(await chooseDirectory());
          writesSeparateFiles = true;
        } catch (error) {
          if (error instanceof DownloadCancelledError) throw error;
          showToast(
            'Folder access is unavailable. Downloading a ZIP instead.',
            {
              persist: true,
            },
          );
          sink = await createStreamingZipSink(totalBytes);
        }
      } else {
        sink = await createStreamingZipSink(totalBytes);
      }

      try {
        for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
          const { encryptedFile, meta } = files[fileIndex];
          const fileOutput = await sink.openFile(
            multipleFiles && !writesSeparateFiles
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
            const response = await fetch(
              serverUrl +
                '/api/chunked-download/' +
                payload.downloadId +
                '/files/' +
                encryptedFile.id +
                '/chunks/' +
                chunkIndex,
              {
                headers: {
                  Authorization: 'Bearer ' + payload.downloadToken,
                },
              },
            );
            if (!response.ok) {
              const body = await response.json().catch(() => ({}));
              throw new Error(
                body.error || 'Unable to download encrypted chunk.',
              );
            }
            const iv = response.headers.get('X-Chunk-IV');
            if (!iv) throw new Error('Encrypted chunk IV is missing.');
            const ciphertext = new Uint8Array(await response.arrayBuffer());
            const plaintext = await chunkCrypto.decrypt(iv, ciphertext);
            const plaintextLength = plaintext.byteLength;
            await fileOutput.write(plaintext);
            downloadedBytes += plaintextLength;
            const percent =
              totalBytes === 0
                ? 100
                : Math.min(
                    100,
                    Math.round((downloadedBytes / totalBytes) * 100),
                  );
            showToast(
              multipleFiles && !writesSeparateFiles
                ? 'Downloading ZIP (' + percent + '%)'
                : 'Downloading file ' +
                    (fileIndex + 1) +
                    '/' +
                    payload.files.length +
                    ' (' +
                    percent +
                    '%)',
              { persist: true },
            );
          }
          await fileOutput.close();
        }
        await sink.close();
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

  async function downloadLegacyFiles(key, lookupKey) {
    const payload = await downloadJsonWithProgress(
      '/api/download',
      { lookupKey },
      (event) => {
        if (event.lengthComputable) {
          const percent = Math.min(
            100,
            Math.round((event.loaded / event.total) * 100),
          );
          showToast('Downloading: ' + percent + '%', { persist: true });
        } else {
          const mb = (event.loaded / (1024 * 1024)).toFixed(1);
          showToast('Downloading: ' + mb + ' MB', { persist: true });
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
        'Decrypting file ' +
          (decryptedCount + 1) +
          ' of ' +
          totalFilesCount +
          '...',
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

    if (files.length === 1) {
      const [file] = files;
      downloadBlob(new Blob([file.bytes], { type: file.mime }), file.name);
    } else {
      showToast('Compressing files...', { persist: true });
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

  async function downloadFiles(code) {
    const key = await keyFromCode(code);
    const lookupKey = await lookupKeyFromCode(code);
    let chunkCrypto;
    try {
      try {
        chunkCrypto = await createChunkCrypto(code);
        return await downloadChunkedFiles(key, lookupKey, chunkCrypto);
      } catch (error) {
        if (error.status !== 404 || error.chunkedDownloadStarted) throw error;
        return await downloadLegacyFiles(key, lookupKey);
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
