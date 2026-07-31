import { createLiquidGlass } from 'https://esm.sh/solid-glass@0.0.3/engines/svg-refraction';
import {
  encryptBytes,
  keyFromCode,
  lookupKeyFromCode,
  textBytes,
} from './modules/crypto-utils.js';
import { createChunkCrypto } from './modules/chunk-crypto-client.js';
import {
  createDownloadManager,
  DownloadCancelledError,
} from './modules/download-manager.js';
import {
  createShortShareUrl,
  createShortToken,
  shortTokenToShareCode,
} from './modules/share-link.js';
import {
  createToastManager,
  filterMediaFiles,
  setBusy,
  summarizeSelectedFiles,
} from './modules/ui-utils.js';
import { initPageEffects } from './modules/ui-effects.js';

const TTL_MINUTES = 30;
const PROGRESS_RENDER_INTERVAL_MS = 120;
const CHUNK_SIZE_BYTES = 64 * 1024 * 1024;
const MAX_PARALLEL_CHUNKS = 3;
const RECENT_UPLOAD_STORAGE_KEY = 'drop:recent-upload';
const DOWNLOAD_CODE_STORAGE_KEY = 'drop:download-code';
const SERVER_URL = 'https://drop-server.jeremytw.qzz.io';

const els = {
  photoInput: document.querySelector('#photoInput'),
  dropZone: document.querySelector('#dropZone'),
  fileMeta: document.querySelector('#fileMeta'),
  uploadButton: document.querySelector('#uploadButton'),
  codeModal: document.querySelector('#codeModal'),
  shareCode: document.querySelector('#shareCode'),
  shareLink: document.querySelector('#shareLink'),
  copyLinkButton: document.querySelector('#copyLinkButton'),
  shareButton: document.querySelector('#shareButton'),
  copyCodeButton: document.querySelector('#copyCodeButton'),
  closeModalButton: document.querySelector('#closeModalButton'),
  downloadDestinationModal: document.querySelector(
    '#downloadDestinationModal',
  ),
  chooseDirectoryButton: document.querySelector('#chooseDirectoryButton'),
  cancelDirectoryButton: document.querySelector('#cancelDirectoryButton'),
  downloadCode: document.querySelector('#downloadCode'),
  downloadButton: document.querySelector('#downloadButton'),
  toast: document.querySelector('#toast'),
};

const toast = createToastManager(els.toast);
let selectedFiles = [];
let activeUploadId = '';

function showToast(message, options = {}) {
  toast.show(message, options);
}

const downloadManager = createDownloadManager({
  serverUrl: SERVER_URL,
  showToast,
  chooseDirectory: chooseDownloadDirectory,
});

function getShareReceiverUrl() {
  return new URL('r/', new URL('.', window.location.href));
}

function setShareDetails(code, shortToken) {
  els.shareCode.value = code;
  els.shareLink.value = createShortShareUrl(shortToken, getShareReceiverUrl());
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const fallback = document.createElement('textarea');
  fallback.value = value;
  fallback.setAttribute('readonly', '');
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  document.body.append(fallback);
  fallback.select();
  const copied = document.execCommand('copy');
  fallback.remove();
  if (!copied) throw new Error('Unable to access the clipboard.');
}

function extractCodes(value) {
  const normalized = String(value || '').replaceAll('SHA-256:', '');
  const codes = normalized.match(/\b[a-fA-F0-9]{64}\b/g) || [];
  const uniqueCodes = [...new Set(codes.map((code) => code.toLowerCase()))];
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

function readSessionValue(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionValue(key, value) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {}
}

function readLocalValue(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalValue(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {}
}

function rememberRecentUpload(code, shortToken, expiresAt) {
  writeLocalValue(
    RECENT_UPLOAD_STORAGE_KEY,
    JSON.stringify({ code, shortToken, expiresAt, acknowledged: false }),
  );
}

function acknowledgeRecentUpload() {
  const storedUpload = readLocalValue(RECENT_UPLOAD_STORAGE_KEY);
  if (!storedUpload) return;
  try {
    const recentUpload = JSON.parse(storedUpload);
    if (
      recentUpload.code !== els.shareCode.value ||
      recentUpload.expiresAt <= Date.now()
    ) {
      return;
    }
    writeLocalValue(
      RECENT_UPLOAD_STORAGE_KEY,
      JSON.stringify({ ...recentUpload, acknowledged: true }),
    );
  } catch {}
}

function restoreSessionState() {
  els.downloadCode.value = readSessionValue(DOWNLOAD_CODE_STORAGE_KEY) || '';

  const storedUpload = readLocalValue(RECENT_UPLOAD_STORAGE_KEY);
  if (!storedUpload) return;
  try {
    const recentUpload = JSON.parse(storedUpload);
    if (
      typeof recentUpload.code !== 'string' ||
      typeof recentUpload.shortToken !== 'string' ||
      !Number.isFinite(recentUpload.expiresAt) ||
      recentUpload.expiresAt <= Date.now()
    ) {
      writeLocalValue(RECENT_UPLOAD_STORAGE_KEY, '');
      return;
    }
    setShareDetails(recentUpload.code, recentUpload.shortToken);
    if (recentUpload.acknowledged !== false) return;
    queueMicrotask(() => {
      if (!els.codeModal.open) els.codeModal.showModal();
      showToast('Recovered a recent secure share link from this browser.');
    });
  } catch {
    writeLocalValue(RECENT_UPLOAD_STORAGE_KEY, '');
  }
}

function chooseDownloadDirectory() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      els.chooseDirectoryButton.onclick = null;
      els.cancelDirectoryButton.onclick = null;
      els.downloadDestinationModal.oncancel = null;
      if (els.downloadDestinationModal.open) {
        els.downloadDestinationModal.close();
      }
      callback(value);
    };
    const cancel = () => settle(reject, new DownloadCancelledError());

    els.chooseDirectoryButton.onclick = async () => {
      setBusy(els.chooseDirectoryButton, true);
      try {
        const directory = await window.showDirectoryPicker({
          id: 'drop-downloads',
          mode: 'readwrite',
          startIn: 'downloads',
        });
        settle(resolve, directory);
      } catch (error) {
        if (error?.name === 'AbortError') cancel();
        else settle(reject, error);
      } finally {
        setBusy(els.chooseDirectoryButton, false);
      }
    };
    els.cancelDirectoryButton.onclick = cancel;
    els.downloadDestinationModal.oncancel = (event) => {
      event.preventDefault();
      cancel();
    };
    els.downloadDestinationModal.showModal();
  });
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

async function reserveUploadSession(files) {
  while (true) {
    const shortToken = createShortToken();
    const code = await shortTokenToShareCode(shortToken);
    const uploadCrypto = await createChunkCrypto(code);
    try {
      const key = await keyFromCode(code);
      const lookupKey = await lookupKeyFromCode(code);
      const manifestFiles = await Promise.all(
        files.map(async (file, index) => ({
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
      return { code, session, shortToken, uploadCrypto };
    } catch (error) {
      uploadCrypto.terminate();
      if (error.status !== 409) throw error;
    }
  }
}

async function uploadPhoto() {
  if (selectedFiles.length === 0) {
    showToast('Please select files to upload first.');
    return;
  }

  setBusy(els.uploadButton, true);
  let chunkCrypto;
  try {
    els.shareCode.value = '';
    els.shareLink.value = '';
    const filesToUpload = selectedFiles.slice();
    const totalFiles = filesToUpload.length;
    const totalBytes = filesToUpload.reduce((sum, file) => sum + file.size, 0);
    const activeChunkBytes = new Map();
    const remainingChunks = [];
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
      const transferred =
        completedBytes +
        [...activeChunkBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
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
    showToast('Preparing a secure share link...', { persist: true });
    const reserved = await reserveUploadSession(filesToUpload);
    const { code, session, shortToken } = reserved;
    chunkCrypto = reserved.uploadCrypto;
    uploadId = session.uploadId;
    activeUploadId = uploadId;
    if (session.chunkSize !== CHUNK_SIZE_BYTES) {
      await api(`/api/chunked-uploads/${uploadId}`, {
        method: 'DELETE',
      }).catch(() => {});
      activeUploadId = '';
      throw new Error('Server and browser chunk sizes do not match.');
    }
    showToast(`Uploading 0/${totalFiles} (0%)`, { persist: true });

    try {
      const chunkTasks = [];
      for (let fileIndex = 0; fileIndex < filesToUpload.length; fileIndex += 1) {
        const file = filesToUpload[fileIndex];
        const chunkCount = Math.max(
          1,
          Math.ceil(file.size / CHUNK_SIZE_BYTES),
        );
        remainingChunks[fileIndex] = chunkCount;
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
          chunkTasks.push({ file, fileIndex, chunkIndex });
        }
      }
      await eachWithConcurrency(
        chunkTasks,
        MAX_PARALLEL_CHUNKS,
        async ({ file, fileIndex, chunkIndex }) => {
          const fileId = `f${fileIndex}`;
          const progressKey = `${fileIndex}:${chunkIndex}`;
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
          const sourceLength = sourceBytes.byteLength;
          const encrypted = await chunkCrypto.encrypt(sourceBytes);
          sourceBytes = null;
          await uploadBinaryWithProgress(
            `/api/chunked-uploads/${uploadId}/files/${fileId}/chunks/${chunkIndex}`,
            encrypted.ciphertext,
            encrypted.iv,
            (event) => {
              activeChunkBytes.set(
                progressKey,
                event.total
                  ? Math.round((event.loaded / event.total) * sourceLength)
                  : 0,
              );
              renderProgress();
            },
          );
          activeChunkBytes.delete(progressKey);
          completedBytes += sourceLength;
          remainingChunks[fileIndex] -= 1;
          if (remainingChunks[fileIndex] === 0) {
            completedFiles += 1;
          }
          renderProgress(true);
        },
      );
      const completion = await api('/api/chunked-uploads/complete', {
        method: 'POST',
        body: JSON.stringify({ uploadId }),
      });
      activeUploadId = '';
      rememberRecentUpload(code, shortToken, completion.expiresAt);

      setShareDetails(code, shortToken);
    } catch (error) {
      if (uploadId) {
        api(`/api/chunked-uploads/${uploadId}`, { method: 'DELETE' }).catch(
          () => {},
        );
      }
      activeUploadId = '';
      throw error;
    }

    els.codeModal.showModal();
    showToast(
      `Successfully encrypted and uploaded ${filesToUpload.length} file(s). Valid for ${TTL_MINUTES} minutes.`,
    );
  } catch (error) {
    showToast(error.message);
  } finally {
    chunkCrypto?.terminate();
    setBusy(els.uploadButton, false);
  }
}

async function downloadPhoto() {
  setBusy(els.downloadButton, true);
  try {
    const [code] = extractCodes(els.downloadCode.value);
    const result = await downloadManager.downloadFiles(code);
    els.downloadCode.value = '';
    writeSessionValue(DOWNLOAD_CODE_STORAGE_KEY, '');
    const { fileCount, serverCopyDestroyed } = result;
    showToast(
      serverCopyDestroyed
        ? fileCount === 1
          ? 'File downloaded successfully. Server copy destroyed.'
          : 'Successfully downloaded ' + fileCount + ' files. Server copy destroyed.'
        : fileCount === 1
          ? 'File saved. Server cleanup could not be confirmed; retry remains possible until expiry.'
          : fileCount + ' files saved. Server cleanup could not be confirmed; retry remains possible until expiry.',
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
  downloadManager.cleanupStaleDownloadFiles();
  restoreSessionState();

  els.uploadButton.addEventListener('click', uploadPhoto);
  els.downloadButton.addEventListener('click', downloadPhoto);
  els.downloadCode.addEventListener('input', () => {
    writeSessionValue(DOWNLOAD_CODE_STORAGE_KEY, els.downloadCode.value);
  });
  els.copyLinkButton.addEventListener('click', async () => {
    try {
      await copyText(els.shareLink.value);
      acknowledgeRecentUpload();
      showToast('Secure share link copied to clipboard.');
    } catch (error) {
      showToast(error.message);
    }
  });

  els.shareButton.addEventListener('click', async () => {
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({
          title: 'Secure file download',
          text: 'Open this secure link to decrypt and download the shared file.',
          url: els.shareLink.value,
        });
        acknowledgeRecentUpload();
        showToast('Secure link ready to share.');
        return;
      }

      await copyText(els.shareLink.value);
      acknowledgeRecentUpload();
      showToast('Secure share link copied to clipboard.');
    } catch (error) {
      if (error?.name !== 'AbortError') {
        showToast('Unable to share the link. Please copy it instead.');
      }
    }
  });

  els.copyCodeButton.addEventListener('click', async () => {
    try {
      await copyText(els.shareCode.value);
      acknowledgeRecentUpload();
      showToast('Decryption code copied to clipboard.');
    } catch (error) {
      showToast(error.message);
    }
  });

  els.closeModalButton.addEventListener('click', () => {
    acknowledgeRecentUpload();
    els.codeModal.close();
    setSelectedFiles([]);
    els.photoInput.value = '';
  });

  window.addEventListener('pagehide', (event) => {
    if (!activeUploadId || event.persisted) return;
    const abortUrl = `${SERVER_URL}/api/chunked-uploads/${activeUploadId}/abort`;
    const beaconQueued =
      typeof navigator.sendBeacon === 'function' &&
      navigator.sendBeacon(abortUrl);
    if (!beaconQueued) {
      fetch(abortUrl, { method: 'POST', keepalive: true }).catch(() => {});
    }
  });
}

init();
