import { createLiquidGlass } from 'https://esm.sh/solid-glass@0.0.3/engines/svg-refraction';
import { zipSync } from 'https://esm.sh/fflate@0.8.2';
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

async function uploadPhoto() {
  if (selectedFiles.length === 0) {
    showToast('Please select image files first.');
    return;
  }

  setBusy(els.uploadButton, true);
  try {
    els.shareCode.value = '';
    const code = await createShareCode();
    const key = await keyFromCode(code);
    const lookupKey = await lookupKeyFromCode(code);
    const totalFiles = selectedFiles.length;
    showToast(`Uploading 0/${totalFiles}`, { persist: true });

    let uploadedFiles = 0;
    let lastProgressAt = 0;

    for (let i = 0; i < selectedFiles.length; i += 1) {
      const selectedFile = selectedFiles[i];
      showToast(`Encrypting ${i + 1}/${totalFiles}`, { persist: true });

      const fileBytes = new Uint8Array(await selectedFile.arrayBuffer());
      const metaBytes = textBytes(
        JSON.stringify({
          name: selectedFile.name || 'picdrop-image',
          mime: selectedFile.type || 'application/octet-stream',
          size: selectedFile.size,
        }),
      );

      const [fileBox, metaBox] = await Promise.all([
        encryptBytes(key, fileBytes),
        encryptBytes(key, metaBytes),
      ]);

      const encryptedFile = {
        fileIv: fileBox.iv,
        fileCiphertext: fileBox.ciphertext,
        metaIv: metaBox.iv,
        metaCiphertext: metaBox.ciphertext,
      };

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
          const currentTime = Date.now();
          const shouldRender =
            percent === 100 || currentTime - lastProgressAt >= 120;

          if (!shouldRender) {
            return;
          }

          lastProgressAt = currentTime;
          const inProgressCount = Math.min(uploadedFiles + 1, totalFiles);
          const overallPercent = Math.min(
            100,
            Math.round(((uploadedFiles + percent / 100) / totalFiles) * 100),
          );

          showToast(
            `Uploading ${inProgressCount}/${totalFiles} (${overallPercent}%)`,
            {
              persist: true,
            },
          );
        },
      );

      uploadedFiles += 1;
      showToast(`Uploading ${uploadedFiles}/${totalFiles}`, { persist: true });
    }

    els.shareCode.value = code;
    els.codeModal.showModal();
    showToast(
      `Successfully encrypted and uploaded ${selectedFiles.length} image(s). Valid for ${TTL_MINUTES} minutes.`,
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
    const payload = await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({ lookupKey }),
    });

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

    for (const encryptedFile of encryptedFiles) {
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
    }

    if (files.length === 1) {
      const [file] = files;
      downloadBlob(new Blob([file.bytes], { type: file.mime }), file.name);
    } else {
      const usedNames = new Set();
      const zipEntries = {};
      for (const file of files) {
        zipEntries[uniqueZipName(file.name, usedNames)] = file.bytes;
      }

      const zipBytes = zipSync(zipEntries, { level: 6 });
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
