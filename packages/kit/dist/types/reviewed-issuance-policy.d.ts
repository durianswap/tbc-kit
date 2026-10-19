import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TbcReviewedPolicyMaterial, TbcReviewedTransactionRequest } from "./reviewed-transaction-types.js";
/** Strict snapshot for a review/approval hash. Empty is sufficient only where
 * all required outputs are already present in the bound transaction request. */
export declare function normalizeReviewedPolicyMaterial(value: unknown): TbcReviewedPolicyMaterial;
/** Recheck a concrete normalized request at the Standard execution boundary.
 * Supplemental material cannot replace an input committed by that request. */
export declare function requireBoundReviewedPolicy(native: PoolMaterialNativeProviderInput, request: TbcReviewedTransactionRequest, material: TbcReviewedPolicyMaterial): Promise<void>;
type PolicyOutput = Readonly<{
    txid: string;
    vout: number;
    satoshis: number;
    scriptPubKey: string;
}>;
/** Wallet-side policy only. Reuses authenticated review material; performs no
 * HTTP, signing or persistence and does not grant asset/approval authority.
 * The Rust checker resolves earlier batch outputs itself, so external material
 * must never shadow a transaction in the batch. Caller must separately bind
 * these exact transactions/material to execution and recheck rebound children. */
export declare function requireReviewedIssuancePolicy(native: PoolMaterialNativeProviderInput, transactions: readonly Readonly<{
    rawTransaction: string;
    txid: string;
}>[], outputs: readonly PolicyOutput[]): Promise<void>;
export {};
