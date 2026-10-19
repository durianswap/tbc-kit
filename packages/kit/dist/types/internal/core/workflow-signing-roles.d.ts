import { type TransactionRoleAccount, type TransactionRoleRequest } from "./transaction-signing-roles.js";
export interface WorkflowRoleRequest {
    readonly chainId: string;
    readonly from: string;
    readonly steps: readonly Readonly<{
        id: string;
        kind: string;
        signingRoles?: TransactionRoleRequest["signingRoles"];
    }>[];
}
/** Ordered, deduplicated lookup set. This is not an account permission grant. */
export declare function workflowSigningAccountIds(request: WorkflowRoleRequest): readonly string[];
/** Preserve each step's role selection while sharing one trusted account lookup. */
export declare function resolveWorkflowSigningAccounts(request: WorkflowRoleRequest, accounts: readonly TransactionRoleAccount[]): Readonly<{
    primary: TransactionRoleAccount;
    additional: readonly Readonly<{
        chainId: string;
        accountId: string;
        address: string;
        publicKey: string;
    }>[];
    steps: readonly Readonly<{
        stepId: string;
        roles: readonly Readonly<{
            role: "pool-controller" | "coin-admin";
            account: TransactionRoleAccount;
        }>[];
    }>[];
}>;
