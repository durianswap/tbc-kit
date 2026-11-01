// Only loaded into the private Hermes VM, never into the DApp WebView.
const host = (method, value) => JSON.parse(__host(method, JSON.stringify(value)));
globalThis.__encode = value => host('encode', value);
globalThis.__decode = value => host('decode', value);
globalThis.__url = value => JSON.stringify(host('url', value));
globalThis.__networkURL = (value, base, changes) => JSON.stringify(host('networkURL', [value, base, changes]));
globalThis.__now = () => host('now', null);
globalThis.__schedule = (id, delay) => host('schedule', [id, delay]);
globalThis.__cancelTimer = id => host('cancel', id);
globalThis.__nativeCall = (id, method, input) => host('call', [id, method, input]);
globalThis.__completed = (id, status, code) => host('completed', [id, status, code]);
globalThis.__opened = navigation => host('opened', navigation);
globalThis.__openFailed = () => host('openFailed', null);
