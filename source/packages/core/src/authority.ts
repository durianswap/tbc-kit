import { canonicalize } from "./canonical-json.js";

export type AuthorityChangeReason =
  | "SESSION_REVOKED"
  | "ORIGIN_CHANGED"
  | "NAVIGATION_CHANGED"
  | "CHAIN_CHANGED"
  | "ACCOUNT_CHANGED";

export type TwsAuthorityErrorCode =
  | "AUTHORITY_INVALID"
  | "AUTHORITY_CHANGED"
  | "COMMIT_ACK_MISMATCH"
  | "COMMIT_AUTHORITY_MISMATCH";

export class TwsAuthorityError extends Error {
  readonly code: TwsAuthorityErrorCode;
  readonly reason?: AuthorityChangeReason;

  constructor(
    code: TwsAuthorityErrorCode,
    message: string,
    reason?: AuthorityChangeReason,
  ) {
    super(message);
    this.name = "TwsAuthorityError";
    this.code = code;
    if (reason !== undefined) this.reason = reason;
  }
}

interface TrustedContextRecord {
  readonly sessionId: string;
  readonly transport: string;
  readonly origin: string;
  readonly topOrigin: string;
  readonly frame: string;
  readonly navigationId?: string;
  readonly createdAt: string;
}

interface ProviderSessionStateRecord {
  readonly version: string;
  readonly sessionId: string;
  readonly revision: string;
  readonly connected: boolean;
  readonly activeChainId: string;
  readonly activeAccountIds: readonly string[];
}

interface ProviderSessionSnapshotRecord {
  readonly version: string;
  readonly scope: {
    readonly walletProfile: string;
    readonly sessionId: string;
  };
  readonly state: ProviderSessionStateRecord;
}

function invalid(message: string): never {
  throw new TwsAuthorityError("AUTHORITY_INVALID", message);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSession(snapshot: unknown): asserts snapshot is ProviderSessionSnapshotRecord {
  if (!isRecord(snapshot) || snapshot.version !== "1.0") {
    invalid("Provider Session snapshot is invalid");
  }
  const scope = snapshot.scope;
  const state = snapshot.state;
  if (!isRecord(scope) || !isRecord(state)) {
    invalid("Provider Session scope or state is missing");
  }
  if (
    typeof scope.sessionId !== "string" ||
    typeof scope.walletProfile !== "string" ||
    typeof state.sessionId !== "string" ||
    scope.sessionId !== state.sessionId
  ) {
    invalid("Provider Session scope and state do not bind the same session");
  }
  if (
    typeof state.activeChainId !== "string" ||
    !Array.isArray(state.activeAccountIds) ||
    state.activeAccountIds.length > 16 ||
    state.activeAccountIds.some((accountId) => typeof accountId !== "string")
  ) {
    invalid("Provider Session active accounts are invalid");
  }
  if (new Set(state.activeAccountIds).size !== state.activeAccountIds.length) {
    invalid("Provider Session active accounts contain duplicates");
  }
  if (!sameJson([...state.activeAccountIds].sort(), state.activeAccountIds)) {
    invalid("Provider Session active accounts are not sorted");
  }
  if (
    state.activeAccountIds.some(
      (accountId) => !accountId.startsWith(`${state.activeChainId}:`),
    )
  ) {
    invalid("Provider Session active account belongs to another chain");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(String(state.revision))) {
    invalid("Provider Session revision is not canonical decimal");
  }
  if (typeof state.connected !== "boolean") {
    invalid("Provider Session connected state is invalid");
  }
}

function validateContext(
  context: unknown,
  enforceTopFrameOrigin: boolean,
): asserts context is TrustedContextRecord {
  if (!isRecord(context)) invalid("Trusted Context is invalid");
  if (
    typeof context.sessionId !== "string" ||
    typeof context.transport !== "string" ||
    typeof context.origin !== "string" ||
    typeof context.topOrigin !== "string" ||
    typeof context.frame !== "string" ||
    typeof context.createdAt !== "string"
  ) {
    invalid("Trusted Context fields are invalid");
  }
  if (
    enforceTopFrameOrigin &&
    context.frame === "top" &&
    context.origin !== context.topOrigin
  ) {
    invalid("Top-frame origin must equal topOrigin");
  }
}

export function validateAuthoritySnapshot(
  context: unknown,
  session: unknown,
): asserts context is TrustedContextRecord {
  validateContext(context, true);
  validateSession(session);
  if (context.sessionId !== session.scope.sessionId) {
    invalid("Trusted Context and Provider Session do not bind the same session");
  }
}

export function classifyAuthorityChange(
  expectedContextValue: unknown,
  expectedSessionValue: unknown,
  currentContextValue: unknown,
  currentSessionValue: unknown,
): AuthorityChangeReason | null {
  validateAuthoritySnapshot(expectedContextValue, expectedSessionValue);
  validateContext(currentContextValue, false);
  validateSession(currentSessionValue);
  const expectedContext = expectedContextValue as TrustedContextRecord;
  const currentContext = currentContextValue as TrustedContextRecord;
  const expectedSession = expectedSessionValue as ProviderSessionSnapshotRecord;
  const currentSession = currentSessionValue as ProviderSessionSnapshotRecord;

  if (
    expectedContext.sessionId !== currentContext.sessionId ||
    !sameJson(expectedSession.scope, currentSession.scope) ||
    expectedSession.state.sessionId !== currentSession.state.sessionId ||
    expectedSession.state.connected !== currentSession.state.connected ||
    expectedContext.transport !== currentContext.transport ||
    expectedContext.createdAt !== currentContext.createdAt
  ) {
    return "SESSION_REVOKED";
  }
  if (
    expectedContext.origin !== currentContext.origin ||
    expectedContext.topOrigin !== currentContext.topOrigin ||
    expectedContext.frame !== currentContext.frame
  ) {
    return "ORIGIN_CHANGED";
  }
  if (expectedContext.navigationId !== currentContext.navigationId) {
    return "NAVIGATION_CHANGED";
  }
  if (expectedSession.state.activeChainId !== currentSession.state.activeChainId) {
    return "CHAIN_CHANGED";
  }
  if (
    !sameJson(
      expectedSession.state.activeAccountIds,
      currentSession.state.activeAccountIds,
    )
  ) {
    return "ACCOUNT_CHANGED";
  }
  if (expectedSession.state.revision !== currentSession.state.revision) {
    return "SESSION_REVOKED";
  }
  return null;
}

export function assertAuthorityUnchanged(
  expectedContext: unknown,
  expectedSession: unknown,
  currentContext: unknown,
  currentSession: unknown,
): void {
  const reason = classifyAuthorityChange(
    expectedContext,
    expectedSession,
    currentContext,
    currentSession,
  );
  if (reason !== null) {
    throw new TwsAuthorityError(
      "AUTHORITY_CHANGED",
      `Provider authority changed: ${reason}`,
      reason,
    );
  }
}

export function assertProviderCommitAcknowledgment(
  mutationValue: unknown,
  acknowledgmentValue: unknown,
  currentSessionValue: unknown,
): void {
  if (!isRecord(mutationValue) || !isRecord(mutationValue.payload)) {
    invalid("Provider Session mutation is invalid");
  }
  if (!isRecord(acknowledgmentValue)) {
    throw new TwsAuthorityError("COMMIT_ACK_MISMATCH", "Commit Ack is invalid");
  }
  validateSession(currentSessionValue);
  const mutation = mutationValue as {
    readonly commitId: string;
    readonly payload: {
      readonly scope: unknown;
      readonly target: unknown;
    };
  };
  const acknowledgment = acknowledgmentValue as {
    readonly version?: unknown;
    readonly commitId?: unknown;
    readonly status?: unknown;
    readonly revision?: unknown;
  };
  const target = mutation.payload.target as ProviderSessionStateRecord;
  if (
    acknowledgment.version !== "1.0" ||
    acknowledgment.status !== "committed" ||
    acknowledgment.commitId !== mutation.commitId ||
    acknowledgment.revision !== target.revision
  ) {
    throw new TwsAuthorityError(
      "COMMIT_ACK_MISMATCH",
      "Commit Ack does not bind the mutation target",
    );
  }
  if (
    !sameJson(currentSessionValue.scope, mutation.payload.scope) ||
    !sameJson(currentSessionValue.state, target)
  ) {
    throw new TwsAuthorityError(
      "COMMIT_AUTHORITY_MISMATCH",
      "Current Provider Session does not equal the committed target",
    );
  }
}
