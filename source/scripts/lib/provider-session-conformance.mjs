import { createHash } from "node:crypto";
import { canonicalize } from "./canonical-json.mjs";
import { readJson } from "./repository.mjs";

const NUL = Buffer.from([0]);
const DETERMINISTIC_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

function utf8(value) {
  return Buffer.from(value, "utf8");
}

function sameJson(left, right) {
  return canonicalize(left) === canonicalize(right);
}

function violation(name) {
  throw new Error(name);
}

function assertMutationBinding(input, mutation) {
  if (deriveCommitId(input) !== mutation.commitId) {
    violation("PROVIDER_SESSION_COMMIT_ID_MISMATCH");
  }
}

export function validateProviderSessionSnapshot(snapshot, context) {
  if (!snapshot || typeof snapshot !== "object") {
    violation("PROVIDER_SESSION_SNAPSHOT_INVALID");
  }
  const { scope, state } = snapshot;
  if (
    snapshot.version !== "1.0" ||
    !scope ||
    !state ||
    scope.sessionId !== state.sessionId ||
    scope.sessionId !== context?.sessionId
  ) {
    violation("PROVIDER_SESSION_SCOPE_MISMATCH");
  }
  if (!Array.isArray(state.activeAccountIds)) {
    violation("PROVIDER_SESSION_ACCOUNTS_INVALID");
  }
  if (new Set(state.activeAccountIds).size !== state.activeAccountIds.length) {
    violation("PROVIDER_SESSION_ACCOUNTS_DUPLICATE");
  }
  const sorted = [...state.activeAccountIds].sort();
  if (!sameJson(sorted, state.activeAccountIds)) {
    violation("PROVIDER_SESSION_ACCOUNTS_NOT_SORTED");
  }
  if (
    state.activeAccountIds.some(
      (accountId) =>
        typeof accountId !== "string" ||
        !accountId.startsWith(`${state.activeChainId}:`),
    )
  ) {
    violation("PROVIDER_SESSION_ACCOUNT_CHAIN_MISMATCH");
  }
  return true;
}

export function classifyAuthorityChange(
  expectedContext,
  expectedSession,
  currentContext,
  currentSession,
) {
  validateProviderSessionSnapshot(expectedSession, expectedContext);
  validateProviderSessionSnapshot(currentSession, currentContext);
  if (expectedContext.sessionId !== currentContext.sessionId) {
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
  if (
    expectedContext.transport !== currentContext.transport ||
    expectedContext.createdAt !== currentContext.createdAt ||
    !sameJson(expectedSession.scope, currentSession.scope) ||
    expectedSession.state.sessionId !== currentSession.state.sessionId ||
    expectedSession.state.connected !== currentSession.state.connected
  ) {
    return "SESSION_REVOKED";
  }
  if (
    expectedSession.state.activeChainId !== currentSession.state.activeChainId
  ) {
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

export function deriveCommitId(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("commit id input must be an object");
  }
  if (!DETERMINISTIC_ID.test(input.operationId)) {
    throw new TypeError("operationId must encode exactly 32 bytes as base64url");
  }
  if (!CANONICAL_DECIMAL.test(input.checkpointRevision)) {
    throw new TypeError("checkpointRevision must be a canonical decimal string");
  }
  if (!input.mutationPayload || typeof input.mutationPayload !== "object") {
    throw new TypeError("mutationPayload must be an object");
  }
  return createHash("sha256")
    .update(
      Buffer.concat([
        utf8("TWS/1.0/provider-commit"),
        NUL,
        utf8(input.operationId),
        NUL,
        utf8(input.checkpointRevision),
        NUL,
        utf8(canonicalize(input.mutationPayload)),
      ]),
    )
    .digest("base64url");
}

export function applyProviderSessionMutation(sessionRecord, mutation) {
  const { scope, state } = sessionRecord;
  const { payload } = mutation;
  if (
    !sameJson(scope, payload.scope) ||
    payload.target.sessionId !== payload.scope.sessionId
  ) {
    violation("PROVIDER_SESSION_SCOPE_MISMATCH");
  }
  if (payload.expectedRevision !== state.revision) {
    violation("PROVIDER_SESSION_REVISION_CONFLICT");
  }
  if (BigInt(payload.target.revision) !== BigInt(state.revision) + 1n) {
    violation("PROVIDER_SESSION_REVISION_CONFLICT");
  }
  const currentMeaningfulState = {
    version: state.version,
    sessionId: state.sessionId,
    connected: state.connected,
    activeChainId: state.activeChainId,
    activeAccountIds: state.activeAccountIds,
  };
  const targetMeaningfulState = {
    version: payload.target.version,
    sessionId: payload.target.sessionId,
    connected: payload.target.connected,
    activeChainId: payload.target.activeChainId,
    activeAccountIds: payload.target.activeAccountIds,
  };
  if (sameJson(currentMeaningfulState, targetMeaningfulState)) {
    violation("PROVIDER_SESSION_NOOP_MUTATION");
  }
  return structuredClone(payload.target);
}

export function evaluateCommitReplay(sessions, scenario) {
  const journal = new Map();
  let state = structuredClone(sessions.sessionA);
  let casWrites = 0;
  let ack;
  let events = [];
  for (const attemptName of scenario.attempts) {
    const mutation = sessions[attemptName];
    if (!mutation) throw new Error(`UNKNOWN_PROVIDER_MUTATION: ${attemptName}`);
    const stored = journal.get(mutation.commitId);
    if (stored) {
      if (!sameJson(stored.mutation, mutation)) {
        return { error: "CONFLICT", casWrites, events: [] };
      }
      ack = structuredClone(stored.ack);
      events = structuredClone(stored.events);
      continue;
    }
    state = {
      scope: structuredClone(state.scope),
      state: applyProviderSessionMutation(state, mutation),
    };
    ack = structuredClone(scenario.firstAck);
    if (
      ack.commitId !== mutation.commitId ||
      ack.revision !== state.state.revision
    ) {
      violation("PROVIDER_SESSION_ACK_MISMATCH");
    }
    events = structuredClone(mutation.payload.events);
    journal.set(mutation.commitId, {
      mutation: structuredClone(mutation),
      ack: structuredClone(ack),
      events: structuredClone(events),
    });
    casWrites += 1;
  }
  return { ack, casWrites, events };
}

function evaluateSemanticFailure(sessions, failure) {
  if (failure.id === "scope-target-session-mismatch") {
    const mutation = structuredClone(sessions.switchA);
    mutation.payload.target.sessionId = sessions.sessionB.scope.sessionId;
    applyProviderSessionMutation(sessions.sessionA, mutation);
  } else if (failure.id === "expected-revision-mismatch") {
    const mutation = structuredClone(sessions.switchA);
    mutation.payload.expectedRevision = "1";
    applyProviderSessionMutation(sessions.sessionA, mutation);
  } else if (failure.id === "commit-id-mismatch") {
    const mutation = structuredClone(sessions.switchA);
    mutation.commitId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    assertMutationBinding(sessions.commitId.input, mutation);
  } else if (failure.id === "completion-events-mismatch") {
    const completion = structuredClone(sessions.switchCompletion);
    completion.events = [];
    if (!sameJson(sessions.switchA.payload.events, completion.events)) {
      violation("PROVIDER_SESSION_EVENTS_MISMATCH");
    }
  }
  throw new Error(`Provider Session failure was accepted: ${failure.id}`);
}

export function runProviderSessionConformance(root) {
  const sessions = readJson(root, "test-vectors/provider.json").providerSessions;
  const records = [sessions.sessionA, sessions.sessionB];
  const scopeKeys = records.map(({ scope }) => canonicalize(scope));
  if (new Set(scopeKeys).size !== records.length) {
    violation("PROVIDER_SESSION_SCOPE_COLLISION");
  }
  if (
    records.some(({ scope, state }) => scope.sessionId !== state.sessionId)
  ) {
    violation("PROVIDER_SESSION_SCOPE_MISMATCH");
  }
  for (const snapshot of records) {
    validateProviderSessionSnapshot(snapshot, {
      sessionId: snapshot.scope.sessionId,
    });
  }

  assertMutationBinding(sessions.commitId.input, sessions.switchA);
  if (!sameJson(sessions.commitId.input.mutationPayload, sessions.switchA.payload)) {
    violation("PROVIDER_SESSION_COMMIT_ID_MISMATCH");
  }
  const switched = applyProviderSessionMutation(
    sessions.sessionA,
    sessions.switchA,
  );
  if (
    switched.activeChainId !== sessions.chainB ||
    sessions.sessionB.state.activeChainId !== sessions.chainA
  ) {
    violation("PROVIDER_SESSION_SCOPE_ISOLATION_FAILED");
  }
  if (
    sessions.commitAck.commitId !== sessions.switchA.commitId ||
    sessions.commitAck.revision !== switched.revision
  ) {
    violation("PROVIDER_SESSION_ACK_MISMATCH");
  }
  if (!sameJson(sessions.switchA.payload.events, sessions.switchCompletion.events)) {
    violation("PROVIDER_SESSION_EVENTS_MISMATCH");
  }
  const expectedLifecycle = [
    "transition:commit",
    "host:cas",
    "host:persist-ack",
    "core:acknowledgeCommit",
    "transition:complete",
    "host:emit-events",
  ];
  if (!sameJson(sessions.switchLifecycle.map(({ kind }) => kind), expectedLifecycle)) {
    violation("PROVIDER_SESSION_LIFECYCLE_ORDER_MISMATCH");
  }

  const exact = evaluateCommitReplay(sessions, sessions.commitReplay.exact);
  const collision = evaluateCommitReplay(
    sessions,
    sessions.commitReplay.collision,
  );
  if (
    exact.casWrites !== 1 ||
    !sameJson(exact.ack, sessions.commitReplay.exact.firstAck) ||
    collision.error !== "CONFLICT" ||
    collision.casWrites !== 1 ||
    collision.events.length !== 0
  ) {
    violation("PROVIDER_SESSION_COMMIT_REPLAY_FAILED");
  }

  if (
    sessions.switchNoop.requestedChainId !== sessions.sessionA.state.activeChainId ||
    sessions.switchNoop.approvalRequested ||
    sessions.switchNoop.mutation !== null ||
    sessions.switchNoop.events.length !== 0 ||
    sessions.switchNoop.completion.events.length !== 0
  ) {
    violation("PROVIDER_SESSION_SWITCH_NOOP_INVALID");
  }
  if (
    sessions.disconnect.sessionMutation !== null ||
    sessions.disconnect.permissionCommit.params.changes.length !== 2 ||
    sessions.disconnect.permissionCommit.params.changes.some(
      ({ permissions }) => permissions.length !== 0,
    )
  ) {
    violation("PROVIDER_SESSION_DISCONNECT_INVALID");
  }

  for (const failure of sessions.semanticFailures) {
    let actual;
    try {
      evaluateSemanticFailure(sessions, failure);
    } catch (error) {
      actual = error.message;
    }
    if (actual !== failure.expectedViolation) {
      throw new Error(
        `Provider Session failure ${failure.id} produced ${actual ?? "no violation"}`,
      );
    }
  }

  return {
    sessions: records.length,
    mutations: 1,
    commitAcks: 1,
    commitReplays: Object.keys(sessions.commitReplay).length,
    lifecycleSteps: sessions.switchLifecycle.length,
    noops: 1,
    disconnects: 1,
    failures: sessions.semanticFailures.length,
  };
}
