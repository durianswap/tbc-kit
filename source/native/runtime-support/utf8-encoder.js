// Load in the wallet's private VM before Kit, never in the DApp page.
// __encode is the existing wallet-owned platform fallback.
globalThis.TextEncoder = class { encode(value = '') {
  const text = String(value);
  if (typeof globalThis.__tbcNativeEncodeAscii === 'function') {
    const bytes = globalThis.__tbcNativeEncodeAscii(text);
    if (bytes !== undefined) {
      if (!(bytes instanceof Uint8Array) || bytes.length !== text.length)
        throw new TypeError('Invalid native ASCII bytes');
      return bytes;
    }
    return Uint8Array.from(__encode(text));
  }
  if (!/[^\x00-\x7f]/.test(text)) {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }
  return Uint8Array.from(__encode(text));
} };
