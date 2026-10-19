import { bytesToHex, hexToBytes, sha256Bytes } from "./network-bytes.js";
import type { TbcOfficialApiClient } from "./official-api.js";
import type { NftTransactionMaterial as TransactionMaterial } from "./nft-material.js";

const HASH = /^[0-9a-f]{64}$/u;
const UINT = /^(0|[1-9][0-9]*)$/u;
const TEMPLATE = "c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3";
type Outpoint = Readonly<{ txid: string; vout: number }>;

/** Only mutable availability is queried here. All signature/contract authority,
 * amount/lock rules and exact transaction construction remain in the Engine. */
export async function resolveCoinManagementMaterial(input: Readonly<{
  mint: boolean;
  contractId: string;
  targetOutpoints?: readonly Outpoint[];
  certificateOutpoint?: Outpoint;
  api: TbcOfficialApiClient;
  readHistory: (txid: string) => Promise<TransactionMaterial>;
  readDecoded: (txid: string) => Promise<TransactionMaterial>;
  ancestors: (parent: TransactionMaterial, vout: number) => readonly string[];
  tipHeight: Promise<bigint>;
  minimumConfirmations: string | undefined;
}>) {
  const { api, contractId, readHistory } = input;
  if (!HASH.test(contractId)) throw new Error("Invalid Coin asset ID");
  const minimum = BigInt(input.minimumConfirmations ?? "0");
  const parents = new Map<string, TransactionMaterial>();
  const keep = (tx: TransactionMaterial) => { parents.set(tx.txid, tx); return tx; };
  let sourcePromise: Promise<TransactionMaterial> | undefined;
  const readSource = () => sourcePromise ??= (minimum > 0n ? input.readDecoded(contractId) : readHistory(contractId)).then(keep);
  let targets: readonly Outpoint[];
  if (input.mint) {
    let point = input.certificateOutpoint;
    if (point === undefined) {
      const source = await readSource();
      const code = source.outputs[0];
      if (code?.satoshis !== "200") throw new Error("Coin source certificate absent");
      const scriptpubkeyhash = bytesToHex(sha256Bytes(hexToBytes(code.scriptPubKey)).reverse());
      const result = await api.utxosByScriptHash({ scriptpubkeyhash }, { category: "asset-index" });
      if (!Array.isArray(result.utxos) || result.utxos.length !== 1) throw new Error("Coin current certificate is missing or ambiguous");
      const row = result.utxos[0]!;
      if (typeof row.txid !== "string" || !HASH.test(row.txid) || row.index !== "0" || row.value !== "200") throw new Error("Coin certificate index inconsistent");
      point = { txid: row.txid, vout: 0 };
    }
    if (point.vout !== 0 || !HASH.test(point.txid)) throw new Error("Coin certificate must select output zero");
    targets = [{ txid: point.txid, vout: 0 }, { txid: point.txid, vout: 1 }];
  } else {
    targets = input.targetOutpoints ?? [];
    if (targets.length < 1 || targets.length > 5) throw new Error("Coin management requires one to five targets");
  }
  if (targets.some(p => !HASH.test(p.txid) || !Number.isSafeInteger(p.vout) || p.vout < 0 || p.vout > 0xffff_ffff) ||
      new Set(targets.map(p => `${p.txid}:${p.vout}`)).size !== targets.length) throw new Error("Invalid Coin target set");
  // The official batch status endpoint is read-only although its HTTP verb is
  // POST. It is not broadcast and must not be counted as a transaction submit.
  const statusRead = api.txoStatus({ txos: targets.map(p => ({ txid: p.txid, index: p.vout })) }, { category: "asset-index" });
  const [status] = await Promise.all([
    statusRead,
    readSource(),
    ...[...new Set(targets.map(p => p.txid))].map(async id => {
      if (id === contractId) return readSource();
      if (minimum === 0n) return readHistory(id).then(keep);
      const status = await statusRead;
      const needsCount = status.txos.some(row => row.txid === id && row.height === undefined);
      return (needsCount ? input.readDecoded(id) : readHistory(id)).then(keep);
    }),
  ]);
  if (!Array.isArray(status.txos) || status.txos.length !== targets.length) throw new Error("Coin target status missing");
  const observed = new Map<string, (typeof status.txos)[number]>();
  for (const row of status.txos) {
    if (typeof row.index !== "string" || !UINT.test(row.index) || BigInt(row.index) > 0xffff_ffffn) throw new Error("Invalid Coin target index");
    const key = `${row.txid}:${row.index}`;
    if (observed.has(key) || !targets.some(p => p.txid === row.txid && String(p.vout) === row.index)) throw new Error("Unexpected or duplicate Coin target status");
    if (row.spent !== false) throw new Error("Coin target is already spent");
    observed.set(key, row);
  }
  const utxos = await Promise.all(targets.map(async point => {
    const parent = parents.get(point.txid)!;
    const output = parent.outputs[point.vout];
    const row = observed.get(`${point.txid}:${point.vout}`)!;
    const value = input.mint ? point.vout === 0 ? "200" : "100" : "500";
    if (!output || output.vout !== point.vout || output.satoshis !== value || row.value !== value ||
        (row.scriptPubKey !== undefined && row.scriptPubKey !== output.scriptPubKey)) throw new Error("Coin target raw/status mismatch");
    let confirmations: string | undefined;
    if (row.height !== undefined) {
      if (!UINT.test(row.height)) throw new Error("Invalid Coin target height");
      const height = BigInt(row.height), tip = await input.tipHeight;
      if (height > tip) throw new Error("Coin target height exceeds tip");
      confirmations = height === 0n ? "0" : String(tip - height + 1n);
    } else if (minimum > 0n) confirmations = parent.confirmations;
    if (minimum > 0n && (confirmations === undefined || BigInt(confirmations) < minimum)) throw new Error("Coin target confirmations below policy");
    return Object.freeze({ ...point, satoshis: value, scriptPubKey: output.scriptPubKey,
      classification: input.mint ? "nft" : "stablecoin", contractId,
      ...(confirmations === undefined ? {} : { confirmations }) });
  }));
  const references = input.mint
    ? [parents.get(targets[0]!.txid)!.inputs[0]?.txid]
    : targets.flatMap(point => input.ancestors(parents.get(point.txid)!, point.vout));
  if (references.some(id => typeof id !== "string" || !HASH.test(id))) throw new Error("Coin proof dependency absent");
  await Promise.all([...new Set(references as string[])].filter(id => !parents.has(id)).map(id => readHistory(id).then(keep)));
  return Object.freeze({ utxos, parents: [...parents.values()], contracts: [Object.freeze({
    contractId, family: "stablecoin", protocolVersion: "coin", standardId: "tbc20-stablecoin",
    templateRevision: TEMPLATE, creationTxid: contractId,
    genesisOutpoint: Object.freeze({ txid: contractId, vout: 0 }), currentOutpoint: targets[0]!,
  })] });
}
