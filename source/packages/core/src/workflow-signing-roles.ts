import { TwsEngineError } from "./errors.js";
import {
  resolveTransactionSigningAccounts, transactionSigningAccountIds,
  type TransactionRoleAccount, type TransactionRoleRequest,
} from "./transaction-signing-roles.js";

export interface WorkflowRoleRequest {
  readonly chainId: string;
  readonly from: string;
  readonly steps: readonly Readonly<{
    id: string;
    kind: string;
    signingRoles?: TransactionRoleRequest["signingRoles"];
  }>[];
}

function roleSteps(request: WorkflowRoleRequest) {
  const ids = new Set<string>();
  if (request.steps.length < 1 || request.steps.length > 5) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "Invalid workflow signing scope");
  }
  for (const step of request.steps) {
    if (ids.has(step.id) || (step.signingRoles !== undefined &&
        step.kind !== "transaction" && step.kind !== "preparedTransaction" && step.kind !== "reviewedTransaction") ||
        (step.kind === "reviewedTransaction" && step.signingRoles?.some(role => role.role !== "coin-admin"))) {
      throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "Invalid workflow signing role step");
    }
    ids.add(step.id);
  }
  return request.steps.filter(step => step.signingRoles !== undefined);
}

/** Ordered, deduplicated lookup set. This is not an account permission grant. */
export function workflowSigningAccountIds(request: WorkflowRoleRequest): readonly string[] {
  const ids = new Set([`${request.chainId}:${request.from}`]);
  for (const step of roleSteps(request)) {
    for (const id of transactionSigningAccountIds({
      chainId: request.chainId, from: request.from, signingRoles: step.signingRoles,
    })) ids.add(id);
  }
  return Object.freeze([...ids]);
}

/** Preserve each step's role selection while sharing one trusted account lookup. */
export function resolveWorkflowSigningAccounts(request: WorkflowRoleRequest, accounts: readonly TransactionRoleAccount[]) {
  const requiredIds = workflowSigningAccountIds(request);
  const primary = resolveTransactionSigningAccounts(request, accounts).primary;
  const steps = roleSteps(request).map(step => {
    const resolved = resolveTransactionSigningAccounts({
      chainId: request.chainId, from: request.from, signingRoles: step.signingRoles,
    }, accounts);
    return Object.freeze({ stepId: step.id, roles: resolved.roles });
  });
  const selected = requiredIds.map(id => accounts.find(account => account.accountId === id && account.chainId === request.chainId)!);
  // Two controllers from different steps must not alias the same signing key.
  if (new Set(selected.map(account => account.publicKey.slice(2))).size !== selected.length) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "Workflow signing key is ambiguous across accounts");
  }
  return Object.freeze({ primary, additional: Object.freeze(selected.slice(1).map(account => Object.freeze({
    chainId: account.chainId, accountId: account.accountId, address: account.address, publicKey: account.publicKey,
  }))), steps: Object.freeze(steps) });
}
