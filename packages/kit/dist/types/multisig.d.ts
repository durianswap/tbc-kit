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
export type MultisigAction = {
    readonly type: "create" | "depositTbc";
    readonly publicKey: string;
    readonly amount: string;
    readonly inputs: readonly MultisigInput[];
} | {
    readonly type: "transferTbc";
    readonly destination: string;
    readonly amount: string;
    readonly inputs: readonly MultisigInput[];
} | {
    readonly type: "mergeTbc";
    readonly inputs: readonly MultisigInput[];
} | {
    readonly type: "depositFt";
    readonly publicKey: string;
    readonly amount: string;
    readonly funding: MultisigInput;
    readonly token: MultisigToken;
    readonly tbcAmount?: string;
} | {
    readonly type: "transferFt";
    readonly publicKey: string;
    readonly destination: string;
    readonly amount: string;
    readonly funding: MultisigInput;
    readonly token: MultisigToken;
} | {
    readonly type: "mergeFt";
    readonly publicKey: string;
    readonly funding: MultisigInput;
    readonly token: MultisigToken;
};
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
    signDigest(task: Readonly<{
        proposalId: string;
        inputIndex: number;
        digest: string;
        sighashType: 65;
    }>): Promise<Readonly<{
        signature: string;
        encoding: "der-sighash" | "compact64";
    }>>;
}
export interface MultisigBatchSigner extends Omit<MultisigSigner, "approve"> {
    approve(proposals: readonly MultisigProposal[], reviews: readonly MultisigReview[]): Promise<boolean>;
}
/**
 * Works in a DApp, wallet or backend with the same Native/WASM keyless engine.
 * No implicit HTTP, approval, private key access, persistence or broadcasting.
 * The caller authenticates API/UTXO material and network/account authority
 * before approval. A proposal hash is binding, not evidence an input is unspent.
 */
export declare function createMultisigClient(engine: MultisigEngine): Readonly<{
    describe: (group: MultisigGroup) => Promise<MultisigDescriptor>;
    decodeAddress: (address: string) => Promise<MultisigAddressInfo>;
    verifyAddress(address: string, group: MultisigGroup): Promise<boolean>;
    prepare: (request: MultisigRequest) => Promise<MultisigProposal>;
    inspect: (proposal: MultisigProposal) => Promise<MultisigProposal>;
    review: (proposal: MultisigProposal) => Promise<ReviewedMultisigProposal>;
    verify: (proposal: MultisigProposal, signatures: readonly MultisigSignature[]) => Promise<MultisigProgress>;
    exportProposal(proposal: MultisigProposal): Promise<string>;
    importProposal(serialized: string): Promise<MultisigProposal>;
    sign(proposal: MultisigProposal, signer: MultisigSigner): Promise<readonly MultisigSignature[]>;
    combine(proposal: MultisigProposal, ...sets: readonly (readonly MultisigSignature[])[]): Promise<readonly MultisigSignature[]>;
    signBatch(proposals: readonly MultisigProposal[], signer: MultisigBatchSigner): Promise<readonly (readonly MultisigSignature[])[]>;
    finalizeBatch(items: readonly Readonly<{
        proposal: MultisigProposal;
        signatures: readonly MultisigSignature[];
    }>[]): Promise<readonly FinalizedMultisig[]>;
    finalize: (proposal: MultisigProposal, signatures: readonly MultisigSignature[]) => Promise<FinalizedMultisig>;
}>;
//# sourceMappingURL=multisig.d.ts.map