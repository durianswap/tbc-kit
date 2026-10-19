import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1";
import { createNativeTbcKeylessEngine, createWasmTbcKeylessEngine } from "../dist/esm/wallet.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
if (!target) throw new Error("rustc host target is unavailable");
if (target.includes("windows")) throw new Error("keyless Native runner currently requires a Unix C toolchain");
const file = target.includes("apple") ? "libtbc_keyless_native.dylib" : "libtbc_keyless_native.so";
const nativeRoot = resolve(root, "artifacts/keyless-native", target);
const nativeArtifact = resolve(nativeRoot, file);
const runnerSource = resolve(root, "../tbc-engine/scripts/keyless-native-runner.c");
const work = mkdtempSync(join(tmpdir(), "tbc-keyless-native-"));
const runner = resolve(work, "keyless-native-runner");
const request = JSON.stringify({
  operation: "increaseLp",
  ftContractId: "22".repeat(32),
  ftDecimal: 6,
  amount: "0.001",
  lockTime: 0,
  pool: {
    ftLpRaw: "10000",
    ftARaw: "5000",
    tbcSat: "10000",
    poolValueSat: "11000",
    publicKeyLocked: false,
  },
});

try {
  execFileSync("cc", [
    runnerSource,
    `-I${nativeRoot}`,
    nativeArtifact,
    `-Wl,-rpath,${nativeRoot}`,
    "-o",
    runner,
  ], { stdio: "inherit" });
  const execute = async (operation, requestJson) => execFileSync(
    runner,
    [operation, requestJson],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const native = createNativeTbcKeylessEngine(execute);
  const wasm = await createWasmTbcKeylessEngine(readFileSync(resolve(root, "artifacts/wasm/tbc_keyless_wasm.wasm")));
  const nativeRaw = await native.execute("legacyPoolPreview", request);
  const wasmRaw = await wasm.execute("legacyPoolPreview", request);
  assert.deepEqual(JSON.parse(nativeRaw), JSON.parse(wasmRaw));
  assert.equal(JSON.parse(nativeRaw).ftlpMintedRaw, "1000");
  // Public synthetic scalar only; never use these vectors with funded UTXOs.
  const scalar = new Uint8Array(32).fill(7);
  const publicKey = Buffer.from(secp256k1.getPublicKey(scalar)).toString("hex");
  const script = "76a914" + "22".repeat(20) + "88ac";
  const txraw = "0a00000001" + "11".repeat(32) + "0000000000ffffffff01282300000000000019" + script + "00000000";
  const rawRequest = {txraws:[txraw],utxosSatoshis:[[10000]],scriptPubkeys:[[script]]};
  const associatedRequest = {sourceTxraw:txraw,sourceUtxos:[{txId:"11".repeat(32),outputIndex:0,satoshis:10000,script,scriptSigType:"p2pkh"}],inputs:[[{outputIndex:0,scriptSigType:"p2pkh"}]],outputs:[[{satoshis:8000,script}]]};
  let reviewedStages=0;
  for (const [format,request,count] of [["raw",rawRequest,1],["associated",associatedRequest,2]]) {
    const previousTransactions=[];
    for(let transactionIndex=0;transactionIndex<count;transactionIndex++) {
      const input=JSON.stringify({format,request,publicKey,transactionIndex,previousTransactions});
      const stage=JSON.parse(await native.execute("prepareReviewedStage",input));
      assert.deepEqual(stage,JSON.parse(await wasm.execute("prepareReviewedStage",input)));
      const signatures=stage.digests.map(d=>secp256k1.sign(d,scalar).toCompactHex());
      const finalizeInput=JSON.stringify({stage,signatures,signatureEncoding:"compact64"});
      const result=JSON.parse(await native.execute("finalizeReviewedStage",finalizeInput));
      assert.deepEqual(result,JSON.parse(await wasm.execute("finalizeReviewedStage",finalizeInput)));
      if(format==="associated")previousTransactions.push(result.txraw);
      reviewedStages++;
    }
  }
  await assert.rejects(native.execute("sign", "{}"), /KEYLESS_OPERATION_UNAVAILABLE/);
  const invalidRaw = await execute("sign", "{}");
  assert.deepEqual(JSON.parse(invalidRaw), { error: "KEYLESS_OPERATION_UNAVAILABLE" });
  console.log(JSON.stringify({
    phase: "Native-keyless-consumption",
    target,
    artifact: `artifacts/keyless-native/${target}/${file}`,
    sha256: createHash("sha256").update(readFileSync(nativeArtifact)).digest("hex"),
    cHeader: `artifacts/keyless-native/${target}/tbc_keyless.h`,
    cRunnerCompiled: true,
    publicAdapterInvoked: true,
    wasmNativeIdentity: true,
    reviewedStages,
    operation: "legacyPoolPreview",
    resultSha256: createHash("sha256").update(nativeRaw).digest("hex"),
    signingOperationRejected: true,
    networkRequests: 0,
    broadcasts: 0,
  }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
