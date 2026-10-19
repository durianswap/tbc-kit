import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { createWasmTbcEngineBackend } from "../dist/esm/wasm.js";

const require = createRequire(import.meta.url);
const packageDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceDirectory = path.join(packageDirectory, "src");
const entryPoint = path.join(sourceDirectory, "index.ts");
const actualOutputs = [
  path.join(packageDirectory, "dist/esm/index.js"),
  path.join(packageDirectory, "dist/cjs/index.cjs"),
];
const fixture = JSON.parse(readFileSync(new URL("../rust/fixtures/tbc-transfer.json", import.meta.url), "utf8"));
const canonical = {
  ...fixture.finalizeInput,
  signature: fixture.finalizeInput.signatures[0],
  bundle: fixture.finalized.bundle,
};
// A platform supplies a backend. Use the actual locked WASM, never a mock or
// the browser-only lazy fetch loader for a Node file URL.
const backend = await createWasmTbcEngineBackend(
  readFileSync(new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url)),
);
const FORBIDDEN_CAPABILITIES = Object.freeze([
  ["Node builtin", /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](?:node:|fs(?:["'/])|path(?:["'/])|crypto(?:["'/])|buffer(?:["'/])|child_process(?:["'/]))/],
  ["network API", /\b(?:fetch|WebSocket|XMLHttpRequest|EventSource|sendBeacon)\s*(?:\.|\()/],
  ["storage API", /\b(?:indexedDB|localStorage|sessionStorage|chrome\.storage)\b/],
  ["UI runtime", /(?:\b(?:document|window)\.|(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']react(?:-native)?(?:["'/]))/i],
  ["ambient timer", /\b(?:setTimeout|setInterval|requestAnimationFrame)\s*\(/],
  ["dynamic code", /(?:\beval\s*\(|\bnew\s+Function\s*\()/],
  ["private Vault protocol", /wallet-vault\/1/i],
  ["legacy transaction library", /(?:tbc-lib-js|bitcoinjs|@?open(?:tbc|bsv)|bsv\/)/i],
  ["copied third-party notice", /(?:copyright\s*\(c\)|all rights reserved|non-?commercial|no derivatives)/i],
]);
const OWNER_FORBIDDEN_CAPABILITIES = Object.freeze([
  ["ambient Node/crypto global", /(?:\bprocess(?:\.|\[)|\bBuffer(?:\.|\[|\()|globalThis\.crypto|crypto\.getRandomValues)/],
  ["signing or key-generation API", /(?:secp256k1|ed25519)\.(?:sign|signAsync)\s*\(|(?:randomPrivateKey|randomSecretKey|privateKeyTo)\s*\(/],
]);

let temporaryDirectory;
let outputs;
let bundleMetafiles;

function sourceFiles(directory) {
  return readdirSync(directory)
    .flatMap((entry) => {
      const absolute = path.join(directory, entry);
      return statSync(absolute).isDirectory() ? sourceFiles(absolute) : [absolute];
    })
    .filter((file) => file.endsWith(".ts"));
}

function assertNoForbiddenCapabilities(source, label, ownerSource = false) {
  const rules = ownerSource
    ? [...FORBIDDEN_CAPABILITIES, ...OWNER_FORBIDDEN_CAPABILITIES]
    : FORBIDDEN_CAPABILITIES;
  for (const [capability, pattern] of rules) {
    assert.doesNotMatch(source, pattern, `${capability} found in ${label}`);
  }
}

async function exercise(runtime, vector = canonical) {
  const engine = runtime.createTbcTransferEngine({ backend });
  const normalized = await engine.normalizeRequest({
    version: "1.0",
    request: vector.request,
  });
  assert.equal(normalized.requestHash, vector.requestHash);
  const planned = await engine.plan({
    version: "1.0",
    request: normalized.request,
    requestHash: normalized.requestHash,
    snapshot: vector.snapshot,
    policy: vector.policy,
  });
  assert.equal(planned.plan.planHash, vector.plan.planHash);
  assert.deepEqual(
    await engine.validate({
      version: "1.0",
      phase: "plan",
      request: normalized.request,
      requestHash: normalized.requestHash,
      snapshot: vector.snapshot,
      policy: vector.policy,
      plan: planned.plan,
    }),
    { valid: true, violations: [] },
  );
  const finalized = await engine.finalize({
    version: "1.0",
    request: normalized.request,
    requestHash: normalized.requestHash,
    snapshot: vector.snapshot,
    policy: vector.policy,
    plan: planned.plan,
    binding: vector.binding,
    approval: vector.approval,
    signatures: [vector.signature],
  });
  assert.equal(finalized.bundle.transactions[0].txid, vector.bundle.transactions[0].txid);
  assert.equal(
    finalized.bundle.transactions[0].rawTransaction,
    vector.bundle.transactions[0].rawTransaction,
  );
}

before(async () => {
  temporaryDirectory = mkdtempSync(path.join(tmpdir(), "tbc-engine-portability-"));
  outputs = {
    esm: path.join(temporaryDirectory, "engine.mjs"),
    cjs: path.join(temporaryDirectory, "engine.cjs"),
    neutralEs2020: path.join(temporaryDirectory, "engine.neutral-es2020.js"),
  };
  const builds = await Promise.all([
    build({
      entryPoints: [entryPoint],
      outfile: outputs.esm,
      bundle: true,
      platform: "neutral",
      format: "esm",
      target: "es2022",
      legalComments: "none",
      minifyWhitespace: true,
      metafile: true,
    }),
    build({
      entryPoints: [entryPoint],
      outfile: outputs.cjs,
      bundle: true,
      platform: "neutral",
      format: "cjs",
      target: "es2022",
      legalComments: "none",
      minifyWhitespace: true,
      metafile: true,
    }),
    build({
      entryPoints: [entryPoint],
      outfile: outputs.neutralEs2020,
      bundle: true,
      platform: "neutral",
      format: "iife",
      globalName: "TbcEngineRuntime",
      target: "es2020",
      legalComments: "none",
      minifyWhitespace: true,
      metafile: true,
    }),
  ]);
  bundleMetafiles = builds.map(({ metafile }) => metafile);
});

after(() => {
  if (temporaryDirectory !== undefined) rmSync(temporaryDirectory, { recursive: true });
});

test("source and dependency boundary contain no Host, UI, Vault, or copied legacy implementation", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    "@noble/curves",
    "@noble/hashes",
    "@tbc-wallet/core",
  ]);

  for (const file of sourceFiles(sourceDirectory)) {
    assertNoForbiddenCapabilities(
      readFileSync(file, "utf8"),
      path.relative(packageDirectory, file),
      true,
    );
  }
});

test("the shared capability denylist rejects every forbidden category", () => {
  const probes = [
    ['import fs from "node:fs";', false],
    ["fetch('https://node.invalid')", false],
    ["localStorage.setItem('key', 'value')", false],
    ["document.createElement('div')", false],
    ["setTimeout(() => undefined, 1)", false],
    ["globalThis.crypto.getRandomValues(bytes)", true],
    ["secp256k1.sign(digest, privateKey)", true],
    ["eval('1 + 1')", false],
    ['const protocol = "wallet-vault/1"', false],
    ['import legacy from "tbc-lib-js"', false],
    ["Copyright (c) Legacy Vendor. All rights reserved.", false],
  ];
  for (const [source, ownerSource] of probes) {
    assert.throws(
      () => assertNoForbiddenCapabilities(source, "probe.ts", ownerSource),
      source,
    );
  }
});

test("standalone ESM and CommonJS bundles execute without Node ambient globals", async () => {
  const saved = Object.fromEntries(
    ["Buffer", "process", "crypto"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const savedAt = {
    array: Object.getOwnPropertyDescriptor(Array.prototype, "at"),
    bytes: Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(Uint8Array.prototype),
      "at",
    ),
  };
  try {
    for (const name of Object.keys(saved)) Reflect.deleteProperty(globalThis, name);
    Reflect.deleteProperty(Array.prototype, "at");
    Reflect.deleteProperty(Object.getPrototypeOf(Uint8Array.prototype), "at");
    const esm = await import(pathToFileURL(outputs.esm).href);
    const cjs = require(outputs.cjs);
    await exercise(esm);
    await exercise(cjs);
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
    }
    if (savedAt.array !== undefined) {
      Object.defineProperty(Array.prototype, "at", savedAt.array);
    }
    if (savedAt.bytes !== undefined) {
      Object.defineProperty(
        Object.getPrototypeOf(Uint8Array.prototype),
        "at",
        savedAt.bytes,
      );
    }
  }
});

test("one neutral ES2020 browser/Hermes facade executes all four phases with an injected Rust backend", async () => {
  const source = readFileSync(outputs.neutralEs2020, "utf8");
  const sandbox = vm.createContext({ vectorJson: JSON.stringify(canonical), backend });
  const originalGlobals = Reflect.ownKeys(sandbox);
  vm.runInContext(source, sandbox, { timeout: 5_000 });
  vm.runInContext(
    "delete Array.prototype.at; delete Object.getPrototypeOf(Uint8Array.prototype).at",
    sandbox,
  );
  assert.equal("Buffer" in sandbox, false);
  assert.equal("process" in sandbox, false);
  assert.equal("crypto" in sandbox, false);
  assert.equal("fetch" in sandbox, false);
  assert.deepEqual(
    Reflect.ownKeys(sandbox).filter((key) => !originalGlobals.includes(key)),
    ["TbcEngineRuntime"],
  );
  const result = await vm.runInContext(`
    (async () => {
      const vector = JSON.parse(vectorJson);
      const engine = TbcEngineRuntime.createTbcTransferEngine({ backend });
      const normalized = await engine.normalizeRequest({ version: "1.0", request: vector.request });
      const planned = await engine.plan({
        version: "1.0",
        request: normalized.request,
        requestHash: normalized.requestHash,
        snapshot: vector.snapshot,
        policy: vector.policy,
      });
      const validation = await engine.validate({
        version: "1.0",
        phase: "plan",
        request: normalized.request,
        requestHash: normalized.requestHash,
        snapshot: vector.snapshot,
        policy: vector.policy,
        plan: planned.plan,
      });
      const finalized = await engine.finalize({
        version: "1.0",
        request: normalized.request,
        requestHash: normalized.requestHash,
        snapshot: vector.snapshot,
        policy: vector.policy,
        plan: planned.plan,
        binding: vector.binding,
        approval: vector.approval,
        signatures: [vector.signature],
      });
      return {
        valid: validation.valid,
        txid: finalized.bundle.transactions[0].txid,
        methods: Object.keys(engine).sort().join(","),
      };
    })()
  `, sandbox, { timeout: 5_000 });
  assert.equal(result.valid, true);
  assert.equal(result.txid, canonical.bundle.transactions[0].txid);
  assert.equal(result.methods, "finalize,normalizeRequest,plan,validate");
});

test("published React Native export executes without ES2022 Array.at built-ins", async () => {
  const manifest = JSON.parse(
    readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
  );
  const reactNativeEntry = path.join(
    packageDirectory,
    manifest.exports["."]["react-native"],
  );
  const arrayAt = Object.getOwnPropertyDescriptor(Array.prototype, "at");
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const bytesAt = Object.getOwnPropertyDescriptor(typedArrayPrototype, "at");
  try {
    Reflect.deleteProperty(Array.prototype, "at");
    Reflect.deleteProperty(typedArrayPrototype, "at");
    const runtime = await import(
      `${pathToFileURL(reactNativeEntry).href}?react-native-smoke=${Date.now()}`
    );
    await exercise(runtime);
  } finally {
    if (arrayAt !== undefined) Object.defineProperty(Array.prototype, "at", arrayAt);
    if (bytesAt !== undefined) Object.defineProperty(typedArrayPrototype, "at", bytesAt);
  }
});

test("source and actual dist deny capabilities while audited bundles have an exact graph", () => {
  for (const output of Object.values(outputs)) {
    assertNoForbiddenCapabilities(readFileSync(output, "utf8"), path.basename(output));
  }
  for (const output of actualOutputs) {
    assertNoForbiddenCapabilities(
      readFileSync(output, "utf8"),
      path.basename(output),
      true,
    );
  }
  for (const metafile of bundleMetafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      assert.match(
        input,
        /(?:packages\/(?:tbc-engine|core)\/|node_modules\/@noble\/(?:curves|hashes)\/)/,
        `unexpected bundled dependency: ${input}`,
      );
    }
    for (const output of Object.values(metafile.outputs)) {
      assert.deepEqual(output.imports, []);
    }
  }
});
