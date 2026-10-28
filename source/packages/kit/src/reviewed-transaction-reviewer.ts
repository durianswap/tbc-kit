import { canonicalize, hashCanonical } from "@tbc-wallet/core";
import { bytesToHex, hexToBytes, sha256Bytes } from "./network-bytes.js";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { createLazyBundledWasmTbcKeylessEngine } from "./keyless.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import { inspectReviewedLopOrders, type LopOrderInspection } from "./reviewed-lop.js";
import { reviewCurrentTokenFlows } from "./reviewed-lop-flows.js";
import { inspectReviewedHtlc, reviewNativeHtlcFlow, type HtlcReviewRow } from "./reviewed-htlc-flows.js";
import { reviewHtlcTokenFlows } from "./reviewed-htlc-token-flows.js";
import { associatedHtlcRefundLock } from "./reviewed-htlc-witness.js";
import { reviewNativeTimelockFlow } from "./reviewed-timelock-flows.js";
import { requireReviewedIssuancePolicy, normalizeReviewedPolicyMaterial } from "./reviewed-issuance-policy.js";
import type { TbcReviewedPolicyMaterial } from "./reviewed-transaction-types.js";
import { reviewedCoinAdministrator } from "./reviewed-coin-admin.js";
import { forEachTxoStatusBatch } from "./txo-status-batches.js";

import type {
  AssetFlow,
  DecodeInputUtxo,
  DecodeTxRawResult,
  TransactionAsset,
} from "tbc-tx-parser";

import {
  createTbcOfficialApi,
  type CreateTbcOfficialApiOptions,
  type TbcApiTxoStatus,
} from "./official-api.js";
import {
  assertTbcNetworkContext,
  type TbcNetworkContext,
} from "./network-context.js";
import {
  parseTbcTransaction,
  turingTransactionId,
  tbcAddressFromPublicKeyHash,
} from "./testnet-validation.js";
import type {
  TbcAssociatedTransactionReviewer,
  TbcRawTransactionReviewer,
  TbcReviewedTransactionRequest,
} from "./reviewed-transaction-types.js";

type TapeExpectation = "ft" | "nft" | "poolNft" | "ftOrPoolNft";

type DecodeTxRaw = typeof import("tbc-tx-parser")["decodeTxRaw"];
let parserPromise: Promise<DecodeTxRaw> | undefined;

function loadDecodeTxRaw(): Promise<DecodeTxRaw> {
  // This package-private copy preserves the published parser implementation
  // while replacing its lone Node-only public-script SHA-256 edge at build
  // time. Keeping the import lazy avoids adding parser work to wallet startup.
  parserPromise ??= import("./vendor/tbc-tx-parser/index.js")
    .then(({ decodeTxRaw }) => decodeTxRaw as DecodeTxRaw);
  return parserPromise;
}

const FTAPE_SUFFIX = "4654617065";
const NTAPE_SUFFIX = "4e54617065";
const MAX_TXO_STATUS_ITEMS = 10_000;

type TrustedInput = Readonly<{
  txid: string;
  vout: number;
  satoshis: number;
  scriptPubKey: string;
  spent: false;
}>;

type LocalPrevouts = ReadonlyMap<string, TbcApiTxoStatus>;
type DefaultReviewOptions = Omit<CreateTbcOfficialApiOptions, "baseUrl" | "network" | "allowedOrigins"> &
  Readonly<{
    network: TbcNetworkContext;
    /** Share the existing platform keyless bridge; browser defaults to lazy WASM. */
    materialNative?: PoolMaterialNativeProviderInput;
  }>;

type ReviewEngineInput = Readonly<{
  request: TbcReviewedTransactionRequest;
  context: Parameters<TbcRawTransactionReviewer["review"]>[0]["context"];
  transactionIds: readonly string[];
  localPrevouts?: LocalPrevouts;
  associated?: boolean;
  associatedInputRows?: readonly (readonly Readonly<Record<string, unknown>>[])[];
  administratorPublicKey?: string;
}>;

function tapeExpectation(script: string): TapeExpectation | undefined {
  const normalized = script.toLowerCase();
  if (normalized.endsWith("32436f6465")) return "ftOrPoolNft";
  if (normalized.endsWith("31436f6465")) return "poolNft";
  if (normalized.endsWith("02436f6465")) return "ft";
  if (normalized.endsWith("33436f6465") || normalized.endsWith("ac6a")) return "nft";
  return undefined;
}

function hasTapeMarker(script: string, expectation: TapeExpectation): boolean {
  const normalized = script.toLowerCase();
  const ft = normalized.endsWith(FTAPE_SUFFIX.toLowerCase());
  const nft = normalized.endsWith(NTAPE_SUFFIX.toLowerCase());
  if (expectation === "ft") return ft;
  if (expectation === "nft" || expectation === "poolNft") return nft;
  return ft || nft;
}

function statusKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

function statusValue(row: TbcApiTxoStatus, label: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(row.value)) {
    throw new Error(`Invalid ${label} value`);
  }
  const value = Number(row.value);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label} value`);
  return value;
}

function statusIndex(row: TbcApiTxoStatus): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(row.index)) {
    throw new Error("Invalid Legacy reviewer TXO index");
  }
  const value = Number(row.index);
  if (!Number.isSafeInteger(value) || value > 0xffff_ffff) {
    throw new Error("Invalid Legacy reviewer TXO index");
  }
  return value;
}

function uniqueOutpoints(
  values: readonly Readonly<{ txid: string; vout: number }>[],
): readonly Readonly<{ txid: string; vout: number }>[] {
  return Object.freeze([
    ...new Map(values.map((value) => [statusKey(value.txid, value.vout), value])).values(),
  ]);
}

function assetKey(asset: TransactionAsset, fallback: number): string {
  const identity = "contractId" in asset
    ? asset.contractId
    : "collectionId" in asset
      ? asset.collectionId
      : "symbol" in asset
        ? asset.symbol
        : undefined;
  return `${asset.type}:${identity ?? `flow-${fallback}`}`;
}

function reviewProjection<T>(value: T): T {
  const project = (candidate: unknown, inArray = false): unknown => {
    if (candidate === undefined) {
      if (inArray) throw new Error("Invalid Legacy reviewer preview array");
      return undefined;
    }
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (Array.isArray(candidate)) {
      return Object.freeze(candidate.map((item) => project(item, true)));
    }
    if (Object.getPrototypeOf(candidate) !== Object.prototype) {
      throw new Error("Invalid Legacy reviewer preview object");
    }
    const output: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== "string") throw new Error("Invalid Legacy reviewer preview key");
      const child = Reflect.get(candidate, key);
      if (child !== undefined) output[key] = project(child);
    }
    return Object.freeze(output);
  };
  return project(value) as T;
}

function reviewFlow(flow: AssetFlow): Readonly<Record<string, unknown>> {
  return Object.freeze({
    purpose: flow.purpose,
    direction: flow.direction,
    ...(flow.amount === undefined ? {} : { amount: flow.amount }),
    ...(flow.from === undefined ? {} : { from: flow.from }),
    ...(flow.to === undefined ? {} : { to: flow.to }),
    isSelf: flow.purpose === "self",
    recognized:
      flow.context?.recognized !== false &&
      flow.purpose !== "unknown" &&
      (flow.direction as string) !== "unknown",
    ...(flow.context === undefined ? {} : { context: reviewProjection(flow.context) }),
  });
}

function structuredPreview(
  decoded: readonly DecodeTxRawResult[],
  lopOrders: ReadonlyMap<number, LopOrderInspection> = new Map(),
  currentReviews: ReadonlyMap<number, Readonly<Record<string, unknown>>> = new Map(),
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    transactions: Object.freeze(decoded.map((transaction, index) => {
      const current = currentReviews.get(index);
      if (current !== undefined) return reviewProjection(current);
      const groups = new Map<string, {
        key: string;
        asset: TransactionAsset;
        flows: Readonly<Record<string, unknown>>[];
      }>();
      transaction.assetFlows.forEach((flow, flowIndex) => {
        const key = assetKey(flow.asset, flowIndex);
        const group = groups.get(key) ?? { key, asset: flow.asset, flows: [] };
        group.flows.push(reviewFlow(flow));
        groups.set(key, group);
      });
      return Object.freeze({
        index,
        txid: transaction.txid,
        ...(transaction.chain.fee === undefined
          ? {}
          : { feeSatoshis: transaction.chain.fee.satoshis }),
        classification: reviewProjection(transaction.classification),
        ...(lopOrders.has(index) ? { orderTerms: reviewProjection(lopOrders.get(index)) } : {}),
        groups: Object.freeze([...groups.values()].map((group) => Object.freeze({
          key: group.key,
          asset: reviewProjection(group.asset),
          flows: Object.freeze(group.flows),
        }))),
      });
    })),
  });
}

/**
 * Default shared reviewer for historical raw `signTransaction`.
 *
 * It uses two primary official TXO-status phases, each split into at most 25
 * outputs per request with bounded parallelism: one for every
 * signed prevout and one for only the contract tape/origin dependencies found
 * by the parser. Reads remain inside the official API's existing idempotent
 * single-flight/retry policy. Current Token LOP adds only missing Tape status
 * and one official metadata read per actual token identity for Code binding;
 * historical supported paths do not use that branch. Token HTLC reuses the
 * same material codecs and selected-output metadata identity authentication;
 * only that newly supported path adds bounded per-asset decode hints. No tip,
 * raw-transaction, account scan or ancestry walk is introduced.
 */
function createLegacyDefaultReviewEngine(
  options: DefaultReviewOptions,
): (input: ReviewEngineInput) => Promise<Readonly<{
  preview: unknown;
  verifiedInputs: readonly (readonly TrustedInput[])[];
  policyMaterial: TbcReviewedPolicyMaterial;
}>> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Legacy raw transaction reviewer network is required");
  }
  const { network: networkInput, materialNative, ...transportOptions } = options;
  const native = materialNative ?? createLazyBundledWasmTbcKeylessEngine();
  const network = assertTbcNetworkContext(networkInput);
  const api = createTbcOfficialApi({
    ...transportOptions,
    baseUrl: network.endpoint.apiOrigin,
    allowedOrigins: Object.freeze([network.endpoint.apiOrigin]),
  });

  async function readStatuses(
    outpoints: readonly Readonly<{ txid: string; vout: number }>[],
    label: string,
  ): Promise<ReadonlyMap<string, TbcApiTxoStatus>> {
    const unique = uniqueOutpoints(outpoints);
    if (unique.length === 0) return new Map();
    if (unique.length > MAX_TXO_STATUS_ITEMS) {
      throw new Error(`Too many Legacy ${label} TXOs`);
    }
    const rows = new Map<string, TbcApiTxoStatus>();
    await forEachTxoStatusBatch(api,
      unique.map(({ txid, vout }) => Object.freeze({ txid, index: vout })), result => {
        if (result.status === "rejected") throw result.reason;
        const { requested, response } = result.value;
        const remaining = new Set(requested.map(p => statusKey(p.txid, p.index)));
        if (!Array.isArray(response.txos) || response.txos.length !== requested.length) {
          throw new Error(`Legacy ${label} status material incomplete`);
        }
        for (const row of response.txos) {
          const key = statusKey(row.txid, statusIndex(row));
          if (!remaining.delete(key) || rows.has(key)) throw new Error(`Legacy ${label} status material mismatch`);
          rows.set(key, Object.freeze({ ...row }));
        }
      }, { category: "asset-index", concurrencyGroup: "legacy-review" });
    return rows;
  }

  const review = async ({
    request,
    context,
    transactionIds,
    localPrevouts = new Map(),
    associated = false,
    associatedInputRows,
    administratorPublicKey,
  }: ReviewEngineInput) => {
      if (
        context.chainId !== network.chainId ||
        transactionIds.length !== request.txraws.length
      ) {
        throw new Error("Legacy raw transaction reviewer network mismatch");
      }
      const decodeTxRaw = await loadDecodeTxRaw();
      const parsed = request.txraws.map((raw) => parseTbcTransaction(raw));
      const primaryOutpoints = parsed.flatMap((transaction) =>
        transaction.inputs.map(({ txid, vout }) => Object.freeze({ txid, vout })),
      );
      const externalPrimaryOutpoints = primaryOutpoints.filter(
        ({ txid, vout }) => !localPrevouts.has(statusKey(txid, vout)),
      );
      const primaryStatuses = new Map(await readStatuses(externalPrimaryOutpoints, "input"));
      for (const [key, value] of localPrevouts) primaryStatuses.set(key, value);
      const verifiedInputs: TrustedInput[][] = [];
      const parserInputs: DecodeInputUtxo[][] = [];
      for (let transactionIndex = 0; transactionIndex < parsed.length; transactionIndex += 1) {
        const transaction = parsed[transactionIndex]!;
        const verifiedRow: TrustedInput[] = [];
        const parserRow: DecodeInputUtxo[] = [];
        for (let inputIndex = 0; inputIndex < transaction.inputs.length; inputIndex += 1) {
          const outpoint = transaction.inputs[inputIndex]!;
          const status = primaryStatuses.get(statusKey(outpoint.txid, outpoint.vout));
          const expectedSatoshis = request.utxos_satoshis[transactionIndex]![inputIndex]!;
          const expectedScript = request.script_pubkeys[transactionIndex]![inputIndex]!.toLowerCase();
          if (
            status === undefined ||
            status.spent ||
            status.scriptPubKey === undefined ||
            statusValue(status, "Legacy input") !== expectedSatoshis ||
            status.scriptPubKey.toLowerCase() !== expectedScript
          ) {
            throw new Error("Legacy raw transaction trusted material mismatch");
          }
          const trusted = Object.freeze({
            txid: outpoint.txid,
            vout: outpoint.vout,
            satoshis: expectedSatoshis,
            scriptPubKey: expectedScript,
            spent: false as const,
          });
          verifiedRow.push(trusted);
          parserRow.push({
            inputIndex,
            txid: outpoint.txid,
            outputIndex: outpoint.vout,
            satoshis: expectedSatoshis,
            lockingScript: expectedScript,
          });
        }
        verifiedInputs.push(verifiedRow);
        parserInputs.push(parserRow);
      }
      if (primaryOutpoints.some(({ txid, vout }) =>
        !primaryStatuses.has(statusKey(txid, vout)))
      ) {
        throw new Error("Legacy raw transaction trusted material mismatch");
      }

      const preliminary = await Promise.all(request.txraws.map((raw, index) =>
        decodeTxRaw(raw, { inputUtxos: parserInputs[index]! }),
      ));
      const dependencyOutpoints: Readonly<{ txid: string; vout: number }>[] = [];
      for (let transactionIndex = 0; transactionIndex < parserInputs.length; transactionIndex += 1) {
        for (const input of parserInputs[transactionIndex]!) {
          const expectation = tapeExpectation(input.lockingScript);
          if (expectation === undefined || input.txid === undefined || input.outputIndex === undefined) continue;
          dependencyOutpoints.push(Object.freeze({
            txid: input.txid,
            vout: input.outputIndex + (expectation === "nft" ? 2 : 1),
          }));
          if (expectation === "nft") {
            // Full NFT identity needs Code/Hold/Tape. Hold is usually another
            // primary input and is reused below, not fetched a second time.
            dependencyOutpoints.push(Object.freeze({ txid: input.txid, vout: input.outputIndex + 1 }));
          }
          const decodedInput = preliminary[transactionIndex]!.chain.inputs.find(
            (candidate) => candidate.index === input.inputIndex,
          );
          const origin = decodedInput?.prevout?.script.originUtxo;
          if (origin !== undefined) {
            dependencyOutpoints.push(Object.freeze({ txid: origin.txid, vout: origin.vout }));
          }
        }
      }
      const externalDependencyOutpoints = dependencyOutpoints.filter(
        ({ txid, vout }) => !primaryStatuses.has(statusKey(txid, vout)),
      );
      const dependencies = new Map(
        await readStatuses(externalDependencyOutpoints, "dependency"),
      );
      for (const [key, value] of primaryStatuses) dependencies.set(key, value);
      for (let transactionIndex = 0; transactionIndex < parserInputs.length; transactionIndex += 1) {
        for (const input of parserInputs[transactionIndex]!) {
          const expectation = tapeExpectation(input.lockingScript);
          if (expectation === undefined || input.txid === undefined || input.outputIndex === undefined) continue;
          const tapeVout = input.outputIndex + (expectation === "nft" ? 2 : 1);
          const tape = dependencies.get(statusKey(input.txid, tapeVout));
          if (
            tape?.scriptPubKey === undefined ||
            statusValue(tape, "Legacy dependency") !== 0 ||
            !hasTapeMarker(tape.scriptPubKey, expectation)
          ) {
            throw new Error("Legacy raw transaction contract context unavailable");
          }
          input.associatedTape = {
            txid: input.txid,
            outputIndex: tapeVout,
            satoshis: 0,
            lockingScript: tape.scriptPubKey,
          };
          const decodedInput = preliminary[transactionIndex]!.chain.inputs.find(
            (candidate) => candidate.index === input.inputIndex,
          );
          const origin = decodedInput?.prevout?.script.originUtxo;
          if (origin !== undefined) {
            const material = dependencies.get(statusKey(origin.txid, origin.vout));
            if (material?.scriptPubKey === undefined) {
              throw new Error("Legacy raw transaction contract origin unavailable");
            }
            input.associatedOrigin = {
              txid: origin.txid,
              outputIndex: origin.vout,
              satoshis: statusValue(material, "Legacy origin"),
              lockingScript: material.scriptPubKey,
            };
          }
        }
      }

      const decoded = await Promise.all(request.txraws.map((raw, index) =>
        decodeTxRaw(raw, { inputUtxos: parserInputs[index]! }),
      ));
      const currentIndexes: number[] = [];
      const nativeLockReviews = new Map<number, Readonly<Record<string, unknown>>>();
      const htlcTokenRows: { row: HtlcReviewRow; material: NonNullable<ReturnType<typeof inspectReviewedHtlc>> }[] = [];
      for (let index = 0; index < decoded.length; index += 1) {
        const transaction = decoded[index]!;
        if (transaction.txid !== transactionIds[index]) throw new Error("Legacy reviewer transaction ID mismatch");
        if (request.signingPublicKeys?.[index]?.some(key => key !== null)) {
          currentIndexes.push(index);continue;
        }
        const row = { index, txid: transactionIds[index]!, transaction: parsed[index]!, inputs: verifiedInputs[index]! };
        const htlcOptions = { addressVersion: network.profile.p2pkhVersion, accountAddress: context.accountId.slice(network.chainId.length + 1), associated,
          ...(associatedInputRows === undefined ? {} : { associatedInputs: associatedInputRows[index]! }) };
        const timeLockReview = reviewNativeTimelockFlow(row, htlcOptions);
        if (timeLockReview !== undefined) {
          nativeLockReviews.set(index, timeLockReview);
          continue;
        }
        const material = inspectReviewedHtlc(row, htlcOptions);
        if (material !== undefined) {
          if (material.sides.some((outputs, side) => outputs.some((output, i) => !material.codes[side]![i] && !/^76a914[0-9a-f]{40}88ac$/u.test(output.script)))) {
            htlcTokenRows.push({ row, material });
          } else nativeLockReviews.set(index, reviewNativeHtlcFlow(row, htlcOptions, material)!);
          continue;
        }
        if (
          transaction.txid !== transactionIds[index] ||
          transaction.classification.conformance === "nonstandard" ||
          transaction.classification.protocol === "stablecoin" ||
          transaction.assetFlows.length === 0 ||
          (transaction.unspendableAssetFlows?.length ?? 0) !== 0 ||
          transaction.assetFlows.some((flow) =>
            flow.asset.type === "stablecoin" ||
            flow.context?.recognized === false ||
            flow.purpose === "unknown" ||
            (flow.direction as string) === "unknown"
          )
        ) {
          currentIndexes.push(index);
        }
      }
      const currentStatuses = new Map([...dependencies, ...primaryStatuses]);
      const readCurrentStatuses = async (points: readonly Readonly<{ txid: string; vout: number }>[]) => {
        const missing = points.filter(point => !currentStatuses.has(statusKey(point.txid, point.vout)));
        for (const [key, value] of await readStatuses(missing, "current Token dependency")) currentStatuses.set(key, value);
        return currentStatuses;
      };
      const lopReviews = currentIndexes.length === 0 ? new Map<number, Readonly<Record<string, unknown>>>() : await reviewCurrentTokenFlows({
        rows: currentIndexes.map(index => ({ index, txid: transactionIds[index]!, transaction: parsed[index]!, inputs: verifiedInputs[index]!,
          ...(request.signingPublicKeys === undefined ? {} : {signingPublicKeys:request.signingPublicKeys[index]!}),
          ...(associatedInputRows === undefined ? {} : { associatedInputs: associatedInputRows[index]! }) })),
        native, api, addressVersion: network.profile.p2pkhVersion,
        holderAccountAddress: context.accountId.slice(network.chainId.length + 1),
        ...(administratorPublicKey === undefined ? {} : { administratorPublicKey }),
        readStatuses: readCurrentStatuses,
      });
      const htlcTokenReviews = htlcTokenRows.length === 0 ? new Map<number, Readonly<Record<string, unknown>>>() : await reviewHtlcTokenFlows(htlcTokenRows,
        { native, api, addressVersion: network.profile.p2pkhVersion, readStatuses: readCurrentStatuses });
      const currentReviews = new Map([...lopReviews, ...nativeLockReviews, ...htlcTokenReviews]);
      // The historical parser's suffix-based OrderBook recognition is not an
      // exact covenant check. Bind the approval terms to the planner's codec.
      // The whole-batch issuance policy below shares this same native instance
      // and already authenticated material; neither check queries versions.
      const lopIndexes = decoded.flatMap((tx, index) => !currentReviews.has(index) && tx.classification.protocol === "orderBook" ? [index] : []);
      const lopOrders = new Map<number, LopOrderInspection>();
      if (lopIndexes.length !== 0) {
        const inspected = await inspectReviewedLopOrders(native, lopIndexes.map(index => ({
          inputs: verifiedInputs[index]!.map(input => input.scriptPubKey),
          outputs: parsed[index]!.outputs.map(output => bytesToHex(output.scriptPubKey)),
        })));
        for (const [position, index] of lopIndexes.entries()) {
          const actual = inspected[position]!;
          const expected = decoded[index]!;
          if (actual.inputs.length + actual.outputs.length === 0 ||
              expected.chain.inputs.some(input => input.prevout?.script.data?.orderBook !== undefined &&
                !actual.inputs.some(order => order.index === input.index)) ||
              expected.chain.outputs.some(output => output.script.data?.orderBook !== undefined &&
                !actual.outputs.some(order => order.index === output.index))) {
            throw new Error("LOP review requires an exact supported order template");
          }
          lopOrders.set(index, actual);
        }
      }
      await requireReviewedIssuancePolicy(native,
        request.txraws.map((rawTransaction, index) => ({ rawTransaction: rawTransaction.toLowerCase(), txid: transactionIds[index]! })),
        [...currentStatuses.values()].map(status => {
          if (status.scriptPubKey === undefined) throw new Error("Reviewed issuance policy material unavailable");
          return { txid: status.txid, vout: statusIndex(status), satoshis: statusValue(status, "Reviewed issuance policy"),
            scriptPubKey: status.scriptPubKey.toLowerCase() };
        }));
      return Object.freeze({
        preview: structuredPreview(decoded, lopOrders, currentReviews),
        policyMaterial: normalizeReviewedPolicyMaterial({ resolvedOutputs: [...currentStatuses.values()]
          .filter(status => !transactionIds.includes(status.txid))
          .map(status => ({ txid: status.txid, vout: statusIndex(status),
            satoshis: String(statusValue(status, "Reviewed policy")), scriptPubKey: status.scriptPubKey!.toLowerCase() })) }),
        verifiedInputs: Object.freeze(
          verifiedInputs.map((row) => Object.freeze(row)),
        ),
      });
  };
  return review;
}

export function createTbcDefaultRawTransactionReviewer(
  options: DefaultReviewOptions,
): TbcRawTransactionReviewer {
  const review = createLegacyDefaultReviewEngine(options);
  return Object.freeze({
    review: (input: Parameters<TbcRawTransactionReviewer["review"]>[0]) => {
      if (input.signingRoles === undefined) {
        if (input.request.signingPublicKeys !== undefined) throw new Error("Raw signing keys require trusted roles");
        return review(input);
      }
      const request = JSON.parse(canonicalize(input.request)) as TbcReviewedTransactionRequest;
      const keys = request.signingPublicKeys;
      if (!Array.isArray(keys) || keys.length !== request.txraws.length || keys.some((row,index) =>
          !Array.isArray(row) || row.length !== request.script_pubkeys[index]?.length || row.some(key => key !== null && typeof key !== "string"))) {
        throw new Error("Raw administrator signing matrix missing");
      }
      const administratorPublicKey = reviewedCoinAdministrator(input.signingRoles, options.network.chainId, options.network.profile.p2pkhVersion);
      return review({...input,request,administratorPublicKey});
    },
  });
}

function unsignedInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Invalid Legacy associated ${label}`);
  }
  return value as number;
}

function hexValue(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/u.test(value)
  ) {
    throw new TypeError(`Invalid Legacy associated ${label}`);
  }
  return value.toLowerCase();
}

function littleEndian(value: number, bytes: number): string {
  let remaining = BigInt(value);
  let encoded = "";
  for (let index = 0; index < bytes; index += 1) {
    encoded += Number(remaining & 0xffn).toString(16).padStart(2, "0");
    remaining >>= 8n;
  }
  return encoded;
}

function varint(value: number): string {
  if (value < 0xfd) return value.toString(16).padStart(2, "0");
  if (value <= 0xffff) return `fd${littleEndian(value, 2)}`;
  return `fe${littleEndian(value, 4)}`;
}

function reverseTxid(txid: string): string {
  return txid.match(/../gu)!.reverse().join("");
}

function bytesHex(value: Uint8Array): string {
  let encoded = "";
  for (const byte of value) encoded += byte.toString(16).padStart(2, "0");
  return encoded;
}

function parsedSatoshis(value: number | bigint): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || BigInt(numeric) !== BigInt(value)) {
    throw new TypeError("Invalid Legacy associated parsed value");
  }
  return numeric;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid Legacy associated ${label}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function signingType(value: unknown): string {
  if (
    value === "tbc20_coin" ||
    value === "tbc20_coin_contract" ||
    !["p2pkh", "tbc20", "tbc20_contract", "other", "tbc_lop_match", "tbc20-standard", "tbc20-stablecoin"].includes(String(value))
  ) {
    throw new TypeError("Unsupported Legacy associated signing type");
  }
  return String(value);
}

function syntheticTransaction(
  inputs: readonly Readonly<{ txid: string; vout: number; sequence: number }>[],
  outputs: readonly Readonly<{ satoshis: number; script: string }>[],
  lockTime = 0,
): string {
  return [
    littleEndian(10, 4),
    varint(inputs.length),
    ...inputs.map(({ txid, vout, sequence }) =>
      `${reverseTxid(txid)}${littleEndian(vout, 4)}00${littleEndian(sequence, 4)}`
    ),
    varint(outputs.length),
    ...outputs.map(({ satoshis, script }) =>
      `${littleEndian(satoshis, 8)}${varint(script.length / 2)}${script}`
    ),
    littleEndian(lockTime, 4),
  ].join("");
}

// Only materialize the unsigned preview. Exact Code/Tape, provenance, ownership
// and lock checks still run in the shared Rust proof/reviewer before approval.
// Read existing parent bytes; never ask an indexer for a lock hint or chain tip.
function associatedCoinLock(parent: ReturnType<typeof parseTbcTransaction>, vout: number): number {
  const code = parent.outputs[vout], tape = parent.outputs[vout + 1];
  const bytes = tape?.scriptPubKey;
  if (code?.satoshis !== 500n || tape?.satoshis !== 0n || bytes === undefined ||
      bytes.length < 66 || bytes.length > 127 || bytes[0] !== 0 || bytes[1] !== 0x6a || bytes[2] !== 0x30 ||
      bytes[bytes.length - 15] !== 4 || bytes[bytes.length - 10] !== 9 ||
      bytesHex(bytes.slice(-9)) !== "544243323054415045") {
    throw new TypeError("Invalid associated Coin parent Tape");
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 14, true);
}

function associatedRawPlan(request: Readonly<Record<string, unknown>>): Readonly<{
  rawRequest: TbcReviewedTransactionRequest;
  transactionIds: readonly string[];
  localPrevouts: LocalPrevouts;
}> {
  const sourceRaw = hexValue(Reflect.get(request, "sourceTxraw"), "source transaction");
  const source = parseTbcTransaction(sourceRaw);
  const sourceUtxos = Reflect.get(request, "sourceUtxos");
  if (!Array.isArray(sourceUtxos) || sourceUtxos.length !== source.inputs.length) {
    throw new TypeError("Invalid Legacy associated source material");
  }
  const rawTransactions = [sourceRaw];
  const satoshiRows: number[][] = [[]];
  const scriptRows: string[][] = [[]];
  for (let index = 0; index < sourceUtxos.length; index += 1) {
    const item = record(sourceUtxos[index], "source input");
    signingType(Reflect.get(item, "scriptSigType"));
    const outpoint = source.inputs[index]!;
    const txid = hexValue(Reflect.get(item, "txId"), "source txid");
    const vout = unsignedInteger(Reflect.get(item, "outputIndex"), "source vout");
    if (txid !== outpoint.txid || vout !== outpoint.vout) {
      throw new TypeError("Legacy associated source outpoint mismatch");
    }
    satoshiRows[0]!.push(unsignedInteger(Reflect.get(item, "satoshis"), "source value"));
    scriptRows[0]!.push(hexValue(Reflect.get(item, "script"), "source script"));
  }

  const availableLocalOutputs = new Map<string, TbcApiTxoStatus>();
  const trustedLocalPrevouts = new Map<string, TbcApiTxoStatus>();
  const addOutputs = (raw: string): void => {
    const transaction = parseTbcTransaction(raw);
    const txid = turingTransactionId(raw);
    transaction.outputs.forEach((output, index) => {
      availableLocalOutputs.set(statusKey(txid, index), Object.freeze({
        txid,
        index: String(index),
        spent: false,
        value: String(parsedSatoshis(output.satoshis)),
        scriptPubKey: bytesHex(output.scriptPubKey),
      }));
    });
  };
  addOutputs(sourceRaw);

  const inputRows = Reflect.get(request, "inputs");
  const outputRows = Reflect.get(request, "outputs");
  if (inputRows === undefined && outputRows === undefined) {
    return Object.freeze({
      rawRequest: Object.freeze({
        txraws: Object.freeze(rawTransactions),
        utxos_satoshis: Object.freeze(satoshiRows.map((row) => Object.freeze(row))),
        script_pubkeys: Object.freeze(scriptRows.map((row) => Object.freeze(row))),
      }),
      transactionIds: Object.freeze(rawTransactions.map(turingTransactionId)),
      localPrevouts: trustedLocalPrevouts,
    });
  }
  if (
    !Array.isArray(inputRows) ||
    !Array.isArray(outputRows) ||
    inputRows.length !== outputRows.length
  ) {
    throw new TypeError("Invalid Legacy associated transaction rows");
  }
  for (let transactionIndex = 0; transactionIndex < inputRows.length; transactionIndex += 1) {
    const inputRow = inputRows[transactionIndex];
    const outputRow = outputRows[transactionIndex];
    if (!Array.isArray(inputRow) || inputRow.length === 0 || !Array.isArray(outputRow)) {
      throw new TypeError("Invalid Legacy associated transaction row");
    }
    const previousRaw = rawTransactions.at(-1)!;
    const previousTxid = turingTransactionId(previousRaw);
    const previous = parseTbcTransaction(previousRaw);
    const inputs: { txid: string; vout: number; sequence: number }[] = [];
    const amounts: number[] = [];
    const scripts: string[] = [];
    let lockTime = 0;
    let hasHtlcRefund = false;
    const coinParents = new Map<string, ReturnType<typeof parseTbcTransaction>>();
    for (const inputValue of inputRow) {
      const item = record(inputValue, "input");
      const profile = signingType(Reflect.get(item, "scriptSigType"));
      // Same shared constraints as Rust: only Coin and exact HTLC refund
      // inputs need non-final sequence. Claims/other profiles stay unchanged.
      let sequence = profile === "tbc20-stablecoin" ? 0xffff_fffe : 0xffff_ffff;
      const vout = unsignedInteger(Reflect.get(item, "outputIndex"), "input vout");
      const explicitTxid = Reflect.get(item, "txId");
      let required = 0;
      if (profile === "tbc20-stablecoin") {
        let parent = previous;
        if (explicitTxid !== undefined && explicitTxid !== null) {
          const id = hexValue(explicitTxid, "input txid");
          const raw = hexValue(Reflect.get(item, "preTx"), "Coin parent");
          if (turingTransactionId(raw) !== id) throw new TypeError("Associated Coin parent identity mismatch");
          parent = coinParents.get(id) ?? parseTbcTransaction(raw);
          coinParents.set(id, parent);
        }
        // Preview only; shared proof authenticates an explicit administrator
        // key against Code before approval or signature. No boolean bypass.
        required = item.signingPublicKey === undefined ? associatedCoinLock(parent, vout) : 0;
      } else if (profile === "other" && typeof item.unfinishedScriptSig === "string" &&
          item.unfinishedScriptSig.length === 90 && item.unfinishedScriptSig.endsWith("00")) {
        const local = explicitTxid === undefined || explicitTxid === null;
        const output = local ? previous.outputs[vout] : undefined;
        if (local && !output) throw new TypeError("Associated HTLC parent output missing");
        const script = local ? bytesHex(output!.scriptPubKey) : hexValue(item.script, "input script");
        const refund = associatedHtlcRefundLock(script, item.unfinishedScriptSig);
        if (refund !== undefined) {
          if (!local) {
            const id = hexValue(explicitTxid, "input txid"), raw = hexValue(item.preTx, "HTLC parent");
            if (turingTransactionId(raw) !== id) throw new TypeError("Associated HTLC parent identity mismatch");
            const parent = coinParents.get(id) ?? parseTbcTransaction(raw);
            coinParents.set(id, parent);
            const actual = parent.outputs[vout];
            if (!actual || bytesHex(actual.scriptPubKey) !== script || parsedSatoshis(actual.satoshis) !== item.satoshis) {
              throw new TypeError("Associated HTLC parent material mismatch");
            }
          }
          required = refund; sequence = 0xffff_fffe; hasHtlcRefund = true;
        }
      }
      if (lockTime !== 0 && required !== 0 && (lockTime < 500_000_000) !== (required < 500_000_000)) {
        throw new TypeError("Associated child locks mix height and timestamp domains");
      }
      lockTime = Math.max(lockTime, required);
      if (hasHtlcRefund && lockTime > 0x7fff_ffff) throw new TypeError("Associated HTLC refund lock outside supported range");
      if (explicitTxid === undefined || explicitTxid === null) {
        const output = previous.outputs[vout];
        if (output === undefined) {
          throw new TypeError("Legacy associated internal outpoint is unavailable");
        }
        inputs.push({ txid: previousTxid, vout, sequence });
        amounts.push(parsedSatoshis(output.satoshis));
        scripts.push(bytesHex(output.scriptPubKey));
        previous.outputs.forEach((_candidate, outputIndex) => {
          const key = statusKey(previousTxid, outputIndex);
          const local = availableLocalOutputs.get(key);
          if (local !== undefined) trustedLocalPrevouts.set(key, local);
        });
      } else {
        inputs.push({ txid: hexValue(explicitTxid, "input txid"), vout, sequence });
        amounts.push(unsignedInteger(Reflect.get(item, "satoshis"), "input value"));
        scripts.push(hexValue(Reflect.get(item, "script"), "input script"));
      }
    }
    const outputs = outputRow.map((outputValue) => {
      const item = record(outputValue, "output");
      return Object.freeze({
        satoshis: unsignedInteger(Reflect.get(item, "satoshis"), "output value"),
        script: hexValue(Reflect.get(item, "script"), "output script"),
      });
    });
    const raw = syntheticTransaction(inputs, outputs, lockTime);
    rawTransactions.push(raw);
    satoshiRows.push(amounts);
    scriptRows.push(scripts);
    addOutputs(raw);
  }
  return Object.freeze({
    rawRequest: Object.freeze({
      txraws: Object.freeze(rawTransactions),
      utxos_satoshis: Object.freeze(satoshiRows.map((row) => Object.freeze(row))),
      script_pubkeys: Object.freeze(scriptRows.map((row) => Object.freeze(row))),
    }),
    transactionIds: Object.freeze(rawTransactions.map(turingTransactionId)),
    localPrevouts: trustedLocalPrevouts,
  });
}

/** Internal shared materializer. No HTTP or witness execution. */
export function materializeAssociatedReviewRequest(request: Readonly<Record<string, unknown>>): TbcReviewedTransactionRequest {
  return associatedRawPlan(request).rawRequest;
}

/**
 * Default associated reviewer. It deterministically materializes unsigned
 * child transactions, trusts only outputs of the immediately constructed
 * local chain, and delegates every external prevout plus contract dependency
 * to the same official batched reviewer used by raw signing.
 */
export function createTbcDefaultAssociatedTransactionReviewer(
  options: DefaultReviewOptions,
): TbcAssociatedTransactionReviewer {
  const native = options.materialNative ?? createLazyBundledWasmTbcKeylessEngine();
  const reviewRaw = createLegacyDefaultReviewEngine({ ...options, materialNative: native });
  return Object.freeze({
    async review(
      { request: requestInput, operationDigest, context, publicKey, signingRoles }:
        Parameters<TbcAssociatedTransactionReviewer["review"]>[0],
    ) {
      const inputRows = [requestInput.sourceUtxos, ...((requestInput.inputs as readonly unknown[] | undefined) ?? [])];
      const current = inputRows.some(row => Array.isArray(row) && row.some(input =>
        input?.scriptSigType === "tbc20-standard" || input?.scriptSigType === "tbc20-stablecoin"));
      // Current proof material must remain the same across asynchronous reads.
      // Historical callers retain their existing small witness snapshot path.
      const currentJson = current ? canonicalize(requestInput) : undefined;
      if (currentJson !== undefined && currentJson.length > 4 * 1_048_576) {
        throw new Error("Current associated request exceeds material bound");
      }
      const request = currentJson === undefined ? requestInput : JSON.parse(currentJson) as Readonly<Record<string, unknown>>;
      const administratorPublicKey = signingRoles === undefined ? undefined : reviewedCoinAdministrator(signingRoles,
        options.network.chainId, options.network.profile.p2pkhVersion);
      if (hashCanonical({ kind: "signAssociated", request }) !== operationDigest) {
        throw new Error("Legacy associated transaction identity mismatch");
      }
      if (current) {
        const network = assertTbcNetworkContext(options.network);
        if (typeof publicKey !== "string" || !/^(?:02|03)[0-9a-f]{64}$/u.test(publicKey) ||
            context.accountId !== `${network.chainId}:${tbcAddressFromPublicKeyHash(bytesToHex(ripemd160(sha256Bytes(hexToBytes(publicKey)))), network.profile.p2pkhVersion)}`) {
          throw new Error("Current associated proof requires the bound wallet public key");
        }
      }
      const plan = associatedRawPlan(request);
      // Snapshot witness fields before awaiting external reads. Strings remain
      // local immutable references, never encoded into previews or diagnostics.
      const exactRows = [request.sourceUtxos, ...((request.inputs as readonly unknown[] | undefined) ?? [])] as
        readonly (readonly Readonly<Record<string, unknown>>[])[];
      const associatedInputRows = exactRows.map(row => row.map(input => Object.freeze({
        scriptSigType: input.scriptSigType, unfinishedScriptSig: input.unfinishedScriptSig,
        ...(input.signingPublicKey === undefined ? {} : { signingPublicKey: input.signingPublicKey }),
      })));
      const reviewed = await reviewRaw({
        request: plan.rawRequest,
        context,
        transactionIds: plan.transactionIds,
        localPrevouts: plan.localPrevouts,
        associated: true,
        associatedInputRows,
        ...(administratorPublicKey === undefined ? {} : { administratorPublicKey }),
      });
      if (current) {
        // Pure shared Rust preflight for each unsigned preview stage. These
        // digests are discarded, never sent to custody. Execution rebuilds
        // proofs with the actual signed parents under the same bound request.
        for (let index = 0; index < plan.rawRequest.txraws.length; index += 1) {
          const stage = JSON.parse(await native.execute("prepareReviewedStage", JSON.stringify({
            format: "associated", request, publicKey, transactionIndex: index,
            previousTransactions: plan.rawRequest.txraws.slice(0, index),
            resolvedOutputs: reviewed.policyMaterial.resolvedOutputs,
          }))) as Record<string, unknown>;
          if (stage.format !== "associated" || stage.transactionIndex !== index || stage.publicKey !== publicKey ||
              stage.txraw !== plan.rawRequest.txraws[index]) {
            throw new Error("Current associated proof preflight differs from approved preview");
          }
        }
      }
      const preview = reviewed.preview as Readonly<{ transactions: readonly unknown[] }>;
      return Object.freeze({
        ...reviewed,
        preview: Object.freeze({
          ...preview,
          transactions: Object.freeze(preview.transactions.map((transaction) => Object.freeze({
            ...(transaction as Readonly<Record<string, unknown>>),
            txidKind: "unsigned-preview",
          }))),
        }),
      });
    },
  });
}
