import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertValidTws,
  createApprovalBinding,
  createApprovalRequest,
} from "../dist/esm/wallet.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rust = resolve(root, "packages/tbc-engine/rust");
const vectors = JSON.parse(execFileSync(
  "cargo",
  ["run", "--locked", "--offline", "--quiet", "-p", "tbc-engine-core", "--example", "export_merge_approval_vectors"],
  { cwd: rust, encoding: "utf8" },
));

const expected = {
  tbc: { kind: "native" },
  ft: { kind: "ft" },
  poolFt: { kind: "ft", contractId: vectors.poolFt.input.snapshot.payload.contracts[0].contractId },
  ftlp: { kind: "lp" },
};

for (const [name, vector] of Object.entries(vectors)) {
  assertValidTws("planResult", vector.result);
  const { plan } = vector.result;
  const flow = plan.payload.preview.assetFlows[0];
  assert.equal(flow.kind, expected[name].kind, `${name} approval asset kind`);
  assert.equal(flow.direction, "merge", `${name} approval direction`);
  if (expected[name].contractId !== undefined) {
    assert.equal(flow.contractId, expected[name].contractId, `${name} approval FT identity`);
  }
  const binding = createApprovalBinding({
    version: "1.0",
    method: "tbc_signTransaction",
    operationKind: "transaction",
    contextHash: "11".repeat(32),
    origin: "https://merge-roundtrip.test",
    sessionId: `merge-${name}`,
    chainId: plan.payload.chainId,
    accountId: plan.payload.accountId,
    requestHash: plan.payload.requestHash,
    operationHash: plan.planHash,
    expiresAt: plan.payload.expiresAt,
  });
  const approval = createApprovalRequest(binding, plan.payload.preview, {
    transport: "webview",
    origin: "https://merge-roundtrip.test",
    topOrigin: "https://merge-roundtrip.test",
    frame: "top",
  });
  assertValidTws("approvalRequestParams", approval);
}

const invalid = structuredClone(vectors.poolFt.result);
invalid.plan.payload.preview.assetFlows[0].kind = "pool-ft";
assert.throws(() => assertValidTws("planResult", invalid));

console.log("MERGE_APPROVAL_ROUNDTRIP_PASS intents=4 invalidPoolFtRejected=1");
