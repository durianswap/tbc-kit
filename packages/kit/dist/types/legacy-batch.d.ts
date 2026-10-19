/** Canonical request-list facts only; this is not approval or signer authority. */
export interface LegacyBatchRequestScope {
    readonly source: string;
    readonly recipient: string;
    readonly kind: "native" | "ft" | "pool-add" | "pool-remove" | "ft-create" | "pool-mint" | "pool-initialize";
    readonly amount: string;
    readonly contractId?: string;
    readonly attachedTbcAtomic: string;
    readonly feeCapAtomic: string;
    readonly poolIntent?: Readonly<Record<string, unknown>>;
    readonly createIntent?: Readonly<Record<string, unknown>>;
    readonly method?: "tbc_sendTransaction";
    readonly transactionCount?: 1 | 2;
}
export declare function createLegacyBatchRequestScope(params: unknown, source: string): LegacyBatchRequestScope;
/** FT decimals must come from the wallet's verified metadata resolver. */
export declare function matchesLegacyBatchRequest(scope: LegacyBatchRequestScope, params: Readonly<Record<string, unknown>>, ftDecimals?: number): boolean;
export declare function withLegacyDependentTxids(params: unknown, txids: readonly string[], field?: string): Readonly<{
    message: string;
    encoding: "utf8";
}> | undefined;
