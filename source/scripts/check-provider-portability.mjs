import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { gzipSync } from "node:zlib";

import { build } from "esbuild";

import { repositoryRoot } from "./lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const sourceRoot = path.join(root, "packages", "provider", "src");
const esmEntry = path.join(root, "packages", "provider", "dist", "esm", "index.js");
const cjsEntry = path.join(root, "packages", "provider", "dist", "cjs", "index.cjs");
const webviewEsmEntry = path.join(root, "packages", "provider", "dist", "esm", "webview.js");
const webviewCjsEntry = path.join(root, "packages", "provider", "dist", "cjs", "webview.cjs");

export const PROVIDER_PORTABILITY_LIMITS = Object.freeze({
  // Current dependency-inclusive baseline, user-approved 2026-10-21.
  // Includes Prepared, reviewed/crypto, batch-send and WebView validation.
  maxBundleBytes: 2_361_000,
  maxGzipBytes: 234_000,
  maxInMemoryBundleBytes: 8_000,
  maxInMemoryGzipBytes: 2_500,
  // The standalone WebView entry carries the exact generated Provider
  // validators so native decoding cannot resolve a different package copy.
  // ESM artifact: 778,979 / 79,827 bytes, same approved baseline.
  maxWebViewArtifactBytes: 780_000,
  maxWebViewArtifactGzipBytes: 81_000,
});

export const PROVIDER_PACKAGE_LIMITS = Object.freeze({
  // Includes source maps for both strict-validator-bearing WebView formats.
  maxTarballBytes: 770_000,
  maxUnpackedBytes: 6_800_000,
});

const expectedRuntimeExports = Object.freeze([
  "ProviderRpcError",
  "TBC_PROVIDER_EVENTS",
  "TBC_PROVIDER_MAX_MESSAGE_BYTES",
  "TBC_PROVIDER_METHODS",
  "TbcProviderValidationError",
  "assertTbcProviderEvent",
  "assertTbcProviderMethodParams",
  "assertTbcProviderMethodResult",
  "assertTbcProviderRequest",
  "assertTbcProviderResponse",
  "assertTbcTransportDelivery",
  "canonicalTbcMessageBytes",
  "createTbcProvider",
]);

const expectedWebViewRuntimeExports = Object.freeze([
  "TBC_WEBVIEW_CHANNEL",
  "TBC_WEBVIEW_MAX_MESSAGE_BYTES",
  "TbcWebViewValidationError",
  "createTbcWebViewNativeController",
  "createTbcWebViewPageTransport",
  "decodeTbcWebViewNativeMessage",
  "decodeTbcWebViewPageMessage",
  "digestTbcWebViewEnvelope",
  "encodeTbcWebViewNativeMessage",
  "encodeTbcWebViewPageMessage",
]);

const allowedRuntimeDependencies = Object.freeze({
  "@tbc-wallet/core": "1.0.0-draft.6.10",
});

const forbiddenRules = Object.freeze([
  Object.freeze({
    kind: "node-builtin",
    pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:node:[^"']+|(?:assert(?:\/strict)?|buffer|child_process|crypto|events|fs|http|https|net|os|path|perf_hooks|process|stream|timers|tls|url|util|vm|worker_threads|zlib)(?:\/[^"']*)?)["']/g,
  }),
  Object.freeze({
    kind: "platform-global",
    pattern: /\b(?:globalThis\.)?(?:AsyncStorage|ReactNativeWebView|SQLite|SecureStore|browser|chrome|document|indexedDB|localStorage|navigator|sessionStorage|window)\s*(?:\.|\[)/g,
  }),
  Object.freeze({
    kind: "network-runtime",
    pattern: /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(/g,
  }),
  Object.freeze({
    kind: "ambient-timer",
    pattern: /\b(?:queueMicrotask|requestAnimationFrame|setImmediate|setInterval|setTimeout)\s*\(/g,
  }),
  Object.freeze({
    kind: "dynamic-code",
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(/g,
  }),
  Object.freeze({
    kind: "ui-runtime",
    pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:react|react-dom|react-native|react-native-webview)(?:[\/"'])/g,
  }),
  Object.freeze({
    kind: "platform-adapter",
    pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:expo(?:-[^"']+|\/[^"']*)?|react-native-webview)["']/g,
  }),
  Object.freeze({
    kind: "runtime-boundary",
    pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["']@tbc-wallet\/(?:host|tbc-engine|wallet-standard)(?:[\/"'])/g,
  }),
  Object.freeze({
    kind: "private-boundary",
    pattern: /wallet-vault\/1|\b(?:keyring|privateKeyWif|quickSignGrantHandle|sessionHandle|vaultHandle|vaultToken)\b/gi,
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

export function scanForbiddenProviderCapabilities(
  source,
  file = "<provider-root>",
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
        scanForbiddenProviderCapabilities(
          fs.readFileSync(file, "utf8"),
          path.relative(root, file),
        ),
      ),
  );
}

function runtimeDependencies() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "packages", "provider", "package.json"), "utf8"),
  );
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).sort(([left], [right]) =>
      compareText(left, right),
    ),
  );
  if (JSON.stringify(dependencies) !== JSON.stringify(allowedRuntimeDependencies)) {
    throw new Error("Provider runtime dependency allowlist changed");
  }
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  if (
    lock.packages?.["packages/provider"]?.dependencies?.["@tbc-wallet/core"] !==
    allowedRuntimeDependencies["@tbc-wallet/core"]
  ) {
    throw new Error("Provider runtime dependency lock drifted");
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
  const forbidden = scanForbiddenProviderCapabilities(
    output.text,
    `${name}.bundle.js`,
  );
  const graphInputs = Object.keys(result.metafile.inputs).sort(compareText);
  const forbiddenGraphInputs = graphInputs.filter((input) =>
    /(?:^|\/)(?:react|react-dom|react-native|react-native-webview|expo|chrome|webextension-polyfill|ethers|web3|axios)(?:\/|$)/i.test(input) ||
    /(?:packages\/(?:host|tbc-engine|wallet-standard)|wallet-vault|keyring)/i.test(input),
  );
  const bytes = output.contents.byteLength;
  const gzipBytes = gzipSync(output.contents).byteLength;
  if (
    bytes > PROVIDER_PORTABILITY_LIMITS.maxBundleBytes ||
    gzipBytes > PROVIDER_PORTABILITY_LIMITS.maxGzipBytes
  ) {
    throw new Error(`${name} Provider bundle exceeds the portability size budget: ${bytes} bytes / ${gzipBytes} gzip`);
  }
  if (forbidden.length > 0 || forbiddenGraphInputs.length > 0) {
    throw new Error(`${name} Provider bundle contains a forbidden runtime capability`);
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

async function bundleInMemory() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["packages/provider/src/in-memory.ts"],
    bundle: true,
    write: false,
    minify: true,
    legalComments: "none",
    logLevel: "silent",
    platform: "neutral",
    format: "esm",
    target: "es2020",
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error("in-memory bundle produced no output");
  const bytes = output.contents.byteLength;
  const gzipBytes = gzipSync(output.contents).byteLength;
  if (
    bytes > PROVIDER_PORTABILITY_LIMITS.maxInMemoryBundleBytes ||
    gzipBytes > PROVIDER_PORTABILITY_LIMITS.maxInMemoryGzipBytes
  ) {
    throw new Error("in-memory Provider bundle exceeds its size budget");
  }
  return Object.freeze({ bytes, gzipBytes });
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
    throw new Error(`${label} Provider bundle failed to load: ${error.message}`);
  }
  const surface = vm.runInContext(
    `(() => {
      const transport = {
        send() { return Promise.reject(new Error("unused")); },
        subscribe() { return () => undefined; }
      };
      const provider = TwsProvider.createTbcProvider({ transport });
      return [
        typeof provider.request,
        typeof provider.on,
        typeof provider.removeListener,
        typeof provider.destroy
      ];
    })()`,
    context,
    { timeout: 1_000 },
  );
  if (JSON.stringify(surface) !== JSON.stringify(["function", "function", "function", "function"])) {
    throw new Error(`${label} Provider public surface drifted`);
  }
}

function smokeWebViewIife(source, label) {
  const context = vm.createContext(Object.create(null), {
    name: label,
    codeGeneration: { strings: false, wasm: false },
  });
  try {
    new vm.Script(source, { filename: `${label}.js` }).runInContext(context, {
      timeout: 5_000,
    });
  } catch (error) {
    throw new Error(`${label} WebView bundle failed to load: ${error.message}`);
  }
  const surface = vm.runInContext(
    "[typeof TwsWebView.createTbcWebViewPageTransport, typeof TwsWebView.createTbcWebViewNativeController, TwsWebView.TBC_WEBVIEW_CHANNEL]",
    context,
    { timeout: 1_000 },
  );
  if (JSON.stringify(surface) !== JSON.stringify(["function", "function", "tws-webview/1"])) {
    throw new Error(`${label} WebView public surface drifted`);
  }
}

async function smokeNodeEsm(source) {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  const runtime = await import(`data:text/javascript;base64,${encoded}`);
  return Object.keys(runtime).sort(compareText);
}

function smokeNodeCjs() {
  const require = createRequire(import.meta.url);
  const runtime = require(cjsEntry);
  return Object.keys(runtime).sort(compareText);
}

function smokeWebViewNodeCjs() {
  const require = createRequire(import.meta.url);
  return Object.keys(require(webviewCjsEntry)).sort(compareText);
}

function webviewArtifactReport() {
  const source = fs.readFileSync(webviewEsmEntry);
  const bytes = source.byteLength;
  const gzipBytes = gzipSync(source).byteLength;
  if (
    bytes > PROVIDER_PORTABILITY_LIMITS.maxWebViewArtifactBytes ||
    gzipBytes > PROVIDER_PORTABILITY_LIMITS.maxWebViewArtifactGzipBytes
  ) {
    throw new Error("WebView Provider artifact exceeds its standalone size budget");
  }
  return Object.freeze({ bytes, gzipBytes });
}

export async function checkProviderPortability() {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new Error("Provider portability gate requires Node.js 20 or newer");
  }
  if (
    !fs.existsSync(esmEntry) ||
    !fs.existsSync(cjsEntry) ||
    !fs.existsSync(webviewEsmEntry) ||
    !fs.existsSync(webviewCjsEntry)
  ) {
    throw new Error("Provider portability gate requires built ESM and CJS artifacts");
  }
  const forbiddenSourceCapabilities = sourceFindings();
  if (forbiddenSourceCapabilities.length > 0) {
    throw new Error("Provider source contains a forbidden runtime capability");
  }
  const [browser, worker, mv3, reactNative, nodeEsm, inMemory, webviewBrowser, webviewWorker, webviewMv3, webviewReactNative, webviewNodeEsm] = await Promise.all([
    bundleVariant("browser", "packages/provider/src/index.ts", {
      platform: "browser",
      format: "iife",
      globalName: "TwsProvider",
      target: "es2020",
      conditions: ["browser", "import", "default"],
    }),
    bundleVariant("worker", "packages/provider/src/index.ts", {
      platform: "browser",
      format: "iife",
      globalName: "TwsProvider",
      target: "es2020",
      conditions: ["worker", "browser", "import", "default"],
    }),
    bundleVariant("mv3", "packages/provider/src/index.ts", {
      platform: "browser",
      format: "iife",
      globalName: "TwsProvider",
      target: "es2020",
      conditions: ["browser", "import", "default"],
    }),
    bundleVariant("react-native", "packages/provider/src/index.ts", {
      platform: "neutral",
      format: "iife",
      globalName: "TwsProvider",
      target: "es2020",
      conditions: ["react-native", "import", "default"],
      mainFields: ["react-native", "module", "main"],
    }),
    bundleVariant("node-esm", "packages/provider/src/index.ts", {
      platform: "neutral",
      format: "esm",
      target: "es2022",
      conditions: ["import", "default"],
    }),
    bundleInMemory(),
    bundleVariant("webview-browser", "packages/provider/src/webview.ts", {
      platform: "browser",
      format: "iife",
      globalName: "TwsWebView",
      target: "es2020",
      conditions: ["browser", "import", "default"],
    }),
    bundleVariant("webview-worker", "packages/provider/src/webview.ts", {
      platform: "browser",
      format: "iife",
      globalName: "TwsWebView",
      target: "es2020",
      conditions: ["worker", "browser", "import", "default"],
    }),
    bundleVariant("webview-mv3", "packages/provider/src/webview.ts", {
      platform: "browser",
      format: "iife",
      globalName: "TwsWebView",
      target: "es2020",
      conditions: ["browser", "import", "default"],
    }),
    bundleVariant("webview-react-native", "packages/provider/src/webview.ts", {
      platform: "neutral",
      format: "iife",
      globalName: "TwsWebView",
      target: "es2020",
      conditions: ["react-native", "import", "default"],
      mainFields: ["react-native", "module", "main"],
    }),
    bundleVariant("webview-node-esm", "packages/provider/src/webview.ts", {
      platform: "neutral",
      format: "esm",
      target: "es2022",
      conditions: ["import", "default"],
    }),
  ]);
  smokeIife(browser.source, "browser-no-ambient-state");
  smokeIife(worker.source, "worker-no-dom");
  smokeIife(mv3.source, "mv3-csp");
  smokeIife(reactNative.source, "react-native-hermes-compatible");
  smokeWebViewIife(webviewBrowser.source, "webview-browser-string-channel");
  smokeWebViewIife(webviewWorker.source, "webview-worker-no-dom");
  smokeWebViewIife(webviewMv3.source, "webview-mv3-csp");
  smokeWebViewIife(webviewReactNative.source, "webview-react-native-hermes-compatible");
  const esmExports = await smokeNodeEsm(nodeEsm.source);
  const cjsExports = smokeNodeCjs();
  const webviewEsmExports = await smokeNodeEsm(webviewNodeEsm.source);
  const webviewCjsExports = smokeWebViewNodeCjs();
  if (
    JSON.stringify(esmExports) !== JSON.stringify(expectedRuntimeExports) ||
    JSON.stringify(cjsExports) !== JSON.stringify(expectedRuntimeExports)
  ) {
    throw new Error("Node Provider public exports drifted");
  }
  if (
    JSON.stringify(webviewEsmExports) !== JSON.stringify(expectedWebViewRuntimeExports) ||
    JSON.stringify(webviewCjsExports) !== JSON.stringify(expectedWebViewRuntimeExports)
  ) {
    throw new Error("Node WebView Provider public exports drifted");
  }
  return Object.freeze({
    status: "pass",
    nodeMajor,
    bundles: Object.freeze({
      browser: browser.report,
      worker: worker.report,
      mv3: mv3.report,
      reactNative: reactNative.report,
      nodeEsm: nodeEsm.report,
      inMemory,
    }),
    webviewBundles: Object.freeze({
      browser: webviewBrowser.report,
      worker: webviewWorker.report,
      mv3: webviewMv3.report,
      reactNative: webviewReactNative.report,
      nodeEsm: webviewNodeEsm.report,
    }),
    webviewArtifact: webviewArtifactReport(),
    runtimeDependencies: runtimeDependencies(),
    publicRuntimeExports: expectedRuntimeExports,
    forbiddenSourceCapabilities,
    browserSmoke: "pass",
    workerSmoke: "pass",
    mv3CspSmoke: "pass",
    reactNativeSmoke: "pass",
    nodeEsmSmoke: "pass",
    nodeCjsSmoke: "pass",
    webviewBrowserSmoke: "pass",
    webviewWorkerSmoke: "pass",
    webviewMv3CspSmoke: "pass",
    webviewReactNativeSmoke: "pass",
    webviewNodeEsmSmoke: "pass",
    webviewNodeCjsSmoke: "pass",
  });
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const report = await checkProviderPortability();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
