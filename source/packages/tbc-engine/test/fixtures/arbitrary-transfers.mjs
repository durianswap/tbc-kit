import { hashCanonical } from "@tbc-wallet/core";

export const SOURCE_PUBLIC_KEY =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
export const RECIPIENT_PUBLIC_KEY =
  "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

const SOURCE_ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const RECIPIENT_ADDRESS = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
const SOURCE_SCRIPT = "76a914751e76e8199196d454941c45d1b3a323f1433bd688ac";

export function rehashSnapshot(snapshot) {
  return { payload: snapshot.payload, snapshotHash: hashCanonical(snapshot.payload) };
}

export function rehashPolicy(policy) {
  return { payload: policy.payload, policyHash: hashCanonical(policy.payload) };
}

export function makeTransferFixture(internals, options = {}) {
  const chainId = options.chainId ?? "tbc:mainnet";
  const p2pkhVersion = options.p2pkhVersion ?? 0x00;
  const sourceAddress = internals.publicKeyToAddress(SOURCE_PUBLIC_KEY, p2pkhVersion);
  const recipientAddress = internals.publicKeyToAddress(
    RECIPIENT_PUBLIC_KEY,
    p2pkhVersion,
  );
  const sourceScript = internals.publicKeyToP2pkhScript(SOURCE_PUBLIC_KEY);
  const amounts = options.utxoAmounts ?? [2_000n];
  const entries = amounts.map((satoshis, index) => {
    const parent = {
      version: 10,
      inputs: [
        {
          txid: BigInt(index + 1).toString(16).padStart(64, "0"),
          vout: index,
          scriptSig: Uint8Array.of(0x51, index),
          sequence: 0xffffffff,
        },
      ],
      outputs: [{ satoshis, scriptPubKey: sourceScript }],
      locktime: index,
    };
    const rawTransaction = internals.bytesToHex(
      internals.serializeTransaction(parent),
    );
    const txid = internals.turingTxid(parent);
    return {
      parent: { txid, rawTransaction },
      utxo: {
        txid,
        vout: 0,
        satoshis: satoshis.toString(),
        scriptPubKey: internals.bytesToHex(sourceScript),
        confirmations: String(options.confirmations ?? 100),
        classification: "native",
      },
    };
  });
  const order = options.order ?? entries.map((_, index) => index);
  const ordered = order.map((index) => entries[index]);
  const request = {
    version: "1.0",
    chainId,
    from: sourceAddress,
    intent: {
      type: "tbc.transfer",
      version: "1.0",
      to: recipientAddress,
      amount: String(options.amount ?? 1_000n),
    },
    ...(options.maxFee === undefined
      ? {}
      : { constraints: { maxFee: String(options.maxFee) } }),
  };
  const snapshotPayload = {
    version: "1.0",
    snapshotId: "arbitrary-snapshot-1",
    chainId,
    block: { height: "1000", hash: "aa".repeat(32) },
    capturedAt: "2026-08-31T12:00:00Z",
    expiresAt: "2026-08-31T12:02:00Z",
    account: {
      address: sourceAddress,
      accountId: `${chainId}:${sourceAddress}`,
      chainId,
      publicKey: SOURCE_PUBLIC_KEY,
    },
    utxos: ordered.map(({ utxo }) => utxo),
    parents: ordered.map(({ parent }) => parent),
    contracts: [],
  };
  const policyPayload = {
    version: "1.0",
    policyId: "arbitrary-policy-1",
    revision: "1",
    chainId,
    feeRateSatPerKb: String(options.fee ?? 80n),
    dustThreshold: String(options.dust ?? 24n),
    minConfirmations: String(options.minConfirmations ?? 1),
    maxBundleTransactions: 32,
    sighashType: 65,
    contractPolicies: [],
    amountLimits: [
      {
        scope: "native",
        maximum: String(options.maximum ?? 21_000_000_000_000_00n),
      },
    ],
    expiresAt: "2026-08-31T12:05:00Z",
  };
  const snapshot = {
    payload: snapshotPayload,
    snapshotHash: hashCanonical(snapshotPayload),
  };
  const policy = {
    payload: policyPayload,
    policyHash: hashCanonical(policyPayload),
  };
  const requestHash = hashCanonical(request);
  return {
    profile: { chainId, p2pkhVersion, transactionVersion: 10 },
    request,
    requestHash,
    snapshot,
    policy,
    params: { version: "1.0", request, requestHash, snapshot, policy },
  };
}

// Current Rust planning treats parent bytes as optional consistency evidence
// for plain native UTXOs. Host integration fixtures therefore bind the exact
// public wallet material directly instead of rebuilding the removed pre-Rust
// TypeScript transaction/address internals.
export function makeRustTransferFixture(options = {}) {
  const chainId = options.chainId ?? "tbc:mainnet";
  const amounts = options.utxoAmounts ?? [2_000n];
  const request = {
    version: "1.0",
    chainId,
    from: SOURCE_ADDRESS,
    intent: {
      type: "tbc.transfer",
      version: "1.0",
      to: options.to ?? RECIPIENT_ADDRESS,
      amount: String(options.amount ?? 1_000n),
    },
    ...(options.maxFee === undefined
      ? {}
      : { constraints: { maxFee: String(options.maxFee) } }),
  };
  const snapshotPayload = {
    version: "1.0",
    snapshotId: "rust-host-transfer-snapshot-1",
    chainId,
    block: { height: "1000", hash: "aa".repeat(32) },
    capturedAt: "2026-08-31T12:00:00Z",
    expiresAt: "2026-08-31T12:02:00Z",
    account: {
      address: SOURCE_ADDRESS,
      accountId: `${chainId}:${SOURCE_ADDRESS}`,
      chainId,
      publicKey: SOURCE_PUBLIC_KEY,
    },
    utxos: amounts.map((satoshis, index) => ({
      txid: BigInt(index + 1).toString(16).padStart(64, "0"),
      vout: 0,
      satoshis: satoshis.toString(),
      scriptPubKey: SOURCE_SCRIPT,
      confirmations: String(options.confirmations ?? 100),
      classification: "native",
    })),
    parents: [],
    contracts: [],
  };
  const policyPayload = {
    version: "1.0",
    policyId: "rust-host-transfer-policy-1",
    revision: "1",
    chainId,
    feeRateSatPerKb: String(options.fee ?? 80n),
    dustThreshold: "24",
    minConfirmations: String(options.minConfirmations ?? 1),
    maxBundleTransactions: 32,
    sighashType: 65,
    contractPolicies: [],
    amountLimits: [
      {
        scope: "native",
        maximum: String(options.maximum ?? 21_000_000_000_000_00n),
      },
    ],
    expiresAt: "2026-08-31T12:05:00Z",
  };
  return {
    request,
    requestHash: hashCanonical(request),
    snapshot: {
      payload: snapshotPayload,
      snapshotHash: hashCanonical(snapshotPayload),
    },
    policy: {
      payload: policyPayload,
      policyHash: hashCanonical(policyPayload),
    },
  };
}
