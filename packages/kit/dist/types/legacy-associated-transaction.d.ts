export type LegacyAssociatedTransactionResult = Readonly<{
    txraws: readonly string[];
}>;
export interface LegacyAssociatedTransactionExecutor {
    /**
     * Wallet-private execution after the controller has received an explicit
     * approval. The operation digest and public request are the only values that
     * cross this boundary; key material stays inside the platform bridge.
     */
    readonly execute: (input: Readonly<{
        operationDigest: string;
        request: Readonly<Record<string, unknown>>;
    }>) => Promise<unknown>;
}
export type LegacyAssociatedTransactionJournalRecord = Readonly<{
    operationDigest: string;
    state: "prepared" | "completed";
    requestJson: string;
    resultDigest: string | null;
    resultJson: string | null;
}>;
/**
 * Wallet/platform-owned durable storage. Implementations must make prepare and
 * complete atomic and return either the inserted record or the exact existing
 * record. Kit validates every returned byte before using it.
 */
export interface LegacyAssociatedTransactionJournal {
    readonly read: (operationDigest: string) => Promise<LegacyAssociatedTransactionJournalRecord | null>;
    readonly prepare: (record: LegacyAssociatedTransactionJournalRecord) => Promise<LegacyAssociatedTransactionJournalRecord>;
    readonly complete: (record: LegacyAssociatedTransactionJournalRecord) => Promise<LegacyAssociatedTransactionJournalRecord>;
}
export interface LegacyAssociatedTransactionService {
    readonly prepare: (request: unknown) => Promise<Readonly<{
        operationDigest: string;
        transactionCount: number;
    }>>;
    /** Read the validated public transaction material for a wallet-private Signer. */
    readonly readRequest: (operationDigest: string) => Promise<Readonly<Record<string, unknown>> | null>;
    /** Validate and durably record output produced by the wallet-private Signer. */
    readonly complete: (operationDigest: string, result: unknown) => Promise<LegacyAssociatedTransactionResult>;
    readonly read: (operationDigest: string) => Promise<LegacyAssociatedTransactionResult | null>;
}
export declare class LegacyAssociatedTransactionConflictError extends Error {
    readonly name = "LegacyAssociatedTransactionConflictError";
}
export declare function normalizeLegacyAssociatedTransactionRequest(request: unknown): Readonly<Record<string, unknown>>;
export declare function normalizeLegacyAssociatedTransactionResult(result: unknown): LegacyAssociatedTransactionResult;
/**
 * Shared associated-transaction preparation and result service. It never
 * accepts a private key or scalar and never invokes a native signer.
 */
export declare function createLegacyAssociatedTransactionService(options: Readonly<{
    journal: LegacyAssociatedTransactionJournal;
}>): LegacyAssociatedTransactionService;
//# sourceMappingURL=legacy-associated-transaction.d.ts.map