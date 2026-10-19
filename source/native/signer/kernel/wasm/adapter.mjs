// Wallet-private adapter. Never expose the instance or this signer to a DApp.
export async function createWasmDigestSigner(source) {
  const created = await WebAssembly.instantiate(source, {});
  const instance = created instanceof WebAssembly.Instance ? created : created.instance;
  const api = instance.exports;
  if (api.tbc_signer_kernel_version() !== 1) throw new Error('Signer kernel ABI mismatch');
  return Object.freeze({
    async signDigest(digest, scalar, encoding) {
      if (!/^[0-9a-f]{64}$/.test(digest) || !(scalar instanceof Uint8Array) || scalar.length !== 32)
        throw new Error('Invalid signing input');
      const tag = encoding === 'compact64' ? 64 : encoding === 'compact65-recoverable' ? 65 : encoding === 'schnorr64' ? 164 : 0;
      const size = tag === 164 ? 64 : tag;
      if (!size) throw new Error('Invalid signature encoding');
      const pointer = api.tbc_signer_buffer_new();
      if (!pointer) throw new Error('Signer allocation failed');
      try {
        const memory = new Uint8Array(api.memory.buffer, pointer, 129);
        for (let i = 0; i < 32; i++) memory[i] = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16);
        memory.set(scalar, 32);
        const status = api.tbc_signer_sign_digest(pointer, 32, pointer + 32, 32, tag, pointer + 64, size);
        if (status !== 0) throw new Error('Signing failed');
        return Array.from(new Uint8Array(api.memory.buffer, pointer + 64, size), x => x.toString(16).padStart(2, '0')).join('');
      } finally {
        new Uint8Array(api.memory.buffer, pointer, 129).fill(0);
        api.tbc_signer_buffer_free(pointer);
      }
    },
  });
}
