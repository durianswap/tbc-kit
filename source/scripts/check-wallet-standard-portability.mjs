import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { gzipSync } from "node:zlib";

import { build } from "esbuild";

import { repositoryRoot } from "./lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const sourceRoot = path.join(root, "packages", "wallet-standard", "src");
const esmEntry = path.join(
  root,
  "packages",
  "wallet-standard",
  "dist",
  "esm",
  "index.js",
);
const cjsEntry = path.join(
  root,
  "packages",
  "wallet-standard",
  "dist",
  "cjs",
  "index.cjs",
);

export const WALLET_STANDARD_PORTABILITY_LIMITS = Object.freeze({
  maxBundleBytes: 10_000,
  maxGzipBytes: 3_000,
});

export const WALLET_STANDARD_PACKAGE_LIMITS = Object.freeze({
  maxTarballBytes: 25_000,
  maxUnpackedBytes: 50_000,
});

const allowedRuntimeDependencies = Object.freeze({
    "@tbc-wallet/provider": "1.0.0-draft.6.15",
  "@wallet-standard/core": "1.1.2",
});

const expectedRuntimeExports = Object.freeze([
  "TBC_PROVIDER_FEATURE",
  "TBC_PROVIDER_FEATURE_VERSION",
  "getTbcWallets",
  "isTbcProviderFeature",
  "registerTbcWallet",
  "subscribeTbcWallets",
]);

const forbiddenRules = Object.freeze([
  Object.freeze({
    kind: "node-builtin",
    pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:node:[^"']+|(?:assert(?:\/strict)?|buffer|child_process|crypto|events|fs|http|https|net|os|path|process|stream|timers|url|util|vm|worker_threads|zlib)(?:\/[^"']*)?)["']/g,
  }),
  Object.freeze({
    kind: "runtime-boundary",
    pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["']@tbc-wallet\/(?:host|tbc-engine)(?:[\/"'])/g,
  }),
  Object.freeze({
    kind: "private-boundary",
    pattern: /wallet-vault\/1|\b(?:keyring|privateKeyWif|quickSignGrantHandle|sessionHandle|vaultHandle|vaultToken)\b/gi,
  }),
  Object.freeze({
    kind: "competing-discovery",
    pattern: /window\.Turing|\beip6963(?::[A-Za-z]+)?\b/gi,
  }),
  Object.freeze({
    kind: "wallet-persistence",
    pattern: /\b(?:indexedDB|localStorage|sessionStorage)\s*(?:\.|\[)/g,
  }),
  Object.freeze({
    kind: "wallet-ranking",
    pattern: /\b(?:autoSelect(?:ed)?|priority|rank(?:ing)?|selectedWallet)\b/gi,
  }),
  Object.freeze({
    kind: "private-registry",
    pattern: /\bnew\s+(?:Map|Set)\s*\(|wallet-standard:(?:app-ready|register-wallet)/g,
  }),
  Object.freeze({
    kind: "network-runtime",
    pattern: /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(/g,
  }),
  Object.freeze({
    kind: "dynamic-code",
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(/g,
  }),
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function listFilesRecursively(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFilesRecursively(absolute);
    return entry.isFile() ? [absolute] : [];
  }).sort(compareText);
}

export function scanForbiddenWalletStandardCapabilities(
  source,
  file = "<wallet-standard>",
) {
  const findings = [];
  for (const { kind, pattern } of forbiddenRules) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      findings.push(Object.freeze({
        file,
        kind,
        match: match[0],
        offset: match.index,
      }));
    }
  }
  return Object.freeze(findings);
}

function sourceFindings() {
  return Object.freeze(
    listFilesRecursively(sourceRoot)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        scanForbiddenWalletStandardCapabilities(
          fs.readFileSync(file, "utf8"),
          path.relative(root, file),
        ),
      ),
  );
}

function runtimeDependencies() {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(root, "packages", "wallet-standard", "package.json"),
      "utf8",
    ),
  );
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).sort(([left], [right]) =>
      compareText(left, right),
    ),
  );
  if (JSON.stringify(dependencies) !== JSON.stringify(allowedRuntimeDependencies)) {
    throw new Error("Wallet Standard runtime dependency allowlist changed");
  }
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  for (const [name, version] of Object.entries(allowedRuntimeDependencies)) {
    if (
      lock.packages?.["packages/wallet-standard"]?.dependencies?.[name] !== version
    ) {
      throw new Error(`Wallet Standard runtime dependency lock drifted: ${name}`);
    }
  }
  return Object.freeze(dependencies);
}

async function browserBundle() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["packages/wallet-standard/src/index.ts"],
    bundle: true,
    write: false,
    minify: true,
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
    platform: "browser",
    format: "iife",
    globalName: "TbcWalletStandard",
    target: "es2020",
    conditions: ["browser", "import", "default"],
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error("Wallet Standard bundle produced no output");
  const bytes = output.contents.byteLength;
  const gzipBytes = gzipSync(output.contents).byteLength;
  if (
    bytes > WALLET_STANDARD_PORTABILITY_LIMITS.maxBundleBytes ||
    gzipBytes > WALLET_STANDARD_PORTABILITY_LIMITS.maxGzipBytes
  ) {
    throw new Error("Wallet Standard bundle exceeds the portability size budget");
  }
  const inputs = Object.keys(result.metafile.inputs).sort(compareText);
  const usesOfficialRegistry = inputs.some((input) =>
    /node_modules\/@wallet-standard\/app\/.*wallets/i.test(input),
  );
  const forbiddenGraphInputs = inputs.filter((input) =>
    /(?:packages\/(?:host|tbc-engine)|wallet-vault|keyring)/i.test(input),
  );
  if (!usesOfficialRegistry || forbiddenGraphInputs.length > 0) {
    throw new Error("Wallet Standard dependency graph is not the official registry path");
  }
  return {
    source: output.text,
    usesOfficialRegistry,
    report: Object.freeze({ bytes, gzipBytes, inputs: inputs.length }),
  };
}

function smokeBrowser(source) {
  const sandbox = Object.assign(Object.create(null), {
    console: Object.freeze({ error() {} }),
    Event,
    EventTarget,
    window: new EventTarget(),
  });
  const context = vm.createContext(sandbox, {
    name: "wallet-standard-browser",
    codeGeneration: { strings: false, wasm: false },
  });
  new vm.Script(source, { filename: "wallet-standard-browser.js" }).runInContext(
    context,
    { timeout: 5_000 },
  );
  const names = vm.runInContext(
    "TbcWalletStandard.getTbcWallets().map(({ name }) => name)",
    context,
    { timeout: 1_000 },
  );
  if (JSON.stringify(names) !== "[]") {
    throw new Error("Browser Wallet Standard smoke failed");
  }
}

async function smokeSsrEsm() {
  const runtime = await import(pathToFileURL(esmEntry).href);
  return Object.keys(runtime).sort(compareText);
}

function smokeSsrCjs() {
  const require = createRequire(import.meta.url);
  const runtime = require(cjsEntry);
  return Object.keys(runtime).sort(compareText);
}

export async function checkWalletStandardPortability() {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    throw new Error("Wallet Standard portability gate requires Node.js 22 or newer");
  }
  if (!fs.existsSync(esmEntry) || !fs.existsSync(cjsEntry)) {
    throw new Error("Wallet Standard portability gate requires built artifacts");
  }
  const forbiddenSourceCapabilities = sourceFindings();
  if (forbiddenSourceCapabilities.length > 0) {
    throw new Error("Wallet Standard source contains a forbidden capability");
  }
  const browser = await browserBundle();
  smokeBrowser(browser.source);
  const esmExports = await smokeSsrEsm();
  const cjsExports = smokeSsrCjs();
  if (
    JSON.stringify(esmExports) !== JSON.stringify(expectedRuntimeExports) ||
    JSON.stringify(cjsExports) !== JSON.stringify(expectedRuntimeExports)
  ) {
    throw new Error("Wallet Standard public exports drifted");
  }
  return Object.freeze({
    status: "pass",
    nodeMajor,
    browserBundle: browser.report,
    usesOfficialRegistry: browser.usesOfficialRegistry,
    runtimeDependencies: runtimeDependencies(),
    forbiddenSourceCapabilities,
    browserSmoke: "pass",
    ssrEsmSmoke: "pass",
    ssrCjsSmoke: "pass",
  });
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const report = await checkWalletStandardPortability();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
