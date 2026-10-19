export interface PoolApprovalTransaction {
    readonly id: string;
    readonly role: string;
    readonly dependsOn: readonly string[];
    readonly fee: string;
    readonly unsignedTransaction: string;
}
export interface PoolApprovalUtxo {
    readonly txid: string;
    readonly vout: number;
    readonly classification: string;
    readonly contractId?: string;
    readonly satoshis: string;
    readonly scriptPubKey: string;
}
export interface PoolApprovalBinding {
    readonly bindingHash: string;
    readonly payload: Readonly<{
        readonly expiresAt: string;
    }>;
}
/** Exact material membership; ordering and repeated references are immaterial. */
export declare function containsCanonicalEvidence(current: readonly unknown[], expected: readonly unknown[]): boolean;
/** Bounded Pool removal recipe: one FTLP maintenance prefix, then its dependent primary. */
export declare function collectPoolRemoveInputEvidence(transactions: readonly Readonly<PoolApprovalTransaction>[], utxos: readonly Readonly<PoolApprovalUtxo>[], poolContractId: string): Readonly<{
    readonly inputOutpoints: readonly string[];
    readonly externalOutpoints: readonly string[];
}>;
/** One-entry, approval-scoped ancestry read; never a durable authorization. */
export declare function createPoolRemoveApprovalMaterialReader<T>(load: (input: Readonly<{
    readonly address: string;
    readonly receiver: string;
    readonly poolContractId: string;
    readonly lpAmount: string;
}>) => Promise<T>, now?: () => number): (binding: Readonly<PoolApprovalBinding>, input: Readonly<{
    readonly address: string;
    readonly receiver: string;
    readonly poolContractId: string;
    readonly lpAmount: string;
}>) => Promise<T>;
/** Read-only single-flight; full binding + exact request, never beyond expiry. */
export declare function createPoolApprovalMaterialReader<T, I>(load: (input: I) => Promise<T>, now?: () => number): (binding: Readonly<PoolApprovalBinding>, input: I) => Promise<T>;
/** Fresh confirmations can grow; the approved immutable input identity cannot. */
export declare function matchesCurrentPoolUtxoEvidence(planned: Readonly<{
    readonly confirmations?: string;
}>, current: Readonly<{
    readonly confirmations?: string;
}>, policy?: Readonly<{
    readonly minConfirmations: string;
}>): boolean;
export declare function collectTransactionInputOutpoints(transactions: readonly Readonly<{
    readonly unsignedTransaction: string;
}>[]): readonly string[];
