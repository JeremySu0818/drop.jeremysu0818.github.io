let encryptionKey;

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function initialize(code) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(code),
  );
  encryptionKey = await crypto.subtle.importKey(
    'raw',
    digest,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}

self.addEventListener('message', async (event) => {
  const { id, operation } = event.data;
  try {
    if (operation === 'init') {
      await initialize(event.data.code);
      self.postMessage({ id });
      return;
    }
    if (!encryptionKey) throw new Error('Chunk crypto worker is not initialized.');

    if (operation === 'encrypt') {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const bytes = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        encryptionKey,
        event.data.bytes,
      );
      self.postMessage({ id, iv: bytesToBase64(iv), bytes }, [bytes]);
      return;
    }
    if (operation === 'decrypt') {
      const bytes = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(event.data.iv) },
        encryptionKey,
        event.data.bytes,
      );
      self.postMessage({ id, bytes }, [bytes]);
      return;
    }
    throw new Error('Unknown chunk crypto operation.');
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
