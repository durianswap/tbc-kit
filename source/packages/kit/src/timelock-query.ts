import type { TbcOfficialApiClient } from "./official-api.js";
import { createImmutableTransactionCache, type ImmutableTransactionCache } from "./chain-data-tools.js";
import { assertTestnetAddress, inspectTbcTransaction } from "./testnet-validation.js";
import { bytesToHex } from "./network-bytes.js";
import { inspectTimelockCode } from "./timelock-material.js";

const HASH = /^[0-9a-f]{64}$/u;
const UINT = /^(0|[1-9][0-9]*)$/u;
type Point = Readonly<{ txid: string; vout: number }>;

export interface ListTimelockDepositsInput {
  readonly address: string;
  /** Optional exact selection. Missing selections fail, never fall back to all deposits. */
  readonly inputOutpoints?: readonly Point[];
}

export interface TimelockDeposit extends Point {
  readonly amountAtomic: string;
  readonly lockHeight: string;
  /** Height condition only, not a promise of spendability or successful submission. */
  readonly maturity: "locked" | "mature";
  readonly confirmations?: string;
  readonly scriptPubKey: string;
}

export interface TimelockDepositObservation {
  readonly address: string;
  readonly tip: Readonly<{ height: string; hash: string }>;
  readonly selection: "all-indexed" | "selected";
  readonly availability: "indexed-unspent";
  readonly deposits: readonly TimelockDeposit[];
}

export interface TimelockReader {
  readonly listDeposits: (input: ListTimelockDepositsInput) => Promise<TimelockDepositObservation>;
}

export interface CreateTimelockReaderOptions {
  /** Uses this already configured network/source; never switches API domains. */
  readonly api: Pick<TbcOfficialApiClient, "nodeInfo" | "timelockUtxosByAddress" | "rawTransaction">;
  readonly cache?: ImmutableTransactionCache;
  /** Bounds parent reads; a larger account must supply an exact bounded selection. */
  readonly maxDeposits?: number;
}

/** Read-only height-profile deposits. Local parent hash/output/template checks
 * supplement the trusted index; they do not independently prove unspent state.
 * Creation is lazy, and mutable index/tip observations are never retained. */
export function createTimelockReader(options: CreateTimelockReaderOptions): TimelockReader {
  const max = options.maxDeposits ?? 128;
  if (!Number.isSafeInteger(max) || max < 1 || max > 128) throw new TypeError("Invalid timelock query bound");
  const api = options.api, cache = options.cache ?? createImmutableTransactionCache();
  const pending = new Map<string, Promise<ReturnType<typeof inspectTbcTransaction>>>();
  function parent(txid: string) {
    const active = pending.get(txid);
    if (active !== undefined) return active;
    const work = (async () => {
      const raw = cache.get(txid)?.rawTransaction ?? (await api.rawTransaction({ txid }, { category: "txraw" })).txraw;
      const parsed = inspectTbcTransaction(raw);
      if (parsed.txid !== txid) throw new Error("Timelock parent hash mismatch");
      cache.remember({ txid, rawTransaction: raw });
      return parsed;
    })();
    pending.set(txid, work);
    void work.finally(() => { if (pending.get(txid) === work) pending.delete(txid); }).catch(() => {});
    return work;
  }
  return Object.freeze({ async listDeposits(input: ListTimelockDepositsInput): Promise<TimelockDepositObservation> {
    // Own the caller's selector before any await. Both current networks use
    // the same P2PKH address version; network identity is supplied by api.
    const address = input.address, owner = assertTestnetAddress(address).scriptPubKey.slice(6, 46);
    const points = input.inputOutpoints?.map(p => ({ txid: p.txid, vout: p.vout }));
    if (points !== undefined && (points.length < 1 || points.length > max || points.some(p => !HASH.test(p.txid) ||
      !Number.isSafeInteger(p.vout) || p.vout < 0 || p.vout > 0xffff_ffff) || new Set(points.map(p => `${p.txid}:${p.vout}`)).size !== points.length)) {
      throw new TypeError("Invalid timelock query selection");
    }
    const [node, index] = await Promise.all([
      api.nodeInfo({ category: "tip", concurrencyGroup: "timelock-query" }),
      api.timelockUtxosByAddress({ address }, { category: "asset-index", concurrencyGroup: "timelock-query" }),
    ]);
    if (!UINT.test(node.blocks) || BigInt(node.blocks) >= 500_000_000n || !HASH.test(node.bestblockhash) ||
      !Array.isArray(index.utxos) || index.utxos.length > 10_000) throw new Error("Invalid timelock query index or tip");
    const tip = Object.freeze({ height: node.blocks, hash: node.bestblockhash }), at = BigInt(tip.height);
    const selected = points === undefined ? undefined : new Set(points.map(p => `${p.txid}:${p.vout}`));
    const seen = new Set<string>();
    const rows = index.utxos.filter(row => {
      if (!HASH.test(row.txid) || !UINT.test(row.index) || BigInt(row.index) > 0xffff_ffffn ||
        !UINT.test(row.value) || BigInt(row.value) < 1n || BigInt(row.value) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid timelock query row");
      const id = `${row.txid}:${row.index}`;
      if (seen.has(id)) throw new Error("Duplicate timelock query row");
      seen.add(id); return selected === undefined || selected.has(id);
    }).map(row => ({ txid: row.txid, index: row.index, value: row.value, height: row.height }));
    if (rows.length > max) throw new Error("Timelock query requires a bounded selection");
    if (selected !== undefined && rows.length !== selected.size) throw new Error("Selected timelock deposit is unavailable");
    const ids = [...new Set(rows.map(row => row.txid))];
    // Drain every bounded parent read on failure; no background work outlives a query.
    const loaded = await Promise.allSettled(ids.map(parent));
    const parents = new Map<string, ReturnType<typeof inspectTbcTransaction>>();
    for (const [i, value] of loaded.entries()) {
      if (value.status === "rejected") throw value.reason;
      parents.set(ids[i]!, value.value);
    }
    const deposits = rows.map(row => {
      const vout = Number(row.index), output = parents.get(row.txid)!.transaction.outputs[vout];
      if (output === undefined || String(output.satoshis) !== row.value) throw new Error("Timelock index/output mismatch");
      const scriptPubKey = bytesToHex(output.scriptPubKey), code = inspectTimelockCode(scriptPubKey);
      if (code.ownerHash !== owner) throw new Error("Timelock deposit owner mismatch");
      const height = row.height === "-1" ? "0" : row.height;
      if (height !== undefined && (!UINT.test(height) || BigInt(height) > at)) throw new Error("Invalid timelock deposit height");
      return Object.freeze({ txid: row.txid, vout, amountAtomic: row.value, lockHeight: String(code.lockHeight), scriptPubKey,
        maturity: code.lockHeight <= Number(at) ? "mature" as const : "locked" as const,
        ...(height === undefined ? {} : { confirmations: height === "0" ? "0" : String(at - BigInt(height) + 1n) }) });
    }).sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout);
    return Object.freeze({ address, tip, selection: selected === undefined ? "all-indexed" : "selected",
      availability: "indexed-unspent", deposits: Object.freeze(deposits) });
  } });
}
