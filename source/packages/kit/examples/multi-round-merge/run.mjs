import {
  createTbcMultiRoundMergeOrchestrator,
  hashTbcMultiRoundMergeState,
  hashCanonical,
} from "@tbc/kit/wallet";

const authority = Object.freeze({
  chainId: "tbc:testnet",
  accountId: "tbc:testnet:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  origin: "https://wallet.example",
  sessionId: "bounded-merge-example",
});
const asset = Object.freeze({ kind: "tbc" });
let count = 205;
let observedTransactionIds = [];

function state() {
  const payload = {
    version: "1.0",
    authority,
    asset,
    observedAt: "2026-09-23T00:00:00Z",
    revision: `controlled-${count}`,
    utxoCount: count,
    observedTransactionIds,
  };
  return Object.freeze({ ...payload, stateHash: hashTbcMultiRoundMergeState(payload) });
}

const orchestrator = createTbcMultiRoundMergeOrchestrator({
  readState: async () => state(),
  approve: async ({ scopeHash }) => ({
    status: "approved",
    scopeHash,
    approvalId: "example-bounded-consent",
    approvedAt: "2026-09-23T00:00:00Z",
    expiresAt: "2026-09-23T00:04:00Z",
  }),
  prepareStep: async ({ state: current, stepIndex, acceptedTxids }) => {
    const inputCount = Math.min(100, current.utxoCount);
    const material = { controlledFixture: true, stepIndex, inputCount };
    return Object.freeze({
      version: "1.0",
      stepId: `merge-${stepIndex}`,
      stepIndex,
      authority,
      asset,
      stateHash: current.stateHash,
      materialHash: hashCanonical(material),
      inputCount,
      outputCount: 1,
      fee: "100",
      expiresAt: "2026-09-23T00:03:00Z",
      dependsOn: acceptedTxids.slice(-1),
      prepared: material,
    });
  },
  // CONTROLLED FIXTURE. Production code delegates here to the shared Kit path.
  executePreparedStep: async ({ step }) => {
    const txid = hashCanonical({ controlledTransaction: step.materialHash });
    count = count - step.inputCount + 1;
    observedTransactionIds = [txid];
    return Object.freeze({
      status: "accepted",
      stepId: step.stepId,
      materialHash: step.materialHash,
      txid,
      fee: step.fee,
      inputsConsumed: step.inputCount,
      outputsCreated: 1,
    });
  },
  reconcile: async ({ txid }) => Object.freeze({ txid, status: "known" }),
}, { now: () => Date.parse("2026-09-23T00:00:00Z") });

const result = await orchestrator.run({
  authority,
  asset,
  limits: {
    targetUtxoCount: 1,
    maxTransactions: 4,
    maxTotalFee: "1000",
    expiresAt: "2026-09-23T00:05:00Z",
    maxIndexRefreshes: 2,
    indexRefreshDelayMs: 0,
  },
  onProgress: ({ phase, stepIndex, utxoCount }) => {
    console.log(`${phase} step=${stepIndex} utxos=${utxoCount}`);
  },
});

console.log(JSON.stringify(result, null, 2));
if (result.status !== "complete" || result.steps.length !== 3) process.exitCode = 1;
