import { type TransactionRoleAccount, type TransactionRoleRequest } from "./transaction-signing-roles.js";
export type ReviewedRoleRequest = TransactionRoleRequest & Readonly<{
    request: Readonly<Record<string, unknown>>;
}>;
/** Request markers choose a role, never a public key or an authorization grant.
 * Code/asset semantics are independently checked by the shared reviewer/Engine.
 */
export declare function resolveReviewedSigningRoles(request: ReviewedRoleRequest, accounts: readonly TransactionRoleAccount[]): readonly Readonly<{
    role: "pool-controller" | "coin-admin";
    account: TransactionRoleAccount;
}>[] | undefined;
/** The review result cannot invent a role or substitute another granted account. */
export declare function assertReviewedSigningRolePreview(request: ReviewedRoleRequest, accounts: readonly TransactionRoleAccount[], preview: Readonly<Record<string, unknown>>): readonly Readonly<{
    role: "pool-controller" | "coin-admin";
    account: TransactionRoleAccount;
}>[] | undefined;
