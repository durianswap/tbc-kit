import type { TbcOfficialApiClient, TbcApiTxoStatus } from "./official-api.js";
import type { TestnetTip } from "./testnet-client.js";
import { forEachTxoStatusBatch } from "./txo-status-batches.js";

type Point = Readonly<{ txid: string; vout: number }>;
type Parent = Readonly<{ txid: string; rawTransaction: string; confirmations?: string;
  outputs: readonly Readonly<{ vout: number; satoshis: string; scriptPubKey: string }>[] }>;
const HASH = /^[0-9a-f]{64}$/u;
const UINT = /^(0|[1-9][0-9]*)$/u;
const REFUND = "8152ba816ea0646e040065cd1da263040065cd1da269a1676d7551686700686956ba01247f778104ffffffff9e6976a914";

/** Exact routing decode, not signature or hashlock authorization. The Engine
 * separately authenticates parent bytes, roles and the supplied claim proof. */
export function inspectHtlcCode(script: string): Readonly<{
  hashlock: string; receiverHash: string; senderHash: string; lockTime: number;
}> {
  if (!/^[0-9a-f]{274}$/u.test(script) || script.slice(0, 6) !== "63a820" ||
      script.slice(70, 78) !== "8876a914" || script.slice(118, 122) !== "6704" ||
      script.slice(130, 228) !== REFUND || script.slice(268) !== "6888ac") {
    throw new TypeError("Unsupported HTLC Code");
  }
  const lockTime = Number.parseInt(script.slice(122, 130).match(/../gu)!.reverse().join(""), 16);
  return Object.freeze({ hashlock: script.slice(6, 70), receiverHash: script.slice(78, 118),
    senderHash: script.slice(228, 268), lockTime });
}

/** Native HTLC only. Reads exact selected outputs and unique direct parents;
 * never accepts/sends a preimage, scans a funding index, or walks ancestors.
 * txoStatus is a read-only HTTP POST, not a transaction broadcast. */
export async function resolveHtlcMaterial(input: Readonly<{
  api: TbcOfficialApiClient;
  branch: "claim" | "refund";
  ownerScript: string;
  inputOutpoints: readonly Point[];
  minimumConfirmations: string;
  readHistory: (txid: string) => Promise<Parent>;
  readDecoded: (txid: string) => Promise<Parent>;
}>) {
  // Snapshot request-owned selectors before any asynchronous transport call.
  const points = input.inputOutpoints.map(point => Object.freeze({ ...point }));
  const { branch, ownerScript, minimumConfirmations, api, readHistory, readDecoded } = input;
  if ((branch !== "claim" && branch !== "refund") || points.length < 1 || points.length > 128 ||
      points.some(p => !HASH.test(p.txid) || !Number.isSafeInteger(p.vout) || p.vout < 0 || p.vout > 0xffff_ffff) ||
      new Set(points.map(p => `${p.txid}:${p.vout}`)).size !== points.length ||
      !/^76a914[0-9a-f]{40}88ac$/u.test(ownerScript) || !UINT.test(minimumConfirmations)) {
    throw new TypeError("Invalid HTLC material request");
  }
  const readStatuses = async () => {
    const rows: TbcApiTxoStatus[] = [];
    await forEachTxoStatusBatch(api, points.map(p => ({ txid: p.txid, index: p.vout })), result => {
      if (result.status === "rejected") throw result.reason;
      const { requested, response } = result.value;
      const remaining = new Set(requested.map(p => `${p.txid}:${p.index}`));
      if (!Array.isArray(response.txos) || response.txos.length !== requested.length) throw new TypeError("Invalid HTLC status batch");
      for (const row of response.txos) {
        if (!HASH.test(row.txid) || !UINT.test(row.index) || BigInt(row.index) > 0xffff_ffffn ||
            !UINT.test(row.value) || BigInt(row.value) < 1n || BigInt(row.value) > BigInt(Number.MAX_SAFE_INTEGER) ||
            !remaining.delete(`${row.txid}:${row.index}`) || row.spent !== false) throw new Error("HTLC selected output unavailable or inconsistent");
        rows.push(Object.freeze({ ...row }));
      }
    }, { category: "asset-index", concurrencyGroup: "htlc-index" });
    return rows;
  };
  const [node, rows] = await Promise.all([
    branch === "refund" || BigInt(minimumConfirmations) > 0n ? api.nodeInfo({ category: "tip", concurrencyGroup: "htlc-index" }) : undefined,
    readStatuses(),
  ]);
  if (node !== undefined && (!UINT.test(node.blocks) || BigInt(node.blocks) >= 500_000_000n || !HASH.test(node.bestblockhash) ||
      (node.mediantime !== undefined && !UINT.test(node.mediantime)))) throw new TypeError("Invalid HTLC status or tip");
  const tip: TestnetTip | undefined = node === undefined ? undefined : Object.freeze({ height: node.blocks, hash: node.bestblockhash,
    ...(node.mediantime === undefined ? {} : { medianTimePast: node.mediantime }) });
  // API rows were copied in each batch before any subsequent read window.
  const floor = BigInt(minimumConfirmations), at = tip === undefined ? undefined : BigInt(tip.height);
  const needDecoded = new Set(rows.filter(row => row.height === undefined && floor > 0n).map(row => row.txid));
  const parents = new Map<string, Parent>();
  await Promise.all([...new Set(rows.map(row => row.txid))].map(async id => {
    const parent = await (needDecoded.has(id) ? readDecoded(id) : readHistory(id));
    if (parent.txid !== id) throw new Error("HTLC parent identity mismatch");
    parents.set(id, parent);
  }));
  let refundDomain: boolean | undefined;
  const utxos = rows.map(row => {
    const parent = parents.get(row.txid)!;
    const vout = Number(row.index), output = parent.outputs[vout];
    if (!output || output.vout !== vout || output.satoshis !== row.value ||
        (row.scriptPubKey !== undefined && row.scriptPubKey !== output.scriptPubKey)) throw new Error("HTLC parent/status output mismatch");
    const code = inspectHtlcCode(output.scriptPubKey);
    if ((branch === "claim" ? code.receiverHash : code.senderHash) !== ownerScript.slice(6, 46)) throw new Error("HTLC account role mismatch");
    // Claim has no HTLC deadline. Refund uses chain observations, never wallclock.
    if (branch === "refund") {
      const heightDomain = code.lockTime < 500_000_000;
      if (code.lockTime === 0 || code.lockTime > 0x7fff_ffff ||
          (refundDomain !== undefined && refundDomain !== heightDomain) ||
          (heightDomain ? at === undefined || BigInt(code.lockTime) > at : tip?.medianTimePast === undefined || BigInt(code.lockTime) >= BigInt(tip.medianTimePast))) {
        throw new Error("HTLC refund lock domain or maturity mismatch");
      }
      refundDomain = heightDomain;
    }
    const height = row.height === "-1" ? "0" : row.height;
    if (height !== undefined && (!UINT.test(height) || at !== undefined && BigInt(height) > at)) throw new Error("HTLC status height invalid");
    const confirmations = height === undefined ? parent.confirmations : height === "0" ? "0" : at === undefined ? undefined : String(at - BigInt(height) + 1n);
    if ((confirmations !== undefined && !UINT.test(confirmations)) ||
        (floor > 0n && (confirmations === undefined || BigInt(confirmations) < floor))) throw new Error("HTLC confirmations do not meet policy");
    return Object.freeze({ txid: row.txid, vout, satoshis: row.value, scriptPubKey: output.scriptPubKey,
      classification: "htlc" as const, ...(confirmations === undefined ? {} : { confirmations }) });
  }).sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout);
  return Object.freeze({ tip, utxos: Object.freeze(utxos),
    parents: Object.freeze([...parents.values()].sort((a, b) => a.txid.localeCompare(b.txid))) });
}
