import type { TbcOfficialApiClient } from "./official-api.js";
import type { TestnetTip } from "./testnet-client.js";
import type { NftTransactionMaterial as TransactionMaterial } from "./nft-material.js";
import { inspectHtlcCode } from "./htlc-material.js";

const HASH = /^[0-9a-f]{64}$/u;
const UINT = /^(0|[1-9][0-9]*)$/u;

/** Exact Token Code + sibling HTLC availability, sharing the caller's tip and
 * immutable parent cache. No secret argument, funding scan, recursive ancestry,
 * or mint-state lookup. The Engine authenticates identity, Tape and claim proof. */
export async function resolveHtlcTokenMaterial(input: Readonly<{
  assetStandard: "tbc20-standard" | "tbc20-stablecoin";
  contractId: string;
  templateRevision: string;
  target: Readonly<{ txid: string; vout: number }>;
  branch: "claim" | "refund";
  ownerScript: string;
  minimumConfirmations: string;
  api: TbcOfficialApiClient;
  readTip: () => Promise<TestnetTip>;
  tokenLockTime: (parent: TransactionMaterial) => Promise<number>;
  readIdentity: () => Promise<Readonly<{contractId:string;codeScript:string;tapeScript:string;totalSupply:string}>>;
  readHistory: (txid: string) => Promise<TransactionMaterial>;
  readDecoded: (txid: string) => Promise<TransactionMaterial>;
  ancestors: (parent: TransactionMaterial, vout: number) => readonly string[];
}>) {
  const { assetStandard, contractId, templateRevision, branch, ownerScript, minimumConfirmations,
    api, readHistory, readDecoded, ancestors } = input;
  const target = Object.freeze({ ...input.target });
  if (!HASH.test(contractId) || !HASH.test(templateRevision) || !HASH.test(target.txid) || target.vout !== 1 ||
      !["tbc20-standard", "tbc20-stablecoin"].includes(assetStandard) || !["claim", "refund"].includes(branch) ||
      !/^76a914[0-9a-f]{40}88ac$/u.test(ownerScript) || !UINT.test(minimumConfirmations)) throw new TypeError("Invalid Token HTLC material request");
  const parents = new Map<string, TransactionMaterial>();
  const keep = (id: string, value: TransactionMaterial) => {
    if (value.txid !== id) throw new Error("Token HTLC parent identity mismatch");
    parents.set(id, value); return value;
  };
  // txoStatus is a read-only POST, never a transaction broadcast.
  const statusRead = api.txoStatus({ txos: [0, 1].map(index => ({ txid: target.txid, index })) }, { category: "asset-index" });
  const targetRead = BigInt(minimumConfirmations) === 0n ? readHistory(target.txid) : statusRead.then(status => {
    if (!Array.isArray(status.txos) || status.txos.length !== 2) throw new Error("Invalid Token HTLC status");
    return status.txos.some(row => row.height === undefined) ? readDecoded(target.txid) : readHistory(target.txid);
  });
  const [status, indexed, parent, tip] = await Promise.all([
    statusRead,
    input.readIdentity(),
    targetRead.then(value => keep(target.txid, value)),
    branch === "refund" || BigInt(minimumConfirmations) > 0n ? input.readTip() : undefined,
  ]);
  if(indexed.contractId!==contractId)throw new Error("Token HTLC indexed identity mismatch");
  const tokenLock = assetStandard === "tbc20-stablecoin" ? await input.tokenLockTime(parent) : 0;
  if (!Number.isSafeInteger(tokenLock) || tokenLock < 0 || tokenLock > 0xffff_ffff) throw new Error("Invalid Token lock time");
  const observed = tip ?? (tokenLock !== 0 ? await input.readTip() : undefined);
  if (observed !== undefined && (!UINT.test(observed.height) || BigInt(observed.height) >= 500_000_000n || !HASH.test(observed.hash) ||
      (observed.medianTimePast !== undefined && !UINT.test(observed.medianTimePast))) ||
      !Array.isArray(status.txos) || status.txos.length !== 2) throw new Error("Invalid Token HTLC status or tip");
  const rows = status.txos.map(row => Object.freeze({ ...row })).sort((a,b) => a.index.localeCompare(b.index));
  const observedHeights = new Set(rows.flatMap(row => row.height === undefined ? [] : [row.height === "-1" ? "0" : row.height]));
  if (observedHeights.size > 1) throw new Error("Token HTLC sibling heights inconsistent");
  for (const [index, row] of rows.entries()) {
    const output = parent.outputs[index], expected = index === 0 ? "100" : "500";
    if (row.txid !== target.txid || row.index !== String(index) || row.spent !== false || row.value !== expected ||
        !output || output.vout !== index || output.satoshis !== expected ||
        (row.scriptPubKey !== undefined && row.scriptPubKey !== output.scriptPubKey)) throw new Error("Token HTLC output unavailable or inconsistent");
  }
  if (parent.outputs[2]?.vout !== 2 || parent.outputs[2]?.satoshis !== "0") throw new Error("Token HTLC Tape absent");
  const code = inspectHtlcCode(parent.outputs[0]!.scriptPubKey);
  if ((branch === "claim" ? code.receiverHash : code.senderHash) !== ownerScript.slice(6, 46)) throw new Error("Token HTLC account role mismatch");
  const at = observed === undefined ? undefined : BigInt(observed.height);
  if (branch === "refund" && (code.lockTime === 0 || code.lockTime > 0x7fff_ffff ||
      (code.lockTime < 500_000_000 ? at === undefined || BigInt(code.lockTime) > at
        : observed?.medianTimePast === undefined || BigInt(code.lockTime) >= BigInt(observed.medianTimePast)))) throw new Error("Token HTLC refund not mature");
  const floor = BigInt(minimumConfirmations);
  const fresh = floor > 0n && rows.some(row => row.height === undefined) ? parent : undefined;
  if (fresh !== undefined && (fresh.txid !== parent.txid || fresh.rawTransaction !== parent.rawTransaction)) throw new Error("Token HTLC fresh parent mismatch");
  const utxos = rows.map((row, index) => {
    const height = row.height === "-1" ? "0" : row.height;
    if (height !== undefined && (!UINT.test(height) || at !== undefined && BigInt(height) > at)) throw new Error("Invalid Token HTLC confirmation height");
    const confirmations = height === undefined ? fresh?.confirmations : height === "0" ? "0" : at === undefined ? undefined : String(at - BigInt(height) + 1n);
    if ((confirmations !== undefined && !UINT.test(confirmations)) ||
        (floor > 0n && (confirmations === undefined || BigInt(confirmations) < floor))) throw new Error("Token HTLC confirmation policy unmet");
    return Object.freeze({ txid: target.txid, vout: index, satoshis: row.value, scriptPubKey: parent.outputs[index]!.scriptPubKey,
      classification: index === 0 ? "htlc" : assetStandard === "tbc20-standard" ? "ft" : "stablecoin",
      ...(index === 0 ? {} : { contractId }), ...(confirmations === undefined ? {} : { confirmations }) });
  });
  const references = [...ancestors(parent, 1)];
  if (references.some(id => !HASH.test(id))) throw new Error("Token HTLC proof reference invalid");
  await Promise.all([...new Set(references)].filter(id => !parents.has(id)).map(id => readHistory(id).then(value => keep(id, value))));
  return Object.freeze({ utxos: Object.freeze(utxos), parents: Object.freeze([...parents.values()]),
    contracts: Object.freeze([Object.freeze({ contractId, family: assetStandard === "tbc20-standard" ? "ft" : "stablecoin",
      indexedFungible: {codeScript:indexed.codeScript,tapeScript:indexed.tapeScript,totalSupply:indexed.totalSupply},
      protocolVersion: assetStandard === "tbc20-standard" ? "tbc20" : "coin", standardId: assetStandard, templateRevision,
      creationTxid: contractId, genesisOutpoint: Object.freeze({ txid: contractId, vout: 0 }), currentOutpoint: target })]) });
}
