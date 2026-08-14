import InAppSpy from 'https://esm.sh/inapp-spy@5.0.10';

const HANDOFF_PARAMETER = 'external-handoff';

function supportsBrowserDownloads() {
  const anchor = document.createElement('a');
  return (
    'download' in anchor &&
    typeof Blob === 'function' &&
    typeof URL.createObjectURL === 'function'
  );
}

function isAndroidPlatform() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  return /android/i.test(platform + ' ' + navigator.userAgent);
}

function cleanUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete(HANDOFF_PARAMETER);
  return url;
}

function externalUrl() {
  const url = cleanUrl();
  url.searchParams.set(HANDOFF_PARAMETER, '1');
  return url;
}

function androidIntentUrl(url) {
  const scheme = url.protocol.slice(0, -1);
  const data =
    '//' + url.host + url.pathname + url.search + url.hash;
  return (
    'intent:' +
    data +
    '#Intent;scheme=' +
    scheme +
    ';action=android.intent.action.VIEW' +
    ';category=android.intent.category.BROWSABLE' +
    ';S.browser_fallback_url=' +
    encodeURIComponent(url.href) +
    ';end'
  );
}

function requestExternalOpen() {
  const url = externalUrl();
  if (isAndroidPlatform()) {
    window.location.assign(androidIntentUrl(url));
    return;
  }

  const link = document.createElement('a');
  link.href = url.href;
  link.target = '_system';
  link.rel = 'external noopener noreferrer';
  document.body.append(link);
  link.click();
  link.remove();
}

async function copyCompleteLink() {
  const value = cleanUrl().href;
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
  if (!copied) throw new Error('Unable to copy the secure link.');
}

export function createBrowserHandoff({
  dialog,
  openButton,
  copyButton,
  showToast = () => {},
}) {
  const detection = InAppSpy();
  const requiresHandoff =
    detection.isInApp || !supportsBrowserDownloads();
  const handoffAlreadyAttempted =
    new URL(window.location.href).searchParams.get(HANDOFF_PARAMETER) === '1';

  openButton.addEventListener('click', requestExternalOpen);
  copyButton.addEventListener('click', async () => {
    try {
      await copyCompleteLink();
      showToast('Complete secure link copied. Paste it into your browser.');
    } catch (error) {
      showToast(error.message);
    }
  });
  dialog.addEventListener('cancel', (event) => event.preventDefault());

  return {
    requiresHandoff,
    present() {
      if (!dialog.open) dialog.showModal();
      if (!handoffAlreadyAttempted) requestExternalOpen();
    },
  };
}
