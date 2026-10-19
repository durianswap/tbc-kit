import type { NftTransactionMaterial as TransactionMaterial } from "./nft-material.js";
import type { TbcOfficialApiClient, TbcApiTbc20Utxo } from "./official-api.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TestnetTip } from "./testnet-client.js";
import { normalizeAmmFeePolicy } from "./amm-fee-policy.js";
import { collectTbcUtxoPages } from "./utxo-pages.js";

const HASH = /^[0-9a-f]{64}$/u;
const UINT = /^(0|[1-9][0-9]*)$/u;
type Point = Readonly<{ txid: string; vout: number }>;
export type AmmMaterialAction = Readonly<{
  kind: "addTbc" | "addFt" | "buy" | "sell" | "remove";
  amount: string;
  initialFtAmount?: string;
}>;
type Utxo = Point & Readonly<{ satoshis: string; scriptPubKey: string; contractId: string;
  classification: "pool" | "pool-ft" | "ft" | "ftlp"; confirmations?: string }>;

/** Only mutable API discovery and bounded direct proofs live here. Quotes and
 * contract parsing use the same Rust codec as Engine, with no signing or UI. */
export async function resolveAmmBusinessMaterial(input: Readonly<{
  contractId: string;
  publicKey: string;
  controllerPublicKey?: string;
  action: AmmMaterialAction;
  api: TbcOfficialApiClient;
  native: PoolMaterialNativeProviderInput;
  readHistory: (txid: string) => Promise<TransactionMaterial>;
  readFtInfo: (id:string) => Promise<Readonly<{codeScript:string;tapeScript:string}>>;
  readDecoded: (txid: string) => Promise<TransactionMaterial>;
  readTip: () => Promise<TestnetTip>;
  minimumConfirmations: string | undefined;
  inputOutpoints?: readonly Point[];
}>) {
  let tip: TestnetTip | undefined, pendingTip: Promise<TestnetTip> | undefined;
  const observeTip = () => pendingTip ??= input.readTip().then(value => tip = value);
  if (!HASH.test(input.contractId)) throw new Error("Invalid AMM Pool ID");
  const parents = new Map<string, TransactionMaterial>();
  const freshReads = new Map<string, Promise<TransactionMaterial>>();
  const readFresh = (id: string) => {
    let pending = freshReads.get(id);
    if (!pending) { pending = input.readDecoded(id); freshReads.set(id, pending); }
    return pending;
  };
  const keep = (tx: TransactionMaterial) => { parents.set(tx.txid, tx); return tx; };
  const proofReads = new Map<string, Promise<{ ok: true } | { ok: false; error: unknown }>>();
  const readProof = (id: string) => {
    if (!parents.has(id) && !proofReads.has(id)) proofReads.set(id, input.readHistory(id).then(keep)
      .then(() => ({ ok: true as const }), error => ({ ok: false as const, error })));
  };
  const raw = ({ txid, rawTransaction }: TransactionMaterial) => ({ txid, rawTransaction });
  const inspect = async (request: unknown) => JSON.parse(await input.native.execute("inspectAmmMaterial", JSON.stringify(request)));
  const permitted = (point: Point) => input.inputOutpoints === undefined || input.inputOutpoints.some(p => p.txid === point.txid && p.vout === point.vout);
  const current = (async () => {
    const info = await input.api.poolInfo({ pool_id: input.contractId }, { category: "pool" });
    if (!HASH.test(info.txid) || info.vout !== "0" || !UINT.test(info.value)) throw new Error("Invalid current AMM index");
    if (!permitted({ txid: info.txid, vout: 0 })) throw new Error("Current AMM is not in the requested inputs");
    const [tx,ft]=await Promise.all([
      (BigInt(input.minimumConfirmations ?? "0") > 0n ? readFresh(info.txid) : input.readHistory(info.txid)).then(keep),
      input.readFtInfo(info.ft_contract_id),
    ]);
    const output = tx.outputs[0];
    if (!output || output.satoshis !== info.value || output.scriptPubKey !== info.pool_code_script || !tx.inputs[0]) throw new Error("AMM Pool index/raw mismatch");
    // Needed for the later proof, not for deriving scripts or starting indexes.
    readProof(tx.inputs[0].txid);
    return { info, tx,ft };
  })();
  const {info,tx,ft}=await current;
  const indexedPool={ftCodeScript:ft.codeScript,ftTapeScript:ft.tapeScript};
  const descriptor = await inspect({ phase: "describe", poolContractId:input.contractId,indexedPool,
    publicKey: input.publicKey, currentPool: raw(tx), action: input.action,
    ...(input.controllerPublicKey === undefined ? {} : { controllerPublicKey: input.controllerPublicKey }) });
  if (descriptor.poolContractId !== input.contractId || descriptor.ftContractId !== info.ft_contract_id ||
      descriptor.currentOutpoint?.txid !== tx.txid || descriptor.currentOutpoint?.vout !== 0 ||
      descriptor.poolCodeScript !== info.pool_code_script || descriptor.state?.ftAmount !== info.token_balance ||
      descriptor.state?.lpAmount !== info.lp_balance || descriptor.state?.tbcAmount !== info.tbc_balance ||
      !HASH.test(descriptor.templateRevision) ||
      !/^[0-9a-f]{42}$/u.test(descriptor.ownerCombineScript) || !/^[0-9a-f]{42}$/u.test(descriptor.poolCombineScript)) throw new Error("AMM current index is not bound to its genesis");
  if (descriptor.feePolicy === undefined) {
    if (String(descriptor.serviceFeeRate) !== info.service_fee_rate) throw new Error("AMM preset fee index mismatch");
  } else {
    // 1.7.3 shares the historical index endpoint: service_fee_rate/lp_plan and
    // service_provider may be stale summaries. Only the locally authenticated
    // full Code + Tape + genesis determine the explicit rates and recipient.
    // No extra HTTP query, no DB-derived fee override, no mutable fee cache.
    normalizeAmmFeePolicy(descriptor.feePolicy);
  }
  // This descriptor is a local requirement, never an account permission. The
  // holder remains the primary account even when an explicit controller is
  // selected. Reject mismatches before asset indexes/proofs; Engine and Host
  // separately enforce account permissions and signing tasks.
  const authorization = descriptor.authorization;
  if (authorization?.kind === "controller") {
    if (!Array.isArray(authorization.controllerHashes) || authorization.controllerHashes.length < 1 ||
        authorization.controllerHashes.length > 5 || typeof authorization.accountMatches !== "boolean" ||
        authorization.controllerHashes.some((value: unknown) => typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) ||
        new Set(authorization.controllerHashes).size !== authorization.controllerHashes.length) throw new Error("Invalid AMM controller requirement");
    if (!authorization.accountMatches) throw new Error("AMM independent Pool controller needs an explicit shared signing role");
  } else if (authorization?.kind !== "public") throw new Error("Invalid AMM authorization requirement");
  else if (input.controllerPublicKey !== undefined) throw new Error("Public AMM does not need an explicit controller");
  const needs = descriptor.requirements;
  const wantedKind = input.action.kind === "buy" ? null : input.action.kind === "remove" ? "lp" : "ft";
  if (needs?.holderKind !== wantedKind || typeof needs.holderAmount !== "string" || !UINT.test(needs.holderAmount) ||
      typeof needs.nativeAmount !== "string" || !UINT.test(needs.nativeAmount)) throw new Error("Invalid AMM quote requirements");
  const poolIndex = collectTbcUtxoPages(after => input.api.ftUtxosByCombineScript({ combine_script: descriptor.poolCombineScript,
    contract_id: descriptor.ftContractId, ...(after === undefined ? {} : { after }) }, { category: "asset-index" }), { maxRows: 128 });
  const holderIndex = wantedKind === "lp"
    ? collectTbcUtxoPages(after => input.api.poolLpUtxosByScriptHash({ scriptpubkeyhash: descriptor.ownerLpScriptHash,
      ...(after === undefined ? {} : { after }) }, { category: "asset-index" }), { maxRows: 128 })
    : wantedKind === "ft" ? collectTbcUtxoPages(after => input.api.ftUtxosByCombineScript({ combine_script: descriptor.ownerCombineScript,
      contract_id: descriptor.ftContractId, ...(after === undefined ? {} : { after }) }, { category: "asset-index" }), { maxRows: 128 })
      : Promise.resolve(undefined);
  const floor = BigInt(input.minimumConfirmations ?? "0");
  const [poolRows, holderRows] = await Promise.all([poolIndex, holderIndex, floor > 0n ? observeTip() : undefined]);
  const dependencies = new Set<string>();
  const confirmations = async (id: string, indexedHeight: string | undefined) => {
    if (indexedHeight === undefined) {
      if (floor === 0n) return undefined;
      const n = (await readFresh(id)).confirmations;
      if (n === undefined || !UINT.test(n)) throw new Error("AMM confirmations unavailable");
      return n;
    }
    const value = indexedHeight === "-1" ? "0" : indexedHeight;
    if (!UINT.test(value) || tip !== undefined && BigInt(value) > BigInt(tip.height)) throw new Error("AMM index height exceeds tip");
    return value === "0" ? "0" : tip === undefined ? undefined : String(BigInt(tip.height) - BigInt(value) + 1n);
  };
  const poolConfirmations = await confirmations(tx.txid, undefined);
  if (floor > 0n && BigInt(poolConfirmations!) < floor) throw new Error("AMM Pool confirmations below policy");
  const utxos: Utxo[] = [{ txid: tx.txid, vout: 0, satoshis: info.value, scriptPubKey: info.pool_code_script,
    classification: "pool", contractId: input.contractId, ...(poolConfirmations === undefined ? {} : { confirmations: poolConfirmations }) }];
  function candidates(rows: readonly TbcApiTbc20Utxo[], zero: boolean) {
    if (!Array.isArray(rows) || rows.length > 128) throw new Error("AMM index candidate bound exceeded");
    const seen = new Set<string>();
    return rows.map(row => {
      const balance = row.ft_value ?? row.balance;
      if (!HASH.test(row.txid) || !UINT.test(row.index) || BigInt(row.index) > 0xffff_ffffn ||
          (row.tbc_value ?? row.value) !== "500" || typeof balance !== "string" || !UINT.test(balance) || (!zero && balance === "0")) throw new Error("Invalid AMM asset index row");
      const point = { txid: row.txid, vout: Number(row.index) };
      const key = `${point.txid}:${point.vout}`;
      if (seen.has(key)) throw new Error("Duplicate AMM asset index output");
      seen.add(key); return { ...point, balance, height: row.height };
    }).sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout);
  }
  async function select(rows: readonly TbcApiTbc20Utxo[], poolOwned: boolean) {
    const kind = poolOwned ? "ft" : wantedKind!;
    const expected = poolOwned ? descriptor.poolFtScript : kind === "lp" ? descriptor.ownerLpScript : descriptor.ownerFtScript;
    const indexed = candidates(rows, poolOwned);
    // Pool3 consumes one exact reserve output, unlike historical Pool merge.
    if (poolOwned && indexed.length !== 1) throw new Error("AMM Pool FT must be one exact state-matching reserve input");
    const wanted = BigInt(needs.holderAmount);
    // Preserve one sufficient input when possible; only fetch smaller fragments
    // if no mature sufficient candidate exists, or exact inputs require them.
    const ordered = poolOwned || input.inputOutpoints !== undefined ? indexed : [
      ...indexed.filter(row => BigInt(row.balance) >= wanted),
      ...indexed.filter(row => BigInt(row.balance) < wanted),
    ];
    const selected: Utxo[] = [];
    let total = 0n;
    for (const candidate of ordered) {
      if (!permitted(candidate)) continue;
      const count = await confirmations(candidate.txid, candidate.height);
      if (floor > 0n && BigInt(count!) < floor) continue;
      const parent = await (freshReads.get(candidate.txid) ?? input.readHistory(candidate.txid));
      const output = parent.outputs[candidate.vout];
      if (output?.satoshis !== "500" || output.scriptPubKey !== expected) throw new Error("AMM selected asset index/raw mismatch");
      const parsed = await inspect({ phase: "inspectAssets", parents: [raw(parent)], outputs: [{ txid: candidate.txid, vout: candidate.vout, kind }] });
      const item = parsed.items?.[0];
      if (parsed.items?.length !== 1 || item?.txid !== candidate.txid || item?.vout !== candidate.vout || item.kind !== kind ||
          item.balance !== candidate.balance || item.scriptPubKey !== expected || !Array.isArray(item.dependencies)) throw new Error("AMM asset parser/index mismatch");
      if (kind === "lp") {
        const lock = item.lockTime;
        if (!Number.isSafeInteger(lock) || lock < 0 || lock > 0xffff_ffff) throw new Error("Invalid AMM LP lock");
        if (lock !== 0) {
          const observed = await observeTip();
          if (lock >= 500_000_000 && observed.medianTimePast === undefined) throw new Error("AMM LP timestamp requires MTP");
          if (lock < 500_000_000 ? BigInt(lock) > BigInt(observed.height) : BigInt(lock) >= BigInt(observed.medianTimePast!)) continue;
        }
      }
      keep(parent);
      for (const p of item.dependencies as Point[]) {
        if (!HASH.test(p.txid) || !parent.inputs.some(i => i.txid === p.txid && i.vout === p.vout)) throw new Error("AMM proof dependency is not a direct input");
        dependencies.add(p.txid);
      }
      selected.push({ txid: candidate.txid, vout: candidate.vout, satoshis: "500", scriptPubKey: output.scriptPubKey,
        classification: poolOwned ? "pool-ft" as const : kind === "lp" ? "ftlp" as const : "ft" as const,
        contractId: poolOwned || kind === "lp" ? input.contractId : descriptor.ftContractId as string,
        ...(count === undefined ? {} : { confirmations: count }) });
      total += BigInt(item.balance);
      if (poolOwned || (input.inputOutpoints === undefined && total >= wanted)) return selected;
    }
    if (selected.length > 0 && total >= wanted) return selected;
    throw new Error("AMM mature holder inputs are insufficient");
  }
  const assets = await Promise.all([select(poolRows.utxos, true), holderRows === undefined ? Promise.resolve([]) : select(holderRows.utxos, false)]);
  for (const group of assets) utxos.push(...group);
  for (const id of dependencies) readProof(id);
  const proofs = await Promise.all(proofReads.values());
  for (const proof of proofs) if (!proof.ok) throw proof.error;
  // Parallel completion and warm-cache resolution must not reorder proposal
  // evidence between DApp preparation and wallet verification. This is local
  // ordering only: same exact raw set, with no extra request or relaxed check.
  return { utxos, parents: [...parents.values()].sort((a, b) => a.txid.localeCompare(b.txid)), contracts: [{
    contractId: input.contractId,indexedPool, family: "pool", protocolVersion: "pool3", standardId: "tbc-amm",
    templateRevision: descriptor.templateRevision as string, creationTxid: input.contractId,
    genesisOutpoint: { txid: input.contractId, vout: 0 }, currentOutpoint: { txid: tx.txid, vout: 0 },
  }] };
}
