import type { KitSupportedIntent, KitTransactionEngine, KitTransactionRequest } from "./public-types.js";
import type { KitWalletNetwork } from "./wallet-runtime.js";
export type TbcPreparedProposalTransaction = Readonly<{
    id: string;
    role: string;
    dependsOn: readonly string[];
    fee: string;
}> & (Readonly<{
    kind: "fixed";
    unsignedTransaction: string;
}> | Readonly<{
    kind: "deferred";
    unsignedTransactionTemplate: string;
    deferredInputs: readonly Readonly<{
        inputIndex: number;
        sourceTransactionId: string;
        sourceOutputIndex: number;
    }>[];
}>);
export interface TbcPreparedProposal {
    readonly payload: Readonly<{
        version: "1.0";
        engineProfile: "tbc-engine-plan-v1";
        createdAt: string;
        expiresAt: string;
        intentHash: string;
        transactions: readonly TbcPreparedProposalTransaction[];
        evidence: Readonly<{
            observedAt: string;
            parentTransactions: readonly Readonly<{
                txid: string;
                rawTransaction: string;
            }>[];
            contracts: readonly Readonly<{
                contractId: string;
                family: "collection" | "nft" | "ft" | "stablecoin" | "pool";
                sourceTransactionId: string;
                standardId?: "tbc20-standard" | "tbc721-standard" | "tbc20-stablecoin" | "tbc-amm";
                protocolVersion?: "tbc20" | "tbc721" | "coin" | "pool3";
                templateRevision?: "0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84" | "a97688ec62777b01e93c8486e0505b56701f48dc8cf7947637ece57fe88df104" | "c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3" | "c98ecae0a22452ce37bcaf24be0c836521d3de3a75aa8f16cef587b8b6f031b2" | "cf7f95c0483b56ad24825591acbce6e82e37890aa0047fc63183d3fb7a7a4ffc" | "a821abdb280268430ad7ea7a9421068a719a8e959b84c11265d4456e8d740db7" | "834610c0726fa0829c50aaa75c3a0b58c046105248f0b023257437a22f8aca22";
                /** Genesis Code output (contractId:0), not the Source OriginalUTXO. */
                genesisOutpoint?: Readonly<{
                    txid: string;
                    vout: 0;
                }>;
            }>[];
        }>;
        estimatedTotalFee: string;
    }>;
    readonly proposalHash: string;
}
export interface TbcPreparedTransactionRequest<TIntent extends KitSupportedIntent = KitSupportedIntent> extends KitTransactionRequest<TIntent> {
    readonly proposal: TbcPreparedProposal;
}
export interface PrepareTbcTransactionOptions<TIntent extends KitSupportedIntent = KitSupportedIntent> {
    readonly request: KitTransactionRequest<TIntent>;
    readonly network: Pick<KitWalletNetwork, "resolveChainData" | "resolvePolicy">;
    /** Explicit opt-in to the transaction Engine subpath; the DApp root stays Engine-free. */
    readonly engine: KitTransactionEngine;
}
export interface TbcWorkflowTransactionStep<TIntent extends KitSupportedIntent = KitSupportedIntent> {
    readonly id: string;
    readonly kind: "transaction";
    readonly dependsOn: readonly string[];
    readonly intent: TIntent;
    readonly signingRoles?: KitTransactionRequest<TIntent>["signingRoles"];
    readonly constraints?: KitTransactionRequest<TIntent>["constraints"];
}
export interface TbcWorkflowTypedDataStep {
    readonly id: string;
    readonly kind: "typedData";
    readonly dependsOn: readonly string[];
    readonly data: Readonly<Record<string, unknown>>;
    readonly bindings: readonly Readonly<Record<string, unknown>>[];
}
export interface TbcWorkflowMessageStep {
    readonly id: string;
    readonly kind: "message";
    readonly dependsOn: readonly string[];
    readonly message: Readonly<{
        readonly encoding: "utf8" | "hex" | "base64";
        readonly data: string;
    }>;
    /** Deterministically inject transaction IDs from one reviewed predecessor into a UTF-8 JSON object. */
    readonly bindings?: readonly Readonly<{
        target: string;
        source: Readonly<{
            stepId: string;
            output: "transactionIds";
        }>;
    }>[];
}
export type TbcReviewedTransactionInput = Readonly<{
    payload: Readonly<{
        format: "raw";
        transactions: readonly Readonly<{
            rawTransaction: string;
            inputs: readonly Readonly<{
                satoshis: string;
                scriptPubKey: string;
            }>[];
        }>[];
    }> | Readonly<{
        format: "associated";
        sourceTransaction: string;
        sourceInputs: readonly Readonly<Record<string, unknown>>[];
        children: readonly Readonly<{
            inputs: readonly Readonly<Record<string, unknown>>[];
            outputs: readonly Readonly<{
                satoshis: string;
                scriptPubKey: string;
            }>[];
        }>[];
    }>;
}>;
export interface TbcWorkflowReviewedTransactionStep {
    readonly id: string;
    readonly kind: "reviewedTransaction";
    readonly dependsOn: readonly string[];
    readonly request: TbcReviewedTransactionInput;
}
export type TbcMessageCryptoAlgorithm = "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
export interface TbcWorkflowEncryptStep {
    readonly id: string;
    readonly kind: "encrypt";
    readonly dependsOn: readonly string[];
    readonly algorithm: TbcMessageCryptoAlgorithm;
    readonly message: TbcWorkflowMessageStep["message"];
}
export interface TbcWorkflowDecryptStep {
    readonly id: string;
    readonly kind: "decrypt";
    readonly dependsOn: readonly string[];
    readonly algorithm: TbcMessageCryptoAlgorithm;
    readonly ciphertext: string;
}
export type TbcWorkflowStep = TbcWorkflowTransactionStep | TbcWorkflowReviewedTransactionStep | TbcWorkflowMessageStep | TbcWorkflowEncryptStep | TbcWorkflowDecryptStep | TbcWorkflowTypedDataStep;
export interface TbcWorkflowRequest {
    readonly version: "1.0";
    readonly chainId: `tbc:${string}`;
    readonly from: string;
    readonly clientRequestId?: string;
    readonly expiresAt?: string;
    readonly maxTotalFee?: string;
    /** Defaults to atomic. Independent continuation never bypasses the one bound approval. */
    readonly failureMode?: "atomic" | "continue-independent";
    readonly steps: readonly TbcWorkflowStep[];
}
export type TbcWorkflowComposition<TSteps extends readonly TbcWorkflowStep[] = readonly TbcWorkflowStep[]> = Readonly<Omit<TbcWorkflowRequest, "version" | "chainId" | "from" | "steps"> & Readonly<{
    readonly steps: TSteps;
}>>;
export interface TbcPreparedWorkflowRequest extends Omit<TbcWorkflowRequest, "steps"> {
    readonly steps: readonly (Readonly<Omit<TbcWorkflowTransactionStep, "kind"> & {
        kind: "preparedTransaction";
        proposal: TbcPreparedProposal;
    }> | TbcWorkflowReviewedTransactionStep | TbcWorkflowMessageStep | TbcWorkflowEncryptStep | TbcWorkflowDecryptStep | TbcWorkflowTypedDataStep)[];
}
export interface PrepareTbcWorkflowOptions {
    readonly request: TbcWorkflowRequest;
    readonly network: Pick<KitWalletNetwork, "resolveChainData" | "resolvePolicy">;
    /** Explicit opt-in to the transaction Engine subpath; the DApp root stays Engine-free. */
    readonly engine: KitTransactionEngine;
}
/**
 * Builds the page-owned portion of a Standard workflow without creating a
 * second executor. Dependencies must point to an earlier step, which makes the
 * ordered result relationship explicit and rejects cycles before Provider I/O.
 */
export declare function composeTbcWorkflow<const TSteps extends readonly TbcWorkflowStep[]>(input: TbcWorkflowComposition<TSteps>): TbcWorkflowComposition<TSteps>;
/**
 * Builds a fixed or structurally deferred DApp proposal with the same Rust
 * Engine used by the wallet. Deferred inputs are parsed transaction inputs;
 * byte offsets and arbitrary template substitution are never accepted.
 */
export declare function prepareTbcTransaction<TIntent extends KitSupportedIntent>(options: PrepareTbcTransactionOptions<TIntent>): Promise<TbcPreparedTransactionRequest<TIntent>>;
/** Prepares every transaction step and preserves typed-data dependencies. */
export declare function prepareTbcWorkflow(options: PrepareTbcWorkflowOptions): Promise<TbcPreparedWorkflowRequest>;
