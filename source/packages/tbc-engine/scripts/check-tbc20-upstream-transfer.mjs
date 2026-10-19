#!/usr/bin/env node
/**
 * Offline, read-only upstream parity oracle for a synthetic TBC20 mint/transfer/merge sequence.
 * Requires an explicitly supplied, already available upstream checkout and
 * dependency installation. No npm install or network. Only public scalar-one synthetic signing is used.
 *
 * node packages/tbc-engine/scripts/check-tbc20-upstream-transfer.mjs \
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
const fixturePath = fileURLToPath(new URL("../rust/fixtures/tbc20-standard-transfer.json", import.meta.url));
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


// This well-known public test scalar is not a wallet key. All inputs are fake.
// The fixed high-level upstream builders serve as a test oracle only; production
// Rust constructors must remain keyless and accept external Signer results.
const publicTestKey = new tbc.PrivateKey(new tbc.crypto.BN(1));
const pubkeyHex = publicTestKey.toPublicKey().toString();
assert.equal(pubkeyHex, "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
const ownerAddress = publicTestKey.toAddress().toString();
const controllerHex = TBC20.addressController(ownerAddress).toString("hex");
const nativeScript = tbc.Script.buildPublicKeyHashOut(ownerAddress);
const fundingUTXO = { txId: "11".repeat(32), outputIndex: 0, satoshis: 100000, script: nativeScript.toHex() };
function utxo(tx, vout) {
  const output = tx.outputs[vout];
  return { txId: tx.id, outputIndex: vout, script: output.script.toHex(), satoshis: output.satoshis };
}
function feeOutput(tx) {
  const vout = tx.outputs.findLastIndex((output) => output.script.toHex() === nativeScript.toHex());
  assert.ok(vout >= 0, "Expected same-batch P2PKH fee change");
  return utxo(tx, vout);
}
const token = new TBC20();
const mint = token.mint(publicTestKey, ownerAddress, 123456n, fundingUTXO);
const mintHistory = new Map([[mint.sourceTransaction.id, mint.sourceTransaction]]);
const split = token.transfer({
  inputs: [{
    utxo: utxo(mint.transaction, 0), parentTx: mint.transaction,
    ancestors: mintHistory, signingKey: publicTestKey,
  }],
  receivers: [{ controller: ownerAddress, amount: 40000n }],
  tokenChangeController: ownerAddress,
  feeInputs: [{ utxo: feeOutput(mint.transaction), privateKey: publicTestKey }],
  tbcChangeAddress: ownerAddress,
});
assert.deepEqual(split.tokenOutputs.map((item) => item.amount.toString()), ["40000", "83456"]);
const splitHistory = new Map([[mint.transaction.id, mint.transaction]]);
const merged = token.merge({
  inputs: split.tokenOutputs.map(({ codeVout }) => ({
    utxo: utxo(split.transaction, codeVout), parentTx: split.transaction,
    ancestors: splitHistory, signingKey: publicTestKey,
  })),
  controller: ownerAddress,
  feeInputs: [{ utxo: feeOutput(split.transaction), privateKey: publicTestKey }],
  tbcChangeAddress: ownerAddress,
});
assert.deepEqual(merged.tokenOutputs.map((item) => item.amount.toString()), ["123456"]);

function recordStage(id, tx, fee, outputGroups, tokenOutputs, tokenInputCount, ancestorTxidsByInput = []) {
  const unsigned = new tbc.Transaction(tx.uncheckedSerialize());
  for (const input of unsigned.inputs) input.setScript(tbc.Script.empty());
  const inputs = tx.inputs.map((input, inputIndex) => {
    const previous = input.output;
    const tokenInput = inputIndex < tokenInputCount;
    const verification = tx.verifyScript(inputIndex);
    assert.equal(verification.success, true, id + " input " + inputIndex + ": " + verification.error);
    const upstreamDigest = tbc.Transaction.Sighash.sighash(tx, 0x41, inputIndex, previous.script, previous.satoshisBN);
    const signature = input.script.chunks[tokenInput ? 98 : 0].buf.toString("hex");
    assert.equal(input.script.chunks[tokenInput ? 99 : 1].buf.toString("hex"), pubkeyHex);
    if (tokenInput) assert.equal(input.script.chunks.length, 123);
    return {
      inputIndex, role: tokenInput ? "tbc20-holder" : "p2pkh-funding",
      txid: input.prevTxId.toString("hex"), vout: input.outputIndex,
      previousValue: String(previous.satoshis), previousScriptHex: previous.script.toHex(),
      pubkeyHex, signatureHex: signature,
      upstreamDigestHex: upstreamDigest.toString("hex"),
      digestBytesHex: Buffer.from(upstreamDigest).reverse().toString("hex"),
      ancestorTxids: ancestorTxidsByInput[inputIndex] ?? [],
      unlockHex: input.script.toHex(),
      localVmVerification: true,
    };
  });
  return {
    id, txid: tx.id, unsignedRaw: unsigned.uncheckedSerialize(), signedRaw: tx.uncheckedSerialize(),
    signedBytes: tx.toBuffer().length, fee: String(fee), inputs,
    outputs: tx.outputs.map((output, vout) => ({ vout, value: String(output.satoshis), scriptHex: output.script.toHex() })),
    outputGroups,
    tokenOutputs: tokenOutputs.map((output) => ({
      codeVout: output.codeVout, tapeVout: output.tapeVout,
      amount: output.amount.toString(), amountsByInput: output.amountsByInput.map(String),
      controllerHex: output.controller.toString("hex"),
      identityHex: proof.getTBC20CodeIdentity(tx.outputs[output.codeVout].script).toString("hex"),
    })),
  };
}
const stages = [
  recordStage("source", mint.sourceTransaction, mint.sourceFeeSatoshis, [{ codeVout: 0 }], [], 0),
  recordStage("genesis", mint.transaction, mint.feeSatoshis, mint.outputGroups, mint.tokenOutputs, 0),
  recordStage("transfer", split.transaction, split.feeSatoshis, split.outputGroups, split.tokenOutputs, 1, [[mint.sourceTransaction.id]]),
  recordStage("merge", merged.transaction, merged.feeSatoshis, merged.outputGroups, merged.tokenOutputs, 2,
    [[mint.transaction.id], [mint.transaction.id]]),
];
const identities = stages.flatMap((stage) => stage.tokenOutputs.map((output) => output.identityHex));
assert.equal(new Set(identities).size, 1, "All token outputs must preserve the same code identity");
assert.deepEqual(stages[3].tokenOutputs[0].amountsByInput, ["40000", "83456", "0", "0", "0", "0"]);
const fixture = {
  standardId: "tbc20-standard",
  scope: "Offline, cryptographically signed synthetic Source→Genesis→Transfer→Merge with valid upstream VM witnesses. Fabricated funding means no node or real-chain acceptance.",
  provenance: {
    upstreamRepository: "https://github.com/TuringBitChain/tbc-contract",
    upstreamCommit: UPSTREAM_COMMIT, upstreamVersion: "1.7.0",
    upstreamSourceSha256: UPSTREAM_HASHES, upstreamArtifactSha256: TBC20.artifactSha256,
    tbcLibJsVersion: "1.0.31", typescriptVersion: "5.9.2", tbcLibJsTree: libTree,
    signatureScope: "Public scalar 1, deterministic ECDSA test signatures, fabricated funding only. Never import real wallet keys.",
    digestEncoding: "upstreamDigestHex is Sighash.sighash reversed hash; digestBytesHex is raw SHA256d(preimage) for Rust/secp256k1. Their byte sequences are reverses.",
    reuseScope: "No fetching: transfer reuses genesis parent/source ancestor; merge reuses the one split parent and the one genesis ancestor for both token inputs; fee funding always uses same-batch change.",
  },
  request: {
    publicTestScalar: "1", publicKeyHex: pubkeyHex, ownerAddress, controllerHex,
    funding: { txid: fundingUTXO.txId, vout: 0, value: "100000", scriptHex: fundingUTXO.script },
    mintAmount: "123456", transferAmount: "40000", expectedTokenChange: "83456", mergeAmount: "123456",
    tapeSize: 61, extensionHex: "09",
    feePolicy: { satoshisPerKb: 80, minimumSatoshis: 80, dustSatoshis: tbc.Transaction.DUST_AMOUNT },
  },
  stages,
};
if (options.emit) process.stdout.write(JSON.stringify(fixture, null, 2) + "\n");
else {
  assert.deepEqual(JSON.parse(readFileSync(fixturePath, "utf8")), fixture, "Committed transfer fixture differs from pinned upstream");
  console.log("TBC20_UPSTREAM_TRANSFER_PASS source/genesis/transfer/merge; 7 input VM verifications; no network");
}

