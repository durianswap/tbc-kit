import { utf8 } from "@tbc-wallet/core";
import { bytesToHex } from "./network-bytes.js";
import { createRequestLedger, type KitRequestLedger } from "./request-ledger.js";
import { OFFICIAL_TBC_TESTNET_API_ORIGIN } from "./network-context.js";
import { TbcApiError, createTbcOfficialApi, type TbcOfficialApiClient } from "./official-api.js";
import { TbcTransportError } from "./network-transport.js";
import { collectTbcUtxoPages } from "./utxo-pages.js";

import {
  assertRawTransaction,
  assertTestnetAddress,
  inspectTbcTransaction,
  TestnetNodeError,
  turingTransactionId,
} from "./testnet-validation.js";

export { isTestnetNodeError, TestnetNodeError } from "./testnet-validation.js";

export { OFFICIAL_TBC_TESTNET_API_ORIGIN } from "./network-context.js";

export interface TestnetTip {
  readonly height: string;
  readonly hash: string;
  /** Node-reported median for this same tip; never the device clock. */
  readonly medianTimePast?: string;
}

export interface TestnetUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: string;
  readonly height: string;
}

export interface TestnetLookupTransaction {
  readonly txid: string;
  readonly rawTransaction: string;
  /** Fresh confirmation count returned by the decode endpoint. */
  readonly confirmations: string;
  readonly inputs: readonly Readonly<{
    readonly txid: string;
    readonly vout: number;
  }>[];
  readonly outputs: readonly Readonly<{
    readonly vout: number;
    readonly satoshis: string;
    readonly scriptPubKey: string;
    readonly addresses: readonly string[];
  }>[];
}

export interface TestnetRawTransaction extends TestnetLookupTransaction {
  readonly confirmations: string;
}

export interface TestnetFtInfo {
  readonly contractId: string;
  readonly codeScript: string;
  readonly tapeScript: string;
  readonly totalSupply: string;
  readonly decimals: number;
  readonly name: string;
  readonly symbol: string;
}

type FtMetadataProfile =
  | Readonly<{ standard: "tbc20-standard"; resolveStandard?: never }>
  | Readonly<{
      standard?: never;
      /** Local template inspection only. Receives normalized hex from this
       * metadata response; must not fetch or treat the response as authority. */
      resolveStandard: (codeScript: string) =>
        "tbc20-standard" | undefined | Promise<"tbc20-standard" | undefined>;
    }>;

export interface TestnetFtUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: string;
  readonly ftAmount: string;
  /** Fresh index height; zero represents the node's mempool sentinel. */
  readonly height?: string;
}

export interface TestnetStablecoinInfo extends TestnetStablecoinMetadata {
  readonly contractId: string;
  /** Current issuance index, not an instruction to download its history. */
  readonly stateTxid: string;
  readonly stateVout: number;
}

export type TestnetStablecoinUtxo = TestnetFtUtxo;

/** Trusted API metadata for receipts; not a historical validation proof. */
export interface TestnetStablecoinMetadata extends TestnetFtInfo {}

export interface TestnetNftInfo {
  readonly contractId: string;
  readonly collectionId: string;
  readonly tokenId: string;
  readonly holder: string;
  readonly transferCount: number;
}

export interface TestnetNftHistoryEntry {
  readonly txid: string;
  /** null only for the indexed genesis/mint row, which has no prior holder. */
  readonly sender: string | null;
  readonly recipient: string;
}

export interface TestnetNftHistoryResult {
  readonly entries: readonly TestnetNftHistoryEntry[];
  readonly historyCount: number;
  readonly pages: number;
  /** Partial means the bounded request budget ended before all history was covered. */
  readonly coverage: "complete" | "partial";
}

export interface TestnetTransactionStatus {
  readonly txid: string;
  readonly status: "unknown" | "mempool" | "confirmed" | "rejected";
  readonly confirmations?: string;
}

export interface TestnetBatchBroadcastItem {
  readonly txid: string;
  readonly status: "accepted" | "rejected" | "unknown";
  readonly reason?: string;
}

export interface TestnetClient {
  /** Same-origin named API surface, sharing this client's transport and ledger. */
  readonly api?: TbcOfficialApiClient;
  readonly preflightBroadcast: (rawTransaction: string) => Promise<void>;
  readonly getUtxos: (
    address: string,
  ) => Promise<Readonly<{ tip: TestnetTip; utxos: readonly TestnetUtxo[] }>>;
  /** Fresh native index without a chain-tip query. No confirmation claim. */
  readonly getNativeUtxos?: (address: string) => Promise<readonly TestnetUtxo[]>;
  readonly getTip?: () => Promise<TestnetTip>;
  readonly getRawTransaction: (txid: string) => Promise<TestnetRawTransaction>;
  /** One decode query with local txid/output proof; null means the node did not find it. */
  readonly lookupRawTransaction: (
    txid: string,
  ) => Promise<TestnetLookupTransaction | null>;
  /** Immutable historical proof bytes only; supplies no confirmation/UTXO state. */
  readonly getRawTransactionBytes?: (txid: string) => Promise<string>;
  // Wallet-private P2PKH proof loader: mutable confirmation state comes from
  // the same fresh UTXO/tip snapshot, not a redundant decode endpoint.
  readonly getNativeUtxoParent?: (
    utxo: TestnetUtxo,
    tip: TestnetTip,
    address: string,
  ) => Promise<TestnetRawTransaction>;
  /** Metadata only, never proof of an asset's template or Genesis identity.
   * Omit options to preserve historical FT metadata limits. */
  readonly getFtInfo: (
    contractId: string,
    options?: FtMetadataProfile,
  ) => Promise<TestnetFtInfo>;
  readonly getFtUtxos: (
    address: string,
    contractId: string,
  ) => Promise<readonly TestnetFtUtxo[]>;
  readonly getStablecoinInfo: (contractId: string) => Promise<TestnetStablecoinInfo>;
  readonly getStablecoinMetadata: (contractId: string) => Promise<TestnetStablecoinMetadata>;
  readonly getStablecoinUtxos: (
    address: string,
    contractId: string,
  ) => Promise<readonly TestnetStablecoinUtxo[]>;
  readonly getNftInfo: (contractId: string) => Promise<TestnetNftInfo>;
  readonly getNftHistory: (
    address: string,
    contractId: string,
    targetTxid?: string,
  ) => Promise<TestnetNftHistoryResult>;
  readonly broadcast: (
    rawTransaction: string,
  ) => Promise<Readonly<{ txid: string }>>;
  readonly broadcastBatch: (
    rawTransactions: readonly string[],
  ) => Promise<readonly TestnetBatchBroadcastItem[]>;
  readonly getTransactionStatus: (
    txid: string,
  ) => Promise<TestnetTransactionStatus>;
}

/** Network-neutral aliases for the shared TBC REST transport. */
export type TbcChainClient = TestnetClient;
export type TbcChainFetch = TestnetFetch;
export type CreateTbcChainClientOptions = CreateTestnetClientOptions;

export const TESTNET_BROADCAST_PREFLIGHT = Symbol(
  "tws.testnet.broadcast-preflight",
);

export type TestnetFetch = typeof globalThis.fetch &
  Readonly<{
    [TESTNET_BROADCAST_PREFLIGHT]?: (
      rawTransaction: string,
    ) => void | Promise<void>;
  }>;

export interface CreateTestnetClientOptions {
  readonly baseUrl: string;
  readonly allowedOrigins?: readonly string[];
  readonly fetch: TestnetFetch;
  readonly maxResponseBytes?: number;
  readonly maxUtxos?: number;
  readonly requestTimeoutMs?: number;
  /** Optional same-request immutable-byte inspector; never caches node metadata. */
  readonly inspectTransaction?: typeof inspectTbcTransaction;
  readonly ledger?: KitRequestLedger;
}

const HASH = /^[0-9a-f]{64}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const NFT_HISTORY_PAGE_SIZE = 100;
const MAX_NFT_HISTORY_PAGES = 5;

function fail(
  code:
    | "INVALID_CONFIG"
    | "INVALID_INPUT"
    | "NODE_REQUEST_FAILED"
    | "NODE_RESPONSE_INVALID",
  message: string,
): never {
  throw new TestnetNodeError(code, message);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("NODE_RESPONSE_INVALID", "Invalid TBC Testnet response");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string") {
    return fail("NODE_RESPONSE_INVALID", "Invalid TBC Testnet text field");
  }
  return value;
}

function integer(value: unknown): number {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value) &&
          BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    return fail("NODE_RESPONSE_INVALID", "Invalid TBC Testnet integer field");
  }
  return normalized;
}

function uint(value: unknown): string {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : text(value);
  if (!UINT.test(normalized)) {
    return fail("NODE_RESPONSE_INVALID", "Invalid TBC Testnet amount field");
  }
  return normalized;
}

function hash(value: unknown): string {
  const normalized = text(value);
  if (!HASH.test(normalized)) {
    return fail("NODE_RESPONSE_INVALID", "Invalid TBC Testnet hash field");
  }
  return normalized;
}

function nonemptyText(value: unknown, maximum: number): string {
  const normalized = text(value);
  if (normalized.length === 0 || normalized.length > maximum) {
    return fail("NODE_RESPONSE_INVALID", "Invalid TBC Testnet text field");
  }
  return normalized;
}

function rawScript(value: unknown): string {
  const normalized = text(value).toLowerCase();
  if (!HEX.test(normalized)) {
    return fail("NODE_RESPONSE_INVALID", "Invalid TBC Testnet script field");
  }
  return normalized;
}

export function createTestnetClient(
  options: CreateTestnetClientOptions,
): TestnetClient {
  if (typeof options.fetch !== "function") {
    return fail("INVALID_CONFIG", "TBC Testnet fetch is unavailable");
  }
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    return fail("INVALID_CONFIG", "TBC Testnet endpoint is invalid");
  }
  const allowed = options.allowedOrigins ?? [OFFICIAL_TBC_TESTNET_API_ORIGIN];
  if (
    base.protocol !== "https:" ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== "" ||
    !allowed.includes(base.origin)
  ) {
    return fail("INVALID_CONFIG", "TBC Testnet endpoint is not authorized");
  }
  const maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
  const maxUtxos = options.maxUtxos ?? 256;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const ledger = options.ledger ?? createRequestLedger();
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 512 ||
    maxResponseBytes > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(maxUtxos) ||
    maxUtxos < 1 ||
    maxUtxos > 256 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 100 ||
    requestTimeoutMs > 60_000
  ) {
    return fail("INVALID_CONFIG", "Invalid TBC Testnet response limits");
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
  const api = createTbcOfficialApi({
    baseUrl: base.href,
    fetch: options.fetch,
    timeoutMs: requestTimeoutMs,
    maxResponseBytes,
    ledger,
    allowedOrigins: allowed,
  });

  async function apiData<T>(pending: Promise<T>, allowNotFound = false): Promise<T | null> {
    try {
      return await pending;
    } catch (error) {
      if (
        allowNotFound &&
        ((error instanceof TbcApiError && error.code === "404") ||
          (error instanceof TbcTransportError && error.status === 404))
      ) return null;
      if (error instanceof TbcApiError && error.code === "INVALID_RESPONSE")
        return fail("NODE_RESPONSE_INVALID", error.message);
      if (error instanceof TbcTransportError && ["INVALID_RESPONSE", "RESPONSE_TOO_LARGE"].includes(error.code))
        return fail("NODE_RESPONSE_INVALID", error.message);
      return fail("NODE_REQUEST_FAILED", "TBC Testnet request failed");
    }
  }

  async function getUtxos(address: string) {
    assertTestnetAddress(address);
    const [tip, utxos] = await Promise.all([getTip(), getNativeUtxos(address)]);
    return Object.freeze({ tip, utxos });
  }

  async function getTip() {
    const tipData = await apiData(api.nodeInfo({ category: "tip", concurrencyGroup: "account-index" }));
    if (tipData === null) return fail("NODE_RESPONSE_INVALID", "Incomplete TBC node tip");
    return Object.freeze({ height: uint(tipData.blocks), hash: hash(tipData.bestblockhash),
      ...(tipData.mediantime === undefined ? {} : { medianTimePast: uint(tipData.mediantime) }) });
  }

  async function getNativeUtxos(address: string) {
    assertTestnetAddress(address);
    const utxoData = await apiData(collectTbcUtxoPages(after => api.utxosByAddress({ address, ...(after === undefined ? {} : { after }) },
      { category: "native-index", concurrencyGroup: "account-index" }), { maxRows: maxUtxos }));
    if (
      utxoData === null ||
      !Array.isArray(utxoData.utxos)
    ) {
      return fail(
        "NODE_RESPONSE_INVALID",
        "Incomplete TBC Testnet UTXO response",
      );
    }
    if (utxoData.utxos.length > maxUtxos) {
      return fail("NODE_RESPONSE_INVALID", "Too many TBC Testnet UTXOs");
    }
    const keys = new Set<string>();
    const utxos = utxoData.utxos
      .map((candidate) => {
        const item = record(candidate);
        const normalized = Object.freeze({
          txid: hash(item.txid),
          vout: integer(item.index),
          satoshis: uint(item.value),
          // The official node uses -1 for an accepted, unmined output.
          // Internally zero represents mempool; all other invalid heights fail closed.
          height:
            item.height === -1 || item.height === "-1"
              ? "0"
              : uint(item.height),
        });
        if (normalized.satoshis === "0") {
          return fail("NODE_RESPONSE_INVALID", "Zero-value TBC Testnet UTXO");
        }
        const key = `${normalized.txid}:${normalized.vout}`;
        if (keys.has(key)) {
          return fail("NODE_RESPONSE_INVALID", "Duplicate TBC Testnet UTXO");
        }
        keys.add(key);
        return normalized;
      })
      .sort(
        (left, right) =>
          left.txid.localeCompare(right.txid) || left.vout - right.vout,
      );
    return Object.freeze(utxos);
  }

  async function getNativeUtxoParent(
    utxo: TestnetUtxo,
    tip: TestnetTip,
    address: string,
  ): Promise<TestnetRawTransaction> {
    const owner = assertTestnetAddress(address);
    const txid = hash(utxo.txid);
    const vout = integer(utxo.vout);
    const satoshis = uint(utxo.satoshis);
    const height = BigInt(uint(utxo.height));
    const tipHeight = BigInt(uint(tip.height));
    hash(tip.hash);
    if (satoshis === "0" || height > tipHeight) {
      return fail("NODE_RESPONSE_INVALID", "Invalid native UTXO snapshot");
    }
    const rawData = await apiData(api.rawTransaction({ txid }, { category: "txraw" }));
    if (rawData === null) {
      return fail("NODE_RESPONSE_INVALID", "Missing native UTXO parent");
    }
    const rawTransaction = assertRawTransaction(text(rawData.txraw));
    const inspected = (options.inspectTransaction ?? inspectTbcTransaction)(
      rawTransaction,
    );
    if (inspected.txid !== txid) {
      return fail(
        "NODE_RESPONSE_INVALID",
        "Native UTXO parent identity mismatch",
      );
    }
    const parsed = inspected.transaction;
    const output = parsed.outputs[vout];
    if (
      output === undefined ||
      output.satoshis.toString() !== satoshis ||
      bytesToHex(output.scriptPubKey) !== owner.scriptPubKey
    ) {
      return fail(
        "NODE_RESPONSE_INVALID",
        "Native UTXO parent output mismatch",
      );
    }
    return Object.freeze({
      txid,
      rawTransaction,
      confirmations: (height === 0n ? 0n : tipHeight - height + 1n).toString(),
      inputs: Object.freeze(
        parsed.inputs.map((input) =>
          Object.freeze({ txid: input.txid, vout: input.vout }),
        ),
      ),
      outputs: Object.freeze(
        parsed.outputs.map((item, index) => {
          const scriptPubKey = bytesToHex(item.scriptPubKey);
          return Object.freeze({
            vout: index,
            satoshis: item.satoshis.toString(),
            scriptPubKey,
            addresses: Object.freeze(
              scriptPubKey === owner.scriptPubKey ? [address] : [],
            ),
          });
        }),
      ),
    });
  }

  async function getRawTransactionBytes(txid: string): Promise<string> {
    if (!HASH.test(txid))
      return fail("INVALID_INPUT", "Invalid TBC Testnet transaction ID");
    const data = await apiData(api.rawTransaction({ txid }, { category: "txraw" }));
    if (data === null)
      return fail(
        "NODE_RESPONSE_INVALID",
        "Incomplete TBC Testnet transaction",
      );
    const raw = assertRawTransaction(text(data.txraw));
    const inspected = (options.inspectTransaction ?? inspectTbcTransaction)(
      raw,
    );
    if (inspected.txid !== txid)
      return fail(
        "NODE_RESPONSE_INVALID",
        "TBC Testnet transaction identity mismatch",
      );
    return raw;
  }

  async function lookupDecodedTransaction(
    txid: string,
  ): Promise<TestnetLookupTransaction | null> {
    if (!HASH.test(txid)) {
      return fail("INVALID_INPUT", "Invalid TBC Testnet transaction ID");
    }
    // The node's decode response already contains the signed transaction bytes.
    // Read them once with confirmation metadata; still prove the requested txid
    // locally. A second txraw GET adds no independent source of authority.
    const decoded = await apiData(api.decodeTransaction({ txid }, { category: "decode" }), true);
    if (decoded === null) return null;
    if (!Array.isArray(decoded.vout)) {
      return fail(
        "NODE_RESPONSE_INVALID",
        "Incomplete TBC Testnet transaction",
      );
    }
    const rawTransaction = assertRawTransaction(text(decoded.hex));
    const inspected = (options.inspectTransaction ?? inspectTbcTransaction)(
      rawTransaction,
    );
    if (decoded.txid !== txid || inspected.txid !== txid) {
      return fail(
        "NODE_RESPONSE_INVALID",
        "TBC Testnet transaction identity mismatch",
      );
    }
    const parsed = inspected.transaction;
    if (decoded.vout.length !== parsed.outputs.length) {
      return fail("NODE_RESPONSE_INVALID", "TBC Testnet output count mismatch");
    }
    const outputs = decoded.vout.map((candidate, index) => {
      const output = record(candidate);
      const script = record(output.scriptPubKey);
      const parsedOutput = parsed.outputs[index];
      if (
        parsedOutput === undefined ||
        integer(output.n) !== index ||
        text(script.hex) !== bytesToHex(parsedOutput.scriptPubKey)
      ) {
        return fail("NODE_RESPONSE_INVALID", "TBC Testnet output mismatch");
      }
      const addresses = script.addresses ?? [];
      if (
        !Array.isArray(addresses) ||
        addresses.some((address) => typeof address !== "string")
      ) {
        return fail(
          "NODE_RESPONSE_INVALID",
          "Invalid TBC Testnet output addresses",
        );
      }
      if (
        output.valueSat !== undefined &&
        uint(output.valueSat) !== parsedOutput.satoshis.toString()
      ) {
        return fail(
          "NODE_RESPONSE_INVALID",
          "TBC Testnet output amount mismatch",
        );
      }
      return Object.freeze({
        vout: index,
        satoshis: parsedOutput.satoshis.toString(),
        scriptPubKey: bytesToHex(parsedOutput.scriptPubKey),
        addresses: Object.freeze([...(addresses as string[])]),
      });
    });
    const decodedConfirmations = uint(decoded.confirmations);
    return Object.freeze({
      txid,
      rawTransaction,
      confirmations: decodedConfirmations,
      inputs: Object.freeze(
        parsed.inputs.map((input) =>
          Object.freeze({ txid: input.txid, vout: input.vout }),
        ),
      ),
      outputs: Object.freeze(outputs),
    });
  }

  async function decodedTransaction(txid: string): Promise<TestnetRawTransaction> {
    const decoded = await lookupDecodedTransaction(txid);
    if (decoded === null) {
      return fail(
        "NODE_RESPONSE_INVALID",
        "Incomplete TBC Testnet transaction",
      );
    }
    return Object.freeze({ ...decoded, confirmations: decoded.confirmations });
  }

  async function getFtInfo(
    contractId: string,
    profile?: FtMetadataProfile,
  ): Promise<TestnetFtInfo> {
    if (!HASH.test(contractId)) {
      return fail("INVALID_INPUT", "Invalid TBC Testnet FT contract ID");
    }
    if (profile !== undefined && (profile === null || typeof profile !== "object" || Array.isArray(profile) ||
        !((profile.standard === "tbc20-standard" && profile.resolveStandard === undefined) ||
          (profile.standard === undefined && typeof profile.resolveStandard === "function")))) {
      return fail("INVALID_INPUT", "Unsupported FT metadata profile");
    }
    const data = await apiData(api.ftInfo({ contract_id: contractId }));
    if (data === null) {
      return fail(
        "NODE_RESPONSE_INVALID",
        "Incomplete TBC Testnet FT metadata",
      );
    }
    const codeScript = rawScript(data.code_script);
    const standard = profile?.resolveStandard === undefined
      ? profile?.standard
      : await profile.resolveStandard(codeScript);
    if (standard !== undefined && standard !== "tbc20-standard") {
      return fail("INVALID_INPUT", "Unsupported resolved FT metadata profile");
    }
    const decimals = integer(data.decimal);
    if (decimals > 18) {
      return fail("NODE_RESPONSE_INVALID", "Invalid TBC Testnet FT decimals");
    }
    const totalSupply = uint(data.amount);
    const name = nonemptyText(data.name, standard === undefined ? 64 : 53);
    const symbol = nonemptyText(data.symbol, standard === undefined ? 16 : 52);
    if (standard !== undefined) {
      let validUtf8 = false;
      try {
        validUtf8 = utf8(name).length + utf8(symbol).length <= 53;
      } catch { /* Lone surrogates cannot identify canonical metadata bytes. */ }
      if (!validUtf8 || name.normalize("NFC") !== name || !/^[\x21-\x7e]+$/u.test(symbol)
        || BigInt(totalSupply) === 0n || BigInt(totalSupply) > (1n << 63n) - 1n) {
        return fail("NODE_RESPONSE_INVALID", "Invalid TBC20 standard metadata");
      }
    }
    return Object.freeze({
      contractId,
      codeScript,
      tapeScript: rawScript(data.tape_script),
      totalSupply,
      decimals,
      name,
      symbol,
    });
  }

  async function getFtUtxos(
    address: string,
    contractId: string,
  ): Promise<readonly TestnetFtUtxo[]> {
    const account = assertTestnetAddress(address);
    if (!HASH.test(contractId)) {
      return fail("INVALID_INPUT", "Invalid TBC Testnet FT contract ID");
    }
    const data = await apiData(collectTbcUtxoPages(after => api.ftUtxosByCombineScript(
      { combine_script: `${account.publicKeyHash}00`, contract_id: contractId, ...(after === undefined ? {} : { after }) },
      { category: "asset-index" },
    ), { maxRows: maxUtxos }));
    if (data === null || !Array.isArray(data.utxos)) {
      return fail("NODE_RESPONSE_INVALID", "Incomplete TBC Testnet FT UTXOs");
    }
    if (data.utxos.length > maxUtxos) {
      return fail("NODE_RESPONSE_INVALID", "Too many TBC Testnet FT UTXOs");
    }
    const outpoints = new Set<string>();
    const result = data.utxos.map((candidate) => {
      const item = record(candidate);
      const normalized = Object.freeze({
        txid: hash(item.txid),
        vout: integer(item.index),
        satoshis: uint(item.tbc_value),
        ftAmount: uint(item.ft_value),
        ...(item.height === undefined
          ? {}
          : {
              height:
                item.height === -1 || item.height === "-1"
                  ? "0"
                  : uint(item.height),
            }),
      });
      if (normalized.satoshis === "0" || normalized.ftAmount === "0") {
        return fail("NODE_RESPONSE_INVALID", "Invalid TBC Testnet FT UTXO");
      }
      const outpoint = `${normalized.txid}:${normalized.vout}`;
      if (outpoints.has(outpoint)) {
        return fail("NODE_RESPONSE_INVALID", "Duplicate TBC Testnet FT UTXO");
      }
      outpoints.add(outpoint);
      return normalized;
    });
    return Object.freeze(
      result.sort(
        (left, right) =>
          left.txid.localeCompare(right.txid) || left.vout - right.vout,
      ),
    );
  }

  async function getStablecoinInfo(contractId: string): Promise<TestnetStablecoinInfo> {
    if (!HASH.test(contractId)) {
      return fail("INVALID_INPUT", "Invalid TBC Testnet StableCoin contract ID");
    }
    const data = await apiData(api.stablecoinInfo({ stablecoin_id: contractId }));
    if (data === null || hash(data.stablecoin_id) !== contractId) {
      return fail("NODE_RESPONSE_INVALID", "Incomplete TBC Testnet StableCoin metadata");
    }
    const utxo = record(data.utxo);
    const decimals = integer(data.decimal);
    if (decimals > 18) return fail("NODE_RESPONSE_INVALID", "Invalid stablecoin decimals");
    return Object.freeze({
      contractId,
      stateTxid: hash(utxo.txid),
      stateVout: integer(utxo.vout),
      codeScript: rawScript(data.code_script), tapeScript: rawScript(data.tape_script),
      totalSupply: uint(data.supply), decimals,
      name: nonemptyText(data.name, 256), symbol: nonemptyText(data.symbol, 256),
    });
  }

  async function getStablecoinMetadata(contractId: string): Promise<TestnetStablecoinMetadata> {
    if (!HASH.test(contractId)) return fail("INVALID_INPUT", "Invalid stablecoin asset ID");
    const data = await apiData(api.stablecoinInfo({ stablecoin_id: contractId }));
    if (data === null || hash(data.stablecoin_id) !== contractId) {
      return fail("NODE_RESPONSE_INVALID", "Stablecoin metadata identity differs");
    }
    const decimals = integer(data.decimal);
    if (decimals > 18) return fail("NODE_RESPONSE_INVALID", "Invalid stablecoin decimals");
    return Object.freeze({ contractId, codeScript: rawScript(data.code_script), tapeScript: rawScript(data.tape_script),
      totalSupply: uint(data.supply), decimals, name: nonemptyText(data.name, 256), symbol: nonemptyText(data.symbol, 256) });
  }

  async function getStablecoinUtxos(
    address: string,
    contractId: string,
  ): Promise<readonly TestnetStablecoinUtxo[]> {
    const account = assertTestnetAddress(address);
    if (!HASH.test(contractId)) {
      return fail("INVALID_INPUT", "Invalid TBC Testnet StableCoin contract ID");
    }
    const data = await apiData(api.stablecoinUtxosByCombineScript(
      { combine_script: `${account.publicKeyHash}00`, stablecoin_id: contractId },
      { category: "asset-index" },
    ));
    if (data === null || !Array.isArray(data.utxos)) {
      return fail("NODE_RESPONSE_INVALID", "Incomplete TBC Testnet StableCoin UTXOs");
    }
    if (data.utxos.length > maxUtxos) {
      return fail("NODE_RESPONSE_INVALID", "Too many TBC Testnet StableCoin UTXOs");
    }
    const outpoints = new Set<string>();
    const result = data.utxos.map((candidate) => {
      const item = record(candidate);
      const normalized = Object.freeze({
        txid: hash(item.txid),
        vout: integer(item.index),
        satoshis: uint(item.tbc_value),
        ftAmount: uint(item.ft_value),
        ...(item.height === undefined
          ? {}
          : { height: item.height === -1 || item.height === "-1" ? "0" : uint(item.height) }),
      });
      if (normalized.satoshis === "0" || normalized.ftAmount === "0") {
        return fail("NODE_RESPONSE_INVALID", "Invalid TBC Testnet StableCoin UTXO");
      }
      const outpoint = `${normalized.txid}:${normalized.vout}`;
      if (outpoints.has(outpoint)) {
        return fail("NODE_RESPONSE_INVALID", "Duplicate TBC Testnet StableCoin UTXO");
      }
      outpoints.add(outpoint);
      return normalized;
    });
    return Object.freeze(result.sort((left, right) =>
      left.txid.localeCompare(right.txid) || left.vout - right.vout,
    ));
  }

  async function getNftInfo(contractId: string): Promise<TestnetNftInfo> {
    if (!HASH.test(contractId)) {
      return fail("INVALID_INPUT", "Invalid TBC NFT contract ID");
    }
    const data = await apiData(api.nftInfo({ nftid: contractId }));
    if (data === null || hash(data.nft_contract_id) !== contractId) {
      return fail("NODE_RESPONSE_INVALID", "Incomplete TBC NFT metadata");
    }
    const holder = text(data.nft_holder);
    assertTestnetAddress(holder);
    return Object.freeze({
      contractId,
      collectionId: hash(data.collection_id),
      tokenId: integer(data.collection_index).toString(),
      holder,
      transferCount: integer(data.nft_transfer_count),
    });
  }

  async function getNftHistory(
    address: string,
    contractId: string,
    targetTxid?: string,
  ): Promise<TestnetNftHistoryResult> {
    assertTestnetAddress(address);
    if (!HASH.test(contractId)) {
      return fail("INVALID_INPUT", "Invalid TBC NFT contract ID");
    }
    if (targetTxid !== undefined && !HASH.test(targetTxid)) {
      return fail("INVALID_INPUT", "Invalid TBC NFT history transaction ID");
    }
    const entries: TestnetNftHistoryEntry[] = [];
    const seen = new Set<string>();
    let historyCount: number | undefined;
    for (let page = 0; page < MAX_NFT_HISTORY_PAGES; page += 1) {
      const start = page * NFT_HISTORY_PAGE_SIZE;
      const end = start + NFT_HISTORY_PAGE_SIZE;
      const data = await apiData(api.nftHistoryByAddress({
        address,
        nftid: contractId,
        start,
        end,
      }));
      if (
        data === null || data.address !== address ||
        hash(data.nft_contract_id) !== contractId || !Array.isArray(data.result) ||
        data.result.length > NFT_HISTORY_PAGE_SIZE
      ) {
        return fail("NODE_RESPONSE_INVALID", "Incomplete TBC NFT history");
      }
      const pageHistoryCount = integer(data.history_count);
      if (historyCount === undefined) historyCount = pageHistoryCount;
      if (historyCount !== pageHistoryCount || entries.length > historyCount) {
        return fail("NODE_RESPONSE_INVALID", "Inconsistent TBC NFT history pagination");
      }
      const pageEntries = data.result.map((candidate) => {
        const item = record(candidate);
        const txid = hash(item.txid);
        // Official NFT history uses an empty sender for the mint itself.
        // Do not invent a zero address or relax normal transfer validation.
        const sender = item.sender_address === "" && txid === contractId
          ? null : text(item.sender_address);
        const recipient = text(item.recipient_address);
        if (sender !== null) assertTestnetAddress(sender);
        assertTestnetAddress(recipient);
        const entry = Object.freeze({ txid, sender, recipient });
        const identity = `${entry.txid}:${entry.sender}:${entry.recipient}`;
        if (seen.has(identity)) {
          return fail("NODE_RESPONSE_INVALID", "Duplicate TBC NFT history entry");
        }
        seen.add(identity);
        return entry;
      });
      entries.push(...pageEntries);
      if (entries.length > historyCount) {
        return fail("NODE_RESPONSE_INVALID", "Invalid TBC NFT history count");
      }
      const pages = page + 1;
      const found = targetTxid !== undefined &&
        pageEntries.some((entry) => entry.txid === targetTxid);
      if (found || entries.length === historyCount) {
        return Object.freeze({
          entries: Object.freeze(entries),
          historyCount,
          pages,
          coverage: entries.length === historyCount
            ? "complete" as const
            : "partial" as const,
        });
      }
      if (pageEntries.length < NFT_HISTORY_PAGE_SIZE) {
        return fail("NODE_RESPONSE_INVALID", "Incomplete TBC NFT history page");
      }
    }
    return Object.freeze({
      entries: Object.freeze(entries),
      historyCount: historyCount ?? 0,
      pages: MAX_NFT_HISTORY_PAGES,
      coverage: "partial" as const,
    });
  }

  async function broadcast(rawTransaction: string) {
    const raw = assertRawTransaction(rawTransaction);
    const expectedTxid = turingTransactionId(raw);
    const data = await apiData(api.broadcastTransaction({ txraw: raw }, { category: "broadcast" }));
    if (data === null || hash(data.txid) !== expectedTxid) {
      return fail(
        "NODE_RESPONSE_INVALID",
        "TBC Testnet broadcast identity mismatch",
      );
    }
    return Object.freeze({ txid: expectedTxid });
  }

  async function broadcastBatch(rawTransactions: readonly string[]) {
    if (!Array.isArray(rawTransactions) || rawTransactions.length < 1 || rawTransactions.length > 32) {
      return fail("INVALID_INPUT", "TBC batch broadcast requires between 1 and 32 transactions");
    }
    const raws = rawTransactions.map(assertRawTransaction);
    const txids = raws.map(turingTransactionId);
    if (new Set(txids).size !== txids.length) {
      return fail("INVALID_INPUT", "TBC batch broadcast contains duplicate transactions");
    }
    const data = await apiData(api.broadcastTransactions(
      raws.map((txraw) => Object.freeze({ txraw })),
      { category: "broadcast" },
    ));
    const count = (value: unknown): number | undefined => {
      if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    };
    const success = count(data?.success);
    const failed = count(data?.failed);
    if (
      data === null ||
      success === undefined || failed === undefined ||
      success + failed > raws.length ||
      (data.results !== undefined && (!Array.isArray(data.results) || data.results.length > raws.length))
    ) {
      return fail("NODE_RESPONSE_INVALID", "Invalid TBC batch broadcast result");
    }
    return Object.freeze(txids.map((txid, index) => {
      const candidate = data.results?.[index];
      if (typeof candidate === "string") {
        return candidate === txid
          ? Object.freeze({ txid, status: "accepted" as const })
          : Object.freeze({ txid, status: "rejected" as const, reason: candidate.slice(0, 512) || "TBC batch item rejected" });
      }
      if (candidate !== null && typeof candidate === "object") {
        if (candidate.txid === txid && candidate.error === undefined) {
          return Object.freeze({ txid, status: "accepted" as const });
        }
        if (typeof candidate.error === "string" && candidate.error.length > 0) {
          return Object.freeze({ txid, status: "rejected" as const, reason: candidate.error.slice(0, 512) });
        }
      }
      return Object.freeze({
        txid,
        status: "unknown" as const,
        reason: "TBC batch response omitted this transaction result",
      });
    }));
  }

  async function preflightBroadcast(rawTransaction: string): Promise<void> {
    const raw = assertRawTransaction(rawTransaction);
    await options.fetch[TESTNET_BROADCAST_PREFLIGHT]?.(raw);
  }

  async function getTransactionStatus(
    txid: string,
  ): Promise<TestnetTransactionStatus> {
    if (!HASH.test(txid)) {
      return fail("INVALID_INPUT", "Invalid TBC Testnet transaction ID");
    }
    const data = await apiData(api.decodeTransaction({ txid }, { category: "decode" }), true);
    if (data === null) return Object.freeze({ txid, status: "unknown" });
    if (data.txid !== txid) {
      return fail(
        "NODE_RESPONSE_INVALID",
        "TBC Testnet status identity mismatch",
      );
    }
    const confirmations = uint(data.confirmations);
    return Object.freeze({
      txid,
      status: BigInt(confirmations) > 0n ? "confirmed" : "mempool",
      confirmations,
    });
  }

  return Object.freeze({
    api,
    preflightBroadcast,
    getUtxos,
    getNativeUtxos,
    getTip,
    getRawTransaction: decodedTransaction,
    lookupRawTransaction: lookupDecodedTransaction,
    getRawTransactionBytes,
    getNativeUtxoParent,
    getFtInfo,
    getFtUtxos,
    getStablecoinInfo,
    getStablecoinMetadata,
    getStablecoinUtxos,
    getNftInfo,
    getNftHistory,
    broadcast,
    broadcastBatch,
    getTransactionStatus,
  });
}

export const createTbcChainClient = createTestnetClient;
