import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standardRoot = resolve(packageRoot, "../..");
const environmentEntry = resolve(packageRoot, "src/runtime-environment.ts");
const nativeRootEntry = resolve(packageRoot, "dist/esm/index.native.js");
const hermesCandidates = [
  process.env.TBC_HERMES_BIN,
  resolve(
    standardRoot,
    "native/flutter/build-tools/react-native-source/sdks/hermesc/osx-bin/hermes",
  ),
].filter((value) => typeof value === "string");
const hermes = hermesCandidates.find(existsSync);

test("react-native direct root import does not evaluate Wallet Standard DOM packages", async () => {
  const emitted = await readFile(nativeRootEntry, "utf8");
  assert.doesNotMatch(emitted, /@wallet-standard\/(?:core|app|wallet)/u);
  assert.doesNotMatch(emitted, /\bextends\s+Event\b/u);
  const script = `
    delete globalThis.Event;
    delete globalThis.window;
    delete globalThis.document;
    const kit = await import("@tbc/kit");
    const walletKit = await import("@tbc/kit/wallet");
    if (typeof kit.createTbcProvider !== "function") throw new Error("missing Provider factory");
    if (typeof kit.createTbcClient !== "function") throw new Error("missing client factory");
    if (typeof walletKit.verifyTbcRecoverableSignature !== "function") {
      throw new Error("missing wallet recoverable-signature verifier");
    }
    const client = kit.createTbcClient({
      network: "testnet",
      provider: { request: async () => [] },
    });
    if (client.wallets().length !== 0) throw new Error("native discovery must be empty");
    const provider = {
      request: async () => null,
      on() { return this; },
      removeListener() { return this; },
      destroy: async () => undefined,
    };
    const wallet = Object.freeze({
      version: "1.0.0",
      name: "Hermes Native No-op",
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      chains: Object.freeze(["tbc:testnet"]),
      accounts: Object.freeze([]),
      features: Object.freeze({
        [kit.TBC_PROVIDER_FEATURE]: Object.freeze({
          version: kit.TBC_PROVIDER_FEATURE_VERSION,
          provider,
        }),
      }),
    });
    kit.registerTbcWallet(wallet);
    if (kit.getTbcWallets().length !== 0) throw new Error("native registry must remain empty");
    if (!kit.isTbcProviderFeature(wallet.features[kit.TBC_PROVIDER_FEATURE])) {
      throw new Error("native feature guard rejected a valid provider");
    }
    kit.subscribeTbcWallets(() => { throw new Error("native registry emitted"); })();
    console.log("RN_ROOT_IMPORT_OK");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-native", "--input-type=module", "--eval", script],
    { cwd: packageRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RN_ROOT_IMPORT_OK/u);
});

test(
  "React Native wallet environment feature test imports and runs without a global Event binding in Hermes",
  { skip: hermes === undefined ? "Hermes runtime is unavailable" : false },
  async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "tbc-kit-hermes-wallet-"));
    const entry = resolve(directory, "entry.mjs");
    const bundle = resolve(directory, "bundle.js");
    await writeFile(
      entry,
      `
        import { hasBrowserWalletStandardEnvironment } from ${JSON.stringify(environmentEntry)};
        if (hasBrowserWalletStandardEnvironment()) {
          throw new Error("Hermes unexpectedly reported a browser environment");
        }
        print("HERMES_WALLET_ENVIRONMENT_NOOP_OK");
      `,
    );
    try {
      await build({
        entryPoints: [entry],
        outfile: bundle,
        bundle: true,
        format: "iife",
        platform: "neutral",
        target: "es2020",
        logLevel: "silent",
      });
      const result = spawnSync(hermes, [bundle], {
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /HERMES_WALLET_ENVIRONMENT_NOOP_OK/u);
      assert.doesNotMatch(result.stderr, /Property 'Event' doesn't exist/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
