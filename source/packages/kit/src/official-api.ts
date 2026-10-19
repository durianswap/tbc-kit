import {
  TbcHttpTransport,
  TbcJsonObject,
  TbcJsonValue,
  TbcRequestOptions,
  TbcTransportOptions,
  createTbcHttpTransport,
} from "./network-transport.js";

export const TBC_API_MAINNET_ORIGIN = "https://api.turingbitchain.io";
export const TBC_API_TESTNET_ORIGIN = "https://api.tbcdev.org";

export type TbcDecimalInteger = string;
export type TbcAtomicAmount = string;
export type TbcApiRecord = TbcJsonObject;
export type TbcApiList = readonly TbcJsonValue[];

export interface TbcApiHealth {
  readonly status: string;
  readonly tip_height: TbcDecimalInteger;
  readonly synced: boolean;
  readonly mempool_size: TbcDecimalInteger;
}
export interface TbcApiNodeInfo {
  readonly chain: string;
  readonly blocks: TbcDecimalInteger;
  readonly headers: TbcDecimalInteger;
  readonly bestblockhash: string;
  readonly mediantime?: TbcDecimalInteger;
}
export interface TbcApiRawTransaction { readonly txraw: string }
export interface TbcApiBroadcastResult { readonly txid: string }
export interface TbcApiBroadcastBatchResult {
  readonly success: TbcDecimalInteger;
  readonly failed: TbcDecimalInteger;
  readonly results?: readonly (Readonly<{ readonly txid?: string; readonly error?: string }> | string)[];
}
export interface TbcApiUtxo {
  readonly txid: string;
  readonly index: TbcDecimalInteger;
  readonly value: TbcAtomicAmount;
  readonly height?: TbcDecimalInteger;
}
export interface TbcApiUtxoList { readonly utxos: readonly TbcApiUtxo[]; readonly next_cursor?: string }
export interface TbcApiTbc20Utxo {
  readonly txid: string;
  readonly index: TbcDecimalInteger;
  readonly ft_value?: TbcAtomicAmount;
  readonly balance?: TbcAtomicAmount;
  readonly tbc_value?: TbcAtomicAmount;
  readonly value?: TbcAtomicAmount;
  /** Documented LP endpoint names; canonical aliases above remain available. */
  readonly lp_balance?: TbcAtomicAmount;
  readonly tbc_balance?: TbcAtomicAmount;
  readonly height?: TbcDecimalInteger;
  readonly lock_time?: TbcDecimalInteger;
}
export interface TbcApiTbc20UtxoList { readonly utxos: readonly TbcApiTbc20Utxo[]; readonly next_cursor?: string }
export interface TbcApiPoolInfo {
  readonly ft_a_partial_hash: string;
  readonly ft_contract_id: string;
  readonly ft_lp_partial_hash: string;
  readonly lp_balance: TbcAtomicAmount;
  readonly pool_code_script: string;
  readonly service_fee_rate: TbcDecimalInteger;
  readonly service_provider: string;
  readonly tbc_balance: TbcAtomicAmount;
  readonly token_balance: TbcAtomicAmount;
  readonly txid: string;
  readonly value: TbcAtomicAmount;
  readonly version: TbcDecimalInteger;
  readonly vout: TbcDecimalInteger;
}
export interface TbcApiTxoStatusInput { readonly txid: string; readonly index: number }
export interface TbcApiTxoStatus {
  readonly txid: string;
  readonly index: TbcDecimalInteger;
  readonly spent: boolean;
  readonly value: TbcAtomicAmount;
  readonly height?: TbcDecimalInteger;
  readonly scriptPubKey?: string;
}
export interface TbcApiTxoStatusResult { readonly txos: readonly TbcApiTxoStatus[] }

export class TbcApiError extends Error {
  readonly code: string;
  readonly data?: TbcJsonValue;
  constructor(code: string, message: string, data?: TbcJsonValue) {
    super(message);
    this.name = "TbcApiError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

type Endpoint = Readonly<{
  method: string;
  http: "GET" | "POST";
  path: string;
  section: string;
  query?: readonly string[];
  effect: "read" | "write";
}>;

export const TBC_OFFICIAL_API_ENDPOINTS = Object.freeze([
  { method: "health", http: "GET", path: "api/tbc/health", section: "health", effect: "read" },
  { method: "chainState", http: "GET", path: "api/tbc/chainstate", section: "chain", effect: "read" },
  { method: "nodeInfo", http: "GET", path: "api/tbc/nodeinfo", section: "chain", effect: "read" },
  { method: "blockByHash", http: "GET", path: "api/tbc/blockByHash/hash/{hash}", section: "block", effect: "read" },
  { method: "blockByHeight", http: "GET", path: "api/tbc/blockByHeight/height/{height}", section: "block", effect: "read" },
  { method: "recentBlocks", http: "GET", path: "api/tbc/recentblocks/start/{start}/end/{end}", section: "block", effect: "read" },
  { method: "transactionsByBlockHash", http: "GET", path: "api/tbc/txbyblockhash/blockhash/{blockhash}/start/{start}/end/{end}", section: "block", effect: "read" },
  { method: "transactionsByBlockHeight", http: "GET", path: "api/tbc/txbyblockheight/height/{height}/start/{start}/end/{end}", section: "block", effect: "read" },
  { method: "decodeTransaction", http: "GET", path: "api/tbc/decode/txid/{txid}", section: "transaction", effect: "read" },
  { method: "rawTransaction", http: "GET", path: "api/tbc/txraw/txid/{txid}", section: "transaction", effect: "read" },
  { method: "broadcastTransaction", http: "POST", path: "api/tbc/broadcasttx", section: "transaction", effect: "write" },
  { method: "broadcastTransactions", http: "POST", path: "api/tbc/broadcasttxs", section: "transaction", effect: "write" },
  { method: "txoStatus", http: "POST", path: "api/tbc/txo/status", section: "transaction", effect: "read" },
  { method: "mempoolInfo", http: "GET", path: "api/tbc/mempoolinfo", section: "mempool", effect: "read" },
  { method: "mempoolTransactions", http: "GET", path: "api/tbc/mempooltxs", section: "mempool", effect: "read" },
  { method: "utxosByAddress", http: "GET", path: "api/tbc/utxo/address/{address}", section: "utxo", query: ["limit", "after", "target"], effect: "read" },
  { method: "utxosByScriptHash", http: "GET", path: "api/tbc/utxo/scriptpubkeyhash/{scriptpubkeyhash}", section: "utxo", query: ["limit", "after", "target"], effect: "read" },
  { method: "balanceByAddress", http: "GET", path: "api/tbc/balance/address/{address}", section: "address", effect: "read" },
  { method: "timelockBalanceByAddress", http: "GET", path: "api/tbc/frozenBalance/address/{address}/piggyBank", section: "timelock", effect: "read" },
  { method: "timelockUtxosByAddress", http: "GET", path: "api/tbc/frozenUtxo/address/{address}/piggyBank", section: "timelock", effect: "read" },
  { method: "historyByAddress", http: "GET", path: "api/tbc/history/address/{address}/start/{start}/end/{end}", section: "address", effect: "read" },
  { method: "historyByScriptHash", http: "GET", path: "api/tbc/history/scriptpubkeyhash/{scriptpubkeyhash}/start/{start}/end/{end}", section: "script", effect: "read" },
  { method: "multisigAddress", http: "GET", path: "api/tbc/multisig/multisigaddress/address/{address}", section: "multisig", effect: "read" },
  { method: "ftTokenListByAddress", http: "GET", path: "api/tbc/ft/tokenlist/address/{address}", section: "tbc20", effect: "read" },
  { method: "ftBalanceByAddress", http: "GET", path: "api/tbc/ft/tokenbalance/address/{address}/contract/{contract_id}", section: "tbc20", effect: "read" },
  { method: "ftHistoryByAddress", http: "GET", path: "api/tbc/ft/history/address/{address}/contract/{contract_id}/start/{start}/end/{end}", section: "tbc20", effect: "read" },
  { method: "ftAllHistoryByAddress", http: "GET", path: "api/tbc/ft/allhistory/address/{address}/start/{start}/end/{end}", section: "tbc20", effect: "read" },
  { method: "ftUtxosByAddress", http: "GET", path: "api/tbc/ft/utxo/address/{address}/contract/{contract_id}", section: "tbc20", query: ["limit", "after", "target"], effect: "read" },
  { method: "ftTokenListByCombineScript", http: "GET", path: "api/tbc/ft/tokenlist/combinescript/{combine_script}", section: "tbc20", effect: "read" },
  { method: "ftBalanceByCombineScript", http: "GET", path: "api/tbc/ft/tokenbalance/combinescript/{combine_script}/contract/{contract_id}", section: "tbc20", effect: "read" },
  { method: "ftHistoryByCombineScript", http: "GET", path: "api/tbc/ft/history/combinescript/{combine_script}/contract/{contract_id}/start/{start}/end/{end}", section: "tbc20", effect: "read" },
  { method: "ftAllHistoryByCombineScript", http: "GET", path: "api/tbc/ft/allhistory/combinescript/{combine_script}/start/{start}/end/{end}", section: "tbc20", effect: "read" },
  { method: "ftUtxosByCombineScript", http: "GET", path: "api/tbc/ft/utxo/combinescript/{combine_script}/contract/{contract_id}", section: "tbc20", query: ["limit", "after", "target"], effect: "read" },
  { method: "ftInfo", http: "GET", path: "api/tbc/ft/info/contract/{contract_id}", section: "tbc20", effect: "read" },
  { method: "ftDecode", http: "GET", path: "api/tbc/ft/decode/txid/{txid}", section: "tbc20", effect: "read" },
  { method: "ftRank", http: "GET", path: "api/tbc/ft/rank/contract/{contract_id}/start/{start}/end/{end}", section: "tbc20", effect: "read" },
  { method: "poolList", http: "GET", path: "api/tbc/pool/poollist/start/{start}/end/{end}", section: "tbc20", effect: "read" },
  { method: "poolInfo", http: "GET", path: "api/tbc/pool/poolinfo/poolid/{pool_id}", section: "tbc20", effect: "read" },
  { method: "poolLpUtxosByScriptHash", http: "GET", path: "api/tbc/pool/lputxo/scriptpubkeyhash/{scriptpubkeyhash}", section: "tbc20", query: ["limit", "after", "target"], effect: "read" },
  { method: "stablecoinInfo", http: "GET", path: "api/tbc/stablecoin/info/stablecoinid/{stablecoin_id}", section: "stablecoin", effect: "read" },
  { method: "stablecoinBalanceByAddress", http: "GET", path: "api/tbc/stablecoin/tokenbalance/address/{address}/stablecoinid/{stablecoin_id}", section: "stablecoin", effect: "read" },
  { method: "stablecoinBalanceByCombineScript", http: "GET", path: "api/tbc/stablecoin/tokenbalance/combinescript/{combine_script}/stablecoinid/{stablecoin_id}", section: "stablecoin", effect: "read" },
  { method: "stablecoinUtxosByAddress", http: "GET", path: "api/tbc/stablecoin/utxo/address/{address}/stablecoinid/{stablecoin_id}", section: "stablecoin", effect: "read" },
  { method: "stablecoinUtxosByCombineScript", http: "GET", path: "api/tbc/stablecoin/utxo/combinescript/{combine_script}/stablecoinid/{stablecoin_id}", section: "stablecoin", effect: "read" },
  { method: "stablecoinHistoryByAddress", http: "GET", path: "api/tbc/stablecoin/history/address/{address}/stablecoinid/{stablecoin_id}/start/{start}/end/{end}", section: "stablecoin", effect: "read" },
  { method: "stablecoinHistoryByCombineScript", http: "GET", path: "api/tbc/stablecoin/history/combinescript/{combine_script}/stablecoinid/{stablecoin_id}/start/{start}/end/{end}", section: "stablecoin", effect: "read" },
  { method: "stablecoinAllHistoryByAddress", http: "GET", path: "api/tbc/stablecoin/allhistory/address/{address}/start/{start}/end/{end}", section: "stablecoin", effect: "read" },
  { method: "stablecoinAllHistoryByCombineScript", http: "GET", path: "api/tbc/stablecoin/allhistory/combinescript/{combine_script}/start/{start}/end/{end}", section: "stablecoin", effect: "read" },
  { method: "stablecoinListByAddress", http: "GET", path: "api/tbc/stablecoin/stablecoinlist/address/{address}", section: "stablecoin", effect: "read" },
  { method: "stablecoinListByCombineScript", http: "GET", path: "api/tbc/stablecoin/stablecoinlist/combinescript/{combine_script}", section: "stablecoin", effect: "read" },
  { method: "stablecoinDecode", http: "GET", path: "api/tbc/stablecoin/decode/txid/{txid}", section: "stablecoin", effect: "read" },
  { method: "stablecoinRank", http: "GET", path: "api/tbc/stablecoin/rank/stablecoinid/{stablecoin_id}/start/{start}/end/{end}", section: "stablecoin", effect: "read" },
  { method: "nftCollectionInfo", http: "GET", path: "api/tbc/nft/collectioninfo/collectionid/{collection_id}", section: "tbc721", effect: "read" },
  { method: "nftInfo", http: "GET", path: "api/tbc/nft/nftinfo/nftid/{nftid}", section: "tbc721", effect: "read" },
  { method: "nftUtxosByScriptHash", http: "GET", path: "api/tbc/nft/utxo/scriptpubkeyhash/{scriptpubkeyhash}", section: "tbc721", effect: "read" },
  { method: "nftCollectionsByAddress", http: "GET", path: "api/tbc/nft/collectionbyaddress/address/{address}/start/{start}/end/{end}", section: "tbc721", effect: "read" },
  { method: "nftHistoryByAddress", http: "GET", path: "api/tbc/nft/history/address/{address}/nftid/{nftid}/start/{start}/end/{end}", section: "tbc721", effect: "read" },
  { method: "nftAllHistoryByAddress", http: "GET", path: "api/tbc/nft/allhistory/address/{address}/start/{start}/end/{end}", section: "tbc721", effect: "read" },
  { method: "nftsByCollection", http: "GET", path: "api/tbc/nft/nftbycollection/collectionid/{collection_id}/start/{start}/end/{end}", section: "tbc721", effect: "read" },
  { method: "nftsByAddress", http: "GET", path: "api/tbc/nft/nftbyaddress/address/{address}/start/{start}/end/{end}", section: "tbc721", effect: "read" },
  { method: "nftCollectionList", http: "GET", path: "api/tbc/nft/collectionlist/start/{start}/end/{end}", section: "tbc721", effect: "read" },
  { method: "nftList", http: "GET", path: "api/tbc/nft/nftlist/start/{start}/end/{end}", section: "tbc721", effect: "read" },
] as const satisfies readonly Endpoint[]);

type PathParameters<Path extends string> =
  Path extends `${string}{${infer Parameter}}${infer Rest}` ? Parameter | PathParameters<Rest> : never;
type Entry = typeof TBC_OFFICIAL_API_ENDPOINTS[number];
type EntryFor<Method extends Entry["method"]> = Extract<Entry, Readonly<{ method: Method }>>;
type QueryFor<E extends Entry> = E extends Readonly<{ query: readonly (infer Q extends string)[] }>
  ? Readonly<{ [Name in Q]?: Name extends "after" | "target" ? string : number }> : Readonly<Record<never, never>>;
type ParamsFor<E extends Entry> = Readonly<Record<PathParameters<E["path"]>, string | number>> & QueryFor<E>;

export interface TbcApiPostInputMap {
  readonly broadcastTransaction: Readonly<{ readonly txraw: string }>;
  readonly broadcastTransactions: readonly Readonly<{ readonly txraw: string }>[];
  readonly txoStatus: Readonly<{ readonly txos: readonly TbcApiTxoStatusInput[] }>;
}
export interface TbcApiResultMap {
  readonly health: TbcApiHealth;
  readonly nodeInfo: TbcApiNodeInfo;
  readonly rawTransaction: TbcApiRawTransaction;
  readonly broadcastTransaction: TbcApiBroadcastResult;
  readonly broadcastTransactions: TbcApiBroadcastBatchResult;
  readonly txoStatus: TbcApiTxoStatusResult;
  readonly utxosByAddress: TbcApiUtxoList;
  readonly utxosByScriptHash: TbcApiUtxoList;
  readonly timelockUtxosByAddress: TbcApiUtxoList;
  readonly ftUtxosByAddress: TbcApiTbc20UtxoList;
  readonly ftUtxosByCombineScript: TbcApiTbc20UtxoList;
  readonly poolLpUtxosByScriptHash: TbcApiTbc20UtxoList;
  readonly poolInfo: TbcApiPoolInfo;
  readonly recentBlocks: TbcApiList;
  readonly mempoolTransactions: TbcApiList;
}
type ResultFor<M extends Entry["method"]> = M extends keyof TbcApiResultMap ? TbcApiResultMap[M] : TbcApiRecord;
type InputFor<E extends Entry> = E["method"] extends keyof TbcApiPostInputMap
  ? TbcApiPostInputMap[E["method"]]
  : ParamsFor<E>;
type CallFor<E extends Entry> = PathParameters<E["path"]> extends never
  ? E["method"] extends keyof TbcApiPostInputMap
    ? (input: InputFor<E>, options?: TbcRequestOptions) => Promise<ResultFor<E["method"]>>
    : (options?: TbcRequestOptions) => Promise<ResultFor<E["method"]>>
  : (input: InputFor<E>, options?: TbcRequestOptions) => Promise<ResultFor<E["method"]>>;
export type TbcOfficialApiClient = Readonly<{
  [E in Entry as E["method"]]: CallFor<E>
}> & Readonly<{ transport: TbcHttpTransport }>;

export type CreateTbcOfficialApiOptions = Omit<TbcTransportOptions, "baseUrl"> & Readonly<{
  network?: "mainnet" | "testnet";
  baseUrl?: string;
}>;

function pathFor(entry: Entry, input: Readonly<Record<string, unknown>>): string {
  let path = entry.path.replace(/\{([^}]+)\}/gu, (_match, name: string) => {
    const value = input[name];
    if ((typeof value !== "string" && typeof value !== "number") || String(value) === "")
      throw new TypeError(`Missing TBC API path parameter: ${name}`);
    return encodeURIComponent(String(value));
  });
  if ("query" in entry) {
    const query = new URLSearchParams();
    for (const name of entry.query) {
      const value = input[name];
      if (value === undefined) continue;
      if (name === "after") {
        if (typeof value !== "string" || value.length === 0 || value.length > 2048) throw new TypeError("Invalid TBC UTXO cursor");
      } else if (name === "target") {
        if (typeof value !== "string" || !/^[1-9][0-9]{0,38}$/u.test(value)) throw new TypeError("TBC UTXO target must be positive atomic-unit decimal text");
      } else if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1000) {
        throw new TypeError(`Invalid TBC API query parameter: ${name}`);
      }
      query.set(name, String(value));
    }
    const encoded = query.toString();
    if (encoded !== "") path += `?${encoded}`;
  }
  return path;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TbcApiError("INVALID_RESPONSE", `Invalid ${label}`);
  return value as Record<string, unknown>;
}

const UTXO_LIST_METHODS = new Set<string>([
  "utxosByAddress",
  "utxosByScriptHash",
  "timelockUtxosByAddress",
  "ftUtxosByAddress",
  "ftUtxosByCombineScript",
  "poolLpUtxosByScriptHash",
  "stablecoinUtxosByAddress",
  "stablecoinUtxosByCombineScript",
  "nftUtxosByScriptHash",
]);

function decimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new TbcApiError("INVALID_RESPONSE", `Invalid ${label}`);
  }
  return value;
}

function normalizeIndexedHeights(value: TbcJsonValue): TbcJsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as TbcJsonObject;
  const list = record.utxos;
  if (!Array.isArray(list) || !list.some((candidate) =>
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) && candidate.height === "-1"
  )) return value;
  return Object.freeze({
    ...record,
    utxos: Object.freeze(list.map((candidate) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || candidate.height !== "-1") return candidate;
      return Object.freeze({ ...candidate, height: "0" });
    })),
  });
}

function normalizeTxoStatus(value: TbcJsonValue): TbcApiTxoStatusResult {
  const data = object(value, "TBC TXO status data");
  const canonical = Array.isArray(data.txos);
  const source = canonical ? data.txos : data.results;
  if (!Array.isArray(source) || source.length > 10_000) {
    throw new TbcApiError("INVALID_RESPONSE", "Invalid TBC TXO status list");
  }
  const txos = source.map((candidate) => {
    const row = object(candidate, "TBC TXO status row");
    const status = canonical ? row : object(row.status, "TBC TXO status state");
    if (typeof row.txid !== "string" || !/^[0-9a-f]{64}$/u.test(row.txid) || typeof status.spent !== "boolean") {
      throw new TbcApiError("INVALID_RESPONSE", "Invalid TBC TXO status identity");
    }
    const scriptPubKey = canonical ? row.scriptPubKey : row.scriptpubkey;
    if (scriptPubKey !== undefined && (typeof scriptPubKey !== "string" || !/^(?:[0-9a-f]{2})*$/u.test(scriptPubKey))) {
      throw new TbcApiError("INVALID_RESPONSE", "Invalid TBC TXO status script");
    }
    const rawHeight = row.height;
    const height = rawHeight === undefined ? undefined : rawHeight === "-1" ? "0" : decimal(rawHeight, "TBC TXO status height");
    return Object.freeze({
      txid: row.txid,
      index: decimal(row.index, "TBC TXO status index"),
      spent: status.spent,
      value: decimal(row.value, "TBC TXO status value"),
      ...(height === undefined ? {} : { height }),
      ...(scriptPubKey === undefined ? {} : { scriptPubKey }),
    });
  });
  return Object.freeze({ txos: Object.freeze(txos) });
}

function deployedAlias(
  row: Readonly<Record<string, unknown>>,
  canonical: string,
  deployed: string,
  label: string,
): unknown {
  const canonicalValue = row[canonical];
  const deployedValue = row[deployed];
  if (canonicalValue !== undefined && deployedValue !== undefined && canonicalValue !== deployedValue) {
    throw new TbcApiError("INVALID_RESPONSE", `Conflicting ${label}`);
  }
  return canonicalValue ?? deployedValue;
}

function normalizeNftUtxos(value: TbcJsonValue): TbcJsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const data = value as TbcJsonObject;
  if (!Array.isArray(data.utxos)) return value;
  if (data.utxos.length > 10_000) throw new TbcApiError("INVALID_RESPONSE", "Invalid TBC NFT UTXO list");
  return Object.freeze({
    ...data,
    utxos: Object.freeze(data.utxos.map((candidate) => {
      const row = object(candidate, "TBC NFT UTXO row");
      const index = deployedAlias(row, "index", "vout", "TBC NFT UTXO index");
      const nftId = deployedAlias(row, "nft_id", "nft_contract_id", "TBC NFT identity");
      const scriptPubKey = deployedAlias(row, "scriptPubKey", "script_pubkey", "TBC NFT UTXO script");
      return Object.freeze({
        ...row,
        ...(index === undefined ? {} : { index: index as TbcJsonValue }),
        ...(nftId === undefined ? {} : { nft_id: nftId as TbcJsonValue }),
        ...(scriptPubKey === undefined ? {} : { scriptPubKey: scriptPubKey as TbcJsonValue }),
        ...(row.height === "-1" ? { height: "0" } : {}),
      });
    })),
  });
}

function normalizeData(entry: Entry, value: TbcJsonValue): TbcJsonValue {
  if (entry.method === "txoStatus") return normalizeTxoStatus(value) as unknown as TbcJsonValue;
  if (entry.method === "nftUtxosByScriptHash") return normalizeNftUtxos(value);
  if (entry.method === "poolLpUtxosByScriptHash") return normalizeLpUtxos(value);
  return UTXO_LIST_METHODS.has(entry.method) ? normalizeIndexedHeights(value) : value;
}

/** LP REST uses lp_balance/tbc_balance, unlike FT's ft_value/tbc_value.
 * Normalize once at the API boundary; never infer balances from other indexes
 * or make another request. Exact-script/Tape checks remain in material loaders.
 */
function normalizeLpUtxos(value: TbcJsonValue): TbcJsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const data = value as TbcJsonObject;
  // Upstream 1.7.3 explicitly treats a present null LP list as empty. Do not
  // turn absent/malformed lists or transport errors into a fabricated balance.
  if (data.utxos === null) return Object.freeze({ ...data, utxos: Object.freeze([]) });
  if (!Array.isArray(data.utxos)) return value;
  if (data.utxos.length > 10_000) throw new TbcApiError("INVALID_RESPONSE", "Invalid TBC LP UTXO list");
  return Object.freeze({ ...data, utxos: Object.freeze(data.utxos.map(candidate => {
    const row = object(candidate, "TBC LP UTXO row");
    const amount = (names: readonly string[], label: string) => {
      let result: string | undefined;
      for (const name of names) {
        if (row[name] === undefined) continue;
        const current = decimal(row[name], label);
        if (result !== undefined && result !== current) throw new TbcApiError("INVALID_RESPONSE", `Conflicting ${label}`);
        result = current;
      }
      return decimal(result, label);
    };
    return Object.freeze({ ...row,
      ft_value: amount(["ft_value", "balance", "lp_balance"], "TBC LP amount"),
      tbc_value: amount(["tbc_value", "value", "tbc_balance"], "TBC LP native amount"),
      ...(row.height === "-1" ? { height: "0" } : {}),
    });
  })) });
}

async function data(transport: TbcHttpTransport, entry: Entry, input: unknown, options?: TbcRequestOptions): Promise<TbcJsonValue> {
  const params = entry.http === "POST" ? {} : object(input ?? {}, "TBC API input");
  const payload = await transport.requestJson<unknown>(
    entry.http,
    pathFor(entry, params),
    entry.http === "POST" ? input : undefined,
    {
      ...options,
      category: options?.category ?? (entry.section === "tbc20" && entry.method.startsWith("pool") ? "pool" : "api"),
      losslessIntegers: true,
      retry: entry.effect === "write"
        ? "none"
        : (options?.retry ?? "idempotent-read"),
    },
  );
  const envelope = object(payload, "TBC API envelope");
  const code = String(envelope.code);
  const message = typeof envelope.message === "string" ? envelope.message : "TBC API request failed";
  const partialBatch = entry.method === "broadcastTransactions" &&
    code === "400" && message.toLowerCase().includes("partial failure");
  if (code !== "200" && !partialBatch) throw new TbcApiError(code, message, envelope.data as TbcJsonValue | undefined);
  if (!("data" in envelope)) throw new TbcApiError("INVALID_RESPONSE", "TBC API response omitted data");
  if (envelope.data === null) throw new TbcApiError("INVALID_RESPONSE", "TBC API response returned null data");
  return normalizeData(entry, envelope.data as TbcJsonValue);
}

export function createTbcOfficialApi(options: CreateTbcOfficialApiOptions = {}): TbcOfficialApiClient {
  const origin = options.baseUrl ?? (options.network === "testnet" ? TBC_API_TESTNET_ORIGIN : TBC_API_MAINNET_ORIGIN);
  if (options.baseUrl !== undefined && options.network !== undefined) {
    const configuredOrigin = new URL(options.baseUrl).origin;
    const opposite = options.network === "testnet"
      ? TBC_API_MAINNET_ORIGIN
      : TBC_API_TESTNET_ORIGIN;
    if (configuredOrigin === opposite) {
      throw new TypeError("TBC API network does not match the official endpoint");
    }
  }
  const transport = createTbcHttpTransport({ ...options, baseUrl: origin });
  const methods: Record<string, unknown> = { transport };
  for (const entry of TBC_OFFICIAL_API_ENDPOINTS) {
    methods[entry.method] = entry.http === "GET" && !entry.path.includes("{")
      ? (options?: TbcRequestOptions) => data(transport, entry, {}, options)
      : (input: unknown, options?: TbcRequestOptions) => data(transport, entry, input, options);
  }
  return Object.freeze(methods) as TbcOfficialApiClient;
}
