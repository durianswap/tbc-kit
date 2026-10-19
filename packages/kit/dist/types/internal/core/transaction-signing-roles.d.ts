export interface TransactionRoleAccount {
    readonly chainId: string;
    readonly accountId: string;
    readonly address: string;
    readonly publicKey: string;
}
export interface TransactionRoleRequest {
    readonly chainId: string;
    readonly from: string;
    readonly signingRoles?: readonly Readonly<{
        role: "pool-controller" | "coin-admin";
        accountId: string;
    }>[] | undefined;
}
export interface ResolvedTransactionSigningRole {
    readonly role: "pool-controller" | "coin-admin";
    readonly account: TransactionRoleAccount;
}
export declare function transactionSigningAccountIds(request: TransactionRoleRequest): readonly string[];
/** Local identity binding, not a permission grant or a private-key lookup. */
export declare function resolveTransactionSigningAccounts(request: TransactionRoleRequest, accounts: readonly TransactionRoleAccount[]): Readonly<{
    primary: TransactionRoleAccount;
    additional: readonly TransactionRoleAccount[];
    roles: readonly Readonly<{
        role: "pool-controller" | "coin-admin";
        account: TransactionRoleAccount;
    }>[];
}>;
/** Chain Data may report observations, never replace accounts resolved by Host. */
export declare function assertTransactionSigningSnapshot(request: TransactionRoleRequest, trustedAccounts: readonly TransactionRoleAccount[], snapshot: Readonly<{
    chainId: string;
    account: TransactionRoleAccount;
    signingAccounts?: readonly TransactionRoleAccount[];
}>): void;
export declare function assertTransactionRoleTasks(request: TransactionRoleRequest, trustedAccounts: readonly TransactionRoleAccount[], tasks: readonly Readonly<{
    accountId?: unknown;
    publicKey?: unknown;
}>[]): void;
