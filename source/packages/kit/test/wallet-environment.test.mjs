import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { discoverySession } from "./fixtures/discovery-session.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const esmWallet = resolve(packageRoot, "dist/esm/wallet.js");
const cjsWallet = resolve(packageRoot, "dist/cjs/wallet.cjs");

function minimalOptions() {
  const account = Object.freeze({
    accountId: "tbc:testnet:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
    address: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
    chainId: "tbc:testnet",
    publicKey: "02".padEnd(66, "0"),
  });
  const forbidden = async () => {
    throw new Error("unexpected Port call");
  };
  return {
    accounts: { current: async () => [account] },
    approval: { request: forbidden },
    signer: { sign: forbidden },
    storage: {
      loadPermissions: forbidden,
      commitPermissions: forbidden,
    },
    network: {
      resolveChainData: forbidden,
      resolvePolicy: forbidden,
      broadcastSubmit: forbidden,
      broadcastReconcile: forbidden,
    },
  };
}

test("production wallet artifacts defer the DOM-only Wallet Standard module", async () => {
  const [esm, cjs] = await Promise.all([
    readFile(esmWallet, "utf8"),
    readFile(cjsWallet, "utf8"),
  ]);
  assert.doesNotMatch(esm, /from\s+["']@wallet-standard\/core["']/u);
  assert.doesNotMatch(cjs, /require\(["']@wallet-standard\/core["']\)/u);
  assert.match(esm, /import\(["']@wallet-standard\/core["']\)/u);
  assert.doesNotMatch(esm, /\btypeof Event\b/u);
  assert.match(esm, /Reflect\.get\(globalThis,\s*["']Event["']\)/u);
});

test("wallet loads and opens a session when Event, window, and document are absent", () => {
  const script = `
    delete globalThis.Event;
    delete globalThis.window;
    delete globalThis.document;
    const { createTbcWallet } = await import(${JSON.stringify(pathToFileURL(esmWallet).href)});
    const forbidden = async () => { throw new Error("unexpected Port call"); };
    const runtime = createTbcWallet({
      accounts: { current: async () => [{
        accountId: "tbc:test:rn-account",
        address: "rn-account",
        chainId: "tbc:test",
        publicKey: "${"02".padEnd(66, "0")}",
      }] },
      approval: { request: forbidden },
      signer: { sign: forbidden },
      storage: { loadPermissions: forbidden, commitPermissions: forbidden },
      network: {
        resolveChainData: forbidden,
        resolvePolicy: forbidden,
        broadcastSubmit: forbidden,
        broadcastReconcile: forbidden,
      },
    });
    const session = await runtime.openSession({
      origin: "https://rn.tbc-kit.invalid",
      sessionId: "rn-session",
    });
    session.close();
    let explicitRequired = false;
    try { await runtime.register(); } catch (e) { explicitRequired = /platform-authorized session/.test(e.message); }
    if (!explicitRequired) throw new Error("Missing discovery authority accepted");
    console.log(JSON.stringify({ loaded: true, opened: true, registrationWithoutAuthority: "rejected" }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    loaded: true,
    opened: true,
    registrationWithoutAuthority: "rejected",
  });
});

test("wallet session startup warms the shared network capability once", async () => {
  const { createTbcWallet } = await import("../dist/esm/wallet.js");
  let warmups = 0;
  const runtime = createTbcWallet({
    ...minimalOptions(),
    network: {
      ...minimalOptions().network,
      async warmup() {
        warmups += 1;
      },
    },
  });
  const first = await runtime.openSession({
    origin: "https://warmup.tbc-kit.invalid",
    sessionId: "warmup-session-a",
  });
  first.close();
  const second = await runtime.openSession({
    origin: "https://warmup.tbc-kit.invalid",
    sessionId: "warmup-session-b",
  });
  second.close();
  assert.equal(warmups, 2, "each session starts the wallet-owned warmup hook");
});

test("browser register still emits a Wallet Standard registration event", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const browserWindow = new EventTarget();
  let registered;
  browserWindow.addEventListener("wallet-standard:register-wallet", (event) => {
    event.detail({ register: (wallet) => { registered = wallet; } });
  });
  globalThis.window = browserWindow;
  globalThis.document = {};
  try {
    const { createTbcWallet } = await import("../dist/esm/wallet.js");
    const runtime = createTbcWallet({
      ...minimalOptions(),
      productId: "org.example.browser-wallet",
      name: "Example Browser Wallet",
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
    });
    const session = await discoverySession(runtime, { account: (await minimalOptions().accounts.current())[0] });
    await runtime.register(session);
    const direct = await runtime.standardWallet(session);
    assert.equal(registered.name, "Example Browser Wallet");
    assert.equal(registered.icon, "data:image/svg+xml;base64,PHN2Zy8+");
    assert.equal(registered.features["tbc:provider"].version, "1.0.0");
    assert.equal(registered.features["tbc:provider"].productId, "org.example.browser-wallet");
    assert.equal(direct.productId, "org.example.browser-wallet");
    assert.equal(direct.name, registered.name);
    assert.equal(direct.icon, registered.icon);
    assert.equal(direct.provider, registered.features["tbc:provider"].provider);
    session.close();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("wallet productId is independent from the private authority profile", async () => {
  const { createTbcWallet } = await import("../dist/esm/wallet.js");
  const first = createTbcWallet({
    ...minimalOptions(),
    productId: "org.example.shared-product",
    profile: "authority-profile-a",
  });
  const second = createTbcWallet({
    ...minimalOptions(),
    productId: "org.example.shared-product",
    profile: "authority-profile-b",
  });
  const account = (await minimalOptions().accounts.current())[0];
  const firstSession = await discoverySession(first, { account, profile: "authority-profile-a" });
  const secondSession = await discoverySession(second, { account, profile: "authority-profile-b" });
  assert.equal((await first.standardWallet(firstSession)).productId, "org.example.shared-product");
  assert.equal((await second.standardWallet(secondSession)).productId, "org.example.shared-product");
  firstSession.close(); secondSession.close();
  await assert.rejects(
    async () => createTbcWallet({ ...minimalOptions(), productId: "Example Wallet" }),
    /productId/,
  );
});

test("wallet bootstrap configures the SHA-256 backend inside the Kit bundle", () => {
  for (const format of ["esm", "cjs"]) {
    const walletPath = format === "esm" ? esmWallet : cjsWallet;
    const sqlitePath = resolve(packageRoot, `dist/${format}/sqlite.${format === "esm" ? "js" : "cjs"}`);
    const load = format === "esm"
      ? `
        const { configureTbcKitSha256Backend, createTbcWallet } =
          await import(${JSON.stringify(pathToFileURL(walletPath).href)});
        const { createTbcKitMemoryHostStore } =
          await import(${JSON.stringify(pathToFileURL(sqlitePath).href)});
      `
      : `
        const { createRequire } = await import("node:module");
        const require = createRequire(import.meta.url);
        const { configureTbcKitSha256Backend, createTbcWallet } =
          require(${JSON.stringify(walletPath)});
        const { createTbcKitMemoryHostStore } =
          require(${JSON.stringify(sqlitePath)});
      `;
    const script = `
      import { sha256 } from "@noble/hashes/sha256";
      import { configureSha256Backend } from "@tbc-wallet/core";
      ${load}
    let rejectedShortDigest = false;
    let rejectedMutatingStoreBackend = false;
    try {
      configureTbcKitSha256Backend(() => new Uint8Array(31));
    } catch (error) {
      rejectedShortDigest = error instanceof TypeError;
    }
    try {
      createTbcKitMemoryHostStore({
        sha256(input) {
          const digest = sha256(input);
          if (input.length > 0) input[0] ^= 1;
          return digest;
        },
      });
    } catch (error) {
      rejectedMutatingStoreBackend = error instanceof TypeError;
    }
    const forbidden = async () => { throw new Error("unexpected Port call"); };
    const options = (profile, hostStore) => ({
      profile,
      accounts: { current: async () => [{
        accountId: "tbc:testnet:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
        address: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
        chainId: "tbc:testnet",
        publicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      }] },
      approval: { request: forbidden },
      signer: { sign: forbidden },
      storage: {
        ...(hostStore === undefined ? {} : { hostStore }),
        loadPermissions: async () => ({ revision: "0", permissions: [] }),
        commitPermissions: forbidden,
      },
      network: {
        resolveChainData: forbidden,
        resolvePolicy: forbidden,
        broadcastSubmit: forbidden,
        broadcastReconcile: forbidden,
      },
      clock: () => "2026-09-17T00:00:00Z",
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
    });
    let externalCalls = 0;
    let kitCalls = 0;
    configureSha256Backend((input) => {
      externalCalls += 1;
      return sha256(input);
    });
    externalCalls = 0;
    const first = createTbcWallet(options("hash-external-only-${format}"));
    const firstSession = await first.openSession({
      origin: "https://hash-external-only-${format}.tbc-kit.invalid",
      sessionId: "hash-external-only-${format}",
    });
    await firstSession.handleRequest({ id: "hash-external-only-${format}", method: "tbc_getCapabilities" });
    firstSession.close();
    configureTbcKitSha256Backend((input) => {
      kitCalls += 1;
      return sha256(input);
    });
    kitCalls = 0;
    const second = createTbcWallet(options("hash-kit-configured-${format}"));
    const secondSession = await second.openSession({
      origin: "https://hash-kit-configured-${format}.tbc-kit.invalid",
      sessionId: "hash-kit-configured-${format}",
    });
    await secondSession.handleRequest({ id: "hash-kit-configured-${format}", method: "tbc_getCapabilities" });
    secondSession.close();
    const walletConfiguredCalls = kitCalls;
    let storeCalls = 0;
    const hostStore = createTbcKitMemoryHostStore({
      sha256(input) {
        storeCalls += 1;
        return sha256(input);
      },
    });
    kitCalls = 0;
    storeCalls = 0;
    const third = createTbcWallet(options("hash-store-configured-${format}", hostStore));
    const thirdSession = await third.openSession({
      origin: "https://hash-store-configured-${format}.tbc-kit.invalid",
      sessionId: "hash-store-configured-${format}",
    });
    await thirdSession.handleRequest({ id: "hash-store-configured-${format}", method: "tbc_getCapabilities" });
    thirdSession.close();
    configureTbcKitSha256Backend(undefined);
    configureSha256Backend(undefined);
    console.log(JSON.stringify({
      externalCalls,
      kitCalls,
      rejectedMutatingStoreBackend,
      rejectedShortDigest,
      storeCalls,
      walletConfiguredCalls,
    }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.externalCalls, 0, `${format}: external Core configuration must not masquerade as Kit configuration`);
    assert.ok(observed.walletConfiguredCalls > 0, `${format}: Kit Core hashing must use the wallet-configured backend`);
    assert.equal(observed.kitCalls, 0, `${format}: SQLite configuration must replace the same shared Kit Core backend`);
    assert.ok(observed.storeCalls > 0, `${format}: a store from the SQLite entry must configure the shared Kit Core backend`);
    assert.equal(observed.rejectedShortDigest, true, `${format}: invalid wallet backend must fail bootstrap`);
    assert.equal(observed.rejectedMutatingStoreBackend, true, `${format}: mutating store backend must fail bootstrap vectors`);
  }
});
