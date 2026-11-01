import type { TbcReviewedPolicyMaterial } from "./reviewed-transaction-types.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import { type CreateTbcOfficialApiOptions } from "./official-api.js";
import { type TbcNetworkContext } from "./network-context.js";
import { type LegacyAssociatedTransactionExecutor, type LegacyAssociatedTransactionService } from "./legacy-associated-transaction.js";
export type LegacySecureOperationKind = "signTransaction" | "signAssociatedTransaction" | "encrypt" | "decrypt";
export interface LegacySecureOperationContext {
    readonly origin: string;
    readonly chainId: string;
    readonly accountId: string;
    readonly sessionId: string;
    readonly navigationId: string;
}
export interface LegacySecureOperationBinding<TRequest = unknown> {
    readonly version: "1.0";
    readonly operationKind: LegacySecureOperationKind;
    readonly bindingHash: string;
    readonly requestHash: string;
    readonly context: LegacySecureOperationContext;
    readonly request: TRequest;
    readonly review?: LegacyRawTransactionReview | LegacyAssociatedTransactionReview;
}
export interface LegacySecureOperationAuthority {
    /** Fails unless this exact origin/account/session/navigation is still current. */
    readonly assertCurrent: (context: LegacySecureOperationContext) => Promise<void>;
}
/**
 * Internal boundary marker for a well-formed Legacy transport request whose
 * operation payload or reviewed material is invalid. The WebView adapter may
 * translate this into the historical `{ error }` result without treating it
 * as a transport-integrity failure.
 */
export declare class LegacySecureOperationRequestValidationError extends Error {
    readonly code = "LEGACY_SECURE_OPERATION_REQUEST_INVALID";
    constructor(cause: unknown);
}
export type LegacySecureOperationApprovalDecision = Readonly<{
    status: "approved";
    bindingHash: string;
    approvalId: string;
}> | Readonly<{
    status: "rejected";
    bindingHash: string;
}>;
export interface LegacySecureOperationApproval {
    /** Must present this exact operation. Legacy secure operations never reuse a grant. */
    readonly request: <TRequest>(binding: LegacySecureOperationBinding<TRequest>) => Promise<LegacySecureOperationApprovalDecision>;
}
export type LegacySecureOperationOutcome<TResult> = Readonly<{
    status: "approved";
    result: TResult;
}> | Readonly<{
    status: "rejected";
}>;
export type LegacyRawTransactionRequest = Readonly<{
    txraws: readonly string[];
    utxos_satoshis: readonly (readonly number[])[];
    script_pubkeys: readonly (readonly string[])[];
}>;
export type LegacyRawTransactionResult = Readonly<{
    sigs: readonly (readonly string[])[];
}>;
export type LegacyRawTransactionReview = Readonly<{
    version: "1.0";
    policy: "recognized-asset-flows";
    requestHash: string;
    previewHash: string;
    materialHash: string;
    policyMaterial: TbcReviewedPolicyMaterial;
    preview: Readonly<Record<string, unknown>>;
}>;
export type LegacyAssociatedTransactionReview = Readonly<{
    version: "1.0";
    policy: "recognized-associated-asset-flows";
    operationDigest: string;
    requestHash: string;
    previewHash: string;
    materialHash: string;
    policyMaterial: TbcReviewedPolicyMaterial;
    preview: Readonly<Record<string, unknown>>;
}>;
export interface LegacyAssociatedTransactionReviewer {
    readonly review: (input: Readonly<{
        request: Readonly<Record<string, unknown>>;
        operationDigest: string;
        context: LegacySecureOperationContext;
    }>) => Promise<Readonly<{
        preview: unknown;
        policyMaterial?: TbcReviewedPolicyMaterial;
        verifiedInputs: readonly (readonly Readonly<{
            txid: string;
            vout: number;
            satoshis: number;
            scriptPubKey: string;
            spent: false;
        }>[])[];
    }>>;
}
export interface LegacyAssociatedTransactionSigningService {
    readonly sign: (request: unknown, context: LegacySecureOperationContext) => Promise<LegacySecureOperationOutcome<Readonly<{
        txraws: readonly string[];
    }>>>;
}
export interface LegacyRawTransactionReviewer {
    /**
     * Shared transaction preview/parser. `verifiedInputs` must come from trusted
     * current material (normally one batched official TXO read), never page data.
     */
    readonly review: (input: Readonly<{
        request: LegacyRawTransactionRequest;
        context: LegacySecureOperationContext;
        transactionIds: readonly string[];
    }>) => Promise<Readonly<{
        preview: unknown;
        policyMaterial?: TbcReviewedPolicyMaterial;
        verifiedInputs: readonly (readonly Readonly<{
            txid: string;
            vout: number;
            satoshis: number;
            scriptPubKey: string;
            spent: false;
        }>[])[];
    }>>;
}
export interface LegacyRawTransactionSigningService {
    readonly sign: (request: unknown, context: LegacySecureOperationContext) => Promise<LegacySecureOperationOutcome<LegacyRawTransactionResult>>;
}
export interface LegacyRawTransactionSigner {
    /** Wallet-private execution. Keys and native handles never enter this input. */
    readonly sign: (input: Readonly<{
        binding: LegacySecureOperationBinding<LegacyRawTransactionRequest>;
        approval: Extract<LegacySecureOperationApprovalDecision, {
            status: "approved";
        }>;
    }>) => Promise<unknown>;
}
export type LegacyCryptoRequest = Readonly<{
    message: string;
}>;
export type LegacyEncryptResult = Readonly<{
    encryptedMessage: string;
}>;
export type LegacyDecryptResult = Readonly<{
    decryptedMessage: string;
}>;
export interface LegacyCryptoService {
    readonly encrypt: (request: unknown, context: LegacySecureOperationContext) => Promise<LegacySecureOperationOutcome<LegacyEncryptResult>>;
    readonly decrypt: (request: unknown, context: LegacySecureOperationContext) => Promise<LegacySecureOperationOutcome<LegacyDecryptResult>>;
}
export interface LegacyCryptoAdapter {
    /** Wallet-private ECIES/native execution. No private material is returned to Kit. */
    readonly encrypt: (input: Readonly<{
        binding: LegacySecureOperationBinding<LegacyCryptoRequest>;
        approval: Extract<LegacySecureOperationApprovalDecision, {
            status: "approved";
        }>;
    }>) => Promise<unknown>;
    readonly decrypt: (input: Readonly<{
        binding: LegacySecureOperationBinding<LegacyCryptoRequest>;
        approval: Extract<LegacySecureOperationApprovalDecision, {
            status: "approved";
        }>;
    }>) => Promise<unknown>;
}
export interface LegacyTbcBalanceReader {
    readonly chainId: string;
    readonly networkSourceIdentity: string;
    readonly read: (address: string) => Promise<Readonly<{
        tbc: number;
    }>>;
}
export declare function normalizeLegacyRawTransactionRequest(input: unknown): LegacyRawTransactionRequest;
export declare function normalizeLegacyRawTransactionResult(input: unknown, request: LegacyRawTransactionRequest): LegacyRawTransactionResult;
export declare function createLegacyRawTransactionSigningService(options: Readonly<{
    approval: LegacySecureOperationApproval;
    authority: LegacySecureOperationAuthority;
    reviewer: LegacyRawTransactionReviewer;
    signer: LegacyRawTransactionSigner;
    materialNative?: PoolMaterialNativeProviderInput;
}>): LegacyRawTransactionSigningService;
export declare function createLegacyAssociatedTransactionSigningService(options: Readonly<{
    approval: LegacySecureOperationApproval;
    authority: LegacySecureOperationAuthority;
    reviewer: LegacyAssociatedTransactionReviewer;
    transactions: Pick<LegacyAssociatedTransactionService, "prepare" | "readRequest" | "read" | "complete">;
    executor: LegacyAssociatedTransactionExecutor;
    materialNative?: PoolMaterialNativeProviderInput;
}>): LegacyAssociatedTransactionSigningService;
export declare function createLegacyCryptoService(options: Readonly<{
    approval: LegacySecureOperationApproval;
    authority: LegacySecureOperationAuthority;
    adapter: LegacyCryptoAdapter;
}>): LegacyCryptoService;
export declare function createLegacyTbcBalanceReader(options: Omit<CreateTbcOfficialApiOptions, "baseUrl" | "network" | "allowedOrigins"> & Readonly<{
    network: TbcNetworkContext;
}>): LegacyTbcBalanceReader;
