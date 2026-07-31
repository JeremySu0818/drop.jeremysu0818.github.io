import { bytesToHex, sha256Bytes } from './crypto-utils.js';

const SHORT_TOKEN_PATTERN = /^[A-Za-z0-9]{22}$/;
const TOKEN_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const TOKEN_LENGTH = 22;
const UNBIASED_BYTE_LIMIT =
  Math.floor(256 / TOKEN_ALPHABET.length) * TOKEN_ALPHABET.length;

function normalizeShortToken(token) {
  const normalized = String(token || '').trim();
  if (!SHORT_TOKEN_PATTERN.test(normalized)) {
    throw new Error('This secure link is incomplete or invalid.');
  }
  return normalized;
}

export function createShortToken() {
  let token = '';
  while (token.length < TOKEN_LENGTH) {
    const bytes = crypto.getRandomValues(
      new Uint8Array(TOKEN_LENGTH - token.length),
    );
    for (const byte of bytes) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      token += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
    }
  }
  return token;
}

export async function shortTokenToShareCode(token) {
  const normalized = normalizeShortToken(token);
  return bytesToHex(await sha256Bytes(`share-code:v1:${normalized}`));
}

export function createShortShareUrl(token, receiverUrl) {
  const url = new URL(receiverUrl);
  url.hash = normalizeShortToken(token);
  return url.href;
}
