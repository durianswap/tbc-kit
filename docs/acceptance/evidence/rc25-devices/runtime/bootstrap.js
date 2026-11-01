// Trusted JSContext only, not injected into the DApp WebView.
globalThis.TextEncoder = class { encode(value = '') {
  const text = String(value);
  // Canonical transaction hex is ASCII. Keep these exact bytes in this VM:
  // a JSON array roundtrip across JNI costs more than the hashing itself.
  // Other Unicode keeps the existing platform codec semantics.
  if (!/[^\x00-\x7f]/.test(text)) {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }
  return Uint8Array.from(__encode(text));
} };
globalThis.TextDecoder = class { decode(value) { const out = __decode(Array.from(value ?? [])); if (out == null) throw Error('Invalid UTF8'); return out; } };
globalThis.URL = class { constructor(value) { Object.assign(this, JSON.parse(__url(String(value)))); } toString() { return this.href; } };
globalThis.performance = { now: () => __now() };
globalThis.console = { log() {}, warn() {}, error() {} };
const timers = new Map(); let timerSequence = 0;
globalThis.setTimeout = (f, ms = 0, ...args) => { const id = ++timerSequence; timers.set(id, () => f(...args)); __schedule(id, ms); return id; };
globalThis.clearTimeout = id => { timers.delete(id); __cancelTimer(id); };
globalThis.__fireTimer = id => { const f = timers.get(id); timers.delete(id); f?.(); };
const pending = new Map(); let sequence = 0, session;
function callHost(method, input) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); __nativeCall(String(id), method, input); }); }
globalThis.__settle = (id, value, error) => { const p = pending.get(Number(id)); if (!p) return; pending.delete(Number(id)); error ? p.reject(Error('Native callback rejected')) : p.resolve(value); };
globalThis.__closeWallet = () => { session?.close(); session = undefined; for (const p of pending.values()) p.reject(Error('Native session closed')); pending.clear(); };
globalThis.__openWallet = (prefix, realTestnet = false, apiOrigin = 'https://api.tbcdev.org') => NativeWalletEntry.openNativeWalletSession({ callHost, requestIdPrefix: prefix, realTestnet, apiOrigin }).then(s => { session = s; });
globalThis.__requestWallet = raw => {
  if (!session) return Promise.reject(Error('Wallet unavailable'));
  return session.request(JSON.parse(raw));
};
