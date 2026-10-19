#!/usr/bin/env node
/**
 * Offline, read-only upstream parity oracle for the pure TBC20 Code/Tape codec.
 * Requires an explicitly supplied, already available upstream checkout and
 * dependency installation. No npm install, network, private keys or signing.
 *
 * node packages/tbc-engine/scripts/check-tbc20-upstream-codec.mjs \
 *   --upstream /path/to/tbc-contract --dependencies /path/to/package-with-deps
 *
 * Default: reproduce and compare the committed fixture, without writing files.
 * --emit-fixture: print a replacement fixture to stdout for reviewed application.
 * Upstream TypeScript is transpiled in memory; nothing is compiled onto disk.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const UPSTREAM_COMMIT = "af77616121db340e15bb8b73c197bc2f8d1ee986";
const UPSTREAM_HASHES = Object.freeze({
  "package.json": "03622bd9640146bef3def2534890600d995f629d33580ec4433b725388ccb00f",
  "lib/contract/tbc20.ts": "402b1cf1de1a284c902daf78e20e66bc36f66a2bb87180052c47328032468c2a",
  "lib/util/tbc20/tbc20unlock.ts": "0798c21eae4c76f2657a30428205fed783e2975ae28ccf3c938230090a6e404b",
});
const LIB_TREE_HASH = "b73c8b5996276584981fe5b14f04db3e4cce02c94e7a19cb2b0f64e37206c7e9";
const fixturePath = fileURLToPath(new URL("../rust/fixtures/tbc20-standard-codec.json", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function argumentsOf(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--emit-fixture") options.emit = true;
    else if (flag === "--upstream" || flag === "--dependencies") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires an explicit local path`);
      options[flag.slice(2)] = path.resolve(value);
    } else throw new Error(`Unknown argument ${flag}`);
  }
  if (!options.upstream || !options.dependencies) {
    throw new Error("Required: --upstream <fixed tbc-contract checkout> --dependencies <package directory with tbc-lib-js 1.0.31 and TypeScript installed>; this tool never downloads dependencies");
  }
  return options;
}

function packageTreeHash(root) {
  const files = [];
  function walk(relative) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) files.push(name);
      else throw new Error(`Unexpected non-file package member: ${name}`);
    }
  }
  walk("");
  files.sort();
  const manifest = files.map((name) => `${name.split(path.sep).join("/")}\0${sha256(readFileSync(path.join(root, name)))}\n`).join("");
  return { files: files.length, sha256: sha256(manifest) };
}

const options = argumentsOf(process.argv.slice(2));
const upstream = options.upstream;
const actualCommit = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(actualCommit, UPSTREAM_COMMIT, "Upstream Git commit differs from the frozen oracle");
for (const [relative, expected] of Object.entries(UPSTREAM_HASHES)) {
  assert.equal(sha256(readFileSync(path.join(upstream, relative))), expected, `Upstream source changed: ${relative}`);
}
assert.equal(JSON.parse(readFileSync(path.join(upstream, "package.json"), "utf8")).version, "1.7.0");
const dependencies = createRequire(path.join(options.dependencies, "package.json"));
const libPackagePath = dependencies.resolve("tbc-lib-js/package.json");
const libRoot = path.dirname(libPackagePath);
assert.equal(JSON.parse(readFileSync(libPackagePath, "utf8")).version, "1.0.31", "tbc-lib-js must be exactly 1.0.31");
const libTree = packageTreeHash(libRoot);
assert.equal(libTree.sha256, LIB_TREE_HASH, "tbc-lib-js package bytes differ from the fixed codec oracle");
const ts = dependencies("typescript");
assert.equal(ts.version, "5.9.2", "TypeScript must be exactly 5.9.2 for the fixed in-memory transpilation oracle");
const consumedSources = new Set();
const upstreamUrl = pathToFileURL(`${upstream}${path.sep}`).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "tbc-lib-js" || specifier.startsWith("tbc-lib-js/")) {
      return { url: pathToFileURL(dependencies.resolve(specifier)).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(upstreamUrl) && url.endsWith(".js")) {
      const sourcePath = fileURLToPath(url).replace(/\.js$/u, ".ts");
      const relative = path.relative(upstream, sourcePath).split(path.sep).join("/");
      if (!existsSync(sourcePath) || !Object.hasOwn(UPSTREAM_HASHES, relative)) {
        throw new Error(`Unpinned upstream executable dependency: ${relative}`);
      }
      const source = readFileSync(sourcePath, "utf8");
      assert.equal(sha256(source), UPSTREAM_HASHES[relative], `Changed source: ${relative}`);
      consumedSources.add(relative);
      return {
        format: "commonjs",
        source: ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText,
        shortCircuit: true,
      };
    }
    return next(url, context);
  },
});

const upstreamRequire = createRequire(path.join(upstream, "package.json"));
const { TBC20 } = upstreamRequire("./lib/contract/tbc20.js");
const { getTBC20CodeIdentity, getTBC20Controller } = upstreamRequire("./lib/util/tbc20/tbc20unlock.js");
hooks.deregister();
assert.deepEqual([...consumedSources].sort(), ["lib/contract/tbc20.ts", "lib/util/tbc20/tbc20unlock.ts"]);

// Public synthetic values only. No keys, accounts or live assets are used.
const originalUTXO = { txId: "0123456789abcdef".repeat(4), outputIndex: 3 };
const addressController = `${"11".repeat(20)}00`;
const max = TBC20.maxSlotAmount;
const zero = Array(6).fill(0n);
const metadataDefinition = { name: "Codec Test", symbol: "CODEC", supply: "123.456", decimal: 3 };
const definitions = [
  { id: "six-distinct-slots-minimum-tape", amounts: [1n, 2n, 3n, 4n, 5n, 6n] },
  { id: "contract-controller-01", controllerHex: `${"22".repeat(20)}01` },
  { id: "contract-controller-ff", controllerHex: `${"33".repeat(20)}ff` },
  { id: "different-original-outpoint", originalUTXO: { txId: "fedcba9876543210".repeat(4), outputIndex: 0xffffffff } },
  { id: "maximum-relay-tape-127", extensionHex: `41${"ab".repeat(65)}09` },
  { id: "single-slot-maximum", amounts: [max, ...zero.slice(1)] },
  { id: "six-maximum-slots-total-exceeds-slot-and-u64", amounts: Array(6).fill(max) },
  { id: "canonical-display-metadata", extensionHex: TBC20.buildMetadataExtension(metadataDefinition).toString("hex"), metadataDefinition },
  { id: "zero-balance-tape", amounts: zero },
];
const vectors = definitions.map((definition) => {
  const original = TBC20.encodeOriginalUTXO(definition.originalUTXO ?? originalUTXO);
  const controllerHex = definition.controllerHex ?? addressController;
  const extensionHex = definition.extensionHex ?? "09";
  const tapeSize = 60 + extensionHex.length / 2;
  const amounts = definition.amounts ?? [1n, ...zero.slice(1)];
  const code = TBC20.instantiateCode({ originalUTXO: original, tapeSize, controller: controllerHex });
  const tape = TBC20.buildTape(amounts, tapeSize, extensionHex);
  const parsed = TBC20.parseTape(tape);
  assert.equal(getTBC20Controller(code).toString("hex"), controllerHex);
  const replaced = TBC20.replaceController(code, addressController);
  assert.equal(getTBC20CodeIdentity(replaced).toString("hex"), getTBC20CodeIdentity(code).toString("hex"));
  let metadata;
  if (definition.metadataDefinition) {
    const decoded = TBC20.parseMetadataExtension(extensionHex);
    metadata = { ...decoded.metadata, declaredSupplyRaw: decoded.declaredSupplyRaw.toString() };
  }
  return {
    id: definition.id,
    originalOutpointHex: original.toString("hex"),
    tapeSize,
    controllerHex,
    codeHex: code.toHex(),
    identityHex: getTBC20CodeIdentity(code).toString("hex"),
    amounts: amounts.map(String),
    extensionHex,
    tapeHex: tape.toHex(),
    balance: parsed.balance.toString(),
    ...(metadata ? { metadata } : {}),
  };
});

const rejections = [
  { id: "scriptnum-negative-zero-controller", kind: "controller", controllerHex: `${"11".repeat(20)}80` },
  { id: "single-slot-overflow", kind: "slot-amount", amounts: [(max + 1n).toString(), ...zero.slice(1).map(String)] },
  { id: "tape-size-over-127", kind: "tape-size", tapeSize: 128 },
];
for (const vector of rejections) {
  assert.throws(() => {
    if (vector.kind === "slot-amount") TBC20.buildTape(vector.amounts.map(BigInt));
    else TBC20.instantiateCode({ originalUTXO, tapeSize: vector.tapeSize ?? 61, controller: vector.controllerHex ?? addressController });
  }, undefined, `Upstream unexpectedly accepted ${vector.id}`);
}
const fixture = {
  standardId: "tbc20-standard",
  scope: "Pure Code/Tape codec and owner-independent code identity only; no signing, transactions, HTTP, nodes or public capability claim.",
  provenance: {
    upstreamRepository: "https://github.com/TuringBitChain/tbc-contract",
    upstreamCommit: UPSTREAM_COMMIT,
    upstreamVersion: "1.7.0",
    upstreamSourceSha256: UPSTREAM_HASHES,
    upstreamArtifactSha256: TBC20.artifactSha256,
    tbcLibJsVersion: "1.0.31",
    typescriptVersion: "5.9.2",
    tbcLibJsTree: { ...libTree, algorithm: "sha256(sorted relative-path + NUL + file-sha256 + LF); excludes node_modules and .git" },
    execution: "Pinned upstream TypeScript transpiled in memory to CommonJS/ES2020; no source edits or runtime identity reimplementation.",
    identityMeaning: "Upstream partial-SHA256 code identity plus ScriptNum size, stable across controller replacement; not a raw full-script hash, network-qualified asset ID or ownership proof.",
    metadataMeaning: "Display declaration only; this fixture does not imply consensus enforcement of metadata or declared supply.",
  },
  vectors,
  rejections,
};
assert.equal(vectors[0].identityHex, vectors[1].identityHex, "Changing only controller must preserve identity");
assert.equal(vectors[0].identityHex, vectors[2].identityHex, "Contract controller option must preserve identity");
assert.notEqual(vectors[0].identityHex, vectors[3].identityHex, "Original outpoint must affect identity");
assert.notEqual(vectors[0].identityHex, vectors[4].identityHex, "Tape size must affect identity");
if (options.emit) process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
else {
  assert.deepEqual(JSON.parse(readFileSync(fixturePath, "utf8")), fixture, "Committed codec fixture differs from pinned upstream");
  console.log(`TBC20_UPSTREAM_CODEC_PASS ${vectors.length} valid + ${rejections.length} rejected vectors; offline/read-only; TypeScript ${ts.version}`);
}
