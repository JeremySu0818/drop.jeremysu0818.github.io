import { createLiquidGlass } from 'https://esm.sh/solid-glass@0.0.3/engines/svg-refraction';
import { zip } from 'https://esm.sh/fflate@0.8.2';
import {
  createShareCode,
  decryptChunkBytes,
  decryptBytes,
  encryptChunkBytes,
  encryptBytes,
  keyFromCode,
  lookupKeyFromCode,
  textBytes,
} from './modules/crypto-utils.js';
import { downloadBlob, uniqueZipName } from './modules/file-utils.js';
import {
  createToastManager,
  filterMediaFiles,
  setBusy,
  summarizeSelectedFiles,
} from './modules/ui-utils.js';
import { initPageEffects } from './modules/ui-effects.js';

const TTL_MINUTES = 30;
const MAX_PARALLEL_UPLOADS = 3;
const PROGRESS_RENDER_INTERVAL_MS = 120;
const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
const MEMORY_DOWNLOAD_LIMIT = 512 * 1024 * 1024;
const SERVER_URL = 'https://drop-server.jeremytw.qzz.io';

const els = {
  photoInput: document.querySelector('#photoInput'),
  dropZone: document.querySelector('#dropZone'),
  fileMeta: document.querySelector('#fileMeta'),
  uploadButton: document.querySelector('#uploadButton'),
  codeModal: document.querySelector('#codeModal'),
  shareCode: document.querySelector('#shareCode'),
  copyButton: document.querySelector('#copyButton'),
  closeModalButton: document.querySelector('#closeModalButton'),
  downloadCode: document.querySelector('#downloadCode'),
  downloadButton: document.querySelector('#downloadButton'),
  toast: document.querySelector('#toast'),
};

const toast = createToastManager(els.toast);
let selectedFiles = [];

function showToast(message, options = {}) {
  toast.show(message, options);
}

function extractCodes(value) {
  const normalized = String(value || '').replaceAll('SHA-256:', '');
  const codes = normalized.match(/\b[a-fA-F0-9]{64}\b/g) || [];
  const uniqueCodes = [...new Set(codes)];

  if (uniqueCodes.length === 0) {
    throw new Error('Invalid decryption code format.');
  }
  if (uniqueCodes.length > 1) {
    throw new Error('Only one decryption code is supported per download.');
  }

  return uniqueCodes;
}

function setSelectedFiles(files) {
  selectedFiles = filterMediaFiles(files);
  els.fileMeta.textContent = summarizeSelectedFiles(selectedFiles);
}

async function api(path, options = {}) {
  const response = await fetch(`${SERVER_URL}${path}`, {
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

function uploadBinaryWithProgress(path, bytes, iv, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${SERVER_URL}${path}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Chunk-IV', iv);
    xhr.upload.onprogress = onProgress;
    xhr.onerror = () => reject(new Error('Network error while uploading.'));
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText || '{}');
      } catch {}
      if (xhr.status < 200 || xhr.status >= 300) {
        const error = new Error(body.error || 'Server response failed.');
        error.status = xhr.status;
        reject(error);
        return;
      }
      resolve(body);
    };
    xhr.send(bytes);
  });
}

function uploadJsonWithProgress(path, payload, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SERVER_URL}${path}`);
    xhr.setRequestHeader('Content-Type', 'application/json');

    xhr.upload.onprogress = (event) => {
      if (typeof onProgress === 'function') {
        onProgress(event);
      }
    };

    xhr.onerror = () => {
      reject(new Error('Network error while uploading.'));
    };

    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText || '{}');
      } catch {
        body = {};
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(body.error || 'Server response failed.'));
        return;
      }

      resolve(body);
    };

    xhr.send(JSON.stringify(payload));
  });
}

function downloadJsonWithProgress(path, payload, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SERVER_URL}${path}`);
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
        reject(new Error(body.error || 'Server response failed.'));
        return;
      }

      resolve(body);
    };

    xhr.send(JSON.stringify(payload));
  });
}

function getUploadConcurrency(fileCount) {
  const connection = navigator.connection;
  if (
    connection?.saveData ||
    ['slow-2g', '2g'].includes(connection?.effectiveType)
  ) {
    return 1;
  }

  return Math.max(1, Math.min(MAX_PARALLEL_UPLOADS, fileCount));
}

async function eachWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await worker(items[currentIndex], currentIndex);
      }
    },
  );

  await Promise.all(workers);
}

async function createEncryptedMetadata(file, key) {
  const metaBytes = textBytes(
    JSON.stringify({
      name: file.name || 'drop-file',
      mime: file.type || 'application/octet-stream',
      size: file.size,
    }),
  );

  const metaBox = await encryptBytes(key, metaBytes);

  return {
    metaIv: metaBox.iv,
    metaCiphertext: metaBox.ciphertext,
  };
}

async function verifyFileReadable(file) {
  try {
    await file.slice(0, Math.min(1, file.size)).arrayBuffer();
  } catch (error) {
    const reason =
      error?.name === 'NotReadableError'
        ? 'The browser lost permission to read it. Choose the file again from local storage and keep it there until the upload finishes.'
        : error?.message || 'The file could not be read.';
    throw new Error(`${file.name}: ${reason}`);
  }
}

async function uploadPhoto() {
  if (selectedFiles.length === 0) {
    showToast('Please select files to upload first.');
    return;
  }

  setBusy(els.uploadButton, true);
  try {
    els.shareCode.value = '';
    const filesToUpload = selectedFiles.slice();
    const code = await createShareCode();
    const key = await keyFromCode(code);
    const lookupKey = await lookupKeyFromCode(code);
    const totalFiles = filesToUpload.length;
    const concurrency = getUploadConcurrency(totalFiles);
    const totalBytes = filesToUpload.reduce((sum, file) => sum + file.size, 0);
    const activeBytes = Array(totalFiles).fill(0);
    let completedBytes = 0;
    let completedFiles = 0;
    let lastProgressAt = 0;
    let uploadId = '';

    const renderProgress = (force = false) => {
      const currentTime = Date.now();
      if (
        !force &&
        currentTime - lastProgressAt < PROGRESS_RENDER_INTERVAL_MS
      ) {
        return;
      }

      lastProgressAt = currentTime;
      const transferred = completedBytes + activeBytes.reduce((a, b) => a + b, 0);
      const overallPercent = Math.min(
        100,
        totalBytes === 0 ? 100 : Math.round((transferred / totalBytes) * 100),
      );

      showToast(
        `Uploading ${completedFiles}/${totalFiles} (${overallPercent}%)`,
        { persist: true },
      );
    };

    showToast('Checking file access...', { persist: true });
    await Promise.all(filesToUpload.map(verifyFileReadable));
    const manifestFiles = await Promise.all(
      filesToUpload.map(async (file, index) => ({
        id: `f${index}`,
        size: file.size,
        chunkCount: Math.max(1, Math.ceil(file.size / CHUNK_SIZE_BYTES)),
        ...(await createEncryptedMetadata(file, key)),
      })),
    );
    const session = await api('/api/chunked-uploads', {
      method: 'POST',
      body: JSON.stringify({ lookupKey, files: manifestFiles }),
    });
    uploadId = session.uploadId;
    if (session.chunkSize !== CHUNK_SIZE_BYTES) {
      throw new Error('Server and browser chunk sizes do not match.');
    }
    showToast(`Uploading 0/${totalFiles} (0%)`, { persist: true });

    try {
      await eachWithConcurrency(
        filesToUpload,
        concurrency,
        async (file, fileIndex) => {
          const fileId = `f${fileIndex}`;
          const chunkCount = Math.max(
            1,
            Math.ceil(file.size / CHUNK_SIZE_BYTES),
          );
          for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
            const start = chunkIndex * CHUNK_SIZE_BYTES;
            const end = Math.min(file.size, start + CHUNK_SIZE_BYTES);
            let sourceBytes;
            try {
              sourceBytes = new Uint8Array(
                await file.slice(start, end).arrayBuffer(),
              );
            } catch (error) {
              const detail =
                error?.name === 'NotReadableError'
                  ? 'The browser lost permission to read the source file. Keep it on local storage and select it again.'
                  : error?.message || 'Unable to read source file.';
              throw new Error(`${file.name}: ${detail}`);
            }
            const encrypted = await encryptChunkBytes(key, sourceBytes);
            const sourceLength = sourceBytes.byteLength;
            sourceBytes = null;
            await uploadBinaryWithProgress(
              `/api/chunked-uploads/${uploadId}/files/${fileId}/chunks/${chunkIndex}`,
              encrypted.ciphertext,
              encrypted.iv,
              (event) => {
                activeBytes[fileIndex] = event.total
                  ? Math.round((event.loaded / event.total) * sourceLength)
                  : 0;
                renderProgress();
              },
            );
            activeBytes[fileIndex] = 0;
            completedBytes += sourceLength;
            renderProgress(true);
          }
          completedFiles += 1;
          renderProgress(true);
        },
      );
      await api('/api/chunked-uploads/complete', {
        method: 'POST',
        body: JSON.stringify({ uploadId }),
      });
    } catch (error) {
      if (uploadId) {
        api(`/api/chunked-uploads/${uploadId}`, { method: 'DELETE' }).catch(
          () => {},
        );
      }
      throw error;
    }

    els.shareCode.value = code;
    els.codeModal.showModal();
    showToast(
      `Successfully encrypted and uploaded ${filesToUpload.length} file(s). Valid for ${TTL_MINUTES} minutes.`,
    );
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(els.uploadButton, false);
  }
}

async function createDownloadSink(name, mime, size) {
  if (navigator.storage?.getDirectory) {
    navigator.storage.persist?.().catch(() => {});
    const root = await navigator.storage.getDirectory();
    const tempName = `drop-${crypto.randomUUID()}`;
    const handle = await root.getFileHandle(tempName, { create: true });
    const writable = await handle.createWritable();
    return {
      write: (bytes) => writable.write(bytes),
      async close() {
        await writable.close();
        const file = await handle.getFile();
        downloadBlob(file, name);
        window.setTimeout(
          () => root.removeEntry(tempName).catch(() => {}),
          10 * 60 * 1000,
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

async function downloadChunkedFiles(code, key, lookupKey) {
  const payload = await api('/api/chunked-download', {
    method: 'POST',
    body: JSON.stringify({ lookupKey }),
  });
  const totalBytes = payload.files.reduce((sum, file) => sum + file.size, 0);
  let downloadedBytes = 0;

  try {
    for (let fileIndex = 0; fileIndex < payload.files.length; fileIndex += 1) {
      const encryptedFile = payload.files[fileIndex];
      const metaBytes = await decryptBytes(
        key,
        encryptedFile.metaIv,
        encryptedFile.metaCiphertext,
      );
      const meta = JSON.parse(new TextDecoder().decode(metaBytes));
      const sink = await createDownloadSink(
        meta.name || 'drop-file',
        meta.mime || 'application/octet-stream',
        encryptedFile.size,
      );
      try {
        for (
          let chunkIndex = 0;
          chunkIndex < encryptedFile.chunkCount;
          chunkIndex += 1
        ) {
          const response = await fetch(
            `${SERVER_URL}/api/chunked-download/${payload.downloadId}/files/${encryptedFile.id}/chunks/${chunkIndex}`,
            {
              headers: {
                Authorization: `Bearer ${payload.downloadToken}`,
              },
            },
          );
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || 'Unable to download encrypted chunk.');
          }
          const iv = response.headers.get('X-Chunk-IV');
          if (!iv) throw new Error('Encrypted chunk IV is missing.');
          const ciphertext = new Uint8Array(await response.arrayBuffer());
          const plaintext = await decryptChunkBytes(key, iv, ciphertext);
          await sink.write(plaintext);
          downloadedBytes += plaintext.byteLength;
          const percent =
            totalBytes === 0
              ? 100
              : Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
          showToast(
            `Downloading file ${fileIndex + 1}/${payload.files.length} (${percent}%)`,
            { persist: true },
          );
        }
        await sink.close();
      } catch (error) {
        await sink.abort();
        throw error;
      }
    }
    await api(`/api/chunked-download/${payload.downloadId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${payload.downloadToken}` },
    });
    return payload.files.length;
  } catch (error) {
    error.chunkedDownloadStarted = true;
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
          showToast(`Downloading: ${percent}%`, { persist: true });
        } else {
          const mb = (event.loaded / (1024 * 1024)).toFixed(1);
          showToast(`Downloading: ${mb} MB`, { persist: true });
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
        `Decrypting file ${decryptedCount + 1} of ${totalFilesCount}...`,
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

    return files.length;
}

async function downloadPhoto() {
  setBusy(els.downloadButton, true);
  try {
    const [code] = extractCodes(els.downloadCode.value);
    const key = await keyFromCode(code);
    const lookupKey = await lookupKeyFromCode(code);
    let fileCount;
    try {
      fileCount = await downloadChunkedFiles(code, key, lookupKey);
    } catch (error) {
      if (error.status !== 404 || error.chunkedDownloadStarted) throw error;
      fileCount = await downloadLegacyFiles(key, lookupKey);
    }
    els.downloadCode.value = '';
    showToast(
      fileCount === 1
        ? 'File downloaded successfully. Server copy destroyed.'
        : `Successfully downloaded ${fileCount} files. Server copy destroyed.`,
    );
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(els.downloadButton, false);
  }
}

function bindDropZone() {
  els.photoInput.addEventListener('change', () => {
    setSelectedFiles([...els.photoInput.files]);
  });

  for (const eventName of ['dragenter', 'dragover']) {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.add('is-dragging');
    });
  }

  for (const eventName of ['dragleave', 'drop']) {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove('is-dragging');
    });
  }

  els.dropZone.addEventListener('drop', (event) => {
    const files = filterMediaFiles([...event.dataTransfer.files]);
    if (files.length === 0) {
      showToast('Please drag and drop valid files.');
      return;
    }

    setSelectedFiles(files);
  });
}

function init() {
  initPageEffects(createLiquidGlass);
  bindDropZone();

  els.uploadButton.addEventListener('click', uploadPhoto);
  els.downloadButton.addEventListener('click', downloadPhoto);
  els.copyButton.addEventListener('click', async () => {
    await navigator.clipboard.writeText(els.shareCode.value);
    showToast('Decryption code copied to clipboard.');
  });

  els.closeModalButton.addEventListener('click', () => {
    els.codeModal.close();
    setSelectedFiles([]);
    els.photoInput.value = '';
  });
}

init();
