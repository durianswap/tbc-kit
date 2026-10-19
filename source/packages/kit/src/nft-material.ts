import { bytesToHex, hexToBytes, sha256Bytes } from "./network-bytes.js";
import type { TbcOfficialApiClient } from "./official-api.js";

/** Matches the same-source Rust NFT mint/hold script markers. */
const MINT_SUFFIX = "6a0d5630204d696e74204e486f6c64";
const HOLD_SUFFIX = "6a0d56302043757272204e486f6c64";
const HASH = /^[0-9a-f]{64}$/u;
export const TBC721_TEMPLATE_REVISION = "a97688ec62777b01e93c8486e0505b56701f48dc8cf7947637ece57fe88df104";

export interface NftTransactionMaterial {
  readonly txid: string;
  readonly rawTransaction: string;
  readonly inputs: readonly Readonly<{ txid: string; vout: number }>[];
  readonly outputs: readonly Readonly<{ vout: number; satoshis: string; scriptPubKey: string }>[];
  readonly confirmations?: string;
}

export class NftMaterialUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NftMaterialUnavailableError";
  }
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid NFT index object");
  return value as Readonly<Record<string, unknown>>;
}
function uint(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error("Invalid NFT index integer");
  return value;
}
function index(value: unknown): number {
  const parsed = BigInt(uint(value));
  if (parsed > 0xffff_ffffn) throw new Error("NFT index exceeds uint32");
  return Number(parsed);
}
function rows(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  const list = object(value).utxos;
  if (!Array.isArray(list) || list.length > 10_000) throw new Error("Invalid NFT index list");
  return list.map(object);
}
function scriptHash(script: string): string {
  // The actual indexer/SDK uses byte-reversed SHA256, not display-order SHA256.
  return bytesToHex(sha256Bytes(hexToBytes(script)).reverse());
}

export async function resolveNftMaterial(input: Readonly<{
  kind: "collection" | "nft";
  contractId: string;
  ownerScript: string;
  api: TbcOfficialApiClient;
  readHistory: (txid: string) => Promise<NftTransactionMaterial>;
  readDecoded: (txid: string) => Promise<NftTransactionMaterial>;
  tipHeight: Promise<bigint | undefined>;
  minimumConfirmations: string | undefined;
  standardId?: "tbc721-standard";
  collectionSlots?: readonly number[];
}>) {
  const { api, contractId, readHistory, readDecoded } = input;
  if (!HASH.test(contractId)) throw new Error("Invalid NFT identity");
  const parents = new Map<string, NftTransactionMaterial>();
  const keep = (tx: NftTransactionMaterial) => { parents.set(tx.txid, tx); return tx; };
  const decoded = new Map<string, Promise<NftTransactionMaterial>>();
  const fresh = (id: string) => {
    let pending = decoded.get(id);
    if (!pending) { pending = readDecoded(id).then(keep); decoded.set(id, pending); }
    return pending;
  };
  async function confirmation(row: Readonly<Record<string, unknown>>, txid: string): Promise<string | undefined> {
    // A zero construction floor does not cause an observation-only decode.
    if (row.height === undefined) return BigInt(input.minimumConfirmations ?? "0") === 0n ? undefined : (await fresh(txid)).confirmations;
    const height = BigInt(uint(row.height));
    const tip = await input.tipHeight;
    if (tip === undefined) {
      if (BigInt(input.minimumConfirmations ?? "0") > 0n) throw new Error("NFT confirmation policy requires observed tip");
      return height === 0n ? "0" : undefined;
    }
    if (height > tip) throw new Error("NFT index height exceeds snapshot tip");
    return height === 0n ? "0" : (tip - height + 1n).toString();
  }
  function utxo(tx: NftTransactionMaterial, vout: number, classification: "collection-slot" | "nft", confirmations: string | undefined) {
    const output = tx.outputs[vout];
    if (output === undefined) throw new Error("NFT indexed output is missing");
    return Object.freeze({ txid: tx.txid, vout, satoshis: output.satoshis, scriptPubKey: output.scriptPubKey,
      classification, contractId, ...(confirmations === undefined ? {} : { confirmations }) });
  }
  function contract(txid: string, vout: number) {
    return Object.freeze({ contractId, family: input.kind, protocolVersion: input.standardId === undefined ? "2.0" : "tbc721",
      ...(input.standardId === undefined ? {} : { standardId: input.standardId, templateRevision: TBC721_TEMPLATE_REVISION,
        genesisOutpoint: Object.freeze({ txid: contractId, vout: 0 as const }) }), creationTxid: contractId,
      currentOutpoint: Object.freeze({ txid, vout }) });
  }
  if (input.kind === "collection") {
    const script = `${input.ownerScript}${MINT_SUFFIX}`;
    const listRead = api.utxosByScriptHash({ scriptpubkeyhash: scriptHash(script) }, { category: "asset-index" }).then(rows);
    const creationRead = BigInt(input.minimumConfirmations ?? "0") === 0n ? readHistory(contractId).then(keep)
      : listRead.then(list => {
        const selected = list.filter(row => row.txid === contractId && (input.collectionSlots === undefined || input.collectionSlots.includes(index(row.index))));
        return selected.length === 0 || selected.some(row => row.height === undefined) ? fresh(contractId) : readHistory(contractId).then(keep);
      });
    const [creation, list] = await Promise.all([
      creationRead,
      listRead,
    ]);
    const candidates = list.filter(row => row.txid === contractId).map(row => ({row,vout:index(row.index)})).sort((a,b)=>a.vout-b.vout);
    if (new Set(candidates.map(c=>c.vout)).size !== candidates.length) throw new Error("Duplicate collection slots");
    if (input.standardId === "tbc721-standard") {
      const slots = input.collectionSlots;
      if (slots === undefined || slots.length < 1 || slots.length > 32 || new Set(slots).size !== slots.length ||
          slots.some(slot => !Number.isSafeInteger(slot) || slot < 1 || slot > 0xffff_ffff)) throw new Error("Invalid requested collection slots");
      const bySlot = new Map(candidates.map(candidate => [candidate.vout, candidate.row]));
      for (const slot of slots) {
        const output = creation.outputs[slot];
        if (!output || output.vout !== slot || output.scriptPubKey !== script || output.satoshis !== "100") throw new Error("Requested collection slot identity/owner mismatch");
      }
      const missing = slots.filter(slot => !bySlot.has(slot));
      if (missing.length > 0) {
        // Index lag: query only missing requested slots in one read, never all
        // collection slots or substitutes that change the approved mint set.
        const response = await api.txoStatus({ txos: missing.map(slot => ({ txid: contractId, index: slot })) }, { category: "asset-index" });
        if (!Array.isArray(response.txos) || response.txos.length > missing.length) throw new Error("Invalid selected slot status list");
        const seen = new Set<number>();
        for (const status of response.txos) {
          const slot = index(status.index); const output = creation.outputs[slot];
          if (status.txid !== contractId || !missing.includes(slot) || seen.has(slot) || status.value !== "100" ||
              (status.scriptPubKey !== undefined && status.scriptPubKey !== output!.scriptPubKey)) throw new Error("Selected slot status mismatch");
          seen.add(slot);
          if (status.spent !== false) throw new Error("Requested collection slot has been spent");
          bySlot.set(slot, status);
        }
        if (seen.size !== missing.length) throw new NftMaterialUnavailableError("Requested collection slots are not indexed yet");
      }
      const utxos = await Promise.all(slots.map(async slot => {
        const row = bySlot.get(slot)!;
        if (uint(row.value) !== "100") throw new Error("Selected slot index amount differs");
        return utxo(creation, slot, "collection-slot", await confirmation(row, creation.txid));
      }));
      return Object.freeze({ utxos, parents: [...parents.values()], contracts: [contract(creation.txid, slots[0]!)] });
    }
    let selected = candidates[0];
    if (selected === undefined) {
      // The collection transaction may be accepted before its script index is
      // populated. Fall back only to exact slot outpoints authenticated by the
      // already verified creation bytes; the normal indexed path performs no
      // status request.
      const expected = creation.outputs
        .filter(output => output.vout > 0 && output.scriptPubKey === script && output.satoshis === "100")
        .sort((left, right) => left.vout - right.vout);
      if (expected.length === 0) throw new Error("Collection creation has no valid slots");
      const response = await api.txoStatus({
        txos: expected.map(output => ({ txid: contractId, index: output.vout })),
      }, { category: "asset-index" });
      if (!Array.isArray(response.txos) || response.txos.length > expected.length) throw new Error("Invalid collection slot status list");
      const expectedByVout = new Map(expected.map(output => [output.vout, output]));
      const statusByVout = new Map<number, (typeof response.txos)[number]>();
      for (const status of response.txos) {
        const vout = index(status.index);
        const output = expectedByVout.get(vout);
        if (status.txid !== contractId || output === undefined || status.value !== output.satoshis ||
          (status.scriptPubKey !== undefined && status.scriptPubKey !== output.scriptPubKey) || statusByVout.has(vout)) {
          throw new Error("Collection slot status mismatch");
        }
        statusByVout.set(vout, status);
      }
      if (statusByVout.size !== expected.length) {
        throw new NftMaterialUnavailableError("Collection slot status is not indexed yet");
      }
      const available = expected.find(output => statusByVout.get(output.vout)?.spent === false);
      if (available === undefined) throw new Error("No unspent collection slot");
      const status = statusByVout.get(available.vout)!;
      selected = {
        vout: available.vout,
        row: Object.freeze({
          txid: status.txid,
          index: status.index,
          value: status.value,
          ...(status.height === undefined ? {} : { height: status.height }),
        }),
      };
    }
    if (!selected || selected.vout === 0) throw new Error("No unspent collection slot");
    const output = creation.outputs[selected.vout];
    if (!output || output.scriptPubKey !== script || output.satoshis !== "100" || uint(selected.row.value) !== output.satoshis) throw new Error("Collection slot identity/owner mismatch");
    const count = await confirmation(selected.row, creation.txid);
    return Object.freeze({ utxos: [utxo(creation, selected.vout, "collection-slot", count)], parents: [...parents.values()], contracts: [contract(creation.txid, selected.vout)] });
  }

  // The authenticated mint bytes already identify the code version and collection;
  // do not probe all versions or enumerate the account's NFT history.
  const mint = keep(await readHistory(contractId));
  const origin = mint.inputs[0];
  const code = mint.outputs[0];
  if (!origin || !HASH.test(origin.txid) || origin.vout === 0 || !code || mint.outputs.length < 3 || code.satoshis !== "200") throw new Error("Invalid NFT mint topology");
  const list = await api.nftUtxosByScriptHash({ scriptpubkeyhash: scriptHash(code.scriptPubKey) }, { category: "asset-index" }).then(rows);
  if (list.length !== 1) throw new Error("NFT current output is missing or ambiguous");
  const row = list[0]!;
  if (typeof row.txid !== "string" || !HASH.test(row.txid) || index(row.index) !== 0 ||
    (row.nft_id !== undefined && row.nft_id !== contractId) ||
    (row.collection_id !== undefined && row.collection_id !== origin.txid)) throw new Error("NFT current identity mismatch");
  const currentTxid = row.txid;
  // Like the SDK, construction trusts the configured NFT index's currentness.
  // Ownership, values and the actual paired scripts remain locally validated.
  const [current, count] = await Promise.all([
    (row.height === undefined && BigInt(input.minimumConfirmations ?? "0") > 0n ? fresh(currentTxid) : readHistory(currentTxid).then(keep)),
    confirmation(row, currentTxid),
  ]);
  const hold = current.outputs[1];
  if (!hold || hold.satoshis !== "100" || hold.scriptPubKey !== `${input.ownerScript}${HOLD_SUFFIX}`) throw new Error("NFT hold is not controlled by this account");
  if (input.standardId === "tbc721-standard") {
    if (current.outputs[0]?.scriptPubKey !== code.scriptPubKey || current.outputs[2]?.scriptPubKey !== mint.outputs[2]?.scriptPubKey) throw new Error("NFT immutable identity changed");
    const first = current.inputs[0], second = current.inputs[1];
    if (!first || (currentTxid !== contractId && (!second || first.txid !== second.txid || first.vout !== 0 || second.vout !== 1))) throw new Error("Invalid new NFT descendant pair");
    // New ABI needs exactly the direct ancestor, not every historical transfer.
    // Engine checks the full new template and proof; labels are never trusted.
    keep(await readHistory(first.txid));
    return Object.freeze({ utxos: [utxo(current, 0, "nft", count), utxo(current, 1, "nft", count)],
      parents: [...parents.values()], contracts: [contract(currentTxid, 0)] });
  }
  const identity = (tx: NftTransactionMaterial) => {
    if (tx.outputs[0]?.scriptPubKey !== code.scriptPubKey || tx.outputs[2]?.scriptPubKey !== mint.outputs[2]?.scriptPubKey)
      throw new Error("NFT immutable identity changed");
  };
  identity(current);
  if (current.txid !== contractId) {
    const first = current.inputs[0], second = current.inputs[1];
    if (!first || !second || first.txid !== second.txid || first.vout !== 0 || second.vout !== 1) throw new Error("Invalid NFT descendant pair");
    identity(keep(await readHistory(first.txid)));
  } else keep(await readHistory(origin.txid));
  return Object.freeze({ utxos: [utxo(current,0,"nft",count),utxo(current,1,"nft",count)], parents: [...parents.values()], contracts: [contract(currentTxid,0)] });
}
