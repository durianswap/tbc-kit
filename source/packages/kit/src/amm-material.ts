import type { NftTransactionMaterial as TransactionMaterial } from "./nft-material.js";
import type { TbcOfficialApiClient } from "./official-api.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TestnetTip } from "./testnet-client.js";
import { collectTbcUtxoPages } from "./utxo-pages.js";
import { positiveHolderCandidates } from "./fungible-candidates.js";

const HASH = /^[0-9a-f]{64}$/u;
const UINT = /^(0|[1-9][0-9]*)$/u;
const FT_TEMPLATE = "0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84";
type Point = Readonly<{ txid: string; vout: number }>;
export class UnsupportedPoolOperationError extends Error {
  constructor() { super("Operation is not supported for the authenticated Pool template"); }
}
type MaterialInput = Readonly<{
  contractId: string;
  readHistory: (txid: string) => Promise<TransactionMaterial>;
}>;

/** Immutable FT anchor only: empty AMM creation does not consume holder FT. */
export async function resolveAmmCreateMaterial(input: Readonly<{contractId:string;readIdentity:()=>Promise<Readonly<{contractId:string;codeScript:string;tapeScript:string;totalSupply:string}>>}>) {
  if (!HASH.test(input.contractId)) throw new Error("Invalid AMM FT identity");
  const info=await input.readIdentity();
  if(info.contractId!==input.contractId)throw new Error("AMM indexed FT ID mismatch");
  return { utxos: [], parents: [], contracts: [{
    indexedFungible:{codeScript:info.codeScript,tapeScript:info.tapeScript,totalSupply:info.totalSupply},
    contractId: input.contractId, family: "ft", protocolVersion: "tbc20", standardId: "tbc20-standard",
    templateRevision: FT_TEMPLATE, creationTxid: input.contractId,
    genesisOutpoint: { txid: input.contractId, vout: 0 }, currentOutpoint: { txid: input.contractId, vout: 0 },
  }] };
}

type AssetInspection = Readonly<{
  txid: string; vout: number; kind: string; balance: string; lockTime: number;
  scriptPubKey: string; dependencies: readonly Point[];
}>;
type LpUtxo = Readonly<Point & {
  satoshis: string; scriptPubKey: string; classification: "ftlp"; contractId: string; confirmations?: string;
}>;

/** Index hints select candidates; the shared Rust codec reads actual locks and
 * proof dependencies. Engine planning still authenticates every selected input.
 * No current Pool query, fee-parent raw, recursive ancestry or signing here. */
export async function resolveLpMaterial(input: MaterialInput & Readonly<{
  intentType: string;
  amount?: string;
  publicKey: string;
  api: TbcOfficialApiClient;
  readFtInfo:(id:string)=>Promise<Readonly<{codeScript:string;tapeScript:string}>>;
  native: PoolMaterialNativeProviderInput;
  readDecoded: (txid: string) => Promise<TransactionMaterial>;
  readTip: () => Promise<TestnetTip>;
  minimumConfirmations: string | undefined;
  inputOutpoints?: readonly Point[];
}>) {
  // Observe the concurrent tip immediately, even if an earlier identity/index
  // failure exits before selection reaches it. Do not leave a rejected branch.
  if (!HASH.test(input.contractId)) throw new Error("Invalid LP Pool identity");
  const inspect = async (request: unknown) => JSON.parse(await input.native.execute("inspectAmmMaterial", JSON.stringify(request)));
  const parents = new Map<string, TransactionMaterial>();
  const keep = (tx: TransactionMaterial) => { parents.set(tx.txid, tx); return tx; };
  const raw = ({ txid, rawTransaction }: TransactionMaterial) => ({ txid, rawTransaction });
  const info=await input.api.poolInfo({pool_id:input.contractId},{category:"pool"});
  if(!HASH.test(info.txid)||info.vout!=="0")throw new Error("Invalid indexed LP Pool");
  const [pool,ft]=await Promise.all([input.readHistory(info.txid).then(keep),input.readFtInfo(info.ft_contract_id)]);
  if(pool.outputs[0]?.scriptPubKey!==info.pool_code_script||pool.outputs[0]?.satoshis!==info.value)throw new Error("LP Pool index/raw mismatch");
  const indexedPool={ftCodeScript:ft.codeScript,ftTapeScript:ft.tapeScript};
  const descriptor = await inspect({ phase: "describe", poolContractId:input.contractId,indexedPool,currentPool:raw(pool), publicKey: input.publicKey });
  if (descriptor.poolContractId !== input.contractId || !HASH.test(descriptor.ownerLpScriptHash) ||
      typeof descriptor.ownerLpScript !== "string" || !HASH.test(descriptor.templateRevision)) throw new Error("Invalid LP descriptor");
  if ((input.intentType === "tbc20-lp-lock" || input.intentType === "tbc20-lp-unlock") && descriptor.lpTimelock !== true) throw new UnsupportedPoolOperationError();
  const { utxos } = await collectTbcUtxoPages(after => input.api.poolLpUtxosByScriptHash({
    scriptpubkeyhash: descriptor.ownerLpScriptHash, ...(after === undefined ? {} : { after }) },
    { category: "asset-index" }), { maxRows: 128 });
  if (!Array.isArray(utxos) || utxos.length > 128) throw new Error("LP candidate bound exceeded");
  const seen = new Set<string>();
  const candidates = positiveHolderCandidates(utxos.map(row => {
    const balance = row.ft_value ?? row.balance;
    const indexedHeight = row.height === "-1" ? "0" : row.height;
    if (!HASH.test(row.txid) || !UINT.test(row.index) || BigInt(row.index) > 0xffff_ffffn ||
        typeof balance !== "string" || !UINT.test(balance) ||
        (row.tbc_value ?? row.value) !== "500" || (indexedHeight !== undefined && !UINT.test(indexedHeight))) throw new Error("Invalid LP index row");
    const point = { txid: row.txid, vout: Number(row.index) };
    const key = `${point.txid}:${point.vout}`;
    if (seen.has(key)) throw new Error("Duplicate LP index outpoint");
    seen.add(key);
    return { ...point, balance, height: indexedHeight };
  }), row => row.balance, input.inputOutpoints).slice().sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout);
  const all = input.intentType === "tbc20-lp-merge" || input.intentType === "tbc20-lp-unlock";
  if (!all && (input.amount === undefined || !UINT.test(input.amount) || BigInt(input.amount) === 0n)) throw new Error("Invalid LP amount");
  const wanted = BigInt(input.amount ?? "0"), floor = BigInt(input.minimumConfirmations ?? "0");
  let tip=floor>0n?await input.readTip():undefined;
  let height=tip===undefined?undefined:BigInt(tip.height);
  const selected: LpUtxo[] = [];
  const dependencies = new Set<string>();
  let total = 0n;
  for (const candidate of candidates) {
    if (input.inputOutpoints !== undefined && !input.inputOutpoints.some(p => p.txid === candidate.txid && p.vout === candidate.vout)) continue;
    if (!all && total >= wanted && input.inputOutpoints === undefined) break;
    let confirmations: string | undefined;
    if (candidate.height !== undefined) {
      const at = BigInt(candidate.height);
      if (height!==undefined && at > height) throw new Error("LP index height exceeds tip");
      confirmations = at === 0n ? "0" : height===undefined?undefined:String(height - at + 1n);
    } else if (floor > 0n) confirmations = (await input.readDecoded(candidate.txid)).confirmations;
    if (floor > 0n && (confirmations === undefined || BigInt(confirmations) < floor)) {
      if (input.inputOutpoints !== undefined) throw new Error("Selected LP confirmations below policy");
      continue;
    }
    const parent = await input.readHistory(candidate.txid);
    const output = parent.outputs[candidate.vout];
    if (output?.satoshis !== "500" || output.scriptPubKey !== descriptor.ownerLpScript) throw new Error("LP index/raw identity mismatch");
    const result = await inspect({ phase: "inspectAssets", parents: [raw(parent)], outputs: [{ txid: candidate.txid, vout: candidate.vout, kind: "lp" }] });
    const item = result.items?.[0] as AssetInspection | undefined;
    if (result.items?.length !== 1 || item === undefined || item.txid !== candidate.txid || item.vout !== candidate.vout || item.kind !== "lp" ||
        item.balance !== candidate.balance || item.scriptPubKey !== output.scriptPubKey ||
        !Number.isSafeInteger(item.lockTime) || item.lockTime < 0 || item.lockTime > 0xffff_ffff || !Array.isArray(item.dependencies)) throw new Error("Invalid LP parsed material");
    const lock = item.lockTime;
    if(lock!==0&&tip===undefined){tip=await input.readTip();height=BigInt(tip.height);}
    // Do not trust an index lock_time hint or substitute wall-clock time for MTP.
    if (lock >= 500_000_000 && tip!.medianTimePast === undefined) throw new Error("LP timestamp requires trusted medianTimePast");
    const mature = lock === 0 || (lock < 500_000_000 ? BigInt(lock) <= height! : BigInt(lock) < BigInt(tip!.medianTimePast!));
    if (!mature) {
      if (input.inputOutpoints !== undefined) throw new Error("Selected LP is not mature");
      continue;
    }
    if (selected.length === 128) throw new Error("LP selected asset input bound exceeded");
    keep(parent);
    total += BigInt(item.balance);
    selected.push({ txid: candidate.txid, vout: candidate.vout, satoshis: "500", scriptPubKey: output.scriptPubKey,
      classification: "ftlp", contractId: input.contractId, ...(confirmations === undefined ? {} : { confirmations }) });
    for (const point of item.dependencies) {
      if (!HASH.test(point.txid) || !parent.inputs.some(p => p.txid === point.txid && p.vout === point.vout)) throw new Error("LP dependency is not a direct input");
      dependencies.add(point.txid);
    }
  }
  if (selected.length === 0 || (!all && total < wanted) || (input.intentType === "tbc20-lp-merge" && selected.length < 2)) throw new Error("Insufficient mature LP inputs");
  await Promise.all([...dependencies].filter(id => !parents.has(id)).map(id => input.readHistory(id).then(keep)));
  return { utxos: selected, parents: [...parents.values()], contracts: [{
    contractId: input.contractId,indexedPool, family: "pool", protocolVersion: "pool3", standardId: "tbc-amm",
    templateRevision: descriptor.templateRevision as string, creationTxid: input.contractId,
    genesisOutpoint: { txid: input.contractId, vout: 0 }, currentOutpoint: { txid: pool.txid, vout: 0 },
  }] };
}
