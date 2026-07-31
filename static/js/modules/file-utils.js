export function formatBytes(size) {
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function shortenFilename(name, maxLength = 30) {
  let displayName = String(name || "");
  if (displayName.length <= maxLength) {
    return displayName;
  }

  const dotIndex = displayName.lastIndexOf(".");
  if (dotIndex !== -1 && displayName.length - dotIndex <= 6) {
    const ext = displayName.slice(dotIndex);
    const base = displayName.slice(0, dotIndex);
    return `${base.slice(0, maxLength - ext.length - 3)}...${ext}`;
  }

  return `${displayName.slice(0, maxLength - 3)}...`;
}

export function downloadBlob(blob, filename, revokeDelayMs = 10 * 60 * 1000) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs);
}

export function uniqueZipName(name, usedNames) {
  const fallbackName = "drop-file";
  const cleanName =
    String(name || fallbackName)
      .replaceAll("\\", "/")
      .split("/")
      .pop() || fallbackName;

  if (!usedNames.has(cleanName)) {
    usedNames.add(cleanName);
    return cleanName;
  }

  const dotIndex = cleanName.lastIndexOf(".");
  const base = dotIndex > 0 ? cleanName.slice(0, dotIndex) : cleanName;
  const ext = dotIndex > 0 ? cleanName.slice(dotIndex) : "";
  let counter = 2;
  let candidate = `${base}-${counter}${ext}`;

  while (usedNames.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}${ext}`;
  }

  usedNames.add(candidate);
  return candidate;
}
