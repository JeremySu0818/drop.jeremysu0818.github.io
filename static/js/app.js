import { createLiquidGlass } from 'https://esm.sh/solid-glass@0.0.3/engines/svg-refraction';
import { zipSync } from 'https://esm.sh/fflate@0.8.2';
import { initPageEffects } from './ui-effects.js';

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

let selectedFiles = [];
let toastTimer = 0;

function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.originalText ||= button.textContent.trim();
}

function showToast(message, options = {}) {
  const { persist = false } = options;
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('is-visible');
  if (!persist) {
    toastTimer = window.setTimeout(() => {
      els.toast.classList.remove('is-visible');
    }, 3600);
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes) {
  return bytesToBase64(bytes)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

async function sha256Bytes(value) {
  const bytes = typeof value === 'string' ? textBytes(value) : value;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function keyFromCode(code) {
  const digest = await sha256Bytes(code);
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    bytes,
  );
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  };
}

async function decryptBytes(key, ivBase64, ciphertextBase64) {
  const iv = base64ToBytes(ivBase64);
  const ciphertext = base64ToBytes(ciphertextBase64);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );
  return new Uint8Array(decrypted);
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

async function lookupKeyFromCode(code) {
  return bytesToHex(await sha256Bytes(`lookup:${code}`));
}

async function createShareCode() {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(secret);
}

function formatBytes(size) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function setSelectedFiles(files) {
  selectedFiles = files.filter((file) => file.type.startsWith('image/'));
  if (selectedFiles.length === 0) {
    els.fileMeta.textContent = 'Supported formats: PNG, JPG, WebP, GIF';
    return;
  }

  const totalSize = selectedFiles.reduce((sum, file) => sum + file.size, 0);
  if (selectedFiles.length === 1) {
    const [file] = selectedFiles;
    let displayName = file.name;
    if (displayName.length > 30) {
      const dotIndex = displayName.lastIndexOf('.');
      if (dotIndex !== -1 && displayName.length - dotIndex <= 6) {
        const ext = displayName.slice(dotIndex);
        const base = displayName.slice(0, dotIndex);
        displayName = `${base.slice(0, 30 - ext.length - 3)}...${ext}`;
      } else {
        displayName = `${displayName.slice(0, 27)}...`;
      }
    }
    els.fileMeta.textContent = `${displayName} · ${formatBytes(file.size)}`;
    return;
  }

  els.fileMeta.textContent = `Selected ${selectedFiles.length} image(s) · ${formatBytes(totalSize)}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function uniqueZipName(name, usedNames) {
  const fallbackName = 'picdrop-image';
  const cleanName =
    String(name || fallbackName)
      .replaceAll('\\', '/')
      .split('/')
      .pop() || fallbackName;
  if (!usedNames.has(cleanName)) {
    usedNames.add(cleanName);
    return cleanName;
  }

  const dotIndex = cleanName.lastIndexOf('.');
  const base = dotIndex > 0 ? cleanName.slice(0, dotIndex) : cleanName;
  const ext = dotIndex > 0 ? cleanName.slice(dotIndex) : '';
  let counter = 2;
  let candidate = `${base}-${counter}${ext}`;
  while (usedNames.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}${ext}`;
  }
  usedNames.add(candidate);
  return candidate;
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
    const files = [...event.dataTransfer.files].filter((item) =>
      item.type.startsWith('image/'),
    );
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
