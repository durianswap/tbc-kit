import type { TbcOfficialApiClient } from "./official-api.js";
import type { TestnetTip } from "./testnet-client.js";

type Point = Readonly<{ txid: string; vout: number }>;
type Parent = Readonly<{ txid: string; rawTransaction: string; confirmations?: string;
  outputs: readonly Readonly<{ vout: number; satoshis: string; scriptPubKey: string }>[] }>;
const HASH = /^[0-9a-f]{64}$/u, UINT = /^(0|[1-9][0-9]*)$/u;
const MIDDLE = "88ad56ba01247f778104ffffffff819e518804";
const SUFFIX = "8152ba81a15187";

/** Read-only routing/display decode; Engine independently authenticates the
 * complete parent, owner and height in the approval-bound transaction plan. */
export function inspectTimelockCode(script: string): Readonly<{ ownerHash: string; lockHeight: number }> {
  if (!/^[0-9a-f]{106}$/u.test(script) || script.slice(0,6) !== "76a914" ||
      script.slice(46,84) !== MIDDLE || script.slice(92) !== SUFFIX) throw new TypeError("Unsupported timelock Code");
  const lockHeight = Number.parseInt(script.slice(84,92).match(/../gu)!.reverse().join(""),16);
  if (lockHeight >= 500_000_000) throw new TypeError("Unsupported timelock lock domain");
  return Object.freeze({ ownerHash: script.slice(6,46), lockHeight });
}

/** Reads only selected deposits and their unique direct parents. No native fee
 * index, metadata, grandparent walk, signing or broadcast is needed to unlock. */
export async function resolveTimelockMaterial(input: Readonly<{
  api: TbcOfficialApiClient;
  address: string;
  ownerScript: string;
  inputOutpoints: readonly Point[];
  minimumConfirmations: string;
  readHistory: (txid: string) => Promise<Parent>;
  readDecoded: (txid: string) => Promise<Parent>;
}>) {
  const points = input.inputOutpoints.map(p => Object.freeze({ ...p }));
  if (points.length < 1 || points.length > 128 || points.some(p => !HASH.test(p.txid) || !Number.isSafeInteger(p.vout) || p.vout < 0 || p.vout > 0xffff_ffff) ||
      new Set(points.map(p => `${p.txid}:${p.vout}`)).size !== points.length ||
      !/^76a914[0-9a-f]{40}88ac$/u.test(input.ownerScript) || !UINT.test(input.minimumConfirmations)) throw new TypeError("Invalid timelock material request");
  const [node, index] = await Promise.all([
    input.api.nodeInfo({ category: "tip", concurrencyGroup: "timelock-index" }),
    input.api.timelockUtxosByAddress({ address: input.address }, { category: "asset-index", concurrencyGroup: "timelock-index" }),
  ]);
  if (!UINT.test(node.blocks) || BigInt(node.blocks) >= 500_000_000n || !HASH.test(node.bestblockhash) ||
      !Array.isArray(index.utxos) || index.utxos.length > 10_000) throw new TypeError("Invalid timelock index or tip");
  const tip: TestnetTip = Object.freeze({ height: node.blocks, hash: node.bestblockhash });
  const selected = new Map(points.map(p => [`${p.txid}:${p.vout}`,p]));
  const seen = new Set<string>();
  const rows = index.utxos.filter(row => {
    if (!HASH.test(row.txid) || !UINT.test(row.index) || BigInt(row.index) > 0xffff_ffffn ||
        !UINT.test(row.value) || BigInt(row.value) < 1n || BigInt(row.value) > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("Invalid timelock UTXO row");
    const key = `${row.txid}:${row.index}`;
    if (seen.has(key)) throw new TypeError("Duplicate timelock index entry");
    seen.add(key); return selected.has(key);
  });
  if (rows.length !== points.length) throw new Error("Selected timelock deposit is unavailable");
  const floor = BigInt(input.minimumConfirmations), at = BigInt(tip.height);
  const needDecoded = new Set(rows.filter(row => row.height === undefined && floor > 0n).map(row => row.txid));
  // One read per unique parent, even when some sibling index rows omit height.
  const parents = new Map<string, Parent>();
  await Promise.all([...new Set(rows.map(row => row.txid))].map(async id => {
    const parent = await (needDecoded.has(id) ? input.readDecoded(id) : input.readHistory(id));
    if (parent.txid !== id) throw new Error("Timelock parent identity mismatch");
    parents.set(id,parent);
  }));
  const utxos = rows.map(row => {
    const parent = parents.get(row.txid)!;
    const vout = Number(row.index), output = parent.outputs[vout];
    if (output === undefined || output.vout !== vout || output.satoshis !== row.value) throw new Error("Timelock parent/index output mismatch");
    const code = inspectTimelockCode(output.scriptPubKey);
    if (code.ownerHash !== input.ownerScript.slice(6,46) || BigInt(code.lockHeight) > at) throw new Error("Timelock owner or maturity mismatch");
    const height = row.height === "-1" ? "0" : row.height;
    if (height !== undefined && (!UINT.test(height) || BigInt(height) > at)) throw new Error("Timelock index height invalid");
    const confirmations = height === undefined ? parent.confirmations : height === "0" ? "0" : String(at - BigInt(height) + 1n);
    if ((confirmations !== undefined && !UINT.test(confirmations)) || (floor > 0n && (confirmations === undefined || BigInt(confirmations) < floor))) throw new Error("Timelock confirmations do not meet policy");
    return Object.freeze({ txid:row.txid,vout,satoshis:row.value,scriptPubKey:output.scriptPubKey,classification:"timelock" as const,
      ...(confirmations === undefined ? {} : { confirmations }) });
  }).sort((a,b) => a.txid.localeCompare(b.txid) || a.vout-b.vout);
  return Object.freeze({ tip,utxos:Object.freeze(utxos),parents:Object.freeze([...parents.values()].sort((a,b)=>a.txid.localeCompare(b.txid))) });
}
