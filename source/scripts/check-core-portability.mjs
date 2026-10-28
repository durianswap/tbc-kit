import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { repositoryRoot } from "./lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const coreSourceRoot = path.join(root, "packages", "core", "src");

export const PORTABILITY_LIMITS = Object.freeze({
  // rc.11 adds NFT multi-contract/100-item validation, not a runtime exclusion.
  // Measured source delta and strict bounds: ft-nft-rc11/evidence/size-source-comparison.json.
  maxBundleBytes: 1_757_000,
  maxGzipBytes: 197_000,
});

const ALLOWED_RUNTIME_DEPENDENCIES = Object.freeze({
  "@noble/curves": "1.9.7",
  "@noble/hashes": "1.8.0",
});

const FORBIDDEN_RULES = Object.freeze([
  Object.freeze({
    kind: "node-builtin",
    pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:node:[^"']+|(?:assert(?:\/strict)?|buffer|child_process|crypto|events|fs|http|https|net|os|path|perf_hooks|process|stream|timers|tls|url|util|vm|worker_threads|zlib)(?:\/[^"']*)?)["']/g,
  }),
  Object.freeze({
    kind: "platform-global",
    pattern: /\b(?:globalThis\.)?(?:browser|chrome|document|indexedDB|localStorage|navigator|sessionStorage|window)\s*(?:\.|\[)/g,
  }),
  Object.freeze({
    kind: "ui-runtime",
    pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:react|react-dom|react-native)(?:[\/"'])/g,
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
    kind: "private-boundary",
    pattern: /wallet-vault\/1|\b(?:apiKey|authorizationHeader|privateKeyWif|quickSignGrantHandle|rpcUrl|sessionHandle|vaultHandle|vaultToken)\b/g,
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

export function scanForbiddenRuntimeCapabilities(source, file = "<runtime>") {
  const findings = [];
  for (const { kind, pattern } of FORBIDDEN_RULES) {
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
    listFilesRecursively(coreSourceRoot)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        scanForbiddenRuntimeCapabilities(
          fs.readFileSync(file, "utf8"),
          path.relative(root, file),
        ),
      ),
  );
}

function runtimeDependencies() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "packages", "core", "package.json"), "utf8"),
  );
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).sort(([left], [right]) =>
      compareText(left, right),
    ),
  );
  if (JSON.stringify(dependencies) !== JSON.stringify(ALLOWED_RUNTIME_DEPENDENCIES)) {
    throw new Error("Core runtime dependency allowlist changed");
  }
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  for (const [name, version] of Object.entries(ALLOWED_RUNTIME_DEPENDENCIES)) {
    if (lock.packages?.[`node_modules/${name}`]?.version !== version) {
      throw new Error(`Core runtime dependency lock drifted: ${name}`);
    }
  }
  return Object.freeze(dependencies);
}

async function bundleVariant(name, options) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["packages/core/src/index.ts"],
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
  const source = output.text;
  const forbiddenCapabilities = scanForbiddenRuntimeCapabilities(
    source,
    `${name}.bundle.js`,
  );
  const graphInputs = Object.keys(result.metafile.inputs).sort(compareText);
  const forbiddenGraphInputs = graphInputs.filter((input) =>
    /(?:^|\/)(?:react|react-dom|react-native|chrome|webextension-polyfill|ethers|web3|axios)(?:\/|$)/i.test(input) ||
    /wallet-vault/i.test(input),
  );
  const bytes = output.contents.byteLength;
  const gzipBytes = gzipSync(output.contents).byteLength;
  if (
    bytes > PORTABILITY_LIMITS.maxBundleBytes ||
    gzipBytes > PORTABILITY_LIMITS.maxGzipBytes
  ) {
    throw new Error(`${name} bundle exceeds the frozen portability size budget: ${bytes} bytes / ${gzipBytes} gzip`);
  }
  if (forbiddenCapabilities.length > 0 || forbiddenGraphInputs.length > 0) {
    throw new Error(`${name} bundle contains a forbidden runtime capability`);
  }
  return {
    source,
    report: Object.freeze({
      bytes,
      gzipBytes,
      inputs: graphInputs.length,
      forbiddenCapabilities,
    }),
  };
}

function smokeIife(source, label) {
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    name: label,
    codeGeneration: { strings: false, wasm: false },
  });
  try {
    new vm.Script(source, { filename: `${label}.js` }).runInContext(context, {
      timeout: 5_000,
    });
  } catch (error) {
    throw new Error(`${label} bundle failed to load: ${error.message}`);
  }
  const api = context.TwsCore;
  const digest = vm.runInContext(
    "TwsCore.hashCanonical({ portable: true })",
    context,
    { timeout: 1_000 },
  );
  if (
    api === undefined ||
    digest !==
      "fc0604e8e78d6f23ee2e3e1866f5d81d23be9f66eb0531249be72abd2f1562bc"
  ) {
    throw new Error(`${label} smoke execution failed`);
  }
  return api;
}

async function smokeNodeEsm(source) {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  const module = await import(`data:text/javascript;base64,${encoded}`);
  const core = module.createTwsCore();
  return Object.keys(core).sort(compareText);
}

export async function checkCorePortability() {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new Error("Core portability gate requires Node.js 20 or newer");
  }
  const forbiddenSourceCapabilities = sourceFindings();
  if (forbiddenSourceCapabilities.length > 0) {
    throw new Error("Core source contains a forbidden runtime capability");
  }
  const [mv3, neutral, hermes] = await Promise.all([
    bundleVariant("mv3", {
      platform: "browser",
      format: "iife",
      globalName: "TwsCore",
      target: "es2020",
      conditions: ["browser", "import", "default"],
    }),
    bundleVariant("neutral", {
      platform: "neutral",
      format: "esm",
      target: "es2022",
      conditions: ["import", "default"],
    }),
    bundleVariant("hermes", {
      platform: "neutral",
      format: "iife",
      globalName: "TwsCore",
      target: "es2020",
      conditions: ["react-native", "import", "default"],
      mainFields: ["react-native", "module", "main"],
    }),
  ]);
  smokeIife(mv3.source, "mv3-csp");
  smokeIife(hermes.source, "hermes-compatible");
  const publicCoreMethods = await smokeNodeEsm(neutral.source);
  if (
    JSON.stringify(publicCoreMethods) !==
    JSON.stringify(["acknowledgeCommit", "cancel", "resume", "start"])
  ) {
    throw new Error("portable Core public method surface drifted");
  }
  return Object.freeze({
    status: "pass",
    nodeMajor,
    bundles: Object.freeze({
      mv3: mv3.report,
      neutral: neutral.report,
      hermes: hermes.report,
    }),
    runtimeDependencies: runtimeDependencies(),
    publicCoreMethods: Object.freeze(publicCoreMethods),
    forbiddenSourceCapabilities,
    mv3CspSmoke: "pass",
    hermesSmoke: "pass",
    nodeEsmSmoke: "pass",
  });
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const report = await checkCorePortability();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
