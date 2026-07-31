import { formatBytes, shortenFilename } from "./file-utils.js";

const DEFAULT_FILE_META = "Supports all file formats";

export function createToastManager(toastElement) {
  let toastTimer = 0;
  let hideTimer = 0;

  const hide = () => {
    window.clearTimeout(toastTimer);
    window.clearTimeout(hideTimer);
    toastElement.classList.remove("is-visible");
    hideTimer = window.setTimeout(() => {
      if (
        !toastElement.classList.contains("is-visible") &&
        typeof toastElement.hidePopover === "function" &&
        toastElement.matches?.(":popover-open")
      ) {
        try {
          toastElement.hidePopover();
        } catch (e) {}
      }
    }, 200);
  };

  return {
    show(message, options = {}) {
      const { persist = false } = options;
      window.clearTimeout(toastTimer);
      window.clearTimeout(hideTimer);

      if (
        typeof toastElement.hidePopover === "function" &&
        toastElement.matches?.(":popover-open")
      ) {
        try {
          toastElement.hidePopover();
        } catch (e) {}
      }

      toastElement.textContent = message;

      if (typeof toastElement.showPopover === "function") {
        try {
          toastElement.showPopover();
        } catch (e) {}
      }

      toastElement.classList.remove("is-visible");
      void toastElement.offsetWidth;
      toastElement.classList.add("is-visible");

      if (!persist) {
        toastTimer = window.setTimeout(() => {
          hide();
        }, 3600);
      }
    },
    hide,
  };
}

export function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.originalText ||= button.textContent.trim();
}

export function summarizeSelectedFiles(files) {
  if (files.length === 0) {
    return DEFAULT_FILE_META;
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length === 1) {
    const [file] = files;
    return `${shortenFilename(file.name)} · ${formatBytes(file.size)}`;
  }

  return `Selected ${files.length} file(s) · ${formatBytes(totalSize)}`;
}

export function filterMediaFiles(files) {
  return files.filter(Boolean);
}

export const filterImageFiles = filterMediaFiles;

export { DEFAULT_FILE_META };
