import { assertValidTws, canonicalize, hashCanonical, bytesToHex } from "@tbc-wallet/core";
import type { ChainDataResolveResult, ChainDataResolveParams } from "@tbc-wallet/core";
import { assertTbcAddress, inspectTbcTransaction } from "./testnet-validation.js";
import type { KitWalletAccount } from "./wallet-runtime.js";
import type { TbcNetworkContext } from "./network-context.js";
import { createTbcNftMintJobScope, TbcNftMintJobExpiredError, type TbcNftMintJobScope } from "./nft-mint-job.js";

type Snapshot = Extract<ChainDataResolveResult, { snapshotHash: string }>;
type Utxo = Snapshot["payload"]["utxos"][number];
type Parent = Snapshot["payload"]["parents"][number];
const outpoint = (txid: string, vout: number) => `${txid}:${vout}`;

/** One job's authenticated material. Not a global UTXO manager or durable cache. */
export interface TbcNftMintJobMaterial {
  readonly expiresAt: string;
  readonly snapshot: (slots: readonly number[]) => Snapshot;
  /** Only after the shared Engine validated the bundle and every submission is accepted/known. */
  readonly acceptValidatedBatch: (slots: readonly number[], transactions: readonly Parent[]) => void;
}

/** The resolver passed here must use one private preparation read scope. */
export async function prepareTbcNftMintJobMaterial(input: Readonly<{
  scope: TbcNftMintJobScope;
  account: KitWalletAccount;
  network: TbcNetworkContext;
  resolve: (params: ChainDataResolveParams, account: KitWalletAccount) => Promise<unknown>;
  now?: () => number;
}>): Promise<TbcNftMintJobMaterial> {
  const { scope: requested, account, resolve } = input;
  const scope = createTbcNftMintJobScope({ authority: requested.authority, collectionId: requested.collectionId,
    items: requested.items, limits: requested.limits });
  if (input.network.chainId !== account.chainId || account.chainId !== scope.authority.chainId || account.accountId !== scope.authority.accountId ||
      account.address !== scope.authority.address) throw new Error("NFT job material account mismatch");
  const now = input.now ?? Date.now;
  const snapshots: Snapshot[] = [];
  const chunks = Array.from({ length: Math.ceil(scope.items.length / 100) }, (_, i) => scope.items.slice(i * 100, i * 100 + 100));
  // Groups share the native/collection/raw read promises. Only missing requested
  // slots may need additional status calls. No balance/history/tip probes here.
  const results = await Promise.allSettled(chunks.map(async items => {
    const response = await resolve({ version: "1.0", chainId: account.chainId, accountId: account.accountId,
      requirement: { intentType: "tbc721-standard-batch-mint", includeAncestry: true,
        contractIds: [scope.collectionId], collectionSlots: items.map(i => i.slot),
        assets: [{ kind: "native" }, { kind: "collection", contractId: scope.collectionId, minimumAmount: String(items.length) }] } }, account);
    assertValidTws("chainDataResolveResult", response);
    const value = response as Snapshot;
    if (!("snapshotHash" in value) || hashCanonical(value.payload) !== value.snapshotHash ||
        canonicalize(value.payload.account) !== canonicalize(account) || value.payload.chainId !== account.chainId) {
      throw new Error("NFT job material could not be authenticated");
    }
    return value;
  }));
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
    snapshots.push(result.value);
  }
  const first = snapshots[0]!, native = new Map<string, Utxo>(), slots = new Map<number, Utxo>(), parents = new Map<string, Parent>();
  const expires = Math.min(Date.parse(scope.limits.expiresAt), ...snapshots.map(s => Date.parse(s.payload.expiresAt)));
  const created = Math.min(...snapshots.map(s => Date.parse(s.payload.capturedAt)));
  const wanted = new Set(scope.items.map(i => i.slot));
  const contract = first.payload.contracts[0];
  if (contract === undefined || first.payload.contracts.length !== 1 || contract.contractId !== scope.collectionId ||
      contract.family !== "collection" || contract.standardId !== "tbc721-standard") throw new Error("NFT job collection identity mismatch");
  for (const snapshot of snapshots) {
    if (snapshot.payload.contracts.length !== 1 || canonicalize({ ...snapshot.payload.contracts[0], currentOutpoint: null }) !==
        canonicalize({ ...contract, currentOutpoint: null })) throw new Error("NFT job collection records conflict");
    for (const p of snapshot.payload.parents) {
      const prior = parents.get(p.txid);
      if (prior && prior.rawTransaction !== p.rawTransaction) throw new Error("NFT job parent bytes conflict");
      parents.set(p.txid, p);
    }
    for (const u of snapshot.payload.utxos) {
      if (u.classification === "native") {
        const key = outpoint(u.txid, u.vout), prior = native.get(key);
        if (prior && canonicalize(prior) !== canonicalize(u)) throw new Error("NFT job native observations conflict");
        native.set(key, u);
      } else if (u.classification === "collection-slot" && u.txid === scope.collectionId && wanted.has(u.vout)) {
        const prior = slots.get(u.vout);
        if (prior && canonicalize(prior) !== canonicalize(u)) throw new Error("NFT job slot observations conflict");
        slots.set(u.vout, u);
      } else throw new Error("NFT job includes unrelated asset material");
    }
  }
  if (slots.size !== wanted.size || !parents.has(scope.collectionId) || !Number.isFinite(expires) || now() >= expires) {
    throw new Error("NFT job slots are incomplete or expired");
  }
  const baseNative = [...native.keys()].sort().join();
  for (const snapshot of snapshots) {
    if (snapshot.payload.utxos.filter(u => u.classification === "native").map(u => outpoint(u.txid,u.vout)).sort().join() !== baseNative) {
      throw new Error("NFT job preparation did not reuse one native index");
    }
  }
  const ownerScript = assertTbcAddress(account.address, input.network.profile.p2pkhVersion).scriptPubKey;
  const scopeHash = hashCanonical(scope);
  let revision = 0;
  const selectSlots = (requestedSlots: readonly number[], requireFresh = true) => {
    if (requireFresh && now() >= expires) throw new TbcNftMintJobExpiredError();
    if (requestedSlots.length < 1 || requestedSlots.length > 100 || new Set(requestedSlots).size !== requestedSlots.length) {
      throw new Error("NFT job sub-batch is invalid");
    }
    return requestedSlots.map(slot => {
      const utxo = slots.get(slot);
      if (!utxo) throw new Error("NFT job slot is not available in this approved task");
      return utxo;
    });
  };
  return Object.freeze({
    expiresAt: new Date(expires).toISOString(),
    snapshot(requestedSlots: readonly number[]): Snapshot {
      const selected = selectSlots(requestedSlots);
      const requiredParents = new Set([scope.collectionId, ...[...native.values()].filter(u => parents.has(u.txid)).map(u => u.txid)]);
      const payload = { ...first.payload, snapshotId: `nft-job-${hashCanonical({ scopeHash, revision, slots: requestedSlots }).slice(0, 32)}`,
        capturedAt: new Date(created).toISOString(), expiresAt: new Date(expires).toISOString(),
        utxos: [...native.values(), ...selected],
        parents: [...requiredParents].map(id => parents.get(id)!),
        contracts: [{ ...contract, currentOutpoint: { txid: scope.collectionId, vout: requestedSlots[0]! } }] };
      const result = { payload, snapshotHash: hashCanonical(payload) };
      assertValidTws("chainDataResolveResult", result);
      // A caller cannot mutate the next batch's retained material.
      return JSON.parse(canonicalize(result)) as Snapshot;
    },
    acceptValidatedBatch(requestedSlots: readonly number[], transactions: readonly Parent[]) {
      // Accounting for an already accepted, validated result is not permission
      // to sign or send. Keep it even if the final reply crossed the deadline;
      // the next snapshot still enforces the original expiry above.
      selectSlots(requestedSlots, false);
      if (transactions.length !== requestedSlots.length) throw new Error("NFT job finalized count differs");
      const nextNative = new Map(native), nextParents = new Map(parents), spent = new Set<string>(), ids = new Set<string>();
      for (let i = 0; i < transactions.length; i++) {
        const value = transactions[i]!, parsed = inspectTbcTransaction(value.rawTransaction);
        const tx = parsed.transaction;
        if (parsed.txid !== value.txid || ids.has(value.txid) || nextParents.has(value.txid) ||
            tx.inputs[0]?.txid !== scope.collectionId || tx.inputs[0]?.vout !== requestedSlots[i]) {
          throw new Error("NFT job signed parent or slot differs");
        }
        ids.add(value.txid);
        for (let vin = 0; vin < tx.inputs.length; vin++) {
          const v = tx.inputs[vin]!, key = outpoint(v.txid, v.vout);
          if (spent.has(key) || (vin !== 0 && !nextNative.has(key))) throw new Error("NFT job funding input is reused or unbound");
          spent.add(key); nextNative.delete(key);
        }
        // Mint's first three outputs are Code/Hold/Tape, not spendable native
        // funding. Only its exact owner P2PKH change may fund later sub-batches.
        for (let vout = 3; vout < tx.outputs.length; vout++) {
          const output = tx.outputs[vout]!;
          if (bytesToHex(output.scriptPubKey) !== ownerScript || output.satoshis === 0n) throw new Error("NFT job change is not owner funding");
          nextNative.set(outpoint(value.txid, vout), { txid: value.txid, vout, satoshis: output.satoshis.toString(),
            scriptPubKey: ownerScript, classification: "native", confirmations: "0" });
        }
        nextParents.set(value.txid, { txid: value.txid, rawTransaction: value.rawTransaction });
      }
      // Commit only the fully checked batch, never partially apply an invalid
      // callback. Keep just the original collection and unspent fee parents.
      native.clear(); for (const [k,v] of nextNative) native.set(k,v);
      for (const slot of requestedSlots) slots.delete(slot);
      parents.clear(); parents.set(scope.collectionId, nextParents.get(scope.collectionId)!);
      for (const value of native.values()) {
        const p = nextParents.get(value.txid); if (p) parents.set(p.txid,p);
      }
      revision++;
    },
  });
}
