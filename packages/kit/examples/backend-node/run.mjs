import { secp256k1 } from "@noble/curves/secp256k1.js";
import { signControlledTask } from "../shared/controlled-signer.mjs";
import { hashCanonical } from "@tbc/kit/wallet";
import { createTbcEngine } from "@tbc/kit/engine";
import { createTbcBackendService } from "@tbc/kit/wallet";

const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const ACCOUNT_ID = `${CHAIN_ID}:${ADDRESS}`;
const PRIVATE_KEY = "01".padStart(64, "0");
const NOW = "2026-09-25T00:00:00Z";
const EXPIRES = "2026-09-25T00:05:00Z";
const TXID = "ddb917e8cad41edda4a38fd8cb8cb51a8511c8bc51ab7f62b97a039af3d9125c";
const RAW = "0a00000001020000000000000000000000000000000000000000000000000000000000000001000000025101ffffffff01b0040000000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac01000000";
const SCRIPT = "76a914751e76e8199196d454941c45d1b3a323f1433bd688ac";
const account = Object.freeze({
  accountId: ACCOUNT_ID,
  address: ADDRESS,
  chainId: CHAIN_ID,
  publicKey: Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex"),
});
const action = process.argv.includes("--send") ? "send" : "sign";

let chainReads = 0;
let submitCalls = 0;
let reconcileCalls = 0;
const snapshotPayload = Object.freeze({
  version: "1.0",
  snapshotId: "backend-node-controlled",
  chainId: CHAIN_ID,
  block: Object.freeze({ height: "1000", hash: "aa".repeat(32) }),
  capturedAt: NOW,
  expiresAt: EXPIRES,
  account,
  utxos: Object.freeze([Object.freeze({
    txid: TXID,
    vout: 0,
    satoshis: "1200",
    scriptPubKey: SCRIPT,
    confirmations: "100",
    classification: "native",
  })]),
  parents: Object.freeze([Object.freeze({ txid: TXID, rawTransaction: RAW })]),
  contracts: Object.freeze([]),
});
const policyPayload = Object.freeze({
  version: "1.0",
  policyId: "backend-node-controlled",
  revision: "1",
  chainId: CHAIN_ID,
  feeRateSatPerKb: "80",
  dustThreshold: "24",
  minConfirmations: "1",
  maxBundleTransactions: 32,
  sighashType: 65,
  contractPolicies: Object.freeze([]),
  amountLimits: Object.freeze([Object.freeze({ scope: "native", maximum: "2100000000000000" })]),
  expiresAt: EXPIRES,
});
const network = Object.freeze({
  async resolveChainData() {
    chainReads += 1;
    return Object.freeze({ payload: snapshotPayload, snapshotHash: hashCanonical(snapshotPayload) });
  },
  async resolvePolicy() {
    return Object.freeze({ payload: policyPayload, policyHash: hashCanonical(policyPayload) });
  },
  ...(action === "send" ? {
    async broadcastSubmit(params) {
      submitCalls += 1;
      return Object.freeze({
        portError: Object.freeze({
          name: "UNAVAILABLE",
          message: `controlled response loss after accepting ${params.transaction.txid}`,
          retryable: true,
        }),
      });
    },
    async broadcastReconcile(params) {
      reconcileCalls += 1;
      return Object.freeze({
        transactions: Object.freeze(params.txids.map((txid) => Object.freeze({ txid, status: "mempool" }))),
      });
    },
  } : {}),
});

const engineCalls = [];
const bundled = createTbcEngine();
const engine = Object.freeze(Object.fromEntries(["normalizeRequest", "plan", "validate", "finalize"].map((method) => [
  method,
  async (params) => {
    engineCalls.push(method);
    return bundled[method](params);
  },
])));
const prepareOnly = createTbcBackendService({
  serviceId: "org.example.backend-prepare",
  account,
  network,
  engine,
});
const prepared = await prepareOnly.prepareTransaction(Object.freeze({
  version: "1.0",
  chainId: CHAIN_ID,
  from: ADDRESS,
  clientRequestId: "backend-node-example",
  intent: Object.freeze({
    version: "1.0",
    type: "tbc.transfer",
    to: "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP",
    amount: "1000",
  }),
  constraints: Object.freeze({ maxFee: "200" }),
}));
prepareOnly.close();

const serializedForWallet = JSON.parse(JSON.stringify(prepared));
let authorizations = 0;
let signerCalls = 0;
const executor = createTbcBackendService({
  serviceId: "org.example.backend-executor",
  account,
  network,
  engine,
  authorize: async () => {
    authorizations += 1;
    return Object.freeze({ status: "approved", decisionId: "controlled-backend-decision", approvedAt: NOW });
  },
  signer: Object.freeze({
    async sign(params) {
      signerCalls += 1;
      return Object.freeze(signControlledTask(params.task, PRIVATE_KEY));
    },
  }),
  clock: () => NOW,
  randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
});
const result = await executor.executePrepared({
  kind: "transaction",
  action,
  prepared: serializedForWallet,
});
executor.close();

console.log(JSON.stringify({
  preparedProposalHash: prepared.proposal.proposalHash,
  preparedSerializable: hashCanonical(prepared) === hashCanonical(serializedForWallet),
  action,
  transactions: result.transactions.length,
  chainReads,
  enginePlans: engineCalls.filter((method) => method === "plan").length,
  authorizations,
  signerCalls,
  submitCalls,
  reconcileCalls,
  externalPosts: 0,
}));
