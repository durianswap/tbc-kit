import { createHash } from "node:crypto";
import { canonicalize } from "./canonical-json.mjs";
import { materializeCheckpoints } from "./lifecycle-conformance.mjs";
import { readJson } from "./repository.mjs";

const NUL = Buffer.from([0]);

function sha256Base64url(parts) {
  return createHash("sha256").update(Buffer.concat(parts)).digest("base64url");
}

function utf8(value) {
  return Buffer.from(value, "utf8");
}

function hashBytes(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be lowercase Hash32`);
  }
  return Buffer.from(value, "hex");
}

export function deriveOperationId(input) {
  return sha256Base64url([
    utf8("TWS/1.0/operation"),
    NUL,
    hashBytes(input.releaseFingerprint, "releaseFingerprint"),
    hashBytes(input.contextHash, "contextHash"),
    utf8(canonicalize(input.requestId)),
    NUL,
    utf8(canonicalize(input.operation)),
  ]);
}

export function deriveCallId(input) {
  for (const field of ["operationId", "checkpointRevision", "effectOrdinal", "operationName"]) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw new Error(`${field} must be a non-empty string`);
    }
  }
  if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(input.operationId)) {
    throw new Error("operationId must encode exactly 32 bytes as base64url");
  }
  for (const field of ["checkpointRevision", "effectOrdinal"]) {
    if (!/^(0|[1-9][0-9]*)$/.test(input[field])) {
      throw new Error(`${field} must be a canonical decimal string`);
    }
  }
  return sha256Base64url([
    utf8("TWS/1.0/port-call"),
    NUL,
    utf8(input.operationId),
    NUL,
    utf8(input.checkpointRevision),
    NUL,
    utf8(input.effectOrdinal),
    NUL,
    utf8(input.operationName),
  ]);
}

function sameCall(left, right) {
  return canonicalize({ operation: left.operation, params: left.params }) ===
    canonicalize({ operation: right.operation, params: right.params });
}

function conflictResponse(callId) {
  return {
    version: "1.0",
    callId,
    error: {
      name: "CONFLICT",
      message: "callId was reused with different operation or params",
      retryable: false,
    },
  };
}

export function evaluateReplayScenario(scenario) {
  const journal = new Map();
  let dispatchCount = 0;
  let journalWrites = 0;
  let response;
  let terminalState;
  for (const call of scenario.attempts) {
    const stored = journal.get(call.callId);
    if (!stored) {
      dispatchCount += 1;
      response = structuredClone(scenario.firstResponse);
      journal.set(call.callId, {
        call: structuredClone(call),
        response: structuredClone(response),
      });
      journalWrites += 1;
      continue;
    }
    if (!sameCall(stored.call, call)) {
      response = conflictResponse(call.callId);
      terminalState = "failed";
      continue;
    }
    response = structuredClone(stored.response);
  }
  return { response, dispatchCount, journalWrites, terminalState };
}

export function doesResponseAdvance(root, entry) {
  const lifecycle = readJson(root, "test-vectors/checkpoints.json");
  const checkpoint = materializeCheckpoints(lifecycle).find(
    (vector) => vector.id === entry.checkpointId,
  )?.checkpoint;
  if (!checkpoint) throw new Error(`Unknown checkpoint: ${entry.checkpointId}`);
  const state = readJson(root, "registry/operation-states.json").states.find(
    (candidate) => candidate.name === checkpoint.payload.state,
  );
  if (state?.terminal) return false;
  if (entry.response.error?.name === "CONFLICT") return false;
  if (entry.consumedCallIds.includes(entry.response.callId)) return false;
  return checkpoint.payload.pendingCalls.some(
    (call) => call.callId === entry.response.callId,
  );
}

function sameSet(left, right) {
  return canonicalize([...left].sort()) === canonicalize([...right].sort());
}

export function runReplayConformance(root) {
  const vectors = readJson(root, "test-vectors/port-replay.json");
  const registry = readJson(root, "registry/integration-ports.json");
  const operations = registry.ports.flatMap((port) => port.operations);
  if (operations.length !== 15) throw new Error("PORT_OPERATION_COUNT_MISMATCH");
  for (const operation of operations) {
    if (operation.semantics?.replay !== "exact-response-by-callId") {
      throw new Error(`PORT_REPLAY_SEMANTICS_MISSING: ${operation.name}`);
    }
  }
  if (!sameSet(operations.map((operation) => operation.name), vectors.operationCoverage)) {
    throw new Error("PORT_REPLAY_OPERATION_COVERAGE_MISMATCH");
  }
  if (
    deriveOperationId(vectors.ids.operation.input) !==
      vectors.ids.operation.expected ||
    deriveCallId(vectors.ids.call.input) !== vectors.ids.call.expected
  ) {
    throw new Error("DETERMINISTIC_ID_KAT_MISMATCH");
  }

  for (const scenario of vectors.exactReplays) {
    const outcome = evaluateReplayScenario(scenario);
    if (
      outcome.dispatchCount !== 1 ||
      outcome.journalWrites !== 1 ||
      canonicalize(outcome.response) !== canonicalize(scenario.firstResponse)
    ) {
      throw new Error(`EXACT_REPLAY_FAILED: ${scenario.id}`);
    }
  }
  const collision = evaluateReplayScenario(vectors.payloadCollision);
  if (
    collision.response.error?.name !== "CONFLICT" ||
    collision.dispatchCount !== 1 ||
    collision.terminalState !== "failed"
  ) {
    throw new Error("PORT_REPLAY_COLLISION_NOT_FAILED");
  }
  const expectedWindows = [
    ["before-dispatch", "dispatch-once"],
    ["after-dispatch-before-response-persist", "do-not-redispatch"],
    ["after-response-persist-before-resume", "replay-persisted-response"],
  ];
  if (
    canonicalize(
      vectors.crashWindows.map((entry) => [entry.window, entry.safeAction]),
    ) !== canonicalize(expectedWindows)
  ) {
    throw new Error("PORT_REPLAY_CRASH_MATRIX_MISMATCH");
  }
  if (
    vectors.nonAdvancingResponses.length !== 5 ||
    vectors.nonAdvancingResponses.some(
      (entry) =>
        entry.advancesRevision || doesResponseAdvance(root, entry),
    )
  ) {
    throw new Error("UNEXPECTED_RESPONSE_ADVANCED_CHECKPOINT");
  }
  if (
    !vectors.broadcastCall.callId ||
    !vectors.broadcastCall.params.idempotencyKey ||
    vectors.broadcastCall.callId === vectors.broadcastCall.params.idempotencyKey
  ) {
    throw new Error("BROADCAST_IDEMPOTENCY_BINDING_MISSING");
  }
  return {
    operations: operations.length,
    exactReplays: vectors.exactReplays.length,
    crashWindows: vectors.crashWindows.length,
    nonAdvancingResponses: vectors.nonAdvancingResponses.length,
    idKnownAnswers: 2,
  };
}
