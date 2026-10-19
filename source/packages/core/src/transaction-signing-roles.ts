import { canonicalize } from "./canonical-json.js";
import { TwsEngineError } from "./errors.js";

export interface TransactionRoleAccount {
  readonly chainId: string;
  readonly accountId: string;
  readonly address: string;
  readonly publicKey: string;
}
export interface TransactionRoleRequest {
  readonly chainId: string;
  readonly from: string;
  readonly signingRoles?: readonly Readonly<{ role: "pool-controller" | "coin-admin"; accountId: string }>[] | undefined;
}
export interface ResolvedTransactionSigningRole {
  readonly role: "pool-controller" | "coin-admin";
  readonly account: TransactionRoleAccount;
}
function conflict(message: string): never {
  throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", message);
}
function identity(account: TransactionRoleAccount): TransactionRoleAccount {
  if (account.accountId !== `${account.chainId}:${account.address}` || !/^0[23][0-9a-f]{64}$/u.test(account.publicKey)) {
    return conflict("Invalid signing role account identity");
  }
  return Object.freeze({ chainId: account.chainId, accountId: account.accountId, address: account.address, publicKey: account.publicKey });
}
export function transactionSigningAccountIds(request: TransactionRoleRequest): readonly string[] {
  const primary = `${request.chainId}:${request.from}`;
  const roles = request.signingRoles;
  if (roles === undefined) return Object.freeze([primary]);
  if (roles.length !== 1 || (roles[0]?.role !== "pool-controller" && roles[0]?.role !== "coin-admin") ||
      !roles[0].accountId.startsWith(`${request.chainId}:`) || roles[0].accountId.length <= request.chainId.length + 1) {
    return conflict("Invalid or cross-chain signing role selection");
  }
  return Object.freeze([...new Set([primary, roles[0].accountId])]);
}

/** Local identity binding, not a permission grant or a private-key lookup. */
export function resolveTransactionSigningAccounts(request: TransactionRoleRequest, accounts: readonly TransactionRoleAccount[]) {
  const selected = transactionSigningAccountIds(request).map(accountId => {
    const candidates = accounts.filter(account => account.accountId === accountId && account.chainId === request.chainId);
    if (candidates.length !== 1) return conflict("Required signing account is missing or ambiguous");
    return identity(candidates[0]!);
  });
  if (new Set(selected.map(account => account.publicKey.slice(2))).size !== selected.length) {
    return conflict("Signing public key is ambiguous across accounts");
  }
  const roles = Object.freeze((request.signingRoles ?? []).map(({ role, accountId }) => Object.freeze({
    role, account: selected.find(account => account.accountId === accountId)!,
  })));
  return Object.freeze({ primary: selected[0]!, additional: Object.freeze(selected.slice(1)), roles });
}

/** Chain Data may report observations, never replace accounts resolved by Host. */
export function assertTransactionSigningSnapshot(
  request: TransactionRoleRequest,
  trustedAccounts: readonly TransactionRoleAccount[],
  snapshot: Readonly<{ chainId: string; account: TransactionRoleAccount; signingAccounts?: readonly TransactionRoleAccount[] }>,
): void {
  const resolved = resolveTransactionSigningAccounts(request, trustedAccounts);
  if (snapshot.chainId !== request.chainId || canonicalize(identity(snapshot.account)) !== canonicalize(resolved.primary) ||
      canonicalize((snapshot.signingAccounts ?? []).map(identity)) !== canonicalize(resolved.additional) ||
      (snapshot.signingAccounts !== undefined && snapshot.signingAccounts.length === 0)) {
    conflict("Chain snapshot replaced the trusted signing accounts");
  }
}

export function assertTransactionRoleTasks(
  request: TransactionRoleRequest,
  trustedAccounts: readonly TransactionRoleAccount[],
  tasks: readonly Readonly<{ accountId?: unknown; publicKey?: unknown }>[],
): void {
  const resolved = resolveTransactionSigningAccounts(request, trustedAccounts);
  const accounts = [resolved.primary, ...resolved.additional];
  for (const task of tasks) {
    if (!accounts.some(account => task.accountId === account.accountId &&
        (task.publicKey === account.publicKey || task.publicKey === account.publicKey.slice(2)))) {
      conflict("Signing task is not bound to an authorized role account");
    }
  }
}
