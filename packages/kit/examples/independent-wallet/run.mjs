import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import { composeTbcWorkflow, createTbcClient } from "@tbc/kit";
import { turingTransactionId } from "@tbc/kit/api";
import { createTbcEngine } from "@tbc/kit/engine";
import {
  createLegacyFtTransferIntentResolver,
  createLegacyPoolIntentResolver,
  createTbcLegacyMetadataResolver,
  createTbcNetworkContext,
  createTbcWallet,
  verifyTbcRecoverableSignature,
} from "@tbc/kit/wallet";

import {
  ACCOUNT_ID,
  ADDRESS,
  CHAIN_ID,
  FT_CONTRACT_ID,
  POOL_CONTRACT_ID,
  PUBLIC_KEY,
  RECIPIENT,
  createControlledPlatform,
} from "./controlled-platform.mjs";

const ORIGIN = "https://independent-wallet.example";
const NOW = "2026-09-19T00:00:10Z";

function permission(capability) {
  return Object.freeze({
    id: `independent-${capability}`,
    parentCapability: capability,
    invoker: ORIGIN,
    date: Date.parse("2026-09-19T00:00:00Z"),
    caveats: Object.freeze([
      Object.freeze({ type: "restrictChains", value: Object.freeze([CHAIN_ID]) }),
      Object.freeze({ type: "restrictAccounts", value: Object.freeze([ACCOUNT_ID]) }),
      Object.freeze({ type: "restrictMethods", value: Object.freeze([capability]) }),
    ]),
  });
}

/** Run a controlled consumer using only public @tbc/kit entry points. */
export async function runIndependentWalletExample() {
  const platform = createControlledPlatform();
  const account = Object.freeze({
    accountId: ACCOUNT_ID,
    address: ADDRESS,
    chainId: CHAIN_ID,
    publicKey: PUBLIC_KEY,
  });
  const accounts = Object.freeze({ current: async () => Object.freeze([account]) });
  const network = createTbcNetworkContext({ network: "testnet" });
  const approvals = [];
  const providerMethods = [];
  let signerCalls = 0;
  const runtime = createTbcWallet({
    productId: "org.example.independent-wallet",
    name: "Independent Wallet",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    accounts,
    legacy: false,
    approval: Object.freeze({
      async request(params) {
        approvals.push(params.preview.operationKind);
        return Object.freeze({
          status: "approved",
          approvalId: `independent-approval-${approvals.length}`,
          approvalToken: `independent-token-${approvals.length}`,
          bindingHash: params.binding.bindingHash,
          approvedAt: NOW,
          expiresAt: params.binding.payload.expiresAt,
        });
      },
    }),
    signer: { async sign(params) { signerCalls += 1; return platform.signer.sign(params); } },
    storage: Object.freeze({
      async loadPermissions() {
        return Object.freeze({
          revision: "0",
          permissions: Object.freeze([
            permission("tbc_accounts"),
            permission("tbc_signWorkflow"),
            permission("tbc_signTransaction"),
            permission("tbc_signMessage"),
          ]),
        });
      },
      async commitPermissions(params) {
        return Object.freeze({
          revisions: Object.freeze(params.changes.map((change) => Object.freeze({
            scope: change.scope,
            revision: "1",
          }))),
        });
      },
    }),
    network: Object.freeze({
      defaultNetwork: Object.freeze({
        network,
        fetch: platform.fetch,
        now: () => Date.parse("2026-09-19T00:00:00Z"),
        snapshotId: async () => "independent-wallet-snapshot",
      }),
    }),
    // In Node, this now loads the package-local WASM file without a custom
    // backend or a network download.
    engine: createTbcEngine(),
    clock: () => NOW,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });

  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "independent-wallet-session",
  });
  const client = createTbcClient({
    network: CHAIN_ID,
    provider: {
      ...session.provider,
      async request(request) {
        providerMethods.push(request.method);
        return session.provider.request(request);
      },
    },
    requestIdFactory: (() => {
      let id = 0;
      return () => `independent-request-${++id}`;
    })(),
  });
  const wallet = await client.connect();

  // One Standard request, one bound transaction/message approval. The shared
  // workflow derives signed transaction IDs and injects them into the message.
  const workflow = await wallet.walletBuild.signWorkflow(composeTbcWorkflow({
    clientRequestId: "independent-deposit-workflow",
    failureMode: "atomic",
    maxTotalFee: "200",
    steps: [{
      id: "deposit", kind: "transaction", dependsOn: [],
      intent: { version: "1.0", type: "tbc.transfer", to: RECIPIENT, amount: "1000" },
      constraints: { maxFee: "200" },
    }, {
      id: "receipt", kind: "message", dependsOn: ["deposit"],
      message: { encoding: "utf8", data: JSON.stringify({ purpose: "independent-wallet-deposit" }) },
      bindings: [{ target: "settlement", source: { stepId: "deposit", output: "transactionIds" } }],
    }],
  }));
  const transaction = workflow.steps[0].result;
  const message = workflow.steps[1].result;
  assert.ok(transaction.transactions.length > 0);
  const transactionIds = transaction.transactions.map(({ rawTransaction, txid }) => {
    assert.equal(turingTransactionId(rawTransaction), txid);
    return txid;
  });
  assert.equal(message.scheme, "tbc-message");
  assert.equal(message.envelope.message.encoding, "utf8");
  assert.deepEqual(JSON.parse(message.envelope.message.data), {
    purpose: "independent-wallet-deposit", settlement: transactionIds,
  });
  // Independently reconstruct this small message's TBC Signed Message digest.
  const magic = Buffer.from("TBC Signed Message:\n");
  const body = Buffer.from(message.envelope.message.data);
  assert.ok(magic.length < 253 && body.length < 253);
  const payload = Buffer.concat([Buffer.from([magic.length]), magic, Buffer.from([body.length]), body]);
  const digest = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest("hex");
  assert.equal(message.digest, digest);
  verifyTbcRecoverableSignature(Buffer.from(message.signature, "base64").toString("hex"), digest, PUBLIC_KEY);
  assert.equal(approvals.filter(kind => kind === "workflow").length, 1);
  const transactionGets = platform.http.length;
  assert.equal(transactionGets, 2, "one node-info and one funding read for the workflow");

  const metadata = createTbcLegacyMetadataResolver({ network, fetch: platform.fetch });
  const ftTransfers = createLegacyFtTransferIntentResolver({ chainId: CHAIN_ID, metadata });
  const pools = createLegacyPoolIntentResolver({ chainId: CHAIN_ID, metadata });
  const ft = await ftTransfers.resolve({
    flag: "FT_TRANSFER",
    ft_contract_address: FT_CONTRACT_ID,
    address: RECIPIENT,
    ft_amount: "1.25",
    tbc_amount: 0,
    broadcastEnabled: false,
  }, ADDRESS);
  const pool = await pools.resolve({
    flag: "POOLNFT_SWAP_TO_TBC",
    nft_contract_address: POOL_CONTRACT_ID,
    address: RECIPIENT,
    ft_amount: "2.5",
    poolNFT_version: 2,
    broadcastEnabled: false,
  }, ADDRESS);
  assert.equal(ft.intent.amount, "1250000");
  assert.equal(pool.intent.ftAmount, "2500000");
  assert.equal(platform.http.filter((entry) => entry.startsWith("POST ")).length, 0);

  session.close();
  return Object.freeze({
    productId: "org.example.independent-wallet",
    dependentStatus: "complete",
    approvals: approvals.length,
    workflowApprovals: approvals.filter(kind => kind === "workflow").length,
    signerCalls,
    transactionIdBindingVerified: true,
    providerMethods,
    transactionGets,
    metadataGets: platform.http.filter((entry) =>
      entry.includes("/ft/info/") || entry.includes("/pool/poolinfo/"),
    ).length,
    posts: 0,
    nodeDefaultWasm: true,
  });
}

if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(await runIndependentWalletExample()));
}
