import { createLiquidGlass } from 'https://esm.sh/solid-glass@0.0.3/engines/svg-refraction';
import { zip } from 'https://esm.sh/fflate@0.8.2';
import {
  createShareCode,
  decryptBytes,
  encryptBytes,
  keyFromCode,
  lookupKeyFromCode,
  textBytes,
} from './modules/crypto-utils.js';
import { downloadBlob, uniqueZipName } from './modules/file-utils.js';
import {
  createToastManager,
  filterImageFiles,
  setBusy,
  summarizeSelectedFiles,
} from './modules/ui-utils.js';
import { initPageEffects } from './modules/ui-effects.js';

const TTL_MINUTES = 30;
const MAX_PARALLEL_UPLOADS = 3;
const PROGRESS_RENDER_INTERVAL_MS = 120;
const SERVER_URL = 'https://picdrop-server.jeremytw.qzz.io';

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
  selectedFiles = filterImageFiles(files);
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
    throw new Error(body.error || 'Server response failed.');
  }

  return body;
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

async function createEncryptedFile(file, key) {
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const metaBytes = textBytes(
    JSON.stringify({
      name: file.name || 'picdrop-image',
      mime: file.type || 'application/octet-stream',
      size: file.size,
    }),
  );

  const [fileBox, metaBox] = await Promise.all([
    encryptBytes(key, fileBytes),
    encryptBytes(key, metaBytes),
  ]);

  return {
    fileIv: fileBox.iv,
    fileCiphertext: fileBox.ciphertext,
    metaIv: metaBox.iv,
    metaCiphertext: metaBox.ciphertext,
  };
}

async function uploadPhoto() {
  if (selectedFiles.length === 0) {
    showToast('Please select image files first.');
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
    const uploadProgress = Array(totalFiles).fill(0);
    let encryptedFiles = 0;
    let uploadedFiles = 0;
    let lastProgressAt = 0;

    const renderProgress = (force = false) => {
      const currentTime = Date.now();
      if (!force && currentTime - lastProgressAt < PROGRESS_RENDER_INTERVAL_MS) {
        return;
      }

      lastProgressAt = currentTime;
      const activeProgress = uploadProgress.reduce(
        (sum, percent) => sum + percent / 100,
        0,
      );
      const overallPercent = Math.min(
        100,
        Math.round(((uploadedFiles + activeProgress) / totalFiles) * 100),
      );

      showToast(
        `Uploading ${uploadedFiles}/${totalFiles} (${overallPercent}%)`,
        { persist: true },
      );
    };

    showToast(
      concurrency > 1
        ? `Encrypting and uploading with ${concurrency} parallel uploads`
        : `Uploading 0/${totalFiles}`,
      { persist: true },
    );

    await eachWithConcurrency(filesToUpload, concurrency, async (file, index) => {
      const encryptedFile = await createEncryptedFile(file, key);
      encryptedFiles += 1;
      showToast(`Encrypted ${encryptedFiles}/${totalFiles}`, { persist: true });

      await uploadJsonWithProgress(
        '/api/uploads',
        {
          lookupKey,
          files: [encryptedFile],
        },
        (event) => {
          const percent = event.total
            ? Math.min(100, Math.round((event.loaded / event.total) * 100))
            : 0;
          uploadProgress[index] = percent;
          renderProgress(percent === 100);
        },
      );

      uploadedFiles += 1;
      uploadProgress[index] = 0;
      renderProgress(true);
    });

    els.shareCode.value = code;
    els.codeModal.showModal();
    showToast(
      `Successfully encrypted and uploaded ${filesToUpload.length} image(s). Valid for ${TTL_MINUTES} minutes.`,
    );
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(els.uploadButton, false);
  }
}

async function downloadPhoto() {
  setBusy(els.downloadButton, true);
  try {
    const codes = extractCodes(els.downloadCode.value);
    const [code] = codes;
    const key = await keyFromCode(code);
    const lookupKey = await lookupKeyFromCode(code);
    const payload = await downloadJsonWithProgress(
      '/api/download',
      { lookupKey },
      (event) => {
        if (event.lengthComputable) {
          const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
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
      showToast(`Decrypting file ${decryptedCount + 1} of ${totalFilesCount}...`, { persist: true });
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
        name: meta.name || 'picdrop-image',
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
        'picdrop-images.zip',
      );
    }

    els.downloadCode.value = '';
    showToast(
      files.length === 1
        ? 'Image downloaded successfully. Server copy destroyed.'
        : `Successfully downloaded ${files.length} images. Server copy destroyed.`,
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
    els.photoInput.value = '';
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
    const files = filterImageFiles([...event.dataTransfer.files]);
    if (files.length === 0) {
      showToast('Please drag and drop image files only.');
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
  });
}

init();
