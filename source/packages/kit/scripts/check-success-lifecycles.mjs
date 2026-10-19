import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hashCanonical } from "@tbc-wallet/core";
import { createTbcEngine, createWasmTbcEngineBackend } from "../dist/esm/engine.js";
import { createTbcWallet } from "../dist/esm/wallet.js";

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(kitRoot, "../..");
const rustRoot = join(repoRoot, "packages/tbc-engine/rust");
const wasmPath = join(kitRoot, "artifacts/wasm/tbc_engine_wasm.wasm");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const wasmBytes = readFileSync(wasmPath);
const backend = await createWasmTbcEngineBackend(wasmBytes);
const engine = createTbcEngine({ backend });

const generated = JSON.parse(execFileSync(
  "cargo",
  ["run", "--quiet", "--locked", "--offline", "-p", "tbc-engine-core", "--example", "export_runtime_vectors"],
  { cwd: rustRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
));
const tbc = JSON.parse(readFileSync(join(rustRoot, "fixtures/tbc-transfer.json"), "utf8"));

function finalizeInputs(vector) {
  if (Array.isArray(vector.finalizeInputs)) return vector.finalizeInputs;
  return vector.finalizeInput === undefined ? [] : [vector.finalizeInput];
}

function expectedBundle(vector) {
  return vector.complete?.bundle ?? vector.finalized?.bundle;
}

function permission(capability, account, origin) {
  return Object.freeze({
    id: `kit-success-${capability}`,
    parentCapability: capability,
    invoker: origin,
    date: Date.parse("2026-08-31T12:00:00Z"),
    caveats: Object.freeze([
      Object.freeze({ type: "restrictChains", value: Object.freeze([account.chainId]) }),
      Object.freeze({ type: "restrictAccounts", value: Object.freeze([account.accountId]) }),
      Object.freeze({ type: "restrictMethods", value: Object.freeze([capability]) }),
    ]),
  });
}

async function runCase(label, vector, mode) {
  const account = vector.planInput.snapshot.payload.account;
  const origin = "https://controlled-kit.test";
  const capability = mode === "send" ? "tbc_sendTransaction" : "tbc_signTransaction";
  const trace = [];
  const signatures = new Map(
    finalizeInputs(vector)
      .flatMap((input) => input.signatures ?? [])
      .map((signature) => [signature.taskId, signature]),
  );
  const submitted = [];
  const approvalSuffix = `${label}-${mode}`.replaceAll(/[^a-z0-9-]/giu, "-");
  let entropyCounter = 0;
  const runtime = createTbcWallet({
    accounts: { current: async () => [account] },
    approval: {
      async request(params) {
        trace.push("approval");
        return {
          status: "approved",
          approvalId: `approval-${approvalSuffix}`,
          approvalToken: `approval-token-${approvalSuffix}`,
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-08-31T12:00:00Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: {
      async sign(params) {
        trace.push(`signer:${params.task.taskId}`);
        const fixed = signatures.get(params.task.taskId);
        if (fixed !== undefined) return fixed;
        return {
          taskId: params.task.taskId,
          signatureEncoding: "compact64",
          signature: secp256k1
            .sign(params.task.digest, "01".padStart(64, "0"), { prehash: false, lowS: true })
            .toCompactHex(),
        };
      },
    },
    storage: {
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [
            permission("tbc_accounts", account, origin),
            permission(capability, account, origin),
          ],
        };
      },
      async commitPermissions(params) {
        return { revisions: params.changes.map((change) => ({ scope: change.scope, revision: "1" })) };
      },
    },
    network: {
      async resolveChainData() {
        trace.push("chainData");
        return vector.planInput.snapshot;
      },
      async resolvePolicy() {
        trace.push("policy");
        return vector.planInput.policy;
      },
      async broadcastSubmit(params) {
        trace.push(`broadcast:${params.transaction.txid}`);
        submitted.push(params.transaction.txid);
        return { txid: params.transaction.txid, status: "accepted" };
      },
      async broadcastReconcile(params) {
        trace.push("reconcile");
        return {
          transactions: params.txids.map((txid) => ({ txid, status: "mempool", confirmations: "0" })),
        };
      },
    },
    engine,
    clock: () => "2026-08-31T12:00:00Z",
    randomBytes: (length) => {
      entropyCounter += 1;
      return Uint8Array.from({ length }, (_, index) => (index + entropyCounter) & 0xff);
    },
  });
  const session = await runtime.openSession({
    origin,
    sessionId: `controlled-${approvalSuffix}`,
  });
  try {
    const result = await session.provider.request({
      method: capability,
      params: vector.planInput.request,
    });
    assert.ok(Array.isArray(result.transactions) && result.transactions.length > 0);
    const txids = result.transactions.map(({ txid }) => txid);
    const expected = expectedBundle(vector);
    if (expected !== undefined) {
      assert.deepEqual(txids, expected.transactions.map(({ txid }) => txid));
    }
    assert.equal(trace.filter((event) => event === "approval").length, 1);
    assert.ok(trace.some((event) => event.startsWith("signer:")));
    const signerLast = trace.reduce((position, event, index) => event.startsWith("signer:") ? index : position, -1);
    const broadcastFirst = trace.findIndex((event) => event.startsWith("broadcast:"));
    if (mode === "send") {
      assert.deepEqual(submitted, txids);
      assert.ok(broadcastFirst > signerLast);
      assert.ok(result.transactions.every(({ status }) => status === "submitted"));
    } else {
      assert.deepEqual(submitted, []);
      assert.equal(broadcastFirst, -1);
      assert.ok(result.transactions.every(({ status }) => status !== "submitted"));
    }
    return {
      label,
      mode,
      transactions: txids.length,
      txids,
      statuses: result.transactions.map(({ status }) => status),
      signerCalls: trace.filter((event) => event.startsWith("signer:")).length,
      approvalCalls: 1,
      broadcastCalls: submitted.length,
      dependencyOrderPreserved: true,
      expectedBundleMatched: expected === undefined ? null : true,
      resultSha256: sha256(JSON.stringify(result)),
    };
  } catch (error) {
    throw new Error(`${label} ${mode} failed after ${trace.join(",")}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    session.close();
  }
}

const ftDirect = structuredClone(generated.ft.direct);
ftDirect.policy.payload.amountLimits = [{ scope: "native", maximum: "2100000000000000" }];
ftDirect.policy.policyHash = hashCanonical(ftDirect.policy.payload);
const tbcForTokenSwap = structuredClone(generated.pool.swap.planInput);
tbcForTokenSwap.policy.payload.amountLimits = [{ scope: "native", maximum: "2100000000000000" }];
tbcForTokenSwap.policy.policyHash = hashCanonical(tbcForTokenSwap.policy.payload);

const cases = [
  ["tbc.transfer", { planInput: tbc.planInput, finalizeInput: tbc.finalizeInput, finalized: tbc.finalized }],
  ["tbc.ft.create", generated.ft.create],
  ["tbc.ft.transfer", { planInput: ftDirect }],
  ["tbc.pool.create.mint", generated.pool.createMint],
  ["tbc.pool.create.initialize", generated.pool.createInitialize],
  ["tbc.pool.swap.exactTbcForToken", { planInput: tbcForTokenSwap }],
  ["tbc.pool.swap.exactTokenForTbc", generated.pool.tokenSwap],
  ["tbc.pool.liquidity.add", generated.pool.addLiquidity],
  ["tbc.pool.liquidity.remove", generated.pool.removeLiquidity],
];

const checks = [];
for (const [label, vector] of cases) {
  checks.push(await runCase(label, vector, "sign"));
  checks.push(await runCase(label, vector, "send"));
}

const requestComparison = cases.map(([label, vector]) => ({
  label,
  sourceRequestHash: vector.planInput.requestHash,
  candidateRequestHash: hashCanonical(vector.planInput.request),
  requestChanged: vector.planInput.requestHash !== hashCanonical(vector.planInput.request),
}));

console.log(JSON.stringify({
  phase: "S2",
  package: "@tbc/kit",
  engineArtifact: wasmPath,
  engineArtifactSha256: sha256(wasmBytes),
  vectorSource: "tbc-engine-core/export_runtime_vectors plus checked-in tbc-transfer fixture",
  cases: cases.length,
  runs: checks.length,
  controlledTransportOnly: true,
  requestComparison,
  checks,
}, null, 2));
