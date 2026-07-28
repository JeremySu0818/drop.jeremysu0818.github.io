export function bytesToBase64(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  return btoa(chunks.join(''));
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function textBytes(value) {
  return new TextEncoder().encode(value);
}

export async function sha256Bytes(value) {
  const bytes = typeof value === 'string' ? textBytes(value) : value;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function keyFromCode(code) {
  const digest = await sha256Bytes(code);
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptBytes(key, bytes) {
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

export async function decryptBytes(key, ivBase64, ciphertextBase64) {
  const iv = base64ToBytes(ivBase64);
  const ciphertext = base64ToBytes(ciphertextBase64);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );
  return new Uint8Array(decrypted);
}

export async function lookupKeyFromCode(code) {
  return bytesToHex(await sha256Bytes(`lookup:${code}`));
}

export async function createShareCode() {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(secret);
}
