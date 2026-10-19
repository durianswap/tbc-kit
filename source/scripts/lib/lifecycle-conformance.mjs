import { createHash } from "node:crypto";
import { canonicalize } from "./canonical-json.mjs";
import { deriveCommitId } from "./provider-session-conformance.mjs";
import { readJson } from "./repository.mjs";

function sha256Jcs(value) {
  return createHash("sha256")
    .update(Buffer.from(canonicalize(value), "utf8"))
    .digest("hex");
}

function sameJson(left, right) {
  return canonicalize(left) === canonicalize(right);
}

function resolveFixturePath(fixture, fixturePath) {
  const value = fixturePath
    .split(".")
    .reduce((current, segment) => current?.[segment], fixture);
  if (value === undefined) {
    throw new Error(`Unknown fixture memory source: ${fixturePath}`);
  }
  return value;
}

function materializeMemory(vectors, vector) {
  const memory = {};
  for (const field of vector.memoryFields ?? []) {
    const source = vectors.fixture.memorySources?.[field];
    if (!source) throw new Error(`Unknown checkpoint memory field: ${field}`);
    memory[field] = structuredClone(
      resolveFixturePath(vectors.fixture, source),
    );
  }
  return memory;
}

function checkpointMap(checkpoints) {
  return new Map(checkpoints.map((vector) => [vector.id, vector]));
}

function classifyContextChange(expected, current) {
  if (expected.sessionId !== current.sessionId) return "SESSION_REVOKED";
  if (expected.navigationId !== current.navigationId) {
    return "NAVIGATION_CHANGED";
  }
  if (
    expected.origin !== current.origin ||
    expected.topOrigin !== current.topOrigin ||
    expected.frame !== current.frame
  ) {
    return "ORIGIN_CHANGED";
  }
  if (expected.transport !== current.transport) return "TRANSPORT_CLOSED";
  return "SESSION_REVOKED";
}

export function validateCheckpointIntegrity(
  checkpoint,
  { previous, loadedReleaseFingerprint, currentContext } = {},
) {
  const { payload, checkpointHash } = checkpoint;
  if (sha256Jcs(payload.release) !== payload.releaseFingerprint) {
    throw new Error("RELEASE_FINGERPRINT_MISMATCH");
  }
  if (
    loadedReleaseFingerprint !== undefined &&
    payload.releaseFingerprint !== loadedReleaseFingerprint
  ) {
    throw new Error("PROTOCOL_RELEASE_CHANGED");
  }
  if (sha256Jcs(payload.context) !== payload.contextHash) {
    throw new Error("CONTEXT_HASH_MISMATCH");
  }
  if (currentContext !== undefined && !sameJson(payload.context, currentContext)) {
    throw new Error(classifyContextChange(payload.context, currentContext));
  }
  if (sha256Jcs(payload) !== checkpointHash) {
    throw new Error("CHECKPOINT_HASH_MISMATCH");
  }
  if (payload.revision === "0") {
    if (previous !== undefined || "previousCheckpointHash" in payload) {
      throw new Error("CHECKPOINT_CHAIN_INVALID");
    }
    return payload;
  }
  if (!previous) throw new Error("CHECKPOINT_CHAIN_INVALID");
  if (BigInt(payload.revision) !== BigInt(previous.payload.revision) + 1n) {
    throw new Error("CHECKPOINT_REVISION_INVALID");
  }
  if (payload.previousCheckpointHash !== previous.checkpointHash) {
    throw new Error("CHECKPOINT_CHAIN_INVALID");
  }
  return payload;
}

export function materializeCheckpoints(vectors) {
  const materialized = [];
  const byId = new Map();
  for (const vector of vectors.checkpoints) {
    const payload = {
      ...structuredClone(vectors.fixture.basePayload),
      ...(vector.operation
        ? { operation: structuredClone(vector.operation) }
        : {}),
      revision: vector.revision,
      state: vector.state,
      pendingCalls: structuredClone(vector.pendingCalls),
      memory: materializeMemory(vectors, vector),
      data: structuredClone(
        vectors.fixture.artifacts[vector.dataArtifact],
      ),
    };
    if (vector.state !== "initializing") {
      Object.assign(payload, structuredClone(vectors.fixture.trustedTimes));
      const previous = byId.get(vector.previousId);
      if (!previous) {
        throw new Error(`Checkpoint ${vector.id} has unknown predecessor`);
      }
      payload.previousCheckpointHash = previous.checkpoint.checkpointHash;
    }
    const materializedVector = {
      ...structuredClone(vector),
      checkpoint: {
        payload,
        checkpointHash: vector.checkpointHash,
      },
    };
    materialized.push(materializedVector);
    byId.set(vector.id, materializedVector);
  }
  return materialized;
}

export function materializePreClockTerminals(vectors) {
  const checkpoints = materializeCheckpoints(vectors);
  const byId = checkpointMap(checkpoints);
  return (vectors.preClockTerminals ?? []).map((vector) => {
    const previous = byId.get(vector.previousId)?.checkpoint;
    if (!previous) {
      throw new Error(`Pre-clock terminal ${vector.id} has unknown predecessor`);
    }
    return {
      ...structuredClone(vector),
      checkpoint: {
        payload: {
          ...structuredClone(vectors.fixture.basePayload),
          revision: vector.revision,
          previousCheckpointHash: previous.checkpointHash,
          state: vector.state,
          pendingCalls: structuredClone(vector.pendingCalls),
          memory: materializeMemory(vectors, vector),
          data: structuredClone(
            vectors.fixture.artifacts[vector.dataArtifact],
          ),
        },
        checkpointHash: vector.checkpointHash,
      },
    };
  });
}

const TRANSACTION_MEMORY_BY_STATE = {
  initializing: [],
  validating: ["trustedTime"],
  authorizing: ["trustedTime", "permissionLoads"],
  resolving: ["trustedTime", "permissionLoads", "accountResolutions"],
  planning: [
    "trustedTime",
    "permissionLoads",
    "accountResolutions",
    "requestHash",
    "normalizedTransaction",
    "chainSnapshot",
    "executionPolicy",
  ],
  approval: [
    "trustedTime",
    "permissionLoads",
    "accountResolutions",
    "requestHash",
    "normalizedTransaction",
    "chainSnapshot",
    "executionPolicy",
    "executionPlan",
    "approvalBinding",
    "approvalPreview",
  ],
  signing: [
    "trustedTime",
    "permissionLoads",
    "accountResolutions",
    "requestHash",
    "normalizedTransaction",
    "chainSnapshot",
    "executionPolicy",
    "executionPlan",
    "approvalBinding",
    "approvalPreview",
    "approvalReceipt",
    "signingTasks",
  ],
  finalizing: [
    "trustedTime",
    "permissionLoads",
    "accountResolutions",
    "requestHash",
    "normalizedTransaction",
    "chainSnapshot",
    "executionPolicy",
    "executionPlan",
    "approvalBinding",
    "approvalPreview",
    "approvalReceipt",
    "signingTasks",
    "signatures",
  ],
  broadcasting: [
    "trustedTime",
    "permissionLoads",
    "accountResolutions",
    "requestHash",
    "normalizedTransaction",
    "chainSnapshot",
    "executionPolicy",
    "executionPlan",
    "approvalBinding",
    "approvalPreview",
    "approvalReceipt",
    "signingTasks",
    "signatures",
    "finalizedBundle",
    "broadcastProgress",
  ],
  reconciliation: [
    "trustedTime",
    "permissionLoads",
    "accountResolutions",
    "requestHash",
    "normalizedTransaction",
    "chainSnapshot",
    "executionPolicy",
    "executionPlan",
    "approvalBinding",
    "approvalPreview",
    "approvalReceipt",
    "signingTasks",
    "signatures",
    "finalizedBundle",
    "broadcastProgress",
  ],
  committing: [
    "trustedTime",
    "permissionLoads",
    "accountResolutions",
    "requestHash",
    "normalizedTransaction",
    "chainSnapshot",
    "executionPolicy",
    "executionPlan",
    "approvalBinding",
    "approvalPreview",
    "providerSessionMutation",
  ],
  completed: [
    "trustedTime",
    "permissionLoads",
    "accountResolutions",
    "requestHash",
    "normalizedTransaction",
    "chainSnapshot",
    "executionPolicy",
    "executionPlan",
    "approvalBinding",
    "approvalPreview",
    "approvalReceipt",
    "signingTasks",
    "signatures",
    "finalizedBundle",
    "broadcastProgress",
    "providerCompletion",
  ],
  rejected: ["trustedTime", "permissionLoads"],
  failed: ["trustedTime", "permissionLoads"],
  cancelled: ["trustedTime", "permissionLoads"],
};

export function validateCheckpointClosure(checkpoint) {
  const { payload } = checkpoint;
  if (!payload.session) throw new Error("CHECKPOINT_SESSION_MISSING");
  if (!payload.memory || typeof payload.memory !== "object") {
    throw new Error("CHECKPOINT_MEMORY_MISSING");
  }
  if (
    payload.session.scope.sessionId !== payload.context.sessionId ||
    payload.session.state.sessionId !== payload.context.sessionId
  ) {
    throw new Error("CHECKPOINT_SESSION_CONTEXT_MISMATCH");
  }
  if (
    payload.revision === "1" &&
    ["failed", "cancelled"].includes(payload.state) &&
    !("createdAt" in payload)
  ) {
    if (Object.keys(payload.memory).length !== 0) {
      throw new Error("PRE_CLOCK_MEMORY_FORBIDDEN");
    }
    return payload;
  }
  if (payload.state === "committing") {
    const permissionMethods = new Set([
      "tbc_requestAccounts",
      "wallet_requestPermissions",
      "tbc_disconnect",
    ]);
    const expectedKind = permissionMethods.has(payload.operation.method)
      ? "permission-store"
      : payload.operation.method === "tbc_switchChain"
        ? "provider-session"
        : undefined;
    if (!expectedKind || payload.data.kind !== expectedKind) {
      throw new Error("COMMITTING_KIND_MISMATCH");
    }
    if (expectedKind === "permission-store") {
      if (
        payload.pendingCalls.length === 0 ||
        payload.pendingCalls.some(
          ({ operation }) => operation !== "permissionStore.commit",
        ) ||
        !payload.memory.permissionCommit ||
        payload.memory.providerSessionMutation
      ) {
        throw new Error("COMMITTING_KIND_MISMATCH");
      }
    } else if (
      payload.pendingCalls.length !== 0 ||
      !sameJson(
        payload.memory.providerSessionMutation,
        payload.data.providerSessionMutation,
      ) ||
      payload.memory.permissionCommit
    ) {
      throw new Error("COMMITTING_KIND_MISMATCH");
    }
  }
  if (payload.operation.method !== "tbc_sendTransaction") return payload;

  for (const field of TRANSACTION_MEMORY_BY_STATE[payload.state] ?? []) {
    if (!(field in payload.memory)) {
      throw new Error(`CHECKPOINT_MEMORY_MISSING:${field}`);
    }
  }
  for (const artifact of payload.memory.permissionLoads ?? []) {
    if (typeof artifact.result?.revision !== "string") {
      throw new Error("CHECKPOINT_PERMISSION_REVISION_MISSING");
    }
  }
  if (
    payload.state === "reconciliation" &&
    payload.memory.broadcastProgress.submittedTransactionIds.length === 0
  ) {
    throw new Error("CHECKPOINT_BROADCAST_PROGRESS_MISSING");
  }
  return payload;
}

export function validateResumeMode(input) {
  const { payload } = input.checkpoint;
  if (["completed", "rejected", "failed", "cancelled"].includes(payload.state)) {
    throw new Error("TERMINAL_STATE_RESUME");
  }
  const hasPendingCalls = payload.pendingCalls.length > 0;
  const hasResponse = Object.hasOwn(input, "response");
  if (hasPendingCalls && !hasResponse) throw new Error("RESPONSE_REQUIRED");
  if (!hasPendingCalls && hasResponse) throw new Error("UNEXPECTED_RESPONSE");
}

export function materializeTransitions(vectors, checkpoints) {
  const byId = checkpointMap(checkpoints);
  return vectors.transitions.map((vector) => {
    const checkpoint = byId.get(vector.checkpointId)?.checkpoint;
    if (!checkpoint) {
      throw new Error(`Transition ${vector.id} has unknown checkpoint`);
    }
    const template = vector.transition;
    let transition;
    if (template.kind === "waiting") {
      transition = {
        kind: "waiting",
        checkpoint,
        calls: structuredClone(checkpoint.payload.pendingCalls),
      };
    } else if (template.kind === "continue") {
      transition = {
        kind: "continue",
        checkpoint,
      };
    } else if (template.kind === "commit") {
      transition = {
        kind: "commit",
        checkpoint,
        mutation: structuredClone(
          vectors.fixture.artifacts[template.mutationArtifact]
            .providerSessionMutation,
        ),
      };
    } else if (template.kind === "complete") {
      const completion = template.completionArtifact
        ? vectors.fixture.artifacts[template.completionArtifact]
            .providerCompletion
        : template.completion;
      transition = {
        kind: "complete",
        checkpoint,
        completion: structuredClone(completion),
      };
    } else {
      throw new Error(`Unknown transition kind: ${template.kind}`);
    }
    return { ...structuredClone(vector), transition };
  });
}

function registryStateMap(root) {
  const registry = readJson(root, "registry/operation-states.json");
  return {
    registry,
    byName: new Map(registry.states.map((state) => [state.name, state])),
  };
}

export function evaluateLifecycleFailure(root, vectors, failure) {
  const checkpoints = materializeCheckpoints(vectors);
  const byId = checkpointMap(checkpoints);
  const { byName } = registryStateMap(root);

  if (failure.id === "revision-rollback") {
    const previous = byId.get(failure.previousId).checkpoint;
    if (BigInt(failure.revision) <= BigInt(previous.payload.revision)) {
      return "CHECKPOINT_REVISION_INVALID";
    }
  } else if (failure.id === "previous-hash-break") {
    const current = byId.get(failure.checkpointId).checkpoint;
    if (
      failure.previousCheckpointHash !==
      current.payload.previousCheckpointHash
    ) {
      return "CHECKPOINT_CHAIN_INVALID";
    }
  } else if (failure.id === "resume-completed") {
    const current = byId.get(failure.checkpointId).checkpoint;
    if (byName.get(current.payload.state)?.terminal) {
      return "TERMINAL_STATE_RESUME";
    }
  } else if (failure.id === "release-fingerprint-mismatch") {
    const current = byId.get(failure.checkpointId).checkpoint;
    if (
      current.payload.releaseFingerprint !== failure.loadedReleaseFingerprint
    ) {
      return "PROTOCOL_RELEASE_CHANGED";
    }
  } else if (failure.id === "illegal-state-transition") {
    const from = byId.get(failure.fromId).checkpoint.payload.state;
    const to = byId.get(failure.toId).checkpoint.payload.state;
    if (!byName.get(from)?.allowedTransitions.includes(to)) {
      return "STATE_TRANSITION_INVALID";
    }
  } else if (failure.id === "expired-signing-effect") {
    const current = byId.get(failure.checkpointId).checkpoint;
    if (
      ["approval", "signing", "finalizing", "broadcasting"].includes(
        current.payload.state,
      ) &&
      Date.parse(failure.trustedNow) > Date.parse(current.payload.expiresAt)
    ) {
      return "OPERATION_EXPIRED";
    }
  }
  throw new Error(`Lifecycle failure was accepted: ${failure.id}`);
}

export function runLifecycleConformance(root) {
  const vectors = readJson(root, "test-vectors/checkpoints.json");
  const integrationSchema = readJson(root, "schemas/integration.schema.json");
  const providerSchema = readJson(root, "schemas/provider.schema.json");
  const { registry, byName } = registryStateMap(root);
  const checkpoints = materializeCheckpoints(vectors);
  const preClockTerminals = materializePreClockTerminals(vectors);
  const byId = checkpointMap(checkpoints);

  if (!sameJson(vectors.coreSurface, integrationSchema.$defs.coreMethodName.enum)) {
    throw new Error("CORE_SURFACE_MISMATCH");
  }
  if (new Set(vectors.coreSurface).size !== 4) {
    throw new Error("CORE_SURFACE_MISMATCH");
  }
  const checkpointStates = checkpoints.map(
    (vector) => vector.checkpoint.payload.state,
  );
  const registryStates = registry.states.map((state) => state.name);
  if (
    !sameJson(
      [...integrationSchema.$defs.operationState.enum].sort(),
      [...registryStates].sort(),
    ) ||
    !sameJson(
      [...providerSchema.$defs.cancellationReason.enum].sort(),
      [...registry.cancellationReasons.map((entry) => entry.reason)].sort(),
    )
  ) {
    throw new Error("LIFECYCLE_REGISTRY_SCHEMA_MISMATCH");
  }
  if (
    checkpointStates.length !== 15 ||
    new Set(checkpointStates).size !== 15 ||
    !sameJson([...checkpointStates].sort(), [...registryStates].sort())
  ) {
    throw new Error("CHECKPOINT_STATE_COVERAGE_MISMATCH");
  }

  for (const vector of checkpoints) {
    const { payload } = vector.checkpoint;
    const previous = vector.previousId
      ? byId.get(vector.previousId)?.checkpoint
      : undefined;
    try {
      validateCheckpointIntegrity(vector.checkpoint, {
        previous,
        loadedReleaseFingerprint: payload.releaseFingerprint,
        currentContext: payload.context,
      });
      validateCheckpointClosure(vector.checkpoint);
    } catch (error) {
      throw new Error(`${error.message}: ${vector.id}`);
    }
    const stateDefinition = byName.get(payload.state);
    if (!stateDefinition) throw new Error(`UNKNOWN_STATE: ${payload.state}`);
    for (const field of stateDefinition.memoryRequired) {
      if (!(field in payload.memory)) {
        throw new Error(`STATE_MEMORY_REQUIRED:${payload.state}:${field}`);
      }
    }
    for (const field of Object.keys(payload.memory)) {
      if (!stateDefinition.memoryAllowed.includes(field)) {
        throw new Error(`STATE_MEMORY_FORBIDDEN:${payload.state}:${field}`);
      }
    }
    for (const call of payload.pendingCalls) {
      if (!stateDefinition.allowedPortOperations.includes(call.operation)) {
        throw new Error(`STATE_PORT_FORBIDDEN:${payload.state}:${call.operation}`);
      }
    }
    if (stateDefinition.terminal && payload.pendingCalls.length !== 0) {
      throw new Error(`TERMINAL_PENDING_CALL: ${vector.id}`);
    }
    if (payload.state === "initializing") {
      if (
        payload.revision !== "0" ||
        "previousCheckpointHash" in payload ||
        "createdAt" in payload ||
        payload.pendingCalls.length !== 1 ||
        payload.pendingCalls[0].operation !== "clock.now"
      ) {
        throw new Error("INITIALIZING_CHECKPOINT_INVALID");
      }
      continue;
    }
    if (!byName.get(previous.payload.state).allowedTransitions.includes(payload.state)) {
      throw new Error(`STATE_TRANSITION_INVALID: ${vector.id}`);
    }
    for (const field of ["createdAt", "updatedAt", "expiresAt"]) {
      if (!payload[field]) throw new Error(`TRUSTED_TIME_MISSING: ${vector.id}`);
    }
    if (
      Date.parse(payload.createdAt) > Date.parse(payload.updatedAt) ||
      Date.parse(payload.updatedAt) > Date.parse(payload.expiresAt)
    ) {
      throw new Error(`TRUSTED_TIME_ORDER_INVALID: ${vector.id}`);
    }
  }

  const initializing = byId.get("initializing")?.checkpoint;
  for (const vector of preClockTerminals) {
    try {
      validateCheckpointIntegrity(vector.checkpoint, {
        previous: initializing,
        loadedReleaseFingerprint:
          vector.checkpoint.payload.releaseFingerprint,
        currentContext: vector.checkpoint.payload.context,
      });
      validateCheckpointClosure(vector.checkpoint);
    } catch (error) {
      throw new Error(`${error.message}: ${vector.id}`);
    }
    const { payload } = vector.checkpoint;
    if (
      payload.revision !== "1" ||
      payload.pendingCalls.length !== 0 ||
      "createdAt" in payload ||
      "updatedAt" in payload ||
      "expiresAt" in payload ||
      !byName.get("initializing").allowedTransitions.includes(payload.state)
    ) {
      throw new Error(`PRE_CLOCK_TERMINAL_INVALID: ${vector.id}`);
    }
  }

  const transitions = materializeTransitions(vectors, checkpoints);
  const transitionKinds = new Set();
  const completionDeliveries = new Set();
  for (const vector of transitions) {
    const { transition } = vector;
    transitionKinds.add(transition.kind);
    if (transition.kind === "waiting") {
      if (
        transition.calls.length === 0 ||
        !sameJson(transition.calls, transition.checkpoint.payload.pendingCalls)
      ) {
        throw new Error(`WAITING_TRANSITION_INVALID: ${vector.id}`);
      }
    } else if (transition.kind === "continue") {
      if (
        transition.checkpoint.payload.pendingCalls.length !== 0 ||
        byName.get(transition.checkpoint.payload.state)?.terminal
      ) {
        throw new Error(`CONTINUE_TRANSITION_INVALID: ${vector.id}`);
      }
    } else if (transition.kind === "commit") {
      if (
        transition.checkpoint.payload.state !== "committing" ||
        !sameJson(
          transition.mutation,
          transition.checkpoint.payload.data.providerSessionMutation,
        )
      ) {
        throw new Error(`COMMIT_TRANSITION_INVALID: ${vector.id}`);
      }
      if (
        deriveCommitId({
          operationId: transition.checkpoint.payload.operationId,
          checkpointRevision: transition.checkpoint.payload.revision,
          mutationPayload: transition.mutation.payload,
        }) !== transition.mutation.commitId
      ) {
        throw new Error(`PROVIDER_SESSION_COMMIT_ID_MISMATCH: ${vector.id}`);
      }
    } else if (transition.kind === "complete") {
      const state = byName.get(transition.checkpoint.payload.state);
      if (!state?.terminal) {
        throw new Error(`COMPLETE_TRANSITION_INVALID: ${vector.id}`);
      }
      completionDeliveries.add(transition.completion.delivery);
      if (transition.completion.delivery === "respond") {
        if (
          !("response" in transition.completion) ||
          !Array.isArray(transition.completion.events) ||
          transition.completion.response.id !==
            transition.checkpoint.payload.requestId
        ) {
          throw new Error(`RESPOND_COMPLETION_INVALID: ${vector.id}`);
        }
      } else if (
        transition.completion.delivery !== "suppress" ||
        !("cancellationReason" in transition.completion) ||
        "response" in transition.completion
      ) {
        throw new Error(`SUPPRESS_COMPLETION_INVALID: ${vector.id}`);
      }
      if (
        transition.checkpoint.payload.state === "completed" &&
        !sameJson(
          transition.completion,
          transition.checkpoint.payload.data.providerCompletion,
        )
      ) {
        throw new Error(`COMPLETE_TRANSITION_INVALID: ${vector.id}`);
      }
      if (
        transition.completion.delivery === "suppress" &&
        transition.completion.cancellationReason !==
          transition.checkpoint.payload.data.cancellationReason
      ) {
        throw new Error(`SUPPRESS_COMPLETION_INVALID: ${vector.id}`);
      }
    }
  }
  if (
    !sameJson(
      [...transitionKinds].sort(),
      ["commit", "complete", "continue", "waiting"],
    ) ||
    !sameJson([...completionDeliveries].sort(), ["respond", "suppress"])
  ) {
    throw new Error("CORE_TRANSITION_COVERAGE_MISMATCH");
  }

  for (const failure of vectors.failures) {
    evaluateLifecycleFailure(root, vectors, failure);
  }

  return {
    coreMethods: vectors.coreSurface.length,
    states: registry.states.length,
    terminalStates: registry.states.filter((state) => state.terminal).length,
    checkpoints: checkpoints.length,
    preClockTerminals: preClockTerminals.length,
    transitions: transitions.length,
    completionDeliveries: completionDeliveries.size,
    failures: vectors.failures.length,
  };
}
