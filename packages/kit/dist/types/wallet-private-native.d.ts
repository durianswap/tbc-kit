import type { TbcReviewedPolicyMaterial } from "./reviewed-transaction-types.js";
export type TbcWalletPrivateNativeMethod = "signP2pkh" | "signAssociated" | "encryptMessage" | "decryptMessage";
/** Platform bridge that closes over the wallet's scoped key accessor. */
export interface TbcWalletPrivateNativeBridge {
    readonly call: (method: TbcWalletPrivateNativeMethod, canonicalRequestJson: string) => Promise<string>;
}
type Approved = Readonly<{
    status: "approved";
    bindingHash: string;
    approvalId: string;
}>;
type BoundRequest<T> = Readonly<{
    bindingHash: string;
    request: T;
}>;
export type TbcWalletPrivateNativeAdapters = Readonly<{
    rawSigner: Readonly<{
        sign(input: Readonly<{
            binding: BoundRequest<Readonly<{
                txraws: readonly string[];
                utxos_satoshis: readonly (readonly number[])[];
                script_pubkeys: readonly (readonly string[])[];
            }>>;
            approval: Approved;
            policyMaterial?: TbcReviewedPolicyMaterial;
        }>): Promise<unknown>;
    }>;
    cryptoAdapter: Readonly<{
        encrypt(input: Readonly<{
            binding: BoundRequest<Readonly<{
                message: string;
            }>>;
            approval: Approved;
        }>): Promise<unknown>;
        decrypt(input: Readonly<{
            binding: BoundRequest<Readonly<{
                message: string;
            }>>;
            approval: Approved;
        }>): Promise<unknown>;
    }>;
    associatedExecutor: Readonly<{
        execute(input: Readonly<{
            operationDigest: string;
            request: Readonly<Record<string, unknown>>;
            policyMaterial?: TbcReviewedPolicyMaterial;
        }>): Promise<unknown>;
    }>;
}>;
/** Creates one-shot Standard/Legacy adapters over the shared restricted ABI. */
export declare function createTbcWalletPrivateNativeAdapters(bridge: TbcWalletPrivateNativeBridge): TbcWalletPrivateNativeAdapters;
export {};
