#!/usr/bin/env node
/**
 * Offline, read-only upstream parity oracle for TBC20 proof ABI and mint transactions.
 * Requires an explicitly supplied, already available upstream checkout and
 * dependency installation. No npm install or network. Only public scalar-one synthetic mint signing is used.
 *
 * node packages/tbc-engine/scripts/check-tbc20-upstream-transaction.mjs \
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
const fixturePath = fileURLToPath(new URL("../rust/fixtures/tbc20-standard-transaction.json", import.meta.url));
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
const proof = upstreamRequire("./lib/util/tbc20/tbc20unlock.js");
const tbc = dependencies("tbc-lib-js");
hooks.deregister();
assert.deepEqual([...consumedSources].sort(), ["lib/contract/tbc20.ts", "lib/util/tbc20/tbc20unlock.ts"]);


// Only public, deliberately synthetic data. No live UTXOs are referenced.
const pubkeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const pubkey = Buffer.from(pubkeyHex, "hex");
const ownerHash = tbc.crypto.Hash.sha256ripemd160(pubkey);
const controller = Buffer.concat([ownerHash, Buffer.from([0])]);
const p2pkh = tbc.Script.fromHex("76a914" + ownerHash.toString("hex") + "88ac");
const signaturePlaceholderHex = "300602010102010141"; // DER r=1,s=1; not a valid signature for these messages.
const zeros = Array(6).fill(0n);
const output = (script, satoshis) => new tbc.Transaction.Output({ script, satoshis });
function makeTx(inputs, outputs, lockTime = 0) {
  const tx = new tbc.Transaction();
  tx.version = 10;
  tx.nLockTime = lockTime;
  for (const input of inputs) {
    tx.uncheckedAddInput(new tbc.Transaction.Input({
      prevTxId: input.txid,
      outputIndex: input.vout,
      sequenceNumber: input.sequence ?? 0xffffffff,
      script: tbc.Script.fromHex(input.unlockHex ?? ""),
      output: input.output,
    }));
  }
  for (const item of outputs) tx.addOutput(item);
  return tx;
}
const reference = (tx, vout, unlockHex = "") => ({ txid: tx.id, vout, output: tx.outputs[vout], unlockHex });
const funding = (byte, outputs) => makeTx([
  { txid: byte.repeat(32), vout: 0, output: output(p2pkh, 250000), unlockHex: "51" },
], outputs);
const source = funding("aa", [output(p2pkh, 100500)]);
const code = TBC20.instantiateCode({ originalUTXO: { txId: source.id, outputIndex: 0 }, tapeSize: 61, controller });
const recipientCode = TBC20.replaceController(code, "22".repeat(20) + "00");
const tape = (amounts) => TBC20.buildTape(amounts);
const simpleParent = makeTx([reference(source, 0, "51")], [
  output(code, 500), output(tape([100n, ...zeros.slice(1)]), 0), output(p2pkh, 100000),
]);

// Deliberately sparse slots exercise absolute vin indices, not compressed indices.
const ancestorA = funding("ab", [
  output(p2pkh, 1000), output(code, 500), output(tape([30n, ...zeros.slice(1)]), 0),
]);
const ancestorB = funding("ac", [
  output(code, 500), output(tape([70n, ...zeros.slice(1)]), 0), output(p2pkh, 1000),
]);
const sparseInputs = [
  { txid: "ba".repeat(32), vout: 2, output: output(p2pkh, 100000), unlockHex: "51" },
  reference(ancestorA, 1, "5151"),
  { txid: "bb".repeat(32), vout: 0, output: output(p2pkh, 500), unlockHex: "52" },
  { txid: "bc".repeat(32), vout: 1, output: output(p2pkh, 500), unlockHex: "53" },
  { txid: "bd".repeat(32), vout: 3, output: output(p2pkh, 500), unlockHex: "54" },
  reference(ancestorB, 0, "55"),
];
const sparseParent = makeTx(sparseInputs, [
  output(tbc.Script.fromHex("006a"), 0),
  output(code, 500), output(tape([0n, 30n, 0n, 0n, 0n, 70n]), 0),
  output(p2pkh, 100000),
], 123);
function unsignedTransfer(parent, codeVout, feeVout) {
  return makeTx([reference(parent, codeVout), reference(parent, feeVout)], [
    output(recipientCode, 500), output(tape([40n, ...zeros.slice(1)]), 0),
    output(code, 500), output(tape([60n, ...zeros.slice(1)]), 0),
    output(p2pkh, 99420),
  ]);
}
const outputGroups = [{ codeVout: 0, tapeVout: 1 }, { codeVout: 2, tapeVout: 3 }, { codeVout: 4 }];
function hexTree(value) {
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (Array.isArray(value)) return value.map(hexTree);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hexTree(item)]));
  return value;
}
function leafHex(chunk) {
  if (chunk.buf) return chunk.buf.toString("hex");
  if (chunk.opcodenum === 0) return "";
  if (chunk.opcodenum === 79) return "81";
  if (chunk.opcodenum >= 81 && chunk.opcodenum <= 96) return (chunk.opcodenum - 80).toString(16).padStart(2, "0");
  throw new Error("Unexpected non-push instruction in upstream unlocking script");
}
function digest(tx, vin) {
  const previous = tx.inputs[vin].output;
  return tbc.Transaction.Sighash.sighash(tx, 0x41, vin, previous.script, previous.satoshisBN).toString("hex");
}
const cases = [
  { id: "single-nonzero-slot-genesis-like-parent", parent: simpleParent, codeVout: 0, feeVout: 2, ancestors: [source] },
  { id: "sparse-slots-one-and-five-nonzero-vout", parent: sparseParent, codeVout: 1, feeVout: 3, ancestors: [ancestorA, ancestorB] },
];
const vectors = cases.map((entry) => {
  const current = unsignedTransfer(entry.parent, entry.codeVout, entry.feeVout);
  const ancestorMap = new Map(entry.ancestors.map((tx) => [tx.id, tx]));
  const options = {
    currentTx: current, inputIndex: 0, preTx: entry.parent, preTxVout: entry.codeVout,
    ancestorTransactions: ancestorMap, outputGroups,
    publicKey: pubkey, signature: signaturePlaceholderHex,
  };
  const unlock = proof.buildTBC20UnlockScriptWithSignature(options);
  assert.equal(unlock.chunks.length, 123);
  assert.throws(() => proof.buildTBC20UnlockScriptWithSignature({ ...options, ancestorTransactions: new Map() }), /missing ancestor transaction/u);
  const wrongParent = entry.parent === simpleParent ? sparseParent : simpleParent;
  assert.throws(() => proof.buildTBC20UnlockScriptWithSignature({ ...options, preTx: wrongParent }), /does not spend preTx/u);
  return {
    id: entry.id,
    currentRaw: current.uncheckedSerialize(),
    currentUnsignedTxid: current.id,
    inputPreviousOutputs: current.inputs.map((input) => ({
      txid: input.prevTxId.toString("hex"), vout: input.outputIndex,
      value: input.output.satoshis.toString(), scriptHex: input.output.script.toHex(),
    })),
    parentRaw: entry.parent.uncheckedSerialize(),
    parentTxid: entry.parent.id,
    parentCodeVout: entry.codeVout,
    inputIndex: 0,
    ancestorsRaw: entry.ancestors.map((tx) => tx.uncheckedSerialize()),
    ancestorTxids: entry.ancestors.map((tx) => tx.id),
    outputGroups,
    pubkeyHex,
    signatureHex: signaturePlaceholderHex,
    digestHex: digest(current, 0),
    feeInputDigestHex: digest(current, 1),
    unlockHex: unlock.toHex(),
    unlockPushesHex: unlock.chunks.map(leafHex),
    currentInputsDataHex: proof.getTBC20CurrentInputsData(current).toString("hex"),
    currentOutputsData: hexTree(proof.getTBC20CurrentOutputData(current, outputGroups)),
    parentData: hexTree(proof.getTBC20PreTxData(entry.parent, entry.codeVout)),
    ancestorsData: hexTree(proof.getTBC20PrePreTxArray(entry.parent, entry.codeVout, ancestorMap)),
  };
});

// Explicitly public test scalar 1, only to compare the upstream mint's signed
// Source→Genesis dependency. These fabricated inputs are not spendable on chain.
const publicTestKey = new tbc.PrivateKey(new tbc.crypto.BN(1));
assert.equal(publicTestKey.toPublicKey().toString(), pubkeyHex);
const mintFunding = {
  txId: "11".repeat(32), outputIndex: 0, satoshis: 100000, script: p2pkh.toHex(),
};
const token = new TBC20();
const mint = token.mint(publicTestKey, publicTestKey.toAddress().toString(), 123456n, mintFunding);
function mintStage(tx, fee) {
  const unsigned = new tbc.Transaction(tx.uncheckedSerialize());
  for (const input of unsigned.inputs) input.setScript(tbc.Script.empty());
  const verify = tx.verifyScript(0);
  assert.equal(verify.success, true, "Synthetic P2PKH mint verification failed");
  return {
    unsignedRaw: unsigned.uncheckedSerialize(),
    signedRaw: tx.uncheckedSerialize(),
    txid: tx.id,
    digestHex: digest(tx, 0),
    signatureHex: tx.inputs[0].script.chunks[0].buf.toString("hex"),
    fee: String(fee),
    signedBytes: tx.toBuffer().length,
    outputs: tx.outputs.map((item) => ({ value: String(item.satoshis), scriptHex: item.script.toHex() })),
    localP2pkhVerification: true,
  };
}
const mintVector = {
  id: "public-scalar-one-source-genesis-123456",
  publicTestScalar: "1",
  funding: { txid: mintFunding.txId, vout: 0, value: "100000", scriptHex: p2pkh.toHex() },
  publicKeyHex: pubkeyHex,
  recipientControllerHex: controller.toString("hex"),
  amount: "123456",
  extensionHex: "09",
  tapeSize: 61,
  feePolicy: { satoshisPerKb: 80, minimumSatoshis: 80, dustSatoshis: tbc.Transaction.DUST_AMOUNT },
  source: mintStage(mint.sourceTransaction, mint.sourceFeeSatoshis),
  genesis: mintStage(mint.transaction, mint.feeSatoshis),
  originalOutpointHex: TBC20.encodeOriginalUTXO(mint.originalUTXO).toString("hex"),
  identityHex: proof.getTBC20CodeIdentity(mint.transaction.outputs[0].script).toString("hex"),
};
const fixture = {
  standardId: "tbc20-standard",
  scope: "Two pure proof/unsigned-layout vectors and one public-scalar synthetic mint. No real inputs, network, node acceptance, wallet approval or production capability evidence.",
  provenance: {
    upstreamRepository: "https://github.com/TuringBitChain/tbc-contract",
    upstreamCommit: UPSTREAM_COMMIT, upstreamVersion: "1.7.0",
    upstreamSourceSha256: UPSTREAM_HASHES,
    upstreamArtifactSha256: TBC20.artifactSha256,
    tbcLibJsVersion: "1.0.31", typescriptVersion: "5.9.2",
    tbcLibJsTree: libTree,
    signatureScope: "Proof vectors use DER r=1,s=1 placeholders only: ABI shape, not ECDSA validity. Only mint uses public scalar 1 for offline synthetic P2PKH signing.",
    digestEncoding: "Exact bytes returned by tbc-lib-js Transaction.Sighash.sighash(..., 0x41); compare this digest in the existing native signing convention.",
    proofScope: "Synthetic parent witnesses are deliberate placeholders. Upstream proof encoding checks linkage, not full validity of the synthetic history.",
  },
  vectors,
  mint: mintVector,
  rejections: [
    { kind: "missing-required-ancestor", appliesTo: vectors.map((value) => value.id) },
    { kind: "current-input-parent-mismatch", appliesTo: vectors.map((value) => value.id) },
  ],
};
if (options.emit) process.stdout.write(JSON.stringify(fixture, null, 2) + "\n");
else {
  assert.deepEqual(JSON.parse(readFileSync(fixturePath, "utf8")), fixture, "Committed transaction fixture differs from pinned upstream");
  console.log("TBC20_UPSTREAM_TRANSACTION_PASS 2 proof vectors, 123 pushes each, 4 linkage rejections, 1 synthetic mint; no network");
}

