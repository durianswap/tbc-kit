import { TwsEngineError } from "./errors.js";
import { canonicalize } from "./canonical-json.js";
import { resolveTransactionSigningAccounts, type TransactionRoleAccount, type TransactionRoleRequest } from "./transaction-signing-roles.js";

export type ReviewedRoleRequest = TransactionRoleRequest & Readonly<{ request: Readonly<Record<string, unknown>> }>;

/** Request markers choose a role, never a public key or an authorization grant.
 * Code/asset semantics are independently checked by the shared reviewer/Engine.
 */
export function resolveReviewedSigningRoles(request: ReviewedRoleRequest, accounts: readonly TransactionRoleAccount[]) {
  const payload = request.request.payload as Readonly<{
    format?: unknown;
    sourceInputs?: readonly Readonly<{ signingProfile?: unknown; signingRole?: unknown }>[];
    children?: readonly Readonly<{ inputs: readonly Readonly<{ signingProfile?: unknown; signingRole?: unknown }>[] }>[];
    transactions?: readonly Readonly<{ inputs: readonly Readonly<{ signingRole?: unknown }>[] }>[];
  }> | undefined;
  const inputs = payload?.format === "associated"
    ? [...(payload.sourceInputs ?? []), ...(payload.children ?? []).flatMap(child => child.inputs)]
    : payload?.format === "raw" ? (payload.transactions ?? []).flatMap(transaction => transaction.inputs) : [];
  const marked = inputs.filter(input => input.signingRole !== undefined);
  if (marked.some(input => input.signingRole !== "coin-admin" ||
        (payload?.format === "associated" && Reflect.get(input, "signingProfile") !== "tbc20-stablecoin")) ||
      request.signingRoles?.some(role => role.role !== "coin-admin") ||
      (request.signingRoles !== undefined && marked.length === 0)) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "Invalid Reviewed signing role scope");
  }
  if (marked.length === 0) return undefined;
  const roles = request.signingRoles ?? [{ role: "coin-admin" as const, accountId: `${request.chainId}:${request.from}` }];
  return resolveTransactionSigningAccounts({ ...request, signingRoles: roles }, accounts).roles;
}

/** The review result cannot invent a role or substitute another granted account. */
export function assertReviewedSigningRolePreview(request: ReviewedRoleRequest, accounts: readonly TransactionRoleAccount[], preview: Readonly<Record<string, unknown>>) {
  const roles = resolveReviewedSigningRoles(request, accounts);
  if (canonicalize(preview.signingRoles ?? []) !== canonicalize(roles ?? [])) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "Reviewed preview replaced its trusted signing roles");
  }
  return roles;
}
