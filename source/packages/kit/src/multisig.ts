/** Opt-in M-of-N wallets. Never imported by the partner/default wallet entry. */
import { secp256k1 } from "@noble/curves/secp256k1";
export { createMultisigMaterialLoader } from "./multisig-material.js";

export interface MultisigEngine {
  execute(operation: string, requestJson: string): Promise<string>;
}
export interface MultisigGroup {
  readonly publicKeys: readonly string[];
  readonly requiredSignatures: number;
  /** Canonical for new/old-wallet groups; provided preserves SDK address order. */
  readonly keyOrder?: "canonical" | "provided";
}
export interface MultisigDescriptor {
  readonly group: MultisigGroup;
  readonly address: string;
  readonly scriptPubKey: string;
  readonly tokenOwner: string;
}
export interface MultisigAddressInfo extends Omit<MultisigDescriptor, "group"> {
  readonly requiredSignatures: number;
  readonly publicKeyCount: number;
}
/** All amounts are canonical decimal strings in atomic units, never floats. */
export interface MultisigInput {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: string;
  readonly scriptPubKey: string;
  readonly parentTxraw?: string;
}
export interface MultisigTokenInput {
  readonly input: MultisigInput;
  readonly balance: string;
  /** Only the direct ancestors required by the released covenant witness. */
  readonly ancestors: readonly string[];
}
/** Released MultiSig FT/legacy Coin templates, not arbitrary Token contracts. */
export interface MultisigToken {
  readonly code: string;
  readonly tape: string;
  readonly inputs: readonly MultisigTokenInput[];
}
export type MultisigAction =
  | { readonly type: "create" | "depositTbc"; readonly publicKey: string; readonly amount: string; readonly inputs: readonly MultisigInput[] }
  | { readonly type: "transferTbc"; readonly destination: string; readonly amount: string; readonly inputs: readonly MultisigInput[] }
  | { readonly type: "mergeTbc"; readonly inputs: readonly MultisigInput[] }
  | { readonly type: "depositFt"; readonly publicKey: string; readonly amount: string; readonly funding: MultisigInput; readonly token: MultisigToken; readonly tbcAmount?: string }
  | { readonly type: "transferFt"; readonly publicKey: string; readonly destination: string; readonly amount: string; readonly funding: MultisigInput; readonly token: MultisigToken }
  | { readonly type: "mergeFt"; readonly publicKey: string; readonly funding: MultisigInput; readonly token: MultisigToken };
export interface MultisigRequest {
  readonly chainId: "tbc:mainnet" | "tbc:testnet";
  readonly group: MultisigGroup;
  readonly action: MultisigAction;
  readonly maxFee: string;
}
export interface MultisigSigningTask {
  readonly inputIndex: number;
  readonly digest: string;
  readonly publicKeys: readonly string[];
  readonly requiredSignatures: number;
}
export interface MultisigProposal {
  readonly format: "tbc-multisig-proposal";
  readonly proposalId: string;
  readonly request: MultisigRequest;
  readonly address: string;
  readonly unsignedTxraw: string;
  readonly fee: string;
  readonly tasks: readonly MultisigSigningTask[];
}
/** Rebuilt transaction outputs, including change, never an untrusted DApp label. */
export interface MultisigReview {
  readonly proposalId: string;
  readonly chainId: "tbc:mainnet" | "tbc:testnet";
  readonly groupAddress: string;
  readonly requiredSignatures: number;
  readonly publicKeys: readonly string[];
  readonly operation: MultisigAction["type"];
  readonly feeAtomic: string;
  readonly maxFeeAtomic: string;
  readonly includesChange: true;
  /** A script fingerprint, not the API's origin transaction/contract ID. */
  readonly assetIdentityKind: "locking-code-fingerprint";
  readonly outputs: readonly Readonly<{
    vouts: readonly number[];
    kind: "native" | "token" | "member-hold" | "metadata";
    assetFamily: "TBC" | "FT" | "STABLE_COIN";
    assetVersion?: number;
    assetIdentity: string;
    amountAtomic: string;
    recipient: string | null;
    nativeValueAtomic: string;
    memberPublicKey?: string;
  }>[];
}
export interface ReviewedMultisigProposal {
  readonly proposal: MultisigProposal;
  readonly review: MultisigReview;
}
export interface MultisigSignature {
  readonly proposalId: string;
  readonly inputIndex: number;
  readonly publicKey: string;
  /** Strict DER + 0x41, low-S. Recovery ID is neither needed nor accepted. */
  readonly signature: string;
}
export interface MultisigProgress {
  readonly proposalId: string;
  readonly complete: boolean;
  readonly signatureCounts: readonly number[];
}
export interface FinalizedMultisig {
  readonly proposalId: string;
  readonly txid: string;
  readonly txraw: string;
  readonly fee: string;
}
export interface MultisigSigner {
  readonly publicKey: string;
  /** UI approval or explicit backend policy; called once for the whole proposal. */
  approve(proposal: MultisigProposal, review: MultisigReview): Promise<boolean>;
  /** Sign digest32 directly, without a message prefix or another hash. */
  signDigest(task: Readonly<{ proposalId: string; inputIndex: number; digest: string; sighashType: 65 }>):
    Promise<Readonly<{ signature: string; encoding: "der-sighash" | "compact64" }>>;
}
export interface MultisigBatchSigner extends Omit<MultisigSigner, "approve"> {
  approve(proposals: readonly MultisigProposal[], reviews: readonly MultisigReview[]): Promise<boolean>;
}

function snapshot<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const member of Object.values(value)) freeze(member);
    Object.freeze(value);
  }
  return value;
}
function wire(signature: string, encoding: "der-sighash" | "compact64"): string {
  if (!/^(?:[0-9a-f]{2})+$/u.test(signature)) throw new TypeError("Invalid signature encoding");
  if (encoding === "der-sighash") return signature;
  if (encoding !== "compact64" || signature.length !== 128) throw new TypeError("Invalid compact signature");
  // Conversion only. Rust verifies low-S, exact digest, owner and sighash.
  return `${secp256k1.Signature.fromCompact(signature).toDERHex()}41`;
}
function validateBatch(checked: readonly MultisigProposal[]): void {
  if (!checked.length || checked.length > 32) throw new RangeError("Invalid multisig batch size");
  const first = checked[0]!;
  const ids = new Set<string>(), points = new Set<string>();
  for (const p of checked) {
    if (p.request.chainId !== first.request.chainId || p.address !== first.address || ids.has(p.proposalId))
      throw new Error("Multisig batch must use one network/group and unique proposals");
    ids.add(p.proposalId);
    const a = p.request.action;
    const inputs = "inputs" in a ? a.inputs : [a.funding, ...a.token.inputs.map(t => t.input)];
    for (const i of inputs) {
      const id = `${i.txid}:${i.vout}`;
      if (points.has(id)) throw new Error("Multisig batch spends an input twice");
      points.add(id);
    }
  }
}

/**
 * Works in a DApp, wallet or backend with the same Native/WASM keyless engine.
 * No implicit HTTP, approval, private key access, persistence or broadcasting.
 * The caller authenticates API/UTXO material and network/account authority
 * before approval. A proposal hash is binding, not evidence an input is unspent.
 */
export function createMultisigClient(engine: MultisigEngine) {
  const invoke = async <T>(operation: string, input: unknown): Promise<T> => {
    const result = JSON.parse(await engine.execute(operation, JSON.stringify(input))) as T & { error?: unknown };
    if (result && typeof result.error === "string") throw new Error(result.error);
    return freeze(result);
  };
  const inspect = (proposal: MultisigProposal): Promise<MultisigProposal> => invoke("inspectMultisig", proposal);
  const review = (proposal: MultisigProposal): Promise<ReviewedMultisigProposal> => invoke("reviewMultisig", proposal);
  const verify = (proposal: MultisigProposal, signatures: readonly MultisigSignature[]): Promise<MultisigProgress> =>
    invoke("verifyMultisigSignatures", { proposal, signatures });
  return Object.freeze({
    describe: (group: MultisigGroup): Promise<MultisigDescriptor> => invoke("describeMultisig", group),
    decodeAddress: (address: string): Promise<MultisigAddressInfo> => invoke("decodeMultisigAddress", {address}),
    async verifyAddress(address: string, group: MultisigGroup): Promise<boolean> {
      await invoke("decodeMultisigAddress", {address});
      const descriptor = await invoke<MultisigDescriptor>("describeMultisig", group);
      return descriptor.address === address;
    },
    prepare: (request: MultisigRequest): Promise<MultisigProposal> => invoke("prepareMultisig", request),
    inspect,
    review,
    verify,
    async exportProposal(proposal: MultisigProposal): Promise<string> { return JSON.stringify(await inspect(proposal)); },
    async importProposal(serialized: string): Promise<MultisigProposal> {
      if (serialized.length > 16 * 1024 * 1024) throw new RangeError("Multisig proposal too large");
      return inspect(JSON.parse(serialized) as MultisigProposal);
    },
    async sign(proposal: MultisigProposal, signer: MultisigSigner): Promise<readonly MultisigSignature[]> {
      // Own an immutable copy across the approval/async signer boundary.
      const {proposal: verified, review: summary} = await review(snapshot(proposal));
      const publicKey = signer.publicKey;
      const signDigest = signer.signDigest.bind(signer);
      const tasks = verified.tasks.filter(task => task.publicKeys.includes(publicKey));
      if (!tasks.length) throw new Error("Signer has no role in this proposal");
      if (!await signer.approve(verified, summary)) throw new Error("Multisig approval rejected");
      const signatures: MultisigSignature[] = [];
      for (const task of tasks) {
        const result = await signDigest(Object.freeze({ proposalId: verified.proposalId,
          inputIndex: task.inputIndex, digest: task.digest, sighashType: 65 as const }));
        signatures.push({ proposalId: verified.proposalId, inputIndex: task.inputIndex,
          publicKey, signature: wire(result.signature, result.encoding) });
      }
      await verify(verified, signatures);
      return freeze(signatures);
    },
    async combine(proposal: MultisigProposal, ...sets: readonly (readonly MultisigSignature[])[]): Promise<readonly MultisigSignature[]> {
      const entries = new Map<string, MultisigSignature>();
      for (const partial of sets.flat()) {
        const id = `${partial.inputIndex}:${partial.publicKey}`;
        const previous = entries.get(id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(partial)) throw new Error("Conflicting participant signature");
        entries.set(id, snapshot(partial));
      }
      const signatures = [...entries.values()].sort((a,b) => a.inputIndex-b.inputIndex || a.publicKey.localeCompare(b.publicKey));
      await verify(proposal, signatures);return freeze(signatures);
    },
    async signBatch(proposals: readonly MultisigProposal[], signer: MultisigBatchSigner): Promise<readonly (readonly MultisigSignature[])[]> {
      if (!proposals.length || proposals.length > 32) throw new RangeError("Invalid multisig batch size");
      const reviewed = await Promise.all(proposals.map(p => review(snapshot(p))));
      const checked = freeze(reviewed.map(p => p.proposal));
      const summaries = freeze(reviewed.map(p => p.review));
      validateBatch(checked);
      const publicKey = signer.publicKey;
      const signDigest = signer.signDigest.bind(signer);
      for (const p of checked) {
        if (!p.tasks.some(t => t.publicKeys.includes(publicKey))) throw new Error("Signer has no role in batch item");
      }
      if (!await signer.approve(checked, summaries)) throw new Error("Multisig batch approval rejected");
      const sets: MultisigSignature[][] = [];
      for (const p of checked) {
        const signatures: MultisigSignature[] = [];
        for (const t of p.tasks.filter(t => t.publicKeys.includes(publicKey))) {
          const result = await signDigest(Object.freeze({ proposalId:p.proposalId,inputIndex:t.inputIndex,digest:t.digest,sighashType:65 as const }));
          signatures.push({proposalId:p.proposalId,inputIndex:t.inputIndex,publicKey,signature:wire(result.signature,result.encoding)});
        }
        await verify(p,signatures);sets.push(signatures);
      }
      return freeze(sets);
    },
    async finalizeBatch(items: readonly Readonly<{proposal:MultisigProposal; signatures:readonly MultisigSignature[]}>[]): Promise<readonly FinalizedMultisig[]> {
      if (!items.length || items.length > 32) throw new RangeError("Invalid multisig batch size");
      const own = snapshot(items);
      const proposals = await Promise.all(own.map(item => inspect(item.proposal)));
      validateBatch(proposals);
      return freeze(await Promise.all(own.map(item => invoke<FinalizedMultisig>("finalizeMultisig",item))));
    },
    finalize: (proposal: MultisigProposal, signatures: readonly MultisigSignature[]): Promise<FinalizedMultisig> =>
      invoke("finalizeMultisig", { proposal, signatures }),
  });
}
