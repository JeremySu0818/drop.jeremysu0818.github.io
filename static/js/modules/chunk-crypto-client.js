export async function createChunkCrypto(code) {
  const worker = new Worker(
    new URL("../workers/chunk-crypto-worker.js", import.meta.url),
    { type: "module" },
  );
  const pending = new Map();
  let nextId = 1;
  let stopped = false;

  worker.addEventListener("message", (event) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.error) {
      request.reject(new Error(event.data.error));
    } else {
      request.resolve(event.data);
    }
  });
  worker.addEventListener("error", (event) => {
    const error = new Error(event.message || "Chunk crypto worker failed.");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  const call = (operation, payload = {}, transfer = []) =>
    new Promise((resolve, reject) => {
      if (stopped) {
        reject(new Error("Chunk crypto worker is no longer available."));
        return;
      }
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, operation, ...payload }, transfer);
    });

  await call("init", { code });

  return {
    async encrypt(bytes) {
      const buffer =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.slice().buffer;
      const result = await call("encrypt", { bytes: buffer }, [buffer]);
      return {
        iv: result.iv,
        ciphertext: new Uint8Array(result.bytes),
      };
    },
    async decrypt(iv, bytes) {
      const buffer =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.slice().buffer;
      const result = await call("decrypt", { iv, bytes: buffer }, [buffer]);
      return new Uint8Array(result.bytes);
    },
    terminate() {
      if (stopped) return;
      stopped = true;
      worker.terminate();
      const error = new Error("Chunk crypto worker was terminated.");
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    },
  };
}
