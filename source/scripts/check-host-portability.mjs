import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { repositoryRoot } from "./lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const hostSourceRoot = path.join(root, "packages", "host", "src");
const hostEsmEntry = path.join(root, "packages", "host", "dist", "esm", "index.js");
const hostCjsEntry = path.join(root, "packages", "host", "dist", "cjs", "index.cjs");
const sqliteEsmEntry = path.join(root, "packages", "host", "dist", "esm", "sqlite.js");
const sqliteCjsEntry = path.join(root, "packages", "host", "dist", "cjs", "sqlite.cjs");
const expectedDriverMethods = Object.freeze([
  "cancelOperation",
  "inspectOperation",
  "recoverPendingOperations",
  "resumeOperation",
  "startOperation",
]);

export const HOST_PORTABILITY_LIMITS = Object.freeze({
  // Candidate189 measured dependency-inclusive baseline, user-approved 2026-09-26.
  // Keep the same bundle graph and all capability checks; do not exclude Core.
  maxBundleBytes: 1_132_000,
  maxGzipBytes: 115_000,
});

const allowedRuntimeDependencies = Object.freeze({
  "@tbc-wallet/core": "1.0.0-draft.6.10",
});

const commonForbiddenRules = Object.freeze([
  Object.freeze({
    kind: "node-builtin",
    pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:node:[^"']+|(?:assert(?:\/strict)?|buffer|child_process|crypto|events|fs|http|https|net|os|path|perf_hooks|process|stream|timers|tls|url|util|vm|worker_threads|zlib)(?:\/[^"']*)?)["']/g,
  }),
  Object.freeze({
    kind: "network-runtime",
    pattern: /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(/g,
  }),
  Object.freeze({
    kind: "ui-runtime",
    pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:react|react-dom|react-native)(?:[\/"'])/g,
  }),
  Object.freeze({
    kind: "platform-adapter",
    pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:expo(?:-[^"']+|\/[^"']*)?|react-native-quick-sqlite)["']/g,
  }),
  Object.freeze({
    kind: "dynamic-code",
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(/g,
  }),
  Object.freeze({
    kind: "ambient-timer",
    pattern: /\b(?:queueMicrotask|requestAnimationFrame|setImmediate|setInterval|setTimeout)\s*\(/g,
  }),
  Object.freeze({
    kind: "private-boundary",
    pattern: /wallet-vault\/1|\b(?:keyring|privateKeyWif|quickSignGrantHandle|sessionHandle|vaultHandle|vaultToken)\b/gi,
  }),
]);

const rootPlatformRule = Object.freeze({
  kind: "root-platform-global",
  pattern: /\b(?:globalThis\.)?(?:browser|chrome|document|indexedDB|localStorage|navigator|sessionStorage|window)\s*(?:\.|\[)/g,
});

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

function scanRules(source, file, rules) {
  const findings = [];
  for (const { kind, pattern } of rules) {
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
  return findings;
}

export function scanForbiddenHostCapabilities(source, file = "<host-root>") {
  return Object.freeze(
    scanRules(source, file, [...commonForbiddenRules, rootPlatformRule]),
  );
}

function sourceFindings() {
  const all = listFilesRecursively(hostSourceRoot).filter((file) => file.endsWith(".ts"));
  const rootFiles = all.filter(
    (file) => !["indexeddb.ts", "indexeddb-store.ts"].includes(path.basename(file)),
  );
  const common = all.flatMap((file) =>
    scanRules(
      fs.readFileSync(file, "utf8"),
      path.relative(root, file),
      commonForbiddenRules,
    ),
  );
  const rootPlatform = rootFiles.flatMap((file) =>
    scanRules(
      fs.readFileSync(file, "utf8"),
      path.relative(root, file),
      [rootPlatformRule],
    ),
  );
  return Object.freeze([...common, ...rootPlatform]);
}

function runtimeDependencies() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "packages", "host", "package.json"), "utf8"),
  );
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).sort(([left], [right]) =>
      compareText(left, right),
    ),
  );
  if (JSON.stringify(dependencies) !== JSON.stringify(allowedRuntimeDependencies)) {
    throw new Error("Host runtime dependency allowlist changed");
  }
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  if (
    lock.packages?.["packages/host"]?.dependencies?.["@tbc-wallet/core"] !==
    allowedRuntimeDependencies["@tbc-wallet/core"]
  ) {
    throw new Error("Host runtime dependency lock drifted");
  }
  return Object.freeze(dependencies);
}

async function bundleVariant(name, entryPoint, options) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    minify: true,
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
    ...options,
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error(`${name} bundle produced no output`);
  const forbidden = scanForbiddenHostCapabilities(output.text, `${name}.bundle.js`);
  const graphInputs = Object.keys(result.metafile.inputs).sort(compareText);
  const forbiddenGraphInputs = graphInputs.filter((input) =>
    /(?:^|\/)(?:react|react-dom|react-native|expo|expo-sqlite|react-native-quick-sqlite|chrome|webextension-polyfill|ethers|web3|axios)(?:\/|$)/i.test(input) ||
    /wallet-vault|keyring/i.test(input),
  );
  const bytes = output.contents.byteLength;
  const gzipBytes = gzipSync(output.contents).byteLength;
  if (
    bytes > HOST_PORTABILITY_LIMITS.maxBundleBytes ||
    gzipBytes > HOST_PORTABILITY_LIMITS.maxGzipBytes
  ) {
    throw new Error(`${name} Host bundle exceeds the portability size budget`);
  }
  if (forbidden.length > 0 || forbiddenGraphInputs.length > 0) {
    throw new Error(`${name} Host bundle contains a forbidden runtime capability`);
  }
  return {
    source: output.text,
    report: Object.freeze({
      bytes,
      gzipBytes,
      inputs: graphInputs.length,
      forbiddenCapabilities: forbidden,
    }),
  };
}

function smokeIife(source, label) {
  const context = vm.createContext(Object.create(null), {
    name: label,
    codeGeneration: { strings: false, wasm: false },
  });
  try {
    new vm.Script(source, { filename: `${label}.js` }).runInContext(context, {
      timeout: 5_000,
    });
  } catch (error) {
    throw new Error(`${label} Host bundle failed to load: ${error.message}`);
  }
  const methods = vm.runInContext("[...TwsHost.TWS_HOST_DRIVER_METHODS]", context, {
    timeout: 1_000,
  });
  if (JSON.stringify(methods) !== JSON.stringify(expectedDriverMethods)) {
    throw new Error(`${label} Host public driver surface drifted`);
  }
}

function smokeSqliteIife(source, label) {
  const context = vm.createContext(Object.create(null), {
    name: label,
    codeGeneration: { strings: false, wasm: false },
  });
  try {
    new vm.Script(source, { filename: `${label}.js` }).runInContext(context, {
      timeout: 5_000,
    });
  } catch (error) {
    throw new Error(`${label} SQLite Host bundle failed to load: ${error.message}`);
  }
  const surface = vm.runInContext(
    "[typeof TwsHost.createSqliteTwsHostStore, TwsHost.TWS_HOST_SQLITE_SCHEMA_VERSION]",
    context,
    { timeout: 1_000 },
  );
  if (JSON.stringify(surface) !== JSON.stringify(["function", 1])) {
    throw new Error(`${label} SQLite Host public surface drifted`);
  }
}

async function smokeNodeEsm(source) {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  const runtime = await import(`data:text/javascript;base64,${encoded}`);
  return [...runtime.TWS_HOST_DRIVER_METHODS].sort(compareText);
}

async function smokeSqliteNodeEsm(source) {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  const runtime = await import(`data:text/javascript;base64,${encoded}`);
  return [typeof runtime.createSqliteTwsHostStore, runtime.TWS_HOST_SQLITE_SCHEMA_VERSION];
}

function smokeNodeCjs() {
  const require = createRequire(import.meta.url);
  const runtime = require(hostCjsEntry);
  return [...runtime.TWS_HOST_DRIVER_METHODS].sort(compareText);
}

function smokeSqliteNodeCjs() {
  const require = createRequire(import.meta.url);
  const runtime = require(sqliteCjsEntry);
  return [typeof runtime.createSqliteTwsHostStore, runtime.TWS_HOST_SQLITE_SCHEMA_VERSION];
}

export async function checkHostPortability() {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new Error("Host portability gate requires Node.js 20 or newer");
  }
  if (
    !fs.existsSync(hostEsmEntry) ||
    !fs.existsSync(hostCjsEntry) ||
    !fs.existsSync(sqliteEsmEntry) ||
    !fs.existsSync(sqliteCjsEntry)
  ) {
    throw new Error("Host portability gate requires built ESM and CJS artifacts");
  }
  const forbiddenRootCapabilities = sourceFindings();
  if (forbiddenRootCapabilities.length > 0) {
    throw new Error("Host source contains a forbidden runtime capability");
  }
  const [browser, worker, reactNative, nodeEsm, sqliteBrowser, sqliteWorker, sqliteReactNative, sqliteNodeEsm] = await Promise.all([
    bundleVariant("browser", "packages/host/src/index.ts", {
      platform: "browser",
      format: "iife",
      globalName: "TwsHost",
      target: "es2020",
      conditions: ["browser", "import", "default"],
    }),
    bundleVariant("worker", "packages/host/src/index.ts", {
      platform: "browser",
      format: "iife",
      globalName: "TwsHost",
      target: "es2020",
      conditions: ["worker", "browser", "import", "default"],
    }),
    bundleVariant("react-native", "packages/host/src/index.ts", {
      platform: "neutral",
      format: "iife",
      globalName: "TwsHost",
      target: "es2020",
      conditions: ["react-native", "import", "default"],
      mainFields: ["react-native", "module", "main"],
    }),
    bundleVariant("node-esm", "packages/host/src/index.ts", {
      platform: "neutral",
      format: "esm",
      target: "es2022",
      conditions: ["import", "default"],
    }),
    bundleVariant("sqlite-browser", "packages/host/src/sqlite.ts", {
      platform: "browser",
      format: "iife",
      globalName: "TwsHost",
      target: "es2020",
      conditions: ["browser", "import", "default"],
    }),
    bundleVariant("sqlite-worker", "packages/host/src/sqlite.ts", {
      platform: "browser",
      format: "iife",
      globalName: "TwsHost",
      target: "es2020",
      conditions: ["worker", "browser", "import", "default"],
    }),
    bundleVariant("sqlite-react-native", "packages/host/src/sqlite.ts", {
      platform: "neutral",
      format: "iife",
      globalName: "TwsHost",
      target: "es2020",
      conditions: ["react-native", "import", "default"],
      mainFields: ["react-native", "module", "main"],
    }),
    bundleVariant("sqlite-node-esm", "packages/host/src/sqlite.ts", {
      platform: "neutral",
      format: "esm",
      target: "es2022",
      conditions: ["import", "default"],
    }),
  ]);
  smokeIife(browser.source, "browser-no-ambient-storage");
  smokeIife(worker.source, "worker-no-dom");
  smokeIife(reactNative.source, "react-native-hermes-compatible");
  smokeSqliteIife(sqliteBrowser.source, "sqlite-browser-no-ambient-database");
  smokeSqliteIife(sqliteWorker.source, "sqlite-worker-no-ambient-database");
  smokeSqliteIife(sqliteReactNative.source, "sqlite-react-native-hermes-compatible");
  const esmMethods = await smokeNodeEsm(nodeEsm.source);
  const cjsMethods = smokeNodeCjs();
  const sqliteEsmSurface = await smokeSqliteNodeEsm(sqliteNodeEsm.source);
  const sqliteCjsSurface = smokeSqliteNodeCjs();
  if (
    JSON.stringify(esmMethods) !== JSON.stringify(expectedDriverMethods) ||
    JSON.stringify(cjsMethods) !== JSON.stringify(expectedDriverMethods)
  ) {
    throw new Error("Node Host public driver surface drifted");
  }
  if (
    JSON.stringify(sqliteEsmSurface) !== JSON.stringify(["function", 1]) ||
    JSON.stringify(sqliteCjsSurface) !== JSON.stringify(["function", 1])
  ) {
    throw new Error("Node SQLite Host public surface drifted");
  }
  return Object.freeze({
    status: "pass",
    nodeMajor,
    bundles: Object.freeze({
      browser: browser.report,
      worker: worker.report,
      reactNative: reactNative.report,
      nodeEsm: nodeEsm.report,
    }),
    sqliteBundles: Object.freeze({
      browser: sqliteBrowser.report,
      worker: sqliteWorker.report,
      reactNative: sqliteReactNative.report,
      nodeEsm: sqliteNodeEsm.report,
    }),
    runtimeDependencies: runtimeDependencies(),
    publicDriverMethods: Object.freeze(esmMethods),
    forbiddenRootCapabilities,
    browserSmoke: "pass",
    workerSmoke: "pass",
    reactNativeSmoke: "pass",
    nodeEsmSmoke: "pass",
    nodeCjsSmoke: "pass",
    sqliteBrowserSmoke: "pass",
    sqliteWorkerSmoke: "pass",
    sqliteReactNativeSmoke: "pass",
    sqliteNodeEsmSmoke: "pass",
    sqliteNodeCjsSmoke: "pass",
  });
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const report = await checkHostPortability();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
