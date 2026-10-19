import { canonicalize } from "./canonical-json.mjs";
import {
  materializeCheckpoints,
  materializePreClockTerminals,
  validateCheckpointClosure,
  validateResumeMode,
} from "./lifecycle-conformance.mjs";
import { classifyAuthorityChange } from "./provider-session-conformance.mjs";
import { readJson } from "./repository.mjs";

function sameJson(left, right) {
  return canonicalize(left) === canonicalize(right);
}

function decodePointerSegment(segment) {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function pointerSegments(pointer) {
  if (!pointer.startsWith("/")) throw new Error(`Invalid pointer: ${pointer}`);
  return pointer.slice(1).split("/").map(decodePointerSegment);
}

function setPointer(value, pointer, replacement) {
  const segments = pointerSegments(pointer);
  const key = segments.pop();
  const parent = segments.reduce((current, segment) => current[segment], value);
  parent[key] = structuredClone(replacement);
}

function deletePointer(value, pointer) {
  const segments = pointerSegments(pointer);
  const key = segments.pop();
  const parent = segments.reduce((current, segment) => current[segment], value);
  delete parent[key];
}

function resolvePointer(value, pointer) {
  if (pointer === "") return value;
  return pointerSegments(pointer).reduce(
    (current, segment) => current?.[segment],
    value,
  );
}

function materializeSource(root, value) {
  if (Array.isArray(value)) {
    return value.map((item) => materializeSource(root, item));
  }
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && typeof value.source === "string") {
      const [file, fragment = ""] = value.source.split("#");
      const resolved = resolvePointer(
        readJson(root, `test-vectors/${file}`),
        fragment,
      );
      if (resolved === undefined) {
        throw new Error(`SELF_CONTAINED_SOURCE_MISSING:${value.source}`);
      }
      return structuredClone(resolved);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        materializeSource(root, child),
      ]),
    );
  }
  return value;
}

function assertArrayPrefix(previous, next, field) {
  if (!Array.isArray(next) || next.length < previous.length) {
    throw new Error(`MEMORY_APPEND_ONLY_VIOLATION:${field}`);
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (!sameJson(previous[index], next[index])) {
      throw new Error(`MEMORY_APPEND_ONLY_VIOLATION:${field}`);
    }
  }
}

function assertFillOnly(previous, next, errorName) {
  if (Array.isArray(previous)) {
    if (!Array.isArray(next) || next.length < previous.length) {
      throw new Error(errorName);
    }
    for (let index = 0; index < previous.length; index += 1) {
      assertFillOnly(previous[index], next[index], errorName);
    }
    return;
  }
  if (previous && typeof previous === "object") {
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new Error(errorName);
    }
    for (const [key, child] of Object.entries(previous)) {
      if (!(key in next)) throw new Error(errorName);
      assertFillOnly(child, next[key], errorName);
    }
    return;
  }
  if (!sameJson(previous, next)) throw new Error(errorName);
}

function validateBroadcastAdvance(previous, next) {
  assertFillOnly(
    previous.attempts,
    next.attempts,
    "BROADCAST_PROGRESS_ROLLBACK",
  );
  try {
    assertArrayPrefix(
      previous.submittedTransactionIds,
      next.submittedTransactionIds,
      "broadcastProgress",
    );
  } catch {
    throw new Error("BROADCAST_PROGRESS_ROLLBACK");
  }
  if (next.reconciliationAttempts < previous.reconciliationAttempts) {
    throw new Error("BROADCAST_PROGRESS_ROLLBACK");
  }
  if (
    previous.nextTransactionId !== undefined &&
    previous.nextTransactionId !== next.nextTransactionId
  ) {
    throw new Error("BROADCAST_PROGRESS_ROLLBACK");
  }
  if (
    previous.reconciliation !== undefined &&
    !sameJson(previous.reconciliation, next.reconciliation)
  ) {
    throw new Error("BROADCAST_PROGRESS_ROLLBACK");
  }
}

const WORKFLOW_STATUS_ORDER = new Map([
  ["pending", 0],
  ["signing", 1],
  ["finalized", 2],
  ["completed", 3],
]);

function validateWorkflowAdvance(previous, next) {
  if (!Array.isArray(next.steps) || next.steps.length < previous.steps.length) {
    throw new Error("WORKFLOW_PROGRESS_ROLLBACK");
  }
  for (let index = 0; index < previous.steps.length; index += 1) {
    const before = previous.steps[index];
    const after = next.steps[index];
    if (
      before.stepId !== after?.stepId ||
      WORKFLOW_STATUS_ORDER.get(after.status) <
        WORKFLOW_STATUS_ORDER.get(before.status)
    ) {
      throw new Error("WORKFLOW_PROGRESS_ROLLBACK");
    }
    for (const field of [
      "signingTasks",
      "signatures",
      "resolvedDeferredSigningTasks",
    ]) {
      if (before[field]) {
        try {
          assertArrayPrefix(before[field], after[field], field);
        } catch {
          throw new Error("WORKFLOW_PROGRESS_ROLLBACK");
        }
      }
    }
    if (
      before.finalizedBundle &&
      !sameJson(before.finalizedBundle, after.finalizedBundle)
    ) {
      throw new Error("WORKFLOW_PROGRESS_ROLLBACK");
    }
  }
  try {
    assertArrayPrefix(
      previous.completedStepIds,
      next.completedStepIds,
      "workflowProgress",
    );
  } catch {
    throw new Error("WORKFLOW_PROGRESS_ROLLBACK");
  }
}

export function validateCheckpointAdvance(previous, next) {
  if (BigInt(next.payload.revision) !== BigInt(previous.payload.revision) + 1n) {
    throw new Error("CHECKPOINT_REVISION_INVALID");
  }
  if (next.payload.previousCheckpointHash !== previous.checkpointHash) {
    throw new Error("CHECKPOINT_CHAIN_INVALID");
  }
  for (const field of [
    "version",
    "release",
    "releaseFingerprint",
    "operationId",
    "requestId",
    "operation",
    "context",
    "contextHash",
    "createdAt",
  ]) {
    if (!sameJson(previous.payload[field], next.payload[field])) {
      throw new Error(`CHECKPOINT_IMMUTABLE_CHANGED:${field}`);
    }
  }
  if (!sameJson(previous.payload.session, next.payload.session)) {
    throw new Error("CHECKPOINT_SESSION_REPLACED");
  }
  if (
    previous.payload.updatedAt !== undefined &&
    next.payload.updatedAt !== undefined &&
    Date.parse(next.payload.updatedAt) < Date.parse(previous.payload.updatedAt)
  ) {
    throw new Error("TRUSTED_TIME_ROLLBACK");
  }
  if (
    previous.payload.expiresAt !== undefined &&
    next.payload.expiresAt !== undefined &&
    Date.parse(next.payload.expiresAt) > Date.parse(previous.payload.expiresAt)
  ) {
    throw new Error("EXPIRY_EXTENSION_FORBIDDEN");
  }

  const previousMemory = previous.payload.memory;
  const nextMemory = next.payload.memory;
  for (const [field, before] of Object.entries(previousMemory)) {
    if (!(field in nextMemory)) throw new Error(`MEMORY_FIELD_REMOVED:${field}`);
    const after = nextMemory[field];
    if (field === "trustedTime") {
      if (Date.parse(after) < Date.parse(before)) {
        throw new Error("TRUSTED_TIME_ROLLBACK");
      }
    } else if (field === "broadcastProgress") {
      validateBroadcastAdvance(before, after);
    } else if (field === "workflowProgress") {
      validateWorkflowAdvance(before, after);
    } else if (field === "permissionCommit") {
      if (!sameJson(before.params, after.params)) {
        throw new Error("MEMORY_IMMUTABLE_CHANGED:permissionCommit");
      }
      if (before.result && !sameJson(before.result, after.result)) {
        throw new Error("MEMORY_IMMUTABLE_CHANGED:permissionCommit");
      }
    } else if (Array.isArray(before)) {
      assertArrayPrefix(before, after, field);
    } else if (!sameJson(before, after)) {
      throw new Error(`MEMORY_IMMUTABLE_CHANGED:${field}`);
    }
  }
  return next;
}

export function consumePendingResponse(checkpoint, response) {
  const next = structuredClone(checkpoint);
  const index = next.payload.pendingCalls.findIndex(
    (call) => call.callId === response.callId,
  );
  if (index === -1) {
    return { disposition: "ignore", checkpoint: next };
  }
  next.payload.pendingCalls.splice(index, 1);
  next.payload.revision = (BigInt(next.payload.revision) + 1n).toString();
  return { disposition: "accept", checkpoint: next };
}

function evaluateResumeMode(checkpoint, response) {
  const input = { checkpoint };
  if (response !== undefined) input.response = response;
  try {
    validateResumeMode(input);
    return "accept";
  } catch (error) {
    return error.message;
  }
}

function applyMemoryMutation(vector, previous, next) {
  if (vector.operation === "delete") {
    deletePointer(next, vector.path);
  } else if (vector.operation === "set") {
    setPointer(next, vector.path, vector.value);
  } else if (vector.operation === "signature-reorder") {
    const signature = structuredClone(next.payload.memory.signatures[0]);
    const replacement = {
      ...structuredClone(signature),
      taskId: "sign-tx-1-input-1",
    };
    next.payload.memory.signatures = [replacement, signature];
  } else if (vector.operation === "workflow-rollback") {
    previous.payload.memory.workflowProgress = {
      steps: [{ stepId: "trade", status: "completed" }],
      completedStepIds: ["trade"],
    };
    next.payload.memory.workflowProgress = {
      steps: [{ stepId: "trade", status: "signing" }],
      completedStepIds: [],
    };
  } else {
    throw new Error(`Unknown memory mutation: ${vector.operation}`);
  }
}

export function runClosureConformance(root) {
  const vectors = readJson(root, "test-vectors/core-closure.json");
  const methods = readJson(root, "registry/methods.json").methods.map(
    ({ name }) => name,
  );
  const stateRegistry = readJson(root, "registry/operation-states.json");
  if (!sameJson(methods, vectors.expectedMethods)) {
    throw new Error("CLOSURE_METHOD_SET_MISMATCH");
  }
  if (
    !sameJson(
      stateRegistry.methodPaths.map(({ category }) => category),
      vectors.expectedCategories,
    )
  ) {
    throw new Error("CLOSURE_METHOD_CATEGORY_MISMATCH");
  }

  for (const vector of vectors.authorityCases) {
    const currentContext = structuredClone(vectors.authorityBase.context);
    const currentSession = structuredClone(vectors.authorityBase.session);
    for (const mutation of vector.mutations) {
      setPointer(
        mutation.target === "context" ? currentContext : currentSession,
        mutation.path,
        mutation.value,
      );
    }
    const actual = classifyAuthorityChange(
      vectors.authorityBase.context,
      vectors.authorityBase.session,
      currentContext,
      currentSession,
    );
    if (actual !== vector.expected) {
      throw new Error(`AUTHORITY_CASE_MISMATCH:${vector.id}`);
    }
  }

  const lifecycle = readJson(root, "test-vectors/checkpoints.json");
  const checkpoints = materializeCheckpoints(lifecycle);
  const byId = new Map(
    checkpoints.map((vector) => [vector.id, vector.checkpoint]),
  );
  for (const vector of vectors.resumeModes) {
    const response = vector.response
      ? vectors.pendingResponses[vector.response]
      : undefined;
    const actual = evaluateResumeMode(byId.get(vector.checkpointId), response);
    if (actual !== vector.expected) {
      throw new Error(`RESUME_MODE_MISMATCH:${vector.id}:${actual}`);
    }
  }

  for (const vector of vectors.selfContainedCheckpoints) {
    const memory = vector.checkpointId
      ? byId.get(vector.checkpointId).payload.memory
      : materializeSource(root, vector.memory);
    for (const field of vector.requiredMemory) {
      if (!(field in memory)) {
        throw new Error(`SELF_CONTAINED_MEMORY_MISSING:${vector.id}:${field}`);
      }
    }
    if (
      vector.id === "permission-commit" &&
      typeof memory.permissionLoads[0].result.revision !== "string"
    ) {
      throw new Error("SELF_CONTAINED_PERMISSION_REVISION_MISSING");
    }
  }

  const callByResponseName = new Map(
    Object.entries(vectors.pendingResponses).map(([name, response]) => [
      name,
      vectors.pendingCheckpoint.payload.pendingCalls.find(
        (call) => call.callId === response.callId,
      ),
    ]),
  );
  for (const vector of vectors.pendingResponseOrders) {
    let checkpoint = structuredClone(vectors.pendingCheckpoint);
    checkpoint.payload.pendingCalls = vector.initial.map((name) =>
      structuredClone(callByResponseName.get(name)),
    );
    let accepted = 0;
    let ignored = 0;
    for (const responseName of vector.responses) {
      const result = consumePendingResponse(
        checkpoint,
        vectors.pendingResponses[responseName],
      );
      checkpoint = result.checkpoint;
      if (result.disposition === "accept") accepted += 1;
      else ignored += 1;
    }
    if (
      accepted !== vector.accepted ||
      ignored !== vector.ignored ||
      checkpoint.payload.pendingCalls.length !== vector.remaining
    ) {
      throw new Error(`PENDING_RESPONSE_ORDER_MISMATCH:${vector.id}`);
    }
  }

  let rejectedMutations = 0;
  for (const vector of vectors.memoryMutations) {
    const previous = structuredClone(byId.get(vector.previousId));
    const next = structuredClone(byId.get(vector.nextId));
    applyMemoryMutation(vector, previous, next);
    try {
      validateCheckpointAdvance(previous, next);
    } catch (error) {
      if (error.message !== vector.expected) {
        throw new Error(
          `MEMORY_MUTATION_MISMATCH:${vector.id}:${error.message}`,
        );
      }
      rejectedMutations += 1;
      continue;
    }
    throw new Error(`MEMORY_MUTATION_ACCEPTED:${vector.id}`);
  }

  const preClockTerminals = materializePreClockTerminals(lifecycle);
  for (const vector of preClockTerminals) {
    validateCheckpointClosure(vector.checkpoint);
    const { payload } = vector.checkpoint;
    if (
      payload.revision !== "1" ||
      payload.pendingCalls.length !== 0 ||
      "createdAt" in payload ||
      Object.keys(payload.memory).length !== 0
    ) {
      throw new Error(`PRE_CLOCK_CLOSURE_INVALID:${vector.id}`);
    }
  }

  return {
    methods: methods.length,
    methodCategories: stateRegistry.methodPaths.length,
    authorityCases: vectors.authorityCases.length,
    resumeModes: vectors.resumeModes.length,
    selfContainedCheckpoints: vectors.selfContainedCheckpoints.length,
    pendingResponseOrders: vectors.pendingResponseOrders.length,
    memoryMutationsRejected: rejectedMutations,
    preClockTerminals: preClockTerminals.length,
  };
}
