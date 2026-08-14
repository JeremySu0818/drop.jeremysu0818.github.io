import { createLiquidGlass } from 'https://esm.sh/solid-glass@0.0.3/engines/svg-refraction';
import {
  createDownloadManager,
  DownloadCancelledError,
} from './modules/download-manager.js';
import { createBrowserHandoff } from './modules/browser-handoff.js';
import { shortTokenToShareCode } from './modules/share-link.js';
import { createToastManager, setBusy } from './modules/ui-utils.js';
import { initPageEffects } from './modules/ui-effects.js';
import { initI18n, t } from './i18n.js';

const SERVER_URL = 'https://drop-server.jeremytw.qzz.io';

const els = {
  title: document.querySelector('#receiveTitle'),
  description: document.querySelector('#receiveDescription'),
  error: document.querySelector('#receiveError'),
  downloadButton: document.querySelector('#downloadButton'),
  downloadZipButton: document.querySelector('#downloadZipButton'),
  downloadCompatibilityNote: document.querySelector(
    '#downloadCompatibilityNote',
  ),
  externalBrowserModal: document.querySelector('#externalBrowserModal'),
  openExternalBrowserButton: document.querySelector(
    '#openExternalBrowserButton',
  ),
  copyExternalLinkButton: document.querySelector('#copyExternalLinkButton'),
  downloadDestinationModal: document.querySelector('#downloadDestinationModal'),
  chooseDirectoryButton: document.querySelector('#chooseDirectoryButton'),
  cancelDirectoryButton: document.querySelector('#cancelDirectoryButton'),
  toast: document.querySelector('#toast'),
};

const toast = createToastManager(els.toast);
let shareCode = '';

function showToast(message, options = {}) {
  toast.show(message, options);
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

const downloadManager = createDownloadManager({
  serverUrl: SERVER_URL,
  showToast,
  chooseDirectory: chooseDownloadDirectory,
});

const browserHandoff = createBrowserHandoff({
  dialog: els.externalBrowserModal,
  openButton: els.openExternalBrowserButton,
  copyButton: els.copyExternalLinkButton,
  showToast,
});

async function readShareCodeFromLocation() {
  const token = window.location.hash.slice(1);
  if (!token) {
    throw new Error(t('runtime.missingAccessKey'));
  }
  return shortTokenToShareCode(token);
}

function showInvalidLink(error) {
  shareCode = '';
  els.title.textContent = t('receive.linkNotReady');
  els.description.textContent = t('receive.sendCompleteLinkAgain');
  els.error.textContent = error.message;
  els.error.hidden = false;
  els.downloadButton.disabled = true;
  els.downloadZipButton.disabled = true;
  els.downloadZipButton.hidden = true;
  if (els.downloadCompatibilityNote) {
    els.downloadCompatibilityNote.hidden = true;
  }
}

function showUnavailableLink(error) {
  shareCode = '';
  els.downloadButton.disabled = true;
  els.downloadZipButton.disabled = true;
  els.downloadZipButton.hidden = true;
  if (els.downloadCompatibilityNote) {
    els.downloadCompatibilityNote.hidden = true;
  }

  if (error.status === 409) {
    els.title.textContent = t('receive.uploadInProgress');
    els.description.textContent = t('receive.finishUploadThenRetry');
    els.error.textContent = error.message;
    els.error.hidden = false;
    return;
  }

  if (error.status === 404 || error.status === 410) {
    els.title.textContent = t('receive.linkExpired');
    els.description.textContent = t('receive.fileNoLongerAvailable');
    els.error.textContent = t('receive.sharedFileExpired');
    els.error.hidden = false;
    return;
  }

  els.title.textContent = t('receive.unableToCheckLink');
  els.description.textContent = t('receive.checkConnectionReload');
  els.error.textContent = error.message || t('receive.unableToContactServer');
  els.error.hidden = false;
}

async function loadShareLink() {
  try {
    shareCode = await readShareCodeFromLocation();
  } catch (error) {
    showInvalidLink(error);
    return;
  }

  els.downloadButton.disabled = true;
  els.downloadZipButton.disabled = true;
  els.downloadZipButton.hidden = true;
  if (els.downloadCompatibilityNote) {
    els.downloadCompatibilityNote.hidden = true;
  }
  els.title.textContent = t('receive.checkingLink');
  els.description.textContent = t('receive.confirmingAvailability');
  els.error.hidden = true;
  if (browserHandoff.requiresHandoff) {
    els.title.textContent = t('receive.openInBrowser');
    els.description.textContent = t('receive.browserDownloadUnavailable');
    browserHandoff.present();
    return;
  }

  try {
    const status = await downloadManager.checkAvailability(shareCode);
    const fileCount =
      Number.isInteger(status?.fileCount) && status.fileCount > 0
        ? status.fileCount
        : null;
    const isMultiple = fileCount > 1;

    const showZipOption = fileCount === null || isMultiple;

    els.title.textContent = isMultiple
      ? t('receive.encryptedFilesReady', { count: fileCount })
      : t('receive.encryptedFileReady');
    els.description.textContent = isMultiple
      ? t('receive.filesRemainEncrypted')
      : t('receive.fileRemainsEncrypted');
    els.downloadButton.disabled = false;
    els.downloadZipButton.hidden = !showZipOption;
    els.downloadZipButton.disabled = !showZipOption;
    if (els.downloadCompatibilityNote) {
      els.downloadCompatibilityNote.hidden = !showZipOption;
    }
  } catch (error) {
    showUnavailableLink(error);
  }
}

async function downloadSharedFiles({ forceZip = false } = {}) {
  if (!shareCode) return;

  let completed = false;
  const activeButton = forceZip ? els.downloadZipButton : els.downloadButton;
  setBusy(activeButton, true);
  els.downloadButton.disabled = true;
  els.downloadZipButton.disabled = true;
  try {
    const { fileCount, serverCopyDestroyed } =
      await downloadManager.downloadFiles(shareCode, { forceZip });
    completed = true;
    els.title.textContent = t('receive.downloadComplete');
    els.description.textContent = serverCopyDestroyed
      ? fileCount === 1
        ? t('receive.fileSavedServerDestroyed')
        : t('receive.filesSavedServerDestroyed')
      : t('receive.fileSavedCleanupUnconfirmed');
    showToast(
      serverCopyDestroyed
        ? fileCount === 1
          ? t('receive.fileDownloadedServerDestroyed')
          : t('receive.filesDownloadedServerDestroyed')
        : t('receive.filesSavedCleanupUnconfirmed'),
    );
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(activeButton, false);
    els.downloadButton.disabled = completed;
    if (els.downloadZipButton.hidden) {
      els.downloadZipButton.disabled = true;
    } else {
      els.downloadZipButton.disabled = completed;
    }
  }
}

function init() {
  initPageEffects(createLiquidGlass);
  downloadManager.cleanupStaleDownloadFiles();
  void loadShareLink();
  els.downloadButton.addEventListener('click', () => downloadSharedFiles());
  els.downloadZipButton.addEventListener('click', () =>
    downloadSharedFiles({ forceZip: true }),
  );
}

await initI18n();
init();
