import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { getWallets } from "@wallet-standard/core";
import { fileURLToPath } from "node:url";

import {
  TBC_PROVIDER_FEATURE,
  TBC_PROVIDER_FEATURE_VERSION,
  getTbcWallets,
  isTbcProviderFeature,
  registerTbcWallet,
  subscribeTbcWallets,
} from "../dist/esm/index.js";
import * as nativeKit from "../dist/esm/index.native.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function staticModuleClosure(entry) {
  const pending = [entry];
  const visited = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const source = await readFile(path, "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+["'](\.\/[^"']+)["']/gu),
      ...source.matchAll(/^\s*import\s+["'](\.\/[^"']+)["']/gmu),
    ].map((match) => match[1]);
    for (const specifier of specifiers) pending.push(resolve(dirname(path), specifier));
  }
  return visited;
}

function providerStub() {
  return {
    async request() {
      return null;
    },
    on() {
      return this;
    },
    removeListener() {
      return this;
    },
    async destroy() {},
  };
}

function wallet(name) {
  return Object.freeze({
    version: "1.0.0",
    name,
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains: Object.freeze(["tbc:testnet"]),
    accounts: Object.freeze([]),
    features: Object.freeze({
      [TBC_PROVIDER_FEATURE]: Object.freeze({
        version: TBC_PROVIDER_FEATURE_VERSION,
        provider: providerStub(),
      }),
    }),
  });
}

test("root browser surface delegates registration and discovery to the official registry", () => {
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const observed = [];
  const unsubscribe = subscribeTbcWallets((change) => observed.push(change));
  const registered = wallet("Kit Wallet Standard Closure");
  try {
    registerTbcWallet(registered);
    assert.equal(getTbcWallets().includes(registered), true);
    assert.equal(isTbcProviderFeature(registered.features[TBC_PROVIDER_FEATURE]), true);
    assert.deepEqual(
      observed.map(({ type, wallets }) => [type, wallets.map(({ name }) => name)]),
      [["register", ["Kit Wallet Standard Closure"]]],
    );
    assert.equal(Object.isFrozen(observed[0]), true);
    assert.equal(Object.isFrozen(observed[0].wallets), true);
  } finally {
    unsubscribe();
    const official = getWallets();
    for (const candidate of official.get()) {
      if (candidate === registered) {
        const unregister = official.register(candidate);
        unregister();
      }
    }
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("root feature guard rejects malformed metadata without invoking a Provider", () => {
  const provider = providerStub();
  assert.equal(isTbcProviderFeature({ version: "1.0.0", provider }), true);
  assert.equal(isTbcProviderFeature({ version: "2.0.0", provider }), false);
  assert.equal(
    isTbcProviderFeature({
      version: "1.0.0",
      productId: "Invalid Product",
      provider,
    }),
    false,
  );
  assert.throws(() => registerTbcWallet({}), /compatible tbc:provider/u);
  assert.throws(() => subscribeTbcWallets(null), /listener must be a function/u);
});

test("react-native surface has the same names but no browser registry", () => {
  const registered = wallet("Native No-op Wallet");
  nativeKit.registerTbcWallet(registered);
  assert.deepEqual(nativeKit.getTbcWallets(), []);
  assert.equal(
    nativeKit.isTbcProviderFeature(registered.features[TBC_PROVIDER_FEATURE]),
    true,
  );
  const unsubscribe = nativeKit.subscribeTbcWallets(() => {
    throw new Error("native subscription must not emit browser discovery");
  });
  unsubscribe();
});

test("browser root discovery has no static transaction Engine or WASM edge", async () => {
  const closure = await staticModuleClosure(resolve(packageRoot, "dist/esm/index.js"));
  const source = (await Promise.all([...closure].map((path) => readFile(path, "utf8")))).join("\n");
  assert.doesNotMatch(source, /tbc_engine_wasm\.wasm/u);
  assert.doesNotMatch(source, /createInternalLazyWasmBackend/u);
  assert.doesNotMatch(source, /new URL\(["'][^"']+\.wasm["'],\s*import\.meta\.url\)/u);
});
