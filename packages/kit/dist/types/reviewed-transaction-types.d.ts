export interface TbcSecureOperationContext {
    readonly origin: string;
    readonly chainId: string;
    readonly accountId: string;
    readonly sessionId: string;
    readonly navigationId: string;
}
export type TbcReviewedTransactionRequest = Readonly<{
    txraws: readonly string[];
    utxos_satoshis: readonly (readonly number[])[];
    script_pubkeys: readonly (readonly string[])[];
    /** Kit-owned Code-authenticated keys. Not a DApp permission or key override. */
    signingPublicKeys?: readonly (readonly (string | null)[])[];
}>;
export type TbcVerifiedTransactionInput = Readonly<{
    txid: string;
    vout: number;
    satoshis: number;
    scriptPubKey: string;
    spent: false;
}>;
/** Authenticated locking outputs only; never raw transactions or witnesses. */
export type TbcReviewedPolicyMaterial = Readonly<{
    resolvedOutputs: readonly Readonly<{
        txid: string;
        vout: number;
        satoshis: string;
        scriptPubKey: string;
    }>[];
}>;
export interface TbcRawTransactionReviewer {
    readonly review: (input: Readonly<{
        request: TbcReviewedTransactionRequest;
        context: TbcSecureOperationContext;
        transactionIds: readonly string[];
        /** Accounts already resolved and authorized by Core/Host. */
        signingRoles?: readonly import("./internal/core/index.js").ResolvedTransactionSigningRole[];
    }>) => Promise<Readonly<{
        preview: unknown;
        verifiedInputs: readonly (readonly TbcVerifiedTransactionInput[])[];
        policyMaterial?: TbcReviewedPolicyMaterial;
    }>>;
}
export interface TbcAssociatedTransactionReviewer {
    readonly review: (input: Readonly<{
        request: Readonly<Record<string, unknown>>;
        operationDigest: string;
        context: TbcSecureOperationContext;
        /** Trusted wallet account key, not a page-provided signing override.
         * Required by current Token/Coin associated proof preflight. */
        publicKey?: string;
        /** Host-resolved public roles. Never copied from the DApp payload. */
        signingRoles?: readonly import("./internal/core/index.js").ResolvedTransactionSigningRole[];
    }>) => Promise<Readonly<{
        preview: unknown;
        verifiedInputs: readonly (readonly TbcVerifiedTransactionInput[])[];
        policyMaterial?: TbcReviewedPolicyMaterial;
    }>>;
}
