import type { TbcOfficialApiClient } from "./official-api.js";
import { createImmutableTransactionCache, type ImmutableTransactionBytes, type ImmutableTransactionCache } from "./chain-data-tools.js";
import { assertTestnetAddress } from "./testnet-validation.js";
import { bytesToHex, hexToBytes, sha256Bytes } from "./network-bytes.js";
import { forEachTxoStatusBatch } from "./txo-status-batches.js";

const HASH = /^[0-9a-f]{64}$/u;
const MINT_SUFFIX = "6a0d5630204d696e74204e486f6c64";
const MAX_SLOTS = 4095;
export interface GetTbc721MintStatusInput { readonly collectionId: string; readonly address: string }
export interface Tbc721Collection { readonly collectionId: string; readonly ownerAddress: string; readonly supply: number }
type Observation = Readonly<{ collectionId: string; address: string; source: "trusted-api" }>;
/** Current API observation, not a slot reservation, mint authorization or consensus proof. */
export type Tbc721MintStatus = Observation & (
  | Readonly<{ status: "available" | "exhausted"; collection: Tbc721Collection;
      availableSlots: readonly number[]; availableCount: number; spentCount: number }>
  | Readonly<{ status: "not-owner"; collection: Tbc721Collection }>
  | Readonly<{ status: "unknown"; reason: "collection-unavailable" | "status-unavailable" | "incomplete-status";
      collection?: Tbc721Collection; availableSlots: readonly number[]; unknownSlots?: readonly number[] }>
);
export interface Tbc721Reader {
  readonly getMintStatus: (input: GetTbc721MintStatusInput) => Promise<Tbc721MintStatus>;
}
export interface CreateTbc721ReaderOptions {
  /** Reuse the configured network/source; no API-domain switching. */
  readonly api: Pick<TbcOfficialApiClient, "rawTransaction" | "utxosByScriptHash" | "txoStatus">;
  /** Reuse the application's keyless Native/WASM codec; no signing or custody. */
  readonly engine: Readonly<{ execute(operation: string, requestJson: string): Promise<string> }>;
  readonly cache?: ImmutableTransactionCache;
}
type Layout = Readonly<{ collection: Tbc721Collection; slotScript: string }>;
class CollectionUnavailable extends Error {}

export function createTbc721Reader(options: CreateTbc721ReaderOptions): Tbc721Reader {
  const { api, engine } = options;
  const cache = options.cache ?? createImmutableTransactionCache();
  const layouts = new WeakMap<ImmutableTransactionBytes, Layout>();
  const loading = new Map<string, Promise<Layout>>();
  const observations = new Map<string, Promise<Tbc721MintStatus>>();
  function load(collectionId: string): Promise<Layout> {
    const active = loading.get(collectionId);
    if (active) return active;
    const work = (async () => {
      const stored = cache.get(collectionId);
      const parsed = stored && layouts.get(stored);
      if (parsed) return parsed;
      let raw = stored?.rawTransaction;
      if (raw === undefined) {
        try { raw = (await api.rawTransaction({ txid: collectionId }, { category: "txraw" })).txraw; }
        catch { throw new CollectionUnavailable(); }
      }
      if (typeof raw !== "string" || raw.length === 0 || raw.length > 2 * 1_048_576 || !/^(?:[0-9a-f]{2})+$/u.test(raw)) {
        throw new Error("Invalid collection transaction bytes");
      }
      // Same hash, Tape, supply and exact slot checks used by the Rust builder.
      // Collection bytes alone cannot distinguish historical/current issuance.
      const row = JSON.parse(await engine.execute("inspectTokenMaterial", JSON.stringify({
        phase: "inspectCollection", contractId: collectionId, rawTransaction: raw,
      }))) as Record<string, unknown>;
      if (!row || row.collectionId !== collectionId || row.verification !== "collection-template" || row.generation !== "shared"
          || typeof row.ownerAddress !== "string" || !Number.isSafeInteger(row.supply) || Number(row.supply) < 1 || Number(row.supply) > MAX_SLOTS
          || row.slotScript !== `${assertTestnetAddress(row.ownerAddress).scriptPubKey}${MINT_SUFFIX}`) {
        throw new Error("Invalid collection layout result");
      }
      const result = Object.freeze({ collection: Object.freeze({ collectionId, ownerAddress: row.ownerAddress, supply: Number(row.supply) }),
        slotScript: row.slotScript as string });
      cache.remember({ txid: collectionId, rawTransaction: raw });
      const saved = cache.get(collectionId);
      if (saved) layouts.set(saved, result);
      return result;
    })();
    loading.set(collectionId, work);
    void work.finally(() => { if (loading.get(collectionId) === work) loading.delete(collectionId); }).catch(() => {});
    return work;
  }
  async function observe(collectionId: string, address: string, slotScript: string): Promise<Tbc721MintStatus> {
    const base = { collectionId, address, source: "trusted-api" as const };
    // Start independent immutable bytes and unspent-index reads together.
    // Drain both even on failure, without retry or a background query.
    const [loaded, indexed] = await Promise.allSettled([
      load(collectionId), api.utxosByScriptHash({ scriptpubkeyhash: bytesToHex(sha256Bytes(hexToBytes(slotScript)).reverse()) }, { category: "asset-index" }),
    ]);
    if (loaded.status === "rejected") {
      if (!(loaded.reason instanceof CollectionUnavailable)) throw loaded.reason;
      return Object.freeze({ ...base, status: "unknown", reason: "collection-unavailable", availableSlots: Object.freeze([]) });
    }
    const { collection } = loaded.value;
    if (collection.ownerAddress !== address) return Object.freeze({ ...base, status: "not-owner", collection });
    const available = new Set<number>(), spent = new Set<number>();
    function slot(row: { txid: string; index: string; value: string; scriptPubKey?: string }): number {
      const n = Number(row.index);
      if (row.txid !== collectionId || !/^[1-9][0-9]*$/u.test(row.index) || !Number.isSafeInteger(n) || n > collection.supply
          || row.value !== "100" || (row.scriptPubKey !== undefined && row.scriptPubKey !== slotScript)) {
        throw new Error("Collection slot index does not match immutable output");
      }
      return n;
    }
    if (indexed.status === "fulfilled") {
      const rows = indexed.value.utxos;
      if (!Array.isArray(rows) || rows.length > 10_000) throw new Error("Invalid collection slot index");
      for (const row of rows) {
        if (row.txid !== collectionId) continue;
        const n = slot(row);
        if (available.has(n)) throw new Error("Duplicate collection slot index");
        available.add(n);
      }
    }
    const missing = Array.from({ length: collection.supply }, (_, i) => i + 1).filter(n => !available.has(n));
    let statusUnavailable = false;
    // Query only missing outputs, once each, within the API's 25-output limit.
    // Bounded parallel windows reuse this observation and its immutable layout;
    // no parent, tip, funding, history scan, retry or mutable status cache.
    await forEachTxoStatusBatch(api, missing.map(index => ({ txid: collectionId, index })), result => {
      if (result.status === "rejected") { statusUnavailable = true; return; }
      const { response, requested: batch } = result.value;
      if (!response || !Array.isArray(response.txos) || response.txos.length > batch.length) throw new Error("Invalid collection status response");
      const requested = new Set(batch.map(p => p.index)), seen = new Set<number>();
      for (const row of response.txos) {
        const n = slot(row);
        if (!requested.has(n) || seen.has(n) || typeof row.spent !== "boolean") throw new Error("Invalid collection status identity");
        seen.add(n);
        (row.spent ? spent : available).add(n);
      }
    });
    const availableSlots = Object.freeze([...available].sort((a, b) => a - b));
    const unknownSlots = Object.freeze(missing.filter(n => !available.has(n) && !spent.has(n)));
    if (unknownSlots.length > 0) return Object.freeze({ ...base, status: "unknown", collection, availableSlots, unknownSlots,
      reason: statusUnavailable ? "status-unavailable" : "incomplete-status" });
    return Object.freeze({ ...base, status: available.size > 0 ? "available" : "exhausted", collection, availableSlots,
      availableCount: available.size, spentCount: spent.size });
  }
  return Object.freeze({ getMintStatus(input: GetTbc721MintStatusInput): Promise<Tbc721MintStatus> {
    const { collectionId, address } = input;
    if (typeof collectionId !== "string" || !HASH.test(collectionId)) throw new TypeError("Invalid collection ID");
    const script = `${assertTestnetAddress(address).scriptPubKey}${MINT_SUFFIX}`;
    const key = `${collectionId}:${address}`;
    const active = observations.get(key);
    if (active) return active;
    const work = observe(collectionId, address, script);
    observations.set(key, work);
    void work.finally(() => { if (observations.get(key) === work) observations.delete(key); }).catch(() => {});
    return work;
  } });
}
