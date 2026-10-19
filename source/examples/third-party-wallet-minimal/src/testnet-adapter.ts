import {
  canonicalize,
  hashCanonical,
  hexToBytes,
  sha256Hex,
  type BroadcastReconcileParams,
  type BroadcastReconcileResult,
  type BroadcastSubmitParams,
  type SignerSignParams,
  type SignerSignResult,
} from "@tbc-wallet/core";
import type { TbcEngineBackend } from "@tbc-wallet/tbc-engine";

import {
  TESTNET_CHAIN_ID,
  TESTNET_PROFILE,
  type MinimalTransferFixture,
} from "./fixtures.js";
import { createMinimalThirdPartyWallet } from "./wallet.js";

export const TBC_TESTNET_API_ORIGIN = "https://api.tbcdev.org";

export type TestnetAcceptanceErrorCode =
  | "INVALID_INPUT"
  | "NODE_RESPONSE_INVALID"
  | "NODE_REQUEST_FAILED"
  | "INSUFFICIENT_PUBLIC_INPUTS"
  | "AUTHORIZATION_REQUIRED"
  | "AUTHORIZATION_MISMATCH"
  | "SIGNED_TRANSACTION_DRIFT"
  | "BROADCAST_MISMATCH"
  | "CONFIRMATION_REQUIRED";

export class TestnetAcceptanceError extends Error {
  readonly code: TestnetAcceptanceErrorCode;

  constructor(code: TestnetAcceptanceErrorCode, message: string) {
    super(message);
    this.name = "TestnetAcceptanceError";
    this.code = code;
  }
}

export interface TbcTestnetNodeTip {
  readonly height: string;
  readonly hash: string;
}

export interface TbcTestnetUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: string;
  readonly height: string;
}

export interface TbcTestnetTransaction {
  readonly txid: string;
  readonly rawTransaction: string;
  readonly outputs: readonly Readonly<{
    vout: number;
    scriptPubKey: string;
    addresses: readonly string[];
  }>[];
}

export interface TbcTestnetTransactionStatus {
  readonly txid: string;
  readonly status: "unknown" | "mempool" | "confirmed" | "rejected";
  readonly confirmations?: string;
}

export interface TbcTestnetNodeAccess {
  readonly readTip: () => Promise<TbcTestnetNodeTip>;
  readonly listUnspent: (address: string) => Promise<readonly TbcTestnetUtxo[]>;
  readonly readTransaction: (txid: string) => Promise<TbcTestnetTransaction>;
  readonly broadcast: (
    rawTransaction: string,
  ) => Promise<Readonly<{ txid: string }>>;
  readonly transactionStatus: (
    txid: string,
  ) => Promise<TbcTestnetTransactionStatus>;
}

export interface TbcTestnetRestNodeOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}

export interface TbcTestnetAcceptancePreview {
  readonly version: "1.0";
  readonly chainId: typeof TESTNET_CHAIN_ID;
  readonly sourceAddress: string;
  readonly destinationAddress: string;
  readonly amount: string;
  readonly totalFee: string;
  readonly transactions: readonly Readonly<{
    txid: string;
    rawTransactionSha256: string;
  }>[];
  readonly packageCommit: string;
  readonly preparedAt: string;
  readonly approvalFingerprint: string;
}

export interface TbcTestnetAcceptanceInput {
  readonly node: TbcTestnetNodeAccess;
  readonly engineBackend: TbcEngineBackend;
  readonly source: Readonly<{
    address: string;
    publicKey: string;
  }>;
  readonly destination: string;
  readonly amount: string;
  readonly clientRequestId: string;
  readonly expiresAt: string;
  readonly packageCommit: string;
  readonly policy: Readonly<{
    feeRateSatPerKb: string;
    dustThreshold: string;
    minConfirmations: string;
    maxFee: string;
  }>;
  readonly signer: (
    task: SignerSignParams["task"],
  ) => SignerSignResult | Promise<SignerSignResult>;
  readonly clockNow: () => string | Promise<string>;
  readonly authorizeBroadcast?: (
    preview: TbcTestnetAcceptancePreview,
  ) => Promise<Readonly<{
    status: "approved" | "rejected";
    approvalFingerprint?: string;
  }>>;
}

export interface TbcTestnetAcceptanceResult {
  readonly status: "dry-run" | "broadcast" | "confirmed";
  readonly preview: TbcTestnetAcceptancePreview;
  readonly transactionIds: readonly string[];
  readonly transactionStatuses: readonly TbcTestnetTransactionStatus[];
  readonly verifiedAt: string;
}

export interface CredentialFreeTestnetRecord {
  readonly schemaVersion: "1.0";
  readonly status: "confirmed";
  readonly chainId: typeof TESTNET_CHAIN_ID;
  readonly sourceAddress: string;
  readonly destinationAddress: string;
  readonly transactionIds: readonly string[];
  readonly packageCommit: string;
  readonly preparedAt: string;
  readonly verifiedAt: string;
}

export interface TbcTestnetReadOnlyPreflightResult {
  readonly version: "1.0";
  readonly status: "pass";
  readonly baseUrl: typeof TBC_TESTNET_API_ORIGIN;
  readonly tip: TbcTestnetNodeTip;
  readonly publicUtxoCount: number;
  readonly sampledTransaction: Readonly<{
    txid: string;
    rawBytes: number;
    outputs: number;
    status: TbcTestnetTransactionStatus["status"];
    confirmations?: string;
  }>;
}

const HASH = /^[0-9a-f]{64}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE = /^[1-9][0-9]*$/;
const PREFLIGHT_PUBLIC_ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";

function fail(
  code: TestnetAcceptanceErrorCode,
  message: string,
): never {
  throw new TestnetAcceptanceError(code, message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("NODE_RESPONSE_INVALID", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    return fail("NODE_RESPONSE_INVALID", `${label} must be a string.`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail("NODE_RESPONSE_INVALID", `${label} must be a safe unsigned integer.`);
  }
  return value as number;
}

function assertHash(value: string, label: string): string {
  if (!HASH.test(value)) fail("NODE_RESPONSE_INVALID", `${label} must be hash32 hex.`);
  return value;
}

function assertRawTransaction(value: string): string {
  if (!HEX.test(value)) {
    fail("NODE_RESPONSE_INVALID", "Raw transaction must be lowercase even-length hex.");
  }
  return value;
}

function assertTimestamp(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  const canonical = Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString().replace(".000Z", "Z")
    : "";
  if (canonical !== value) {
    fail("INVALID_INPUT", `${label} must be a canonical RFC 3339 UTC timestamp.`);
  }
  return value;
}

function assertInput(input: TbcTestnetAcceptanceInput): void {
  for (const [value, label, pattern] of [
    [input.amount, "amount", POSITIVE],
    [input.policy.feeRateSatPerKb, "feeRateSatPerKb", POSITIVE],
    [input.policy.dustThreshold, "dustThreshold", UINT],
    [input.policy.minConfirmations, "minConfirmations", UINT],
    [input.policy.maxFee, "maxFee", UINT],
  ] as const) {
    if (!pattern.test(value)) fail("INVALID_INPUT", `${label} is invalid.`);
  }
  if (!/^[0-9a-f]{40}$/.test(input.packageCommit)) {
    fail("INVALID_INPUT", "packageCommit must be a full lowercase Git SHA.");
  }
  if (
    !/^[1-9A-HJ-NP-Za-km-z]{26,64}$/.test(input.source.address) ||
    !/^(02|03)[0-9a-f]{64}$/.test(input.source.publicKey) ||
    !/^[1-9A-HJ-NP-Za-km-z]{26,64}$/.test(input.destination) ||
    input.clientRequestId.length === 0 ||
    input.clientRequestId.length > 128
  ) {
    fail("INVALID_INPUT", "Public account, destination, and request ID are required.");
  }
  if (BigInt(input.policy.minConfirmations) > 4_294_967_295n) {
    fail("INVALID_INPUT", "minConfirmations exceeds uint32.");
  }
  if (typeof input.clockNow !== "function") {
    fail("INVALID_INPUT", "A wallet-controlled trusted clock is required.");
  }
  assertTimestamp(input.expiresAt, "expiresAt");
}

async function trustedNow(input: TbcTestnetAcceptanceInput): Promise<string> {
  return assertTimestamp(await input.clockNow(), "clockNow result");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

async function restJson(
  fetcher: typeof globalThis.fetch,
  url: URL,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch {
    return fail("NODE_REQUEST_FAILED", "TBC testnet node request failed.");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return fail("NODE_RESPONSE_INVALID", "TBC testnet node returned invalid JSON.");
  }
  const envelope = object(payload, "API envelope");
  if (!response.ok || envelope.code !== "200") {
    return fail("NODE_REQUEST_FAILED", "TBC testnet node rejected the request.");
  }
  return object(envelope.data, "API data");
}

export function createTbcTestnetRestNodeAccess(
  options: TbcTestnetRestNodeOptions,
): TbcTestnetNodeAccess {
  if (typeof options.fetch !== "function") {
    fail("INVALID_INPUT", "A user-provided Fetch implementation is required.");
  }
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    return fail("INVALID_INPUT", "The testnet API base URL is invalid.");
  }
  if (
    base.protocol !== "https:" ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    fail("INVALID_INPUT", "The testnet API base URL must be credential-free HTTPS.");
  }
  base.pathname = base.pathname.replace(/\/$/, "") + "/";
  const endpoint = (relative: string) => new URL(relative.replace(/^\//, ""), base);

  return Object.freeze({
    async readTip(): Promise<TbcTestnetNodeTip> {
      const data = await restJson(options.fetch, endpoint("api/tbc/nodeinfo"));
      return Object.freeze({
        height: String(integer(data.blocks, "nodeinfo.blocks")),
        hash: assertHash(string(data.bestblockhash, "nodeinfo.bestblockhash"), "best block hash"),
      });
    },
    async listUnspent(address: string): Promise<readonly TbcTestnetUtxo[]> {
      const data = await restJson(
        options.fetch,
        endpoint(`api/tbc/utxo/address/${encodeURIComponent(address)}`),
      );
      if (!Array.isArray(data.utxos)) {
        fail("NODE_RESPONSE_INVALID", "utxos must be an array.");
      }
      return Object.freeze(data.utxos.map((candidate, index) => {
        const utxo = object(candidate, `utxos[${index}]`);
        return Object.freeze({
          txid: assertHash(string(utxo.txid, "utxo.txid"), "UTXO txid"),
          vout: integer(utxo.index, "utxo.index"),
          satoshis: String(integer(utxo.value, "utxo.value")),
          height: String(integer(utxo.height, "utxo.height")),
        });
      }));
    },
    async readTransaction(txid: string): Promise<TbcTestnetTransaction> {
      assertHash(txid, "transaction ID");
      const [raw, decoded] = await Promise.all([
        restJson(options.fetch, endpoint(`api/tbc/txraw/txid/${txid}`)),
        restJson(options.fetch, endpoint(`api/tbc/decode/txid/${txid}`)),
      ]);
      const rawTransaction = assertRawTransaction(
        string(raw.txraw, "transaction.txraw"),
      );
      if (decoded.txid !== txid || (decoded.hex !== undefined && decoded.hex !== rawTransaction)) {
        fail("NODE_RESPONSE_INVALID", "Decoded transaction identity does not match raw data.");
      }
      if (!Array.isArray(decoded.vout)) {
        fail("NODE_RESPONSE_INVALID", "transaction.vout must be an array.");
      }
      const outputs = decoded.vout.map((candidate, index) => {
        const output = object(candidate, `transaction.vout[${index}]`);
        const script = object(output.scriptPubKey, "transaction.scriptPubKey");
        const addresses = script.addresses === undefined ? [] : script.addresses;
        if (!Array.isArray(addresses) || addresses.some((address) => typeof address !== "string")) {
          fail("NODE_RESPONSE_INVALID", "transaction addresses are invalid.");
        }
        return Object.freeze({
          vout: integer(output.n, "transaction.vout.n"),
          scriptPubKey: assertRawTransaction(string(script.hex, "scriptPubKey.hex")),
          addresses: Object.freeze([...(addresses as string[])]),
        });
      });
      return Object.freeze({
        txid,
        rawTransaction,
        outputs: Object.freeze(outputs),
      });
    },
    async broadcast(rawTransaction: string): Promise<Readonly<{ txid: string }>> {
      assertRawTransaction(rawTransaction);
      const data = await restJson(
        options.fetch,
        endpoint("api/tbc/broadcasttx"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ txraw: rawTransaction }),
        },
      );
      return Object.freeze({
        txid: assertHash(string(data.txid, "broadcast.txid"), "broadcast txid"),
      });
    },
    async transactionStatus(txid: string): Promise<TbcTestnetTransactionStatus> {
      assertHash(txid, "transaction ID");
      const data = await restJson(
        options.fetch,
        endpoint(`api/tbc/decode/txid/${txid}`),
      );
      if (data.txid !== txid) {
        fail("NODE_RESPONSE_INVALID", "Status transaction identity does not match.");
      }
      const confirmations = integer(data.confirmations ?? 0, "transaction.confirmations");
      return Object.freeze({
        txid,
        status: confirmations > 0 ? "confirmed" : "mempool",
        confirmations: String(confirmations),
      });
    },
  });
}

export async function runTbcTestnetReadOnlyPreflight(
  options: Readonly<{ fetch: typeof globalThis.fetch }>,
): Promise<TbcTestnetReadOnlyPreflightResult> {
  if (typeof options.fetch !== "function") {
    fail("INVALID_INPUT", "A user-provided Fetch implementation is required.");
  }
  const readOnlyFetch: typeof globalThis.fetch = (input, init) => {
    const RequestConstructor = globalThis.Request;
    const requestMethod = typeof RequestConstructor === "function" &&
        input instanceof RequestConstructor
      ? input.method
      : "GET";
    const method = String(init?.method ?? requestMethod).toUpperCase();
    if (method !== "GET") {
      return Promise.reject(
        new TestnetAcceptanceError(
          "AUTHORIZATION_REQUIRED",
          "Read-only testnet preflight rejected a network write.",
        ),
      );
    }
    return options.fetch(input, init);
  };
  const node = createTbcTestnetRestNodeAccess({
    baseUrl: TBC_TESTNET_API_ORIGIN,
    fetch: readOnlyFetch,
  });
  const tip = await node.readTip();
  const [unspent, block] = await Promise.all([
    node.listUnspent(PREFLIGHT_PUBLIC_ADDRESS),
    restJson(
      readOnlyFetch,
      new URL(
        `/api/tbc/blockByHeight/height/${tip.height}`,
        TBC_TESTNET_API_ORIGIN,
      ),
    ),
  ]);
  if (!Array.isArray(block.tx) || block.tx.length === 0) {
    fail("NODE_RESPONSE_INVALID", "The current testnet block has no transaction IDs.");
  }
  const txids = block.tx.map((value, index) =>
    assertHash(string(value, `block.tx[${index}]`), `block.tx[${index}]`)
  );
  const coinbaseTxid = assertHash(
    string(block.coinbasetxid, "block.coinbasetxid"),
    "block coinbase transaction ID",
  );
  if (!txids.includes(coinbaseTxid)) {
    fail("NODE_RESPONSE_INVALID", "The block transaction list omits its coinbase transaction.");
  }
  const [transaction, transactionStatus] = await Promise.all([
    node.readTransaction(coinbaseTxid),
    node.transactionStatus(coinbaseTxid),
  ]);
  return deepFreeze({
    version: "1.0",
    status: "pass",
    baseUrl: TBC_TESTNET_API_ORIGIN,
    tip,
    publicUtxoCount: unspent.length,
    sampledTransaction: {
      txid: transaction.txid,
      rawBytes: transaction.rawTransaction.length / 2,
      outputs: transaction.outputs.length,
      status: transactionStatus.status,
      ...(transactionStatus.confirmations === undefined
        ? {}
        : { confirmations: transactionStatus.confirmations }),
    },
  });
}

export async function buildTbcTestnetFixture(
  input: TbcTestnetAcceptanceInput,
): Promise<MinimalTransferFixture> {
  assertInput(input);
  const [capturedAt, tip, unspent] = await Promise.all([
    trustedNow(input),
    input.node.readTip(),
    input.node.listUnspent(input.source.address),
  ]);
  if (Date.parse(input.expiresAt) <= Date.parse(capturedAt)) {
    fail("INVALID_INPUT", "expiresAt must follow the trusted snapshot time.");
  }
  if (!POSITIVE.test(tip.height) || !HASH.test(tip.hash)) {
    fail("NODE_RESPONSE_INVALID", "The node tip is invalid.");
  }
  if (unspent.length === 0) {
    fail("INSUFFICIENT_PUBLIC_INPUTS", "The source address has no public testnet UTXOs.");
  }
  const tipHeight = BigInt(tip.height);
  const transactions = new Map<string, TbcTestnetTransaction>();
  for (const txid of [...new Set(unspent.map((utxo) => utxo.txid))]) {
    transactions.set(txid, await input.node.readTransaction(txid));
  }
  const seenOutpoints = new Set<string>();
  const utxos = unspent.map((utxo) => {
    if (
      !HASH.test(utxo.txid) ||
      !Number.isSafeInteger(utxo.vout) ||
      utxo.vout < 0 ||
      !POSITIVE.test(utxo.satoshis) ||
      !UINT.test(utxo.height)
    ) {
      return fail("NODE_RESPONSE_INVALID", "A public UTXO is invalid.");
    }
    const outpoint = `${utxo.txid}:${utxo.vout}`;
    if (seenOutpoints.has(outpoint)) {
      return fail("NODE_RESPONSE_INVALID", "The public UTXO list contains a duplicate.");
    }
    seenOutpoints.add(outpoint);
    const transaction = transactions.get(utxo.txid);
    const output = transaction?.outputs.find(({ vout }) => vout === utxo.vout);
    if (
      transaction?.txid !== utxo.txid ||
      output === undefined ||
      !output.addresses.includes(input.source.address)
    ) {
      return fail("NODE_RESPONSE_INVALID", "A UTXO parent does not bind the source address.");
    }
    const height = BigInt(utxo.height);
    if (height > tipHeight) {
      return fail("NODE_RESPONSE_INVALID", "A UTXO height exceeds the node tip.");
    }
    return {
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.satoshis,
      scriptPubKey: output.scriptPubKey,
      confirmations: height === 0n ? "0" : String(tipHeight - height + 1n),
      classification: "native" as const,
    };
  });
  const account = {
    address: input.source.address,
    accountId: `${TESTNET_CHAIN_ID}:${input.source.address}`,
    chainId: TESTNET_CHAIN_ID,
    publicKey: input.source.publicKey,
  } as const;
  const snapshotPayload = {
    version: "1.0",
    snapshotId: `testnet-${input.clientRequestId}`,
    chainId: TESTNET_CHAIN_ID,
    block: { height: tip.height, hash: tip.hash },
    capturedAt,
    expiresAt: input.expiresAt,
    account,
    utxos,
    parents: [...transactions.values()].map(({ txid, rawTransaction }) => ({
      txid,
      rawTransaction,
    })),
    contracts: [],
  } as const;
  const policyPayload = {
    version: "1.0",
    policyId: `testnet-policy-${input.clientRequestId}`,
    revision: "1",
    chainId: TESTNET_CHAIN_ID,
    feeRateSatPerKb: input.policy.feeRateSatPerKb,
    dustThreshold: input.policy.dustThreshold,
    minConfirmations: input.policy.minConfirmations,
    maxBundleTransactions: 32,
    sighashType: 65,
    contractPolicies: [],
    amountLimits: [{ scope: "native", maximum: "2100000000000000" }],
    expiresAt: input.expiresAt,
  } as const;
  const request = {
    version: "1.0",
    chainId: TESTNET_CHAIN_ID,
    from: input.source.address,
    clientRequestId: input.clientRequestId,
    intent: {
      type: "tbc.transfer",
      version: "1.0",
      to: input.destination,
      amount: input.amount,
    },
    constraints: {
      expiresAt: input.expiresAt,
      maxFee: input.policy.maxFee,
      feePreference: "standard",
    },
  } as const;
  return deepFreeze({
    profile: TESTNET_PROFILE,
    request,
    account,
    snapshot: {
      payload: snapshotPayload,
      snapshotHash: hashCanonical(snapshotPayload),
    },
    policy: {
      payload: policyPayload,
      policyHash: hashCanonical(policyPayload),
    },
  } as MinimalTransferFixture);
}

function signatureIdentity(task: SignerSignParams["task"]): string {
  if (task.purpose !== "transaction") {
    fail("INVALID_INPUT", "Testnet acceptance only signs transaction tasks.");
  }
  return hashCanonical({
    purpose: task.purpose,
    algorithm: task.algorithm,
    digest: task.digest,
    signatureEncoding: task.signatureEncoding,
    transactionTemplateId: task.transactionTemplateId,
    inputIndex: task.inputIndex,
    accountId: task.accountId,
    publicKey: task.publicKey,
    sighashType: task.sighashType,
  });
}

function previewFor(
  input: TbcTestnetAcceptanceInput,
  preparedAt: string,
  bundle: Readonly<{
    totalFee: string;
    transactions: readonly Readonly<{
      txid: string;
      rawTransaction: string;
    }>[];
  }>,
): TbcTestnetAcceptancePreview {
  const payload = {
    version: "1.0" as const,
    chainId: TESTNET_CHAIN_ID,
    sourceAddress: input.source.address,
    destinationAddress: input.destination,
    amount: input.amount,
    totalFee: bundle.totalFee,
    transactions: bundle.transactions.map((transaction) => ({
      txid: transaction.txid,
      rawTransactionSha256: sha256Hex(hexToBytes(transaction.rawTransaction)),
    })),
    packageCommit: input.packageCommit,
    preparedAt,
  };
  return deepFreeze({
    ...payload,
    approvalFingerprint: hashCanonical(payload),
  });
}

async function statusOrUnknown(
  node: TbcTestnetNodeAccess,
  txid: string,
): Promise<TbcTestnetTransactionStatus> {
  try {
    const result = await node.transactionStatus(txid);
    if (
      result.txid !== txid ||
      !["unknown", "mempool", "confirmed", "rejected"].includes(result.status) ||
      (result.confirmations !== undefined && !UINT.test(result.confirmations))
    ) {
      throw new Error("invalid transaction status");
    }
    return result;
  } catch {
    return Object.freeze({ txid, status: "unknown" });
  }
}

export async function runTbcTestnetAcceptance(
  input: TbcTestnetAcceptanceInput,
): Promise<TbcTestnetAcceptanceResult> {
  const fixture = await buildTbcTestnetFixture(input);
  const signatures = new Map<string, SignerSignResult>();
  const dryWallet = createMinimalThirdPartyWallet({
    fixture,
    engineBackend: input.engineBackend,
    preauthorizeAccounts: true,
    clockNow: () => trustedNow(input),
    async signDigest(task) {
      const result = await input.signer(task);
      signatures.set(signatureIdentity(task), result);
      return result;
    },
  });
  const dryBundle = await dryWallet.provider.request({
    method: "tbc_signTransaction",
    params: fixture.request,
  });
  const preview = previewFor(input, fixture.snapshot.payload.capturedAt, dryBundle);
  if (input.authorizeBroadcast === undefined) {
    return deepFreeze({
      status: "dry-run",
      preview,
      transactionIds: preview.transactions.map(({ txid }) => txid),
      transactionStatuses: [],
      verifiedAt: await trustedNow(input),
    });
  }
  const authorization = await input.authorizeBroadcast(preview);
  if (authorization.status !== "approved") {
    fail("AUTHORIZATION_REQUIRED", "Explicit testnet broadcast authority was rejected.");
  }
  if (authorization.approvalFingerprint !== preview.approvalFingerprint) {
    fail("AUTHORIZATION_MISMATCH", "Broadcast authority did not echo the exact preview.");
  }
  const approvedTransactions = new Map(
    preview.transactions.map((transaction) => [transaction.txid, transaction]),
  );
  const liveWallet = createMinimalThirdPartyWallet({
    fixture,
    engineBackend: input.engineBackend,
    preauthorizeAccounts: true,
    clockNow: () => trustedNow(input),
    signDigest(task) {
      const cached = signatures.get(signatureIdentity(task));
      if (cached === undefined) {
        return fail("SIGNED_TRANSACTION_DRIFT", "Live signing task differs from dry-run.");
      }
      return { ...cached, taskId: task.taskId };
    },
    async broadcastSubmit(params: BroadcastSubmitParams) {
      const approved = approvedTransactions.get(params.transaction.txid);
      const rawHash = sha256Hex(hexToBytes(params.transaction.rawTransaction));
      if (approved?.rawTransactionSha256 !== rawHash) {
        return fail("SIGNED_TRANSACTION_DRIFT", "Final transaction differs from approval.");
      }
      const submitted = await input.node.broadcast(params.transaction.rawTransaction);
      if (submitted.txid !== params.transaction.txid) {
        return fail("BROADCAST_MISMATCH", "Node returned a different transaction ID.");
      }
      return { txid: submitted.txid, status: "accepted" };
    },
    async broadcastReconcile(
      params: BroadcastReconcileParams,
    ): Promise<BroadcastReconcileResult> {
      return {
        transactions: await Promise.all(
          params.txids.map((txid) => input.node.transactionStatus(txid)),
        ),
      };
    },
  });
  const submitted = await liveWallet.provider.request({
    method: "tbc_sendTransaction",
    params: fixture.request,
  });
  const transactionIds = Array.from(
    submitted.transactions as readonly unknown[],
    (candidate) => {
      const transaction = object(candidate, "submitted transaction");
      const txid = string(transaction.txid, "submitted transaction txid");
      return assertHash(txid, "submitted transaction txid");
    },
  );
  if (canonicalize(transactionIds) !== canonicalize([...approvedTransactions.keys()])) {
    fail("SIGNED_TRANSACTION_DRIFT", "Submitted transaction IDs differ from dry-run.");
  }
  const transactionStatuses = await Promise.all(
    transactionIds.map((txid) => statusOrUnknown(input.node, txid)),
  );
  const confirmed = transactionStatuses.every(({ status }) => status === "confirmed");
  return deepFreeze({
    status: confirmed ? "confirmed" : "broadcast",
    preview,
    transactionIds,
    transactionStatuses,
    verifiedAt: await trustedNow(input),
  });
}

export async function refreshTbcTestnetAcceptance(
  node: TbcTestnetNodeAccess,
  result: TbcTestnetAcceptanceResult,
  verifiedAt: string,
): Promise<TbcTestnetAcceptanceResult> {
  if (result.status === "dry-run") {
    fail("CONFIRMATION_REQUIRED", "A dry-run has no broadcast to confirm.");
  }
  assertTimestamp(verifiedAt, "verifiedAt");
  const transactionStatuses = await Promise.all(
    result.transactionIds.map((txid) => statusOrUnknown(node, txid)),
  );
  return deepFreeze({
    status: transactionStatuses.every(({ status }) => status === "confirmed")
      ? "confirmed"
      : "broadcast",
    preview: result.preview,
    transactionIds: [...result.transactionIds],
    transactionStatuses,
    verifiedAt,
  });
}

export function createCredentialFreeTestnetRecord(
  result: TbcTestnetAcceptanceResult,
): CredentialFreeTestnetRecord {
  const { approvalFingerprint, ...previewPayload } = result.preview;
  const previewTransactionIds = result.preview.transactions.map(({ txid }) => txid);
  const confirmedIds = result.transactionStatuses
    .filter(({ status, confirmations }) =>
      status === "confirmed" &&
      confirmations !== undefined &&
      POSITIVE.test(confirmations)
    )
    .map(({ txid }) => txid);
  if (
    result.status !== "confirmed" ||
    result.preview.chainId !== TESTNET_CHAIN_ID ||
    !/^[1-9A-HJ-NP-Za-km-z]{26,64}$/.test(result.preview.sourceAddress) ||
    !/^[1-9A-HJ-NP-Za-km-z]{26,64}$/.test(result.preview.destinationAddress) ||
    !/^[0-9a-f]{40}$/.test(result.preview.packageCommit) ||
    approvalFingerprint !== hashCanonical(previewPayload) ||
    result.transactionIds.length === 0 ||
    result.transactionIds.some((txid) => !HASH.test(txid)) ||
    canonicalize(result.transactionIds) !== canonicalize(previewTransactionIds) ||
    canonicalize(result.transactionIds) !== canonicalize(confirmedIds)
  ) {
    fail("CONFIRMATION_REQUIRED", "A credential-free record requires confirmation.");
  }
  assertTimestamp(result.preview.preparedAt, "preparedAt");
  assertTimestamp(result.verifiedAt, "verifiedAt");
  return deepFreeze({
    schemaVersion: "1.0",
    status: "confirmed",
    chainId: result.preview.chainId,
    sourceAddress: result.preview.sourceAddress,
    destinationAddress: result.preview.destinationAddress,
    transactionIds: [...result.transactionIds],
    packageCommit: result.preview.packageCommit,
    preparedAt: result.preview.preparedAt,
    verifiedAt: result.verifiedAt,
  });
}
