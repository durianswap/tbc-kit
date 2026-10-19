import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getWallets } from "@wallet-standard/core";
import {
  TBC_PROVIDER_FEATURE,
  getTbcWallets,
  isTbcProviderFeature,
  registerTbcWallet,
  subscribeTbcWallets,
} from "../dist/esm/index.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const adapterUrl = pathToFileURL(
  path.join(root, "packages/wallet-standard/dist/esm/index.js"),
).href;

class RecordingWindow extends EventTarget {
  dispatched = [];

  dispatchEvent(event) {
    this.dispatched.push(event.type);
    return super.dispatchEvent(event);
  }
}

function providerStub() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async request() {
      calls += 1;
      return null;
    },
    on() {
      calls += 1;
      return this;
    },
    removeListener() {
      calls += 1;
      return this;
    },
    async destroy() {
      calls += 1;
    },
  };
}

function wallet(name, version = "1.0.0", productId) {
  const provider = providerStub();
  return {
    wallet: Object.freeze({
      version: "1.0.0",
      name,
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      chains: Object.freeze(["tbc:mainnet"]),
      accounts: Object.freeze([]),
      features: Object.freeze({
        [TBC_PROVIDER_FEATURE]: Object.freeze({
          version,
          ...(productId === undefined ? {} : { productId }),
          provider,
        }),
      }),
    }),
    provider,
  };
}

test("filters official discovery without selection and tracks register/unregister", () => {
  const previousWindow = globalThis.window;
  const discoveryWindow = new RecordingWindow();
  globalThis.window = discoveryWindow;
  try {
    assert.deepEqual(getTbcWallets(), []);
    const observed = [];
    const unsubscribe = subscribeTbcWallets((event) => observed.push(event));

    const official = getWallets();
    const unregisterNonTbc = official.register(Object.freeze({
      version: "1.0.0",
      name: "Non TBC",
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      chains: Object.freeze(["example:1"]),
      accounts: Object.freeze([]),
      features: Object.freeze({}),
    }));
    assert.deepEqual(getTbcWallets(), []);
    assert.deepEqual(observed, []);

    const first = wallet("First");
    const second = wallet("Second", "1.12.3", "org.example.second-wallet");
    registerTbcWallet(first.wallet);
    assert.deepEqual(getTbcWallets(), [first.wallet]);
    registerTbcWallet(first.wallet);
    assert.deepEqual(getTbcWallets(), [first.wallet]);
    registerTbcWallet(second.wallet);
    assert.deepEqual(getTbcWallets(), [first.wallet, second.wallet]);
    assert.equal(first.provider.calls, 0);
    assert.equal(second.provider.calls, 0);

    const removable = wallet("Removable");
    const unregisterRemovable = official.register(removable.wallet);
    assert.deepEqual(getTbcWallets(), [
      first.wallet,
      second.wallet,
      removable.wallet,
    ]);
    unregisterRemovable();
    assert.deepEqual(getTbcWallets(), [first.wallet, second.wallet]);

    assert.deepEqual(
      observed.map(({ type, wallets }) => [
        type,
        wallets.map(({ name }) => name),
      ]),
      [
        ["register", ["First"]],
        ["register", ["Second"]],
        ["register", ["Removable"]],
        ["unregister", ["Removable"]],
      ],
    );
    assert.equal(Object.isFrozen(observed[0]), true);
    assert.equal(Object.isFrozen(observed[0].wallets), true);
    unsubscribe();
    unregisterNonTbc();

    assert.equal("Turing" in discoveryWindow, false);
    assert.equal(
      discoveryWindow.dispatched.some((name) => name.startsWith("eip6963:")),
      false,
    );
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("rejects malformed features and incompatible semantic versions", () => {
  const valid = wallet("Valid", "1.0.0", "org.example.valid-wallet").wallet.features[TBC_PROVIDER_FEATURE];
  assert.equal(isTbcProviderFeature(valid), true);
  for (const feature of [
    null,
    {},
    { version: "2.0.0", provider: valid.provider },
    { version: "1.01.0", provider: valid.provider },
    { version: "1.0", provider: valid.provider },
    { version: "1.0.0" },
    { version: "1.0.0", provider: { request() {} } },
    { version: "1.0.0", productId: "Example Wallet", provider: valid.provider },
    { version: "1.0.0", productId: "", provider: valid.provider },
  ]) {
    assert.equal(isTbcProviderFeature(feature), false);
  }
});

test("supports wallet-before-DApp load order and SSR import through official APIs", () => {
  const earlyLoad = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import assert from "node:assert/strict";
        globalThis.window = new EventTarget();
        const adapter = await import(${JSON.stringify(adapterUrl)});
        const provider = {
          request: async () => null,
          on() { return this; },
          removeListener() { return this; },
          destroy: async () => undefined
        };
        const wallet = Object.freeze({
          version: "1.0.0",
          name: "Early",
          icon: "data:image/svg+xml;base64,PHN2Zy8+",
          chains: Object.freeze(["tbc:mainnet"]),
          accounts: Object.freeze([]),
          features: Object.freeze({
            "tbc:provider": Object.freeze({ version: "1.0.0", provider })
          })
        });
        adapter.registerTbcWallet(wallet);
        assert.deepEqual(adapter.getTbcWallets().map(({ name }) => name), ["Early"]);
      `,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(earlyLoad.status, 0, `${earlyLoad.stdout}\n${earlyLoad.stderr}`);

  const ssr = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `delete globalThis.window; await import(${JSON.stringify(adapterUrl)});`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(ssr.status, 0, `${ssr.stdout}\n${ssr.stderr}`);
});
