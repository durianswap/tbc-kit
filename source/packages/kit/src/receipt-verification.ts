import { createLazyBundledWasmTbcKeylessEngine } from "./keyless.js";
import {
  createTestnetClient,
  isTestnetNodeError,
  OFFICIAL_TBC_TESTNET_API_ORIGIN,
  type TestnetClient,
  type TestnetFetch,
  type TestnetLookupTransaction,
} from "./testnet-client.js";
import { assertTestnetAddress } from "./testnet-validation.js";

const HASH = /^[0-9a-f]{64}$/u;
const UINT = /^(?:0|[1-9][0-9]*)$/u;
const POSITIVE = /^[1-9][0-9]*$/u;
const HEX = /^(?:[0-9a-f]{2})+$/u;
const DISPLAY = /^(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/u;
const MAX_DECIMALS = 18;
const NFT_HOLD_SUFFIX = "6a0d56302043757272204e486f6c64";

export const TBC_ATOMIC_DECIMALS = 6 as const;
export const TBC_MAINNET_API_ORIGIN = "https://api.turingbitchain.io" as const;

export type TransferNetwork = "mainnet" | "testnet";

const RECEIPT_NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    chainId: "tbc:mainnet" as const,
    apiOrigin: TBC_MAINNET_API_ORIGIN,
  }),
  testnet: Object.freeze({
    chainId: "tbc:testnet" as const,
    apiOrigin: OFFICIAL_TBC_TESTNET_API_ORIGIN,
  }),
});

function decimals(value: number): number {
  input(Number.isSafeInteger(value) && value >= 0 && value <= MAX_DECIMALS, "Invalid asset decimals");
  return value;
}

/** Exact integer-to-display conversion; this never uses floating point. */
export function formatTbcAtomicAmount(atomic: string, assetDecimals: number): string {
  input(UINT.test(atomic), "Invalid atomic amount");
  const width = decimals(assetDecimals);
  if (width === 0) return atomic;
  const padded = atomic.padStart(width + 1, "0");
  const whole = padded.slice(0, -width);
  const fraction = padded.slice(-width).replace(/0+$/u, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/** Exact display-to-integer conversion; excess precision is rejected, never rounded. */
export function parseTbcDisplayAmount(display: string, assetDecimals: number): string {
  const match = DISPLAY.exec(display);
  input(match !== null, "Invalid display amount");
  const width = decimals(assetDecimals);
  const fraction = match[1] ?? "";
  input(fraction.length <= width, "Display amount exceeds asset precision");
  const [whole] = display.split(".", 1);
  return BigInt(`${whole}${fraction.padEnd(width, "0")}`).toString();
}

export type TransferAsset =
  | Readonly<{ kind: "tbc" }>
  | Readonly<{ kind: "ft"; contractId: string }>
  | Readonly<{ kind: "stablecoin"; contractId: string }>
  /** LP identity is the Pool creation transaction ID, not its underlying FT. */
  | Readonly<{ kind: "lp"; contractId: string }>
  | Readonly<{ kind: "nft"; contractId: string }>;

export type TransferAmountExpectation =
  | Readonly<{ mode: "exact"; atomic: string }>
  | Readonly<{ mode: "minimum"; atomic: string }>;

export type TransferRecipient =
  | Readonly<{ address: string; scriptPubKey?: never }>
  | Readonly<{ address?: never; scriptPubKey: string }>;

export interface CreateTransferVerifierOptions {
  readonly network: TransferNetwork;
  readonly fetch?: TestnetFetch;
  readonly baseUrl?: string;
  readonly allowedOrigins?: readonly string[];
  readonly requestTimeoutMs?: number;
  /** Optional host/bundler adapter. Keyless WASM loads only for token/NFT receipts. */
  readonly assetInspector?: Readonly<{
    execute: (operation: string, requestJson: string) => Promise<string>;
  }>;
}

interface VerifyTransferInputBase {
  readonly txid: string;
  readonly recipient: TransferRecipient;
  readonly minimumConfirmations: string;
  readonly now?: () => number;
}

export type VerifyTransferInput = VerifyTransferInputBase & (
  | Readonly<{
      asset: Extract<TransferAsset, { kind: "tbc" | "ft" | "stablecoin" | "lp" }>;
      /** Omit when the caller genuinely does not know the expected quantity. */
      amount?: TransferAmountExpectation;
    }>
  | Readonly<{
      asset: Extract<TransferAsset, { kind: "nft" }>;
      /** NFT identity is unique and singleton; fungible amount expectations do not apply. */
      amount?: never;
    }>
);

export type VerifyTransferOptions = CreateTransferVerifierOptions & VerifyTransferInput;

export interface TransferVerifier {
  readonly network: TransferNetwork;
  readonly chainId: `tbc:${string}`;
  readonly verify: (input: VerifyTransferInput) => Promise<TransferVerificationResult>;
}

export type TransferObservation =
  | Readonly<{ status: "not-found" }>
  | Readonly<{ status: "confirmation-unknown" }>
  | Readonly<{ status: "mempool" | "confirmed"; confirmations: string }>
  | Readonly<{
      status: "request-failed" | "invalid-response";
      code: "NODE_REQUEST_FAILED" | "NODE_RESPONSE_INVALID";
    }>;

export type TransferConfirmationPolicy = Readonly<{
  minimumConfirmations: string;
  status: "satisfied" | "insufficient" | "unavailable";
}>;

export type TransferAmountResult =
  // Current LP Tape carries integer shares, not display precision. Never
  // borrow underlying FT decimals or fetch display metadata to verify arrival.
  | Readonly<{
      expectation: "not-checked";
      status: "not-checked";
      actualAtomic: string;
      denomination: "atomic";
    }>
  | Readonly<{
      expectation: "exact" | "minimum";
      expectedAtomic: string;
      status: "matched" | "mismatched";
      actualAtomic: string;
      denomination: "atomic";
    }>
  | Readonly<{
      expectation: "not-checked";
      status: "not-checked";
      actualAtomic: string;
      decimals: number;
      actualDisplay: string;
    }>
  | Readonly<{
      expectation: "exact" | "minimum";
      expectedAtomic: string;
      status: "matched" | "mismatched";
      actualAtomic: string;
      decimals: number;
      actualDisplay: string;
    }>
  | Readonly<{
      expectation: "not-checked" | "exact" | "minimum";
      expectedAtomic?: string;
      status: "unavailable";
      decimals?: number;
    }>
  | Readonly<{
      expectation: "nft-singleton";
      status: "matched" | "mismatched" | "unavailable";
      actualAtomic?: "1";
    }>;

export type TransferContent = Readonly<{
  status: "matched" | "mismatched" | "unsupported" | "unavailable";
  recipient: Readonly<{
    scriptPubKey: string;
    status: "matched" | "mismatched" | "unavailable";
  }>;
  asset: Readonly<{
    kind: TransferAsset["kind"];
    identity?: string;
    status: "matched" | "mismatched" | "unsupported" | "unavailable";
  }>;
  amount: TransferAmountResult;
  matchedOutputs: readonly Readonly<{
    vout: number;
    amountAtomic: string;
    tapeVout?: number;
    /** Raw Coin/LP lock field, not a maturity/spendability claim. Receipt arrival
     * can match while an administrator-imposed lock still prevents spending. */
    lockTime?: number;
  }>[];
  reasons: readonly string[];
}>;

export interface TransferVerificationResult {
  readonly txid: string;
  readonly checkedAt: string;
  readonly observation: TransferObservation;
  readonly content: TransferContent;
  readonly policy: TransferConfirmationPolicy;
  readonly queries: Readonly<{
    decode: number;
    mempool: number;
    assetMetadata: number;
    transactionRaw: number;
    post: 0;
  }>;
  readonly source: Readonly<{
    network: TransferNetwork;
    chainId: `tbc:${string}`;
    origin: string;
    trustModel: "configured-node-api-plus-local-raw-validation";
  }>;
}

export class TransferVerificationError extends Error {
  override readonly name = "TransferVerificationError";
  readonly code: "INVALID_INPUT" | "UNSUPPORTED_NETWORK";

  constructor(
    code: "INVALID_INPUT" | "UNSUPPORTED_NETWORK",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

function input(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TransferVerificationError("INVALID_INPUT", message);
}

function checkedAt(now: () => number): string {
  const value = now();
  input(Number.isFinite(value), "Invalid receipt verification clock");
  return new Date(value).toISOString();
}

function recipient(value: TransferRecipient) {
  if (typeof value.address === "string") {
    const address = assertTestnetAddress(value.address);
    return Object.freeze({
      address: value.address,
      scriptPubKey: address.scriptPubKey,
      controller: `${address.publicKeyHash}00`,
      nftHoldScript: `${address.scriptPubKey}${NFT_HOLD_SUFFIX}`,
    });
  }
  input(typeof value.scriptPubKey === "string", "Receipt recipient is required");
  const script = value.scriptPubKey.toLowerCase();
  input(HEX.test(script) && script.length <= 20_000, "Invalid receipt locking script");
  const match = /^76a914([0-9a-f]{40})88ac$/u.exec(script);
  return Object.freeze({
    address: undefined,
    scriptPubKey: script,
    controller: match === null ? undefined : `${match[1]}00`,
    nftHoldScript: match === null ? script : `${script}${NFT_HOLD_SUFFIX}`,
  });
}

function amountResult(
  expectation: TransferAmountExpectation | undefined,
  actual: bigint,
  assetDecimals: number | undefined,
): TransferAmountResult {
  const actualAtomic = actual.toString();
  const display = assetDecimals === undefined
    ? { denomination: "atomic" as const }
    : { decimals: assetDecimals, actualDisplay: formatTbcAtomicAmount(actualAtomic, assetDecimals) };
  if (expectation === undefined) {
    return Object.freeze({
      expectation: "not-checked" as const,
      status: "not-checked" as const,
      actualAtomic,
      ...display,
    });
  }
  const expected = BigInt(expectation.atomic);
  const matched = expectation.mode === "exact" ? actual === expected : actual >= expected;
  return Object.freeze({
    expectation: expectation.mode,
    expectedAtomic: expectation.atomic,
    status: matched ? "matched" as const : "mismatched" as const,
    actualAtomic,
    ...display,
  });
}

function unavailableAmount(
  expectation: TransferAmountExpectation | undefined,
  assetDecimals?: number,
): TransferAmountResult {
  return Object.freeze({
    expectation: expectation?.mode ?? "not-checked",
    ...(expectation === undefined ? {} : { expectedAtomic: expectation.atomic }),
    status: "unavailable" as const,
    ...(assetDecimals === undefined ? {} : { decimals: assetDecimals }),
  });
}

function policy(
  minimumConfirmations: string,
  observation: TransferObservation,
): TransferConfirmationPolicy {
  if (observation.status !== "mempool" && observation.status !== "confirmed") {
    return Object.freeze({ minimumConfirmations, status: "unavailable" as const });
  }
  return Object.freeze({
    minimumConfirmations,
    status:
      BigInt(observation.confirmations) >= BigInt(minimumConfirmations)
        ? "satisfied" as const
        : "insufficient" as const,
  });
}

function unavailableContent(
  scriptPubKey: string,
  asset: TransferAsset,
  amount: TransferAmountExpectation | undefined,
  reason: string,
): TransferContent {
  const identity = asset.kind === "tbc" ? undefined : asset.contractId;
  return Object.freeze({
    status: "unavailable" as const,
    recipient: Object.freeze({ scriptPubKey, status: "unavailable" as const }),
    asset: Object.freeze({
      kind: asset.kind,
      ...(identity === undefined ? {} : { identity }),
      status: "unavailable" as const,
    }),
    amount: asset.kind === "nft"
      ? Object.freeze({ expectation: "nft-singleton" as const, status: "unavailable" as const })
      : unavailableAmount(amount, asset.kind === "tbc" ? TBC_ATOMIC_DECIMALS : undefined),
    matchedOutputs: Object.freeze([]),
    reasons: Object.freeze([reason]),
  });
}

function observationFor(transaction: TestnetLookupTransaction): TransferObservation {
  if (transaction.confirmations === undefined) {
    return Object.freeze({ status: "confirmation-unknown" as const });
  }
  return Object.freeze({
    status: BigInt(transaction.confirmations) > 0n ? "confirmed" as const : "mempool" as const,
    confirmations: transaction.confirmations,
  });
}

function nativeContent(
  transaction: TestnetLookupTransaction,
  scriptPubKey: string,
  expectation: TransferAmountExpectation | undefined,
): TransferContent {
  const outputs = transaction.outputs
    .filter((output) => output.scriptPubKey === scriptPubKey)
    .map((output) => Object.freeze({
      vout: output.vout,
      amountAtomic: output.satoshis,
    }));
  const actual = outputs.reduce((sum, output) => sum + BigInt(output.amountAtomic), 0n);
  const amount = amountResult(expectation, actual, TBC_ATOMIC_DECIMALS);
  const recipientMatched = outputs.length > 0;
  const amountMatched = amount.status === "not-checked" || amount.status === "matched";
  const reasons = Object.freeze([
    ...(recipientMatched ? [] : ["RECIPIENT_OUTPUT_NOT_FOUND"]),
    ...(amountMatched ? [] : ["AMOUNT_MISMATCH"]),
  ]);
  return Object.freeze({
    status: recipientMatched && amountMatched ? "matched" as const : "mismatched" as const,
    recipient: Object.freeze({
      scriptPubKey,
      status: recipientMatched ? "matched" as const : "mismatched" as const,
    }),
    asset: Object.freeze({ kind: "tbc" as const, status: "matched" as const }),
    amount,
    matchedOutputs: Object.freeze(outputs),
    reasons,
  });
}

type InspectedTokenOutput = Readonly<{
  codeVout: number;
  tapeVout: number;
  family: string;
  version: number;
  balanceRaw: string;
  controller: string;
  contractCodeMatches: boolean;
  standardId?: "tbc20-standard" | "tbc20-stablecoin";
  lockTime?: number;
}>;

type InspectedTokenReceipt = Readonly<{
  outputs: readonly InspectedTokenOutput[];
  contractStandardId?: "tbc20-standard" | "tbc20-stablecoin";
}>;

type InspectedNftOutput = Readonly<{
  codeVout: number;
  holdVout: number;
  tapeVout: number;
  version: number;
  standardId?: "tbc721-standard";
  collectionId: string;
  tokenId: string;
  controller: string;
  holdScript: string;
}>;

function inspectedTokenReceipt(value: string, txid: string): InspectedTokenReceipt {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("Invalid token receipt inspector response");
  }
  const record = decoded as { readonly txid?: unknown; readonly outputs?: unknown; readonly contractStandardId?: unknown };
  if (record === null || typeof record !== "object" || record.txid !== txid || !Array.isArray(record.outputs)) {
    throw new Error("Invalid token receipt inspector response");
  }
  if (record.contractStandardId !== undefined && record.contractStandardId !== "tbc20-standard" && record.contractStandardId !== "tbc20-stablecoin") {
    throw new Error("Invalid token receipt contract standard");
  }
  const outputs = Object.freeze(record.outputs.map((candidate) => {
    const output = candidate as Partial<InspectedTokenOutput> | null;
    if (
      output === null || typeof output !== "object" ||
      !Number.isSafeInteger(output.codeVout) || Number(output.codeVout) < 0 ||
      !Number.isSafeInteger(output.tapeVout) || Number(output.tapeVout) < 0 ||
      typeof output.family !== "string" || !Number.isSafeInteger(output.version) ||
      typeof output.balanceRaw !== "string" || !UINT.test(output.balanceRaw) ||
      typeof output.controller !== "string" || !/^[0-9a-f]{42}$/u.test(output.controller) ||
      typeof output.contractCodeMatches !== "boolean" ||
      (output.standardId !== undefined && output.standardId !== "tbc20-standard" && output.standardId !== "tbc20-stablecoin") ||
      (output.contractCodeMatches === true && record.contractStandardId !== undefined && output.standardId !== record.contractStandardId) ||
      (output.standardId === "tbc20-stablecoin" && (output.family !== "COIN" || output.lockTime === undefined)) ||
      (output.lockTime !== undefined && (!["COIN", "STABLE_COIN"].includes(String(output.family)) || !Number.isSafeInteger(output.lockTime) || output.lockTime < 0 || output.lockTime > 0xffff_ffff))
    ) {
      throw new Error("Invalid token receipt inspector output");
    }
    return Object.freeze(output as InspectedTokenOutput);
  }));
  return Object.freeze({ outputs, ...(record.contractStandardId === undefined ? {} : { contractStandardId: record.contractStandardId }) });
}

function inspectedNftOutputs(value: string, txid: string): readonly InspectedNftOutput[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("Invalid NFT receipt inspector response");
  }
  const record = decoded as { readonly txid?: unknown; readonly outputs?: unknown };
  if (record === null || typeof record !== "object" || record.txid !== txid || !Array.isArray(record.outputs)) {
    throw new Error("Invalid NFT receipt inspector response");
  }
  return Object.freeze(record.outputs.map((candidate) => {
    const output = candidate as Partial<InspectedNftOutput> | null;
    if (
      output === null || typeof output !== "object" ||
      !Number.isSafeInteger(output.codeVout) || Number(output.codeVout) < 0 ||
      !Number.isSafeInteger(output.holdVout) || Number(output.holdVout) < 0 ||
      !Number.isSafeInteger(output.tapeVout) || Number(output.tapeVout) < 0 ||
      !Number.isSafeInteger(output.version) ||
      (output.standardId !== undefined && output.standardId !== "tbc721-standard") ||
      (output.version === 3 && output.standardId !== "tbc721-standard") ||
      (output.standardId === "tbc721-standard" && output.version !== 3) ||
      typeof output.collectionId !== "string" || !HASH.test(output.collectionId) ||
      typeof output.tokenId !== "string" || !UINT.test(output.tokenId) ||
      typeof output.controller !== "string" || !/^[0-9a-f]{42}$/u.test(output.controller) ||
      typeof output.holdScript !== "string" || !HEX.test(output.holdScript)
    ) {
      throw new Error("Invalid NFT receipt inspector output");
    }
    return Object.freeze(output as InspectedNftOutput);
  }));
}

async function fungibleContent(
  client: TestnetClient,
  transaction: TestnetLookupTransaction,
  scriptPubKey: string,
  controller: string | undefined,
  asset: Extract<TransferAsset, { kind: "ft" | "stablecoin" }>,
  expectation: TransferAmountExpectation | undefined,
  inspector: NonNullable<VerifyTransferOptions["assetInspector"]>,
): Promise<TransferContent> {
  if (controller === undefined) {
    return Object.freeze({
      ...unavailableContent(scriptPubKey, asset, expectation, "FT_RECIPIENT_SCRIPT_UNSUPPORTED"),
      status: "unsupported" as const,
      asset: Object.freeze({ kind: asset.kind, identity: asset.contractId, status: "unsupported" as const }),
    });
  }
  // The same trusted metadata response supplies the Code for local recognition.
  // Reuse this one inspection both to select strict metadata rules and to check
  // outputs; no template copy, second inspector call, or extra HTTP lookup.
  let receipt: InspectedTokenReceipt | undefined;
  const inspectReceipt = async (codeScript: string) => {
    receipt = inspectedTokenReceipt(await inspector.execute("inspectTokenReceipt", JSON.stringify({
      rawTransaction: transaction.rawTransaction, contractCodeScript: codeScript,
    })), transaction.txid);
    return receipt;
  };
  const metadata = asset.kind === "stablecoin" ? await client.getStablecoinMetadata(asset.contractId) : await client.getFtInfo(asset.contractId, {
    resolveStandard: async (codeScript) => {
      const inspected = await inspectReceipt(codeScript);
      if (inspected.contractStandardId === "tbc20-stablecoin") throw new Error("Stablecoin is not an FT metadata profile");
      return inspected.contractStandardId;
    },
  });
  if (asset.kind === "stablecoin") await inspectReceipt(metadata.codeScript);
  if (receipt === undefined) throw new Error("FT metadata did not resolve its receipt profile");
  const contractOutputs = receipt.outputs.filter((output) => output.contractCodeMatches &&
    (asset.kind === "stablecoin" ? ["COIN", "STABLE_COIN"].includes(output.family) : ["FT", "TBC20"].includes(output.family)));
  const outputs = contractOutputs
    .filter((output) => output.controller === controller)
    .map((output) => Object.freeze({
      vout: output.codeVout,
      tapeVout: output.tapeVout,
      amountAtomic: output.balanceRaw,
      ...(output.lockTime === undefined ? {} : { lockTime: output.lockTime }),
    }));
  const actual = outputs.reduce((sum, output) => sum + BigInt(output.amountAtomic), 0n);
  const amount = amountResult(expectation, actual, metadata.decimals);
  const assetMatched = contractOutputs.length > 0;
  const recipientMatched = outputs.length > 0;
  const amountMatched = amount.status === "not-checked" || amount.status === "matched";
  const reasons = Object.freeze([
    ...(assetMatched ? [] : ["ASSET_IDENTITY_MISMATCH"]),
    ...(recipientMatched ? [] : ["RECIPIENT_OUTPUT_NOT_FOUND"]),
    ...(amountMatched ? [] : ["AMOUNT_MISMATCH"]),
  ]);
  return Object.freeze({
    status: assetMatched && recipientMatched && amountMatched ? "matched" as const : "mismatched" as const,
    recipient: Object.freeze({
      scriptPubKey,
      status: recipientMatched ? "matched" as const : "mismatched" as const,
    }),
    asset: Object.freeze({
      kind: asset.kind,
      identity: asset.contractId,
      status: assetMatched ? "matched" as const : "mismatched" as const,
    }),
    amount,
    matchedOutputs: Object.freeze(outputs),
    reasons,
  });
}

async function nftContent(
  client: TestnetClient,
  transaction: TestnetLookupTransaction,
  recipientAddress: string | undefined,
  holdScript: string,
  asset: Extract<TransferAsset, { kind: "nft" }>,
  inspector: NonNullable<VerifyTransferOptions["assetInspector"]>,
): Promise<Readonly<{ content: TransferContent; metadataQueries: number }>> {
  if (recipientAddress === undefined) {
    return Object.freeze({ content: Object.freeze({
      ...unavailableContent(holdScript, asset, undefined, "NFT_RECIPIENT_ADDRESS_REQUIRED"),
      status: "unsupported" as const,
      asset: Object.freeze({ kind: "nft" as const, identity: asset.contractId, status: "unsupported" as const }),
    }), metadataQueries: 0 });
  }
  const [metadata, history] = await Promise.all([
    client.getNftInfo(asset.contractId),
    client.getNftHistory(recipientAddress, asset.contractId, transaction.txid),
  ]);
  const inspected = inspectedNftOutputs(
    await inspector.execute("inspectNftReceipt", JSON.stringify({
      rawTransaction: transaction.rawTransaction,
    })),
    transaction.txid,
  );
  const identityOutputs = inspected.filter((output) =>
    output.collectionId === metadata.collectionId && output.tokenId === metadata.tokenId
  );
  const outputs = identityOutputs
    .filter((output) => output.holdScript === holdScript)
    .map((output) => Object.freeze({
      vout: output.holdVout,
      tapeVout: output.tapeVout,
      amountAtomic: "1",
    }));
  const assetMatched = identityOutputs.length > 0;
  const recipientMatched = outputs.length > 0;
  const targetHistory = history.entries.find((entry) => entry.txid === transaction.txid);
  const historyMatched = history.entries.some((entry) =>
    entry.txid === transaction.txid && entry.recipient === recipientAddress
  );
  const historyConclusive = targetHistory !== undefined || history.coverage === "complete";
  if (!historyConclusive) {
    return Object.freeze({
      content: Object.freeze({
        status: "unavailable" as const,
        recipient: Object.freeze({
          scriptPubKey: holdScript,
          status: recipientMatched ? "matched" as const : "mismatched" as const,
        }),
        asset: Object.freeze({
          kind: "nft" as const,
          identity: asset.contractId,
          status: assetMatched ? "unavailable" as const : "mismatched" as const,
        }),
        amount: Object.freeze({
          expectation: "nft-singleton" as const,
          status: "unavailable" as const,
        }),
        matchedOutputs: Object.freeze(outputs),
        reasons: Object.freeze([
          ...(assetMatched ? [] : ["ASSET_IDENTITY_MISMATCH"]),
          ...(recipientMatched ? [] : ["RECIPIENT_OUTPUT_NOT_FOUND"]),
          "NFT_HISTORY_INCOMPLETE",
        ]),
      }),
      metadataQueries: 1 + history.pages,
    });
  }
  const matched = assetMatched && recipientMatched && historyMatched;
  return Object.freeze({ content: Object.freeze({
    status: matched ? "matched" as const : "mismatched" as const,
    recipient: Object.freeze({
      scriptPubKey: holdScript,
      status: recipientMatched ? "matched" as const : "mismatched" as const,
    }),
    asset: Object.freeze({
      kind: "nft" as const,
      identity: asset.contractId,
      status: assetMatched && historyMatched ? "matched" as const : "mismatched" as const,
    }),
    amount: Object.freeze({
      expectation: "nft-singleton" as const,
      status: matched ? "matched" as const : "mismatched" as const,
      ...(matched ? { actualAtomic: "1" as const } : {}),
    }),
    matchedOutputs: Object.freeze(outputs),
    reasons: Object.freeze([
      ...(assetMatched ? [] : ["ASSET_IDENTITY_MISMATCH"]),
      ...(recipientMatched ? [] : ["RECIPIENT_OUTPUT_NOT_FOUND"]),
      ...(historyMatched ? [] : ["NFT_HISTORY_MISMATCH"]),
    ]),
  }), metadataQueries: 1 + history.pages });
}

async function lpContent(
  transaction: TestnetLookupTransaction,
  poolOrigin: string,
  scriptPubKey: string,
  controller: string,
  asset: Extract<TransferAsset, { kind: "lp" }>,
  expectation: TransferAmountExpectation | undefined,
  inspector: NonNullable<VerifyTransferOptions["assetInspector"]>,
): Promise<TransferContent> {
  const receipt = JSON.parse(await inspector.execute("inspectAmmMaterial", JSON.stringify({
    phase: "inspectLpReceipt",
    poolOrigin: { txid: asset.contractId, rawTransaction: poolOrigin },
    transaction: { txid: transaction.txid, rawTransaction: transaction.rawTransaction },
  }))) as {
    txid?: unknown; poolContractId?: unknown; generation?: unknown;
    verification?: unknown; outputs?: unknown;
  } | null;
  if (receipt === null || receipt.txid !== transaction.txid || receipt.poolContractId !== asset.contractId ||
      !["current", "historical"].includes(String(receipt.generation)) ||
      receipt.verification !== "pool-origin-and-output-structure" || !Array.isArray(receipt.outputs) ||
      receipt.outputs.length > transaction.outputs.length) throw new Error("Invalid LP receipt response");
  const seen = new Set<number>();
  const outputs: { vout: number; tapeVout: number; amountAtomic: string; lockTime: number }[] = [];
  let assetMatched = false;
  for (const candidate of receipt.outputs) {
    const out = candidate as {
      codeVout: number; tapeVout: number; balanceRaw: string; controller: string;
      lockTime: number; contractCodeMatches: boolean; generation: string;
    } | null;
    if (out === null || !Number.isSafeInteger(out.codeVout) || out.codeVout < 0 ||
        out.tapeVout !== out.codeVout + 1 || out.tapeVout >= transaction.outputs.length || seen.has(out.codeVout) ||
        typeof out.balanceRaw !== "string" || !UINT.test(out.balanceRaw) || out.balanceRaw.length > 39 ||
        typeof out.controller !== "string" || !/^[0-9a-f]{42}$/u.test(out.controller) ||
        !Number.isSafeInteger(out.lockTime) || out.lockTime < 0 || out.lockTime > 0xffff_ffff ||
        typeof out.contractCodeMatches !== "boolean" || !["current", "historical"].includes(out.generation) ||
        (out.contractCodeMatches && out.generation !== receipt.generation)) throw new Error("Invalid LP receipt output");
    seen.add(out.codeVout);
    if (!out.contractCodeMatches) continue;
    assetMatched = true;
    if (out.controller === controller) outputs.push(Object.freeze({
      vout: out.codeVout, tapeVout: out.tapeVout, amountAtomic: out.balanceRaw, lockTime: out.lockTime,
    }));
  }
  const amount = amountResult(expectation, outputs.reduce((sum, out) => sum + BigInt(out.amountAtomic), 0n), undefined);
  const recipientMatched = outputs.length > 0;
  const amountMatched = amount.status === "not-checked" || amount.status === "matched";
  return Object.freeze({
    status: assetMatched && recipientMatched && amountMatched ? "matched" : "mismatched",
    recipient: Object.freeze({ scriptPubKey, status: recipientMatched ? "matched" : "mismatched" }),
    asset: Object.freeze({ kind: "lp", identity: asset.contractId, status: assetMatched ? "matched" : "mismatched" }),
    amount, matchedOutputs: Object.freeze(outputs),
    reasons: Object.freeze([
      ...(assetMatched ? [] : ["ASSET_IDENTITY_MISMATCH"]),
      ...(recipientMatched ? [] : ["RECIPIENT_OUTPUT_NOT_FOUND"]),
      ...(amountMatched ? [] : ["AMOUNT_MISMATCH"]),
    ]),
  });
}

function validateNetwork(network: unknown): asserts network is TransferNetwork {
  if (network !== "mainnet" && network !== "testnet") {
    throw new TransferVerificationError(
      "UNSUPPORTED_NETWORK",
      "Receipt verification supports the built-in TBC mainnet and testnet profiles",
    );
  }
}

function validate(options: VerifyTransferInput): void {
  input(HASH.test(options.txid), "Invalid receipt transaction ID");
  input(UINT.test(options.minimumConfirmations), "Invalid confirmation policy");
  if (options.amount !== undefined) {
    input(
      (options.amount.mode === "exact" || options.amount.mode === "minimum") &&
        POSITIVE.test(options.amount.atomic),
      "Invalid receipt amount expectation",
    );
  }
  if (options.asset.kind === "ft" || options.asset.kind === "stablecoin" || options.asset.kind === "lp") {
    input(HASH.test(options.asset.contractId), "Invalid asset contract ID");
  } else if (options.asset.kind === "nft") {
    input(HASH.test(options.asset.contractId), "Invalid NFT contract ID");
  } else {
    input(options.asset.kind === "tbc", "Unsupported receipt asset kind");
  }
}

type ReceiptContext = Readonly<{
  client: TestnetClient;
  network: TransferNetwork;
  chainId: `tbc:${string}`;
  origin: string;
  inspector: NonNullable<CreateTransferVerifierOptions["assetInspector"]>;
  /** Bounded immutable raw cache scoped to this verifier's network and origin.
   * Confirmation state and target receipts are deliberately never cached. */
  poolOrigins: Map<string, Promise<string>>;
}>;

async function verifyWithClient(
  options: VerifyTransferInput,
  context: ReceiptContext,
): Promise<TransferVerificationResult> {
  validate(options);
  const expected = recipient(options.recipient);
  const expectedScript = options.asset.kind === "nft" ? expected.nftHoldScript : expected.scriptPubKey;
  const now = options.now ?? Date.now;
  const checked = checkedAt(now);
  let transaction: TestnetLookupTransaction | null;
  try {
    transaction = await context.client.lookupRawTransaction(options.txid);
  } catch (error) {
    if (!isTestnetNodeError(error) || (error.code !== "NODE_REQUEST_FAILED" && error.code !== "NODE_RESPONSE_INVALID")) {
      throw error;
    }
    const observation = Object.freeze({
      status: error.code === "NODE_REQUEST_FAILED" ? "request-failed" as const : "invalid-response" as const,
      code: error.code,
    });
    return Object.freeze({
      txid: options.txid,
      checkedAt: checked,
      observation,
      content: unavailableContent(expectedScript, options.asset, options.amount, error.code),
      policy: policy(options.minimumConfirmations, observation),
      queries: Object.freeze({ decode: 1, mempool: 0, assetMetadata: 0, transactionRaw: 0, post: 0 as const }),
      source: Object.freeze({ network: context.network, chainId: context.chainId, origin: context.origin, trustModel: "configured-node-api-plus-local-raw-validation" as const }),
    });
  }
  if (transaction === null) {
    const observation = Object.freeze({ status: "not-found" as const });
    return Object.freeze({
      txid: options.txid,
      checkedAt: checked,
      observation,
      content: unavailableContent(expectedScript, options.asset, options.amount, "TRANSACTION_NOT_FOUND"),
      policy: policy(options.minimumConfirmations, observation),
      queries: Object.freeze({ decode: 1, mempool: 0, assetMetadata: 0, transactionRaw: 0, post: 0 as const }),
      source: Object.freeze({ network: context.network, chainId: context.chainId, origin: context.origin, trustModel: "configured-node-api-plus-local-raw-validation" as const }),
    });
  }
  const observation = observationFor(transaction);
  const mempool = 0;
  let content: TransferContent;
  let assetMetadata = 0;
  let transactionRaw = 0;
  if (options.asset.kind === "tbc") {
    content = nativeContent(transaction, expected.scriptPubKey, options.amount);
  } else if (options.asset.kind === "nft") {
    assetMetadata = expected.address === undefined ? 0 : 2;
    try {
      const nft = await nftContent(
        context.client,
        transaction,
        expected.address,
        expected.nftHoldScript,
        options.asset,
        context.inspector,
      );
      content = nft.content;
      assetMetadata = nft.metadataQueries;
    } catch (error) {
      const reason = isTestnetNodeError(error)
        ? error.code
        : "ASSET_INSPECTION_FAILED";
      content = unavailableContent(expected.nftHoldScript, options.asset, undefined, reason);
    }
  } else if (options.asset.kind === "lp") {
    if (expected.controller === undefined) {
      content = Object.freeze({
        ...unavailableContent(expected.scriptPubKey, options.asset, options.amount, "LP_RECIPIENT_SCRIPT_UNSUPPORTED"),
        status: "unsupported" as const,
        asset: Object.freeze({ kind: "lp" as const, identity: options.asset.contractId, status: "unsupported" as const }),
      });
    } else {
      try {
        const id = options.asset.contractId;
        let origin: string;
        if (id === transaction.txid) origin = transaction.rawTransaction;
        else {
          let pending = context.poolOrigins.get(id);
          if (pending === undefined) {
            if (context.client.getRawTransactionBytes === undefined) throw new Error("LP origin reader unavailable");
            transactionRaw = 1;
            pending = context.client.getRawTransactionBytes(id);
            if (context.poolOrigins.size >= 8) context.poolOrigins.delete(context.poolOrigins.keys().next().value!);
            context.poolOrigins.set(id, pending);
            const inserted = pending;
            void pending.catch(() => { if (context.poolOrigins.get(id) === inserted) context.poolOrigins.delete(id); });
          }
          origin = await pending;
        }
        content = await lpContent(transaction, origin, expected.scriptPubKey, expected.controller,
          options.asset, options.amount, context.inspector);
      } catch (error) {
        content = unavailableContent(expected.scriptPubKey, options.asset, options.amount,
          isTestnetNodeError(error) ? error.code : "ASSET_INSPECTION_FAILED");
      }
    }
  } else {
    assetMetadata = expected.controller === undefined ? 0 : 1;
    try {
      content = await fungibleContent(
        context.client,
        transaction,
        expected.scriptPubKey,
        expected.controller,
        options.asset,
        options.amount,
        context.inspector,
      );
    } catch (error) {
      const reason = isTestnetNodeError(error)
        ? error.code
        : "ASSET_INSPECTION_FAILED";
      content = unavailableContent(expected.scriptPubKey, options.asset, options.amount, reason);
    }
  }
  return Object.freeze({
    txid: options.txid,
    checkedAt: checked,
    observation,
    content,
    policy: policy(options.minimumConfirmations, observation),
    queries: Object.freeze({ decode: 1, mempool, assetMetadata, transactionRaw, post: 0 as const }),
    source: Object.freeze({ network: context.network, chainId: context.chainId, origin: context.origin, trustModel: "configured-node-api-plus-local-raw-validation" as const }),
  });
}

/** Create one network-bound verifier and reuse its client, in-flight ledger, and inspector. */
export function createTransferVerifier(
  options: CreateTransferVerifierOptions,
): TransferVerifier {
  validateNetwork(options.network);
  const profile = RECEIPT_NETWORKS[options.network];
  const baseUrl = options.baseUrl ?? profile.apiOrigin;
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    throw new TransferVerificationError("INVALID_INPUT", "Invalid transfer verification API endpoint");
  }
  const selectedFetch = options.fetch ?? globalThis.fetch;
  input(typeof selectedFetch === "function", "Receipt API fetch is unavailable");
  const client = createTestnetClient({
    baseUrl,
    allowedOrigins: options.allowedOrigins ?? [origin],
    fetch: selectedFetch,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const context = Object.freeze({
    client,
    network: options.network,
    chainId: profile.chainId,
    origin,
    inspector: options.assetInspector ?? createLazyBundledWasmTbcKeylessEngine(),
    poolOrigins: new Map<string, Promise<string>>(),
  });
  return Object.freeze({
    network: options.network,
    chainId: profile.chainId,
    verify: (verifyOptions: VerifyTransferInput) => verifyWithClient(verifyOptions, context),
  });
}

/**
 * One-shot explicit read-only payment evidence check. Prefer a client-bound
 * verifier for repeated calls. Neither path connects a wallet, requests
 * approval, signs, broadcasts, or records merchant orders.
 */
export async function verifyTransfer(
  options: VerifyTransferOptions,
): Promise<TransferVerificationResult> {
  const verifier = createTransferVerifier({
    network: options.network,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.assetInspector === undefined ? {} : { assetInspector: options.assetInspector }),
  });
  return verifier.verify(options);
}
