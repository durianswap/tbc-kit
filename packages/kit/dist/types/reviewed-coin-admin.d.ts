import { type ResolvedTransactionSigningRole } from "./internal/core/index.js";
import { type ReviewedTokenCode } from "./reviewed-token.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TbcReviewedTransactionRequest } from "./reviewed-transaction-types.js";
export declare function reviewedCoinAdministrator(roles: readonly ResolvedTransactionSigningRole[], chainId: string, addressVersion: number): string;
/** Code identity is already decoded by the shared exact-template inspector.
 * No role flag or indexer label substitutes for this committed key hash. */
export declare function reviewedCoinAdminKey(code: ReviewedTokenCode | null | undefined, publicKey: string): string;
/** Bind raw input role markers to actual Code using the same trusted role key.
 * No script assembly, chain read or custody. Null cells retain the fee/holder. */
export declare function bindReviewedRawCoinAdminMaterial(input: Readonly<{
    request: TbcReviewedTransactionRequest;
    inputRoles: readonly (readonly unknown[])[];
    publicKey: string;
    native: PoolMaterialNativeProviderInput;
}>): Promise<TbcReviewedTransactionRequest>;
/** Internal normalized associated material, not a public signing endpoint.
 * Role selections came from Core's trusted account resolution. This snapshots
 * public material, authenticates the Code, and derives the exact key encoding
 * used by the existing keyless proof. No HTTP, private key or state store.
 */
export declare function bindReviewedCoinAdminMaterial(input: Readonly<{
    request: Readonly<Record<string, unknown>>;
    publicKey: string;
    native: PoolMaterialNativeProviderInput;
}>): Promise<Readonly<Record<string, unknown>>>;
//# sourceMappingURL=reviewed-coin-admin.d.ts.map