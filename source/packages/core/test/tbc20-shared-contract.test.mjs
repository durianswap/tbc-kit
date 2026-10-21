import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

// Exercise current source without overwriting shared dist or generated files.
const compiled = await build({
  stdin: {
    contents: `
      export { normalizeCapabilityConfiguration, TWS_CAPABILITY_INTENTS } from "./src/engine.ts";
      export { chainDataRequirement, workflowChainDataRequirement } from "./src/reducers/chain-data-requirements.ts";
      export { assertPreparedProposalForPlan, preparedProposalTransactions } from "./src/reducers/planning.ts";
      export { hashCanonical } from "./src/hash.ts";
    `,
    resolveDir: new URL("../", import.meta.url).pathname,
  },
  bundle: true, platform: "node", format: "cjs", write: false,
  external: ["@noble/hashes/*"],
});
const module = { exports: {} };
new Function("module", "exports", "require", compiled.outputFiles[0].text)(
  module, module.exports, createRequire(import.meta.url),
);
const {
  normalizeCapabilityConfiguration, TWS_CAPABILITY_INTENTS,
  chainDataRequirement, workflowChainDataRequirement,
  assertPreparedProposalForPlan, preparedProposalTransactions, hashCanonical,
} = module.exports;
const intents = ["tbc20-standard-create", "tbc20-standard-transfer", "tbc20-standard-merge"];
const contractId = "ab".repeat(32);
const templateRevision = "0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84";

test("capability profiles advertise current issuance and unified holders, never disabled historical issuance", () => {
  assert.equal(normalizeCapabilityConfiguration(undefined), undefined);
  const config = (declared, profiles = ["core"]) => ({
    version: "1.0", scopes: [{ chainId: "tbc:mainnet", intents: declared, profiles }],
  });
  assert.deepEqual(normalizeCapabilityConfiguration(config(["tbc.transfer"])).scopes[0].intents, ["tbc.transfer"]);
  assert.deepEqual(normalizeCapabilityConfiguration(config(["tbc.transfer", ...intents])).scopes[0].intents,
    ["tbc.transfer", ...intents]);
  assert.ok(intents.every((intent) => TWS_CAPABILITY_INTENTS.includes(intent)));
  // Collection format is shared with the current NFT standard; only distinct
  // historical issuance is disabled, not the reusable collection operation.
  assert.ok(TWS_CAPABILITY_INTENTS.includes('tbc.collection.create'));
  for(const disabled of ['tbc.nft.mint','tbc.ft.create','tbc.pool.create']) {
    assert.equal(TWS_CAPABILITY_INTENTS.includes(disabled),false);
    assert.throws(()=>normalizeCapabilityConfiguration(config(['tbc.transfer',disabled])),/Invalid wallet capability scope/);
  }
  const current=['tbc.transfer','tbc721-standard-create-collection','tbc721-standard-mint',
    'tbc721.transfer','tbc20-standard-create','tbc20.transfer','tbc20Stablecoin.transfer'];
  const assets=normalizeCapabilityConfiguration(config(current,['core','assets']));
  assert.deepEqual(new Set(assets.scopes[0].intents),new Set(current));
  const defi=normalizeCapabilityConfiguration(config([...current,'tbc-amm-create','amm.swap','amm.addLiquidity','amm.removeLiquidity'],['core','assets','defi']));
  assert.ok(defi.scopes[0].profiles.includes('defi'));
  assert.throws(() => normalizeCapabilityConfiguration(config(["tbc.transfer", ...intents], ["core", "assets"])),
    /profiles exceed/);
});

test("TBC20 create/transfer/merge share minimal chain-data requirements and preserve explicit inputs", () => {
  const points = [{ txid: "11".repeat(32), vout: 2 }];
  const requests = intents.map((type) => ({
    intent: { type, ...(type === intents[0] ? {} : { contractId }), ...(type === intents[1] ? { amount: "123" } : {}) },
    constraints: { inputOutpoints: points },
  }));
  const results = requests.map(chainDataRequirement);
  assert.deepEqual(results[0], { intentType: intents[0], includeAncestry: false,
    assets: [{ kind: "native" }], inputOutpoints: points });
  assert.deepEqual(results[1], { intentType: intents[1], includeAncestry: true, contractIds: [contractId],
    assets: [{ kind: "native" }, { kind: "ft", contractId, minimumAmount: "123" }], inputOutpoints: points });
  assert.deepEqual(results[2], { intentType: intents[2], includeAncestry: true, contractIds: [contractId],
    assets: [{ kind: "native" }, { kind: "ft", contractId }], inputOutpoints: points });
  points[0].vout = 99;
  assert.equal(results[0].inputOutpoints[0].vout, 2, "input snapshots must not alias mutable request objects");
  assert.ok(Object.isFrozen(results[1].inputOutpoints[0]));
  const combined = workflowChainDataRequirement([requests[1], requests[1]]);
  assert.deepEqual(combined.assets, [{ kind: "native" }, { kind: "ft", contractId, minimumAmount: "246" }]);
  assert.equal(combined.inputOutpoints.length, 1);
  assert.deepEqual(chainDataRequirement({ intent: { type: "tbc.ft.create" } }),
    { intentType: "tbc.ft.create", includeAncestry: false, assets: [{ kind: "native" }] });
  assert.throws(() => chainDataRequirement({ intent: { type: intents[1], contractId } }), /missing amount/);
  assert.throws(() => chainDataRequirement({ intent: { type: intents[2] } }), /missing contractId/);
});

test("LP holder operations share funding and ancestry without requesting mutable Pool reserves", () => {
  const points = [{ txid: "11".repeat(32), vout: 4 }];
  for (const type of ["tbc20-lp-transfer", "tbc20-lp-lock", "tbc20-lp-merge", "tbc20-lp-unlock"]) {
    const amount = type === "tbc20-lp-transfer" || type === "tbc20-lp-lock" ? "40000" : undefined;
    const request = { intent: { type, poolContractId: contractId, ...(amount === undefined ? {} : { amount }) }, constraints: { inputOutpoints: points } };
    assert.deepEqual(chainDataRequirement(request), {
      intentType: type, includeAncestry: true, contractIds: [contractId], inputOutpoints: points,
      assets: [{ kind: "native" }, { kind: "ftlp", contractId, ...(amount === undefined ? {} : { minimumAmount: amount }) }],
    });
    assert.ok(TWS_CAPABILITY_INTENTS.includes(type));
    assert.deepEqual(workflowChainDataRequirement([request]), chainDataRequirement(request));
  }
});

test("new empty Pool creation reads FT identity but does not require a holder FT balance", () => {
  const points = [{ txid: "11".repeat(32), vout: 2 }];
  const request = { intent: { type: "tbc-amm-create", ftContractId: contractId }, constraints: { inputOutpoints: points } };
  assert.deepEqual(chainDataRequirement(request), { intentType: "tbc-amm-create", includeAncestry: true,
    contractIds: [contractId], inputOutpoints: points, assets: [{ kind: "native" }] });
  assert.deepEqual(workflowChainDataRequirement([request]), chainDataRequirement(request));
  assert.ok(TWS_CAPABILITY_INTENTS.includes("tbc-amm-create"));
});

test("AMM business reads current Pool but only requests holder assets that the operation spends", () => {
  const points = [{ txid: "11".repeat(32), vout: 0 }];
  const pool = { kind: "pool", contractId };
  const asset = (kind, relation, minimumAmount) => ({ kind, contractDependency: { relation, contractId }, ...(minimumAmount === undefined ? {} : { minimumAmount }) });
  const cases = [
    [{ type: "tbc-amm-add-liquidity", budgetAsset: "tbc", amount: "100", initialFtAmount: "200" }, "100", [{ kind: "native", minimumAmount: "100" }, pool, asset("ft", "pool-ft", "200")]],
    [{ type: "tbc-amm-add-liquidity", budgetAsset: "ft", amount: "200" }, undefined, [{ kind: "native" }, pool, asset("ft", "pool-ft", "200")]],
    [{ type: "tbc-amm-remove-liquidity", lpAmount: "50" }, undefined, [{ kind: "native" }, pool, asset("ftlp", "pool-lp", "50")]],
    [{ type: "tbc-amm-swap", direction: "tbc-to-ft", amount: "100" }, "100", [{ kind: "native", minimumAmount: "100" }, pool]],
    [{ type: "tbc-amm-swap", direction: "ft-to-tbc", amount: "200" }, undefined, [{ kind: "native" }, pool, asset("ft", "pool-ft", "200")]],
  ];
  for (const [intent, nativeAmount, assets] of cases) {
    const request = { intent: { ...intent, poolContractId: contractId }, constraints: { inputOutpoints: points } };
    assert.deepEqual(chainDataRequirement(request), { intentType: intent.type, includeAncestry: true,
      contractIds: [contractId], inputOutpoints: points, assets, ...(nativeAmount === undefined ? {} : { nativeAmount }) });
    assert.deepEqual(workflowChainDataRequirement([request]), chainDataRequirement(request));
    assert.ok(TWS_CAPABILITY_INTENTS.includes(intent.type));
  }
  for (const intent of [{ type: "tbc-amm-swap", direction: "buy" }, { type: "tbc-amm-add-liquidity", budgetAsset: "lp" }])
    assert.throws(() => chainDataRequirement({ intent: { ...intent, amount: "1", poolContractId: contractId } }), /invalid/);
});
test("a workflow's sole NFT transaction retains exact mint slots alongside non-transaction steps", () => {
  for (const intent of [
    { type: "tbc721-standard-mint", collectionId: contractId, slot: 3 },
    { type: "tbc721-standard-batch-mint", collectionId: contractId, items: [{ slot: 3 }, { slot: 1 }] },
  ]) {
    const request = { intent, constraints: { inputOutpoints: [{ txid: "11".repeat(32), vout: 4 }] } };
    // Core has already separated message/crypto steps before calling this helper.
    assert.deepEqual(workflowChainDataRequirement([request]), chainDataRequirement(request));
  }
});

test("same-collection workflow mint steps share exact slots without dropping per-step input scope", () => {
  const requests = [
    { intent: { type: "tbc721-standard-mint", collectionId: contractId, slot: 3 },
      constraints: { inputOutpoints: [{ txid: "11".repeat(32), vout: 0 }, { txid: contractId, vout: 3 }] } },
    { intent: { type: "tbc721-standard-batch-mint", collectionId: contractId, items: [{ slot: 1 }, { slot: 2 }] },
      constraints: { inputOutpoints: [{ txid: "22".repeat(32), vout: 0 }, { txid: contractId, vout: 1 }, { txid: contractId, vout: 2 }] } },
  ];
  const aggregate = workflowChainDataRequirement(requests);
  assert.equal(aggregate.intentType, "tbc721-standard-batch-mint");
  assert.deepEqual(aggregate.collectionSlots, [3, 1, 2]);
  assert.deepEqual(aggregate.assets, [{ kind: "native" }, { kind: "collection", contractId, minimumAmount: "3" }]);
  assert.equal(aggregate.inputOutpoints.length, 5);
  assert.equal(requests[0].constraints.inputOutpoints.length, 2);
  const partlyScoped = workflowChainDataRequirement([requests[0], { intent: requests[1].intent }]);
  assert.equal(partlyScoped.inputOutpoints, undefined, "one scoped step must not restrict the other step's candidates");
  assert.throws(() => workflowChainDataRequirement([requests[0], requests[0]]), /mint slots/);
  const tooMany = Array.from({ length: 2 }, (_, group) => ({ intent: {
    type: "tbc721-standard-batch-mint", collectionId: contractId,
    items: Array.from({ length: 20 }, (_, i) => ({ slot: group * 20 + i + 1 })),
  } }));
  assert.throws(() => workflowChainDataRequirement(tooMany), /mint slots/);
});

const canonical = JSON.parse(await readFile(new URL(
  "../../tbc-engine/rust/fixtures/tbc-transfer.json", import.meta.url,
), "utf8")).finalizeInput;
function preparedCase(standard = true) {
  const snapshot = structuredClone(canonical.snapshot);
  const identity = standard ? { standardId: "tbc20-standard", protocolVersion: "tbc20", templateRevision,
    genesisOutpoint: { txid: contractId, vout: 0 } } : {};
  snapshot.payload.contracts = [{ contractId, family: "ft", creationTxid: contractId,
    protocolVersion: "4.0", currentOutpoint: { txid: contractId, vout: 2 }, ...identity }];
  const intent = { type: intents[1], version: "1.0", contractId, to: canonical.request.from, amount: "1" };
  const payload = {
    version: "1.0", engineProfile: "tbc-engine-plan-v1",
    createdAt: snapshot.payload.capturedAt, expiresAt: canonical.plan.payload.expiresAt,
    intentHash: hashCanonical(intent), transactions: preparedProposalTransactions(canonical.plan.payload.transactions),
    evidence: { observedAt: snapshot.payload.capturedAt, parentTransactions: snapshot.payload.parents,
      contracts: [{ contractId, family: "ft", sourceTransactionId: contractId, ...structuredClone(identity) }] },
    estimatedTotalFee: canonical.plan.payload.preview.totalFee,
  };
  return { snapshot, prepared: { intent, proposal: { payload, proposalHash: hashCanonical(payload) } }, plan: canonical.plan };
}

test("Prepared evidence binds every new-standard identity field even after attacker rehashes proposal", () => {
  const original = preparedCase();
  assert.doesNotThrow(() => assertPreparedProposalForPlan(original.prepared, original.snapshot, original.plan));
  for (const field of ["standardId", "protocolVersion", "templateRevision", "genesisOutpoint"]) {
    for (const remove of [true, false]) {
      const { prepared, snapshot, plan } = preparedCase();
      const record = prepared.proposal.payload.evidence.contracts[0];
      if (remove) delete record[field];
      else record[field] = field === "genesisOutpoint" ? { txid: contractId, vout: 1 } : "tampered";
      prepared.proposal.proposalHash = hashCanonical(prepared.proposal.payload);
      assert.throws(() => assertPreparedProposalForPlan(prepared, snapshot, plan), /wallet-verified execution plan/,
        `${field} ${remove ? "missing" : "modified"}`);
    }
  }
  const changed = preparedCase();
  changed.prepared.proposal.payload.evidence.contracts[0].genesisOutpoint.txid = "cd".repeat(32);
  changed.prepared.proposal.proposalHash = hashCanonical(changed.prepared.proposal.payload);
  assert.throws(() => assertPreparedProposalForPlan(changed.prepared, changed.snapshot, changed.plan), /wallet-verified execution plan/);
});

test("historical Prepared contract evidence retains its old exact shape", () => {
  const { prepared, snapshot, plan } = preparedCase(false);
  assert.doesNotThrow(() => assertPreparedProposalForPlan(prepared, snapshot, plan));
  prepared.proposal.payload.evidence.contracts[0].protocolVersion = "4.0";
  prepared.proposal.proposalHash = hashCanonical(prepared.proposal.payload);
  assert.throws(() => assertPreparedProposalForPlan(prepared, snapshot, plan), /wallet-verified execution plan/);
});

test("Prepared chronology allows independent clocks but preserves interval and material integrity", () => {
  const {prepared, snapshot, plan} = preparedCase();
  const captured = Date.parse(snapshot.payload.capturedAt);
  for (const skew of [-1000, 0, 1000]) {
    const candidate = structuredClone(prepared);
    candidate.proposal.payload.createdAt = new Date(captured + skew).toISOString();
    candidate.proposal.payload.evidence.observedAt = candidate.proposal.payload.createdAt;
    candidate.proposal.proposalHash = hashCanonical(candidate.proposal.payload);
    const check = () => assertPreparedProposalForPlan(candidate, snapshot, plan);
    assert.doesNotThrow(check);
    candidate.proposal.payload.evidence.parentTransactions.push({txid: "11".repeat(32), rawTransaction: "00"});
    candidate.proposal.proposalHash = hashCanonical(candidate.proposal.payload);
    assert.throws(check, /wallet-verified execution plan/);
  }
  prepared.proposal.payload.createdAt = new Date(Date.parse(prepared.proposal.payload.expiresAt) + 1).toISOString();
  prepared.proposal.proposalHash = hashCanonical(prepared.proposal.payload);
  assert.throws(() => assertPreparedProposalForPlan(prepared, snapshot, plan), /PROPOSAL_STALE/);
});
