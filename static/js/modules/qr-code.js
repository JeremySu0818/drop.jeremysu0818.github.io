import QRCode from 'https://esm.sh/qrcode@1.5.4';

/**
 * Checks if the current browser environment supports sharing image files via Web Share API.
 * @returns {boolean}
 */
export function canShareFiles() {
  if (
    typeof navigator.share !== 'function' ||
    typeof navigator.canShare !== 'function'
  ) {
    return false;
  }
  try {
    const testFile = new File([''], 'test.png', { type: 'image/png' });
    return navigator.canShare({ files: [testFile] });
  } catch {
    return false;
  }
}

/**
 * Renders a QR Code onto a canvas element.
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {object} [options]
 */
function drawPathRoundRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

function createCompositeExportCanvas(sourceCanvas) {
  if (!sourceCanvas) return null;

  const exportW = sourceCanvas.width || 240;
  const exportH = exportW;

  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = exportW;
  exportCanvas.height = exportH;

  const ctx = exportCanvas.getContext('2d');
  if (!ctx) return sourceCanvas;

  const bgImg = window.__currentBgImg;

  if (bgImg && bgImg.complete && bgImg.naturalWidth > 0) {
    const imgAspect = bgImg.naturalWidth / bgImg.naturalHeight;
    let drawW;
    let drawH;
    let drawX;
    let drawY;
    if (imgAspect > 1) {
      drawH = exportH;
      drawW = exportH * imgAspect;
      drawX = (exportW - drawW) / 2;
      drawY = 0;
    } else {
      drawW = exportW;
      drawH = exportW / imgAspect;
      drawX = 0;
      drawY = (exportH - drawH) / 2;
    }
    
    // Expand the drawing area by 16px on all sides so the blur doesn't pull in transparent edges
    const margin = 16;
    drawW += margin * 2;
    drawH += margin * 2;
    drawX -= margin;
    drawY -= margin;
    
    // Apply blur to simulate the modal's backdrop-filter (8px)
    ctx.filter = 'blur(8px)';
    ctx.drawImage(bgImg, drawX, drawY, drawW, drawH);
    ctx.filter = 'none';
  } else {
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(0, 0, exportW, exportH);
  }

  // Simulate modal CSS compositing layers:
  // 1. dialog::backdrop background (darkens the screen)
  ctx.fillStyle = 'rgba(11, 13, 16, 0.4)';
  ctx.fillRect(0, 0, exportW, exportH);
  
  // 2. dialog.glass-card background
  ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.fillRect(0, 0, exportW, exportH);

  // Draw the QR Code dots canvas
  ctx.drawImage(sourceCanvas, 0, 0, exportW, exportH);

  return exportCanvas;
}

export async function renderQrCode(canvas, text, options = {}) {
  if (!canvas || !text) return;

  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const modules = qr.modules;
  const size = modules.size;
  const margin = options.margin ?? 2;
  const canvasWidth = options.width || 220;
  const canvasHeight = canvasWidth;

  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Clear canvas background (網頁畫面保持全透明無白底)
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Highest saturation color sampled from background image
  const dotColor =
    options.color?.dark ||
    window.__highestSaturationColor ||
    document.documentElement.style.getPropertyValue('--highest-sat-color').trim() ||
    '#101318';

  const cellSize = canvasWidth / (size + margin * 2);
  const dotRadius = cellSize * 0.44;

  ctx.fillStyle = dotColor;

  // Render dots for each dark module (點點呈現)
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules.get(row, col)) {
        const cx = (col + margin + 0.5) * cellSize;
        const cy = (row + margin + 0.5) * cellSize;
        ctx.beginPath();
        ctx.arc(cx, cy, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

export function downloadQrCode(canvas, filename = 'drop-share-qr.png') {
  return new Promise((resolve, reject) => {
    if (!canvas) {
      reject(new Error('Canvas element not found.'));
      return;
    }
    const exportCanvas = createCompositeExportCanvas(canvas) || canvas;
    exportCanvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to create QR code image file.'));
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 150);
      resolve();
    }, 'image/png');
  });
}

/**
 * Shares the QR code canvas image file via navigator.share.
 * @param {HTMLCanvasElement} canvas
 * @param {object} [shareData]
 * @param {string} [filename]
 * @returns {Promise<void>}
 */
export function shareQrCode(
  canvas,
  shareData = {},
  filename = 'drop-share-qr.png',
) {
  return new Promise((resolve, reject) => {
    if (!canvas) {
      reject(new Error('Canvas element not found.'));
      return;
    }
    const exportCanvas = createCompositeExportCanvas(canvas) || canvas;
    exportCanvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('Failed to create QR code image file.'));
        return;
      }
      const file = new File([blob], filename, { type: 'image/png' });
      try {
        await navigator.share({
          title: shareData.title || 'Drop Secure Share QR Code',
          text:
            shareData.text ||
            'Scan this QR Code to access the encrypted file download.',
          files: [file],
        });
        resolve();
      } catch (error) {
        reject(error);
      }
    }, 'image/png');
  });
}
