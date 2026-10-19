import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerHooks, createRequire } from "node:module";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const built = await build({ stdin: { contents: `
  export { createTbcWallet } from './packages/kit/src/wallet-runtime.ts';
  export { createMemoryTwsHostStore } from './packages/host/src/index.ts';
`, resolveDir: root }, bundle: true, write: false, format: "esm", platform: "node", target: "node22", logLevel: "silent",
  alias: { "@tbc-wallet/core": `${root}packages/core/src/index.ts`, "@tbc-wallet/host": `${root}packages/host/src/index.ts`,
    "@tbc-wallet/provider": `${root}packages/provider/src/index.ts`, "@tbc-wallet/provider/in-memory": `${root}packages/provider/src/in-memory.ts` } });
const url = new URL("../src/.session-order-test.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(s, c, next) { return s === url ? { url, shortCircuit: true } : next(s, c); },
  load(u, c, next) { return u === url ? { source: built.outputFiles[0].text, format: "module", shortCircuit: true } : next(u, c); },
});
const { createTbcWallet, createMemoryTwsHostStore } = await import(url); hooks.deregister();
const tbc = createRequire(import.meta.url)("tbc-lib-js");
const accounts = [2, 1, 3].map(scalar => {
  const key = new tbc.PrivateKey(new tbc.crypto.BN(scalar)); // Published synthetic scalars only.
  const address = key.toAddress().toString();
  return { address, chainId: "tbc:testnet", accountId: `tbc:testnet:${address}`, publicKey: key.publicKey.toString() };
});

test("local session sorts only authority IDs without reordering wallet accounts or adding reads", async () => {
  const before = structuredClone(accounts);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  let accountReads = 0;
  const forbidden = async () => { throw new Error("No network, approval or signing expected"); };
  const store = createMemoryTwsHostStore({ now: () => Date.parse(now) });
  const wallet = createTbcWallet({ legacy: false, clock: () => now,
    accounts: { current: async () => { accountReads++; return accounts; } },
    approval: { request: forbidden }, signer: { sign: forbidden },
    storage: { loadPermissions: async () => ({ revision: "0", permissions: [] }), commitPermissions: forbidden },
    network: { resolveChainData: forbidden, resolvePolicy: forbidden, broadcastSubmit: forbidden, broadcastReconcile: forbidden },
  });
  const session = await wallet.openSession({ origin: "https://wallet.test", sessionId: "account-order", execution: { hostStore: store } });
  try {
    const delivery = await session.startOperation({ id: "chain", method: "tbc_chainId" });
    assert.equal(delivery.status, "complete");
    assert.equal(delivery.completion.response.result, "tbc:testnet");
    const checkpoint = (await store.readOperation(delivery.operationId)).transition.checkpoint;
    assert.deepEqual(checkpoint.payload.session.state.activeAccountIds, accounts.map(a => a.accountId).sort());
    assert.deepEqual(accounts, before);
    assert.equal(accountReads, 1);
  } finally { await session.close(); }
});
