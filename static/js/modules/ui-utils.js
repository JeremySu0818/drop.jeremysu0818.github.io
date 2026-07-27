import { formatBytes, shortenFilename } from './file-utils.js';

const DEFAULT_FILE_META = 'Supports all file formats';

export function createToastManager(toastElement) {
  let toastTimer = 0;

  return {
    show(message, options = {}) {
      const { persist = false } = options;
      window.clearTimeout(toastTimer);
      toastElement.textContent = message;
      toastElement.classList.add('is-visible');

      if (!persist) {
        toastTimer = window.setTimeout(() => {
          toastElement.classList.remove('is-visible');
        }, 3600);
      }
    },
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

