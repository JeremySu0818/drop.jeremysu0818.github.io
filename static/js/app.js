import { createLiquidGlass } from "https://esm.sh/solid-glass@0.0.3/engines/svg-refraction";
import { initPageEffects } from "./ui-effects.js";

const TTL_MINUTES = 30;
const DEFAULT_SERVER_URL = "https://picdrop-server.jeremytw.qzz.io";

const els = {
  serverStatus: document.querySelector("#serverStatus"),
  photoInput: document.querySelector("#photoInput"),
  dropZone: document.querySelector("#dropZone"),
  fileMeta: document.querySelector("#fileMeta"),
  uploadButton: document.querySelector("#uploadButton"),
  codePanel: document.querySelector("#codePanel"),
  shareCode: document.querySelector("#shareCode"),
  copyButton: document.querySelector("#copyButton"),
  downloadCode: document.querySelector("#downloadCode"),
  downloadButton: document.querySelector("#downloadButton"),
  serverUrl: document.querySelector("#serverUrl"),
  saveServerUrl: document.querySelector("#saveServerUrl"),
  toast: document.querySelector("#toast"),
};

let selectedFile = null;
let toastTimer = 0;

function getServerUrl() {
  return (localStorage.getItem("picdrop.serverUrl") || DEFAULT_SERVER_URL).replace(/\/+$/, "");
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.originalText ||= button.textContent.trim();
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("is-visible");
  }, 3600);
}

function bytesToBase64(bytes) {
  let binary = "";
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
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes) {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

async function sha256Bytes(value) {
  const bytes = typeof value === "string" ? textBytes(value) : value;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function keyFromCode(code) {
  const digest = await sha256Bytes(code);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  };
}

async function decryptBytes(key, ivBase64, ciphertextBase64) {
  const iv = base64ToBytes(ivBase64);
  const ciphertext = base64ToBytes(ciphertextBase64);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new Uint8Array(decrypted);
}

function normalizeCode(value) {
  const code = value.trim();
  if (!/^SHA-256:[A-Za-z0-9_-]{43}$/.test(code)) {
    throw new Error("代碼格式不正確。");
  }
  return code;
}

async function lookupHashFromCode(code) {
  return bytesToHex(await sha256Bytes(`lookup:${code}`));
}

async function createShareCode() {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return `SHA-256:${base64Url(secret)}`;
}

function formatBytes(size) {
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function api(path, options = {}) {
  const response = await fetch(`${getServerUrl()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || "伺服器回應失敗。");
  }
  return body;
}

async function uploadPhoto() {
  if (!selectedFile) {
    showToast("請先選擇圖片。");
    return;
  }

  setBusy(els.uploadButton, true);
  try {
    const code = await createShareCode();
    const key = await keyFromCode(code);
    const lookupHash = await lookupHashFromCode(code);
    const fileBytes = new Uint8Array(await selectedFile.arrayBuffer());
    const metaBytes = textBytes(
      JSON.stringify({
        name: selectedFile.name || "picdrop-image",
        mime: selectedFile.type || "application/octet-stream",
        size: selectedFile.size,
      }),
    );

    const [fileBox, metaBox] = await Promise.all([
      encryptBytes(key, fileBytes),
      encryptBytes(key, metaBytes),
    ]);

    await api("/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        lookupHash,
        fileIv: fileBox.iv,
        fileCiphertext: fileBox.ciphertext,
        metaIv: metaBox.iv,
        metaCiphertext: metaBox.ciphertext,
      }),
    });

    els.shareCode.value = code;
    els.codePanel.hidden = false;
    showToast(`已加密上傳，有效 ${TTL_MINUTES} 分鐘。`);
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(els.uploadButton, false);
  }
}

async function downloadPhoto() {
  setBusy(els.downloadButton, true);
  try {
    const code = normalizeCode(els.downloadCode.value);
    const key = await keyFromCode(code);
    const lookupHash = await lookupHashFromCode(code);
    const payload = await api("/api/download", {
      method: "POST",
      body: JSON.stringify({ lookupHash }),
    });

    const metaBytes = await decryptBytes(key, payload.metaIv, payload.metaCiphertext);
    const meta = JSON.parse(new TextDecoder().decode(metaBytes));
    const fileBytes = await decryptBytes(key, payload.fileIv, payload.fileCiphertext);
    const blob = new Blob([fileBytes], { type: meta.mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = meta.name || "picdrop-image";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    els.downloadCode.value = "";
    showToast("圖片已下載，伺服器端資料已銷毀。");
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(els.downloadButton, false);
  }
}

function bindDropZone() {
  els.photoInput.addEventListener("change", () => {
    selectedFile = els.photoInput.files?.[0] || null;
    els.fileMeta.textContent = selectedFile
      ? `${selectedFile.name} · ${formatBytes(selectedFile.size)}`
      : "PNG、JPG、WebP、GIF";
  });

  for (const eventName of ["dragenter", "dragover"]) {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("is-dragging");
    });
  }

  for (const eventName of ["dragleave", "drop"]) {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("is-dragging");
    });
  }

  els.dropZone.addEventListener("drop", (event) => {
    const file = [...event.dataTransfer.files].find((item) => item.type.startsWith("image/"));
    if (!file) {
      showToast("請拖曳圖片檔。");
      return;
    }
    selectedFile = file;
    els.fileMeta.textContent = `${file.name} · ${formatBytes(file.size)}`;
  });
}

async function checkServer() {
  els.serverStatus.textContent = "API 檢查中";
  els.serverStatus.classList.remove("is-online", "is-offline");
  try {
    await api("/api/health");
    els.serverStatus.textContent = "API 已連線";
    els.serverStatus.classList.add("is-online");
  } catch {
    els.serverStatus.textContent = "API 未連線";
    els.serverStatus.classList.add("is-offline");
  }
}

function init() {
  els.serverUrl.value = getServerUrl();
  initPageEffects(createLiquidGlass);
  bindDropZone();
  checkServer();

  els.uploadButton.addEventListener("click", uploadPhoto);
  els.downloadButton.addEventListener("click", downloadPhoto);
  els.copyButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(els.shareCode.value);
    showToast("已複製代碼。");
  });
  els.saveServerUrl.addEventListener("click", () => {
    localStorage.setItem("picdrop.serverUrl", els.serverUrl.value.trim().replace(/\/+$/, ""));
    showToast("Server URL 已儲存。");
    checkServer();
  });
}

init();
