import { canonicalize } from "./canonical-json.mjs";
import { readJson } from "./repository.mjs";

const AUTHORIZATION_WINDOW_MS = 5 * 60 * 1000;
const EXPIRY_SOURCES = [
  "request",
  "snapshot",
  "policy",
  "plan",
  "approval",
  "workflow",
];

function sameJson(left, right) {
  return canonicalize(left) === canonicalize(right);
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be RFC3339`);
  return parsed;
}

export function computeEffectiveExpiry(input) {
  const establishedAt = timestamp(input.establishedAt, "establishedAt");
  const authorizationLimit = establishedAt + AUTHORIZATION_WINDOW_MS;
  const unknownSources = Object.keys(input.candidates).filter(
    (source) => !EXPIRY_SOURCES.includes(source),
  );
  if (unknownSources.length !== 0) {
    throw new Error(`EXPIRY_SOURCE_UNKNOWN: ${unknownSources.join(",")}`);
  }
  const candidates = [authorizationLimit];
  for (const value of Object.values(input.candidates)) {
    candidates.push(timestamp(value, "expiry candidate"));
  }
  if (input.currentExpiresAt !== undefined) {
    candidates.push(timestamp(input.currentExpiresAt, "currentExpiresAt"));
  }
  if (input.proposedExpiresAt !== undefined) {
    const proposed = timestamp(input.proposedExpiresAt, "proposedExpiresAt");
    if (
      proposed > authorizationLimit ||
      (input.currentExpiresAt !== undefined &&
        proposed > timestamp(input.currentExpiresAt, "currentExpiresAt"))
    ) {
      throw new Error("EXPIRY_EXTENSION_FORBIDDEN");
    }
    candidates.push(proposed);
  }
  return new Date(Math.min(...candidates)).toISOString();
}

export function methodPathFor(root, method) {
  const paths = readJson(root, "registry/operation-states.json").methodPaths;
  const matches = paths.filter((entry) => entry.methods.includes(method));
  if (matches.length !== 1) {
    throw new Error(`METHOD_PATH_NOT_UNIQUE: ${method}`);
  }
  return structuredClone(matches[0]);
}

export function evaluateCancellation(root, reason, channelReachable) {
  const entries = readJson(
    root,
    "registry/operation-states.json",
  ).cancellationReasons.filter((entry) => entry.reason === reason);
  if (entries.length !== 1) throw new Error(`CANCELLATION_REASON_UNKNOWN: ${reason}`);
  const entry = entries[0];
  if (entry.delivery === "conditional" && !channelReachable) {
    return {
      terminalState: entry.terminalState,
      delivery: "suppress",
      providerCode: null,
      executionErrorName: null,
      retryable: entry.retryable,
    };
  }
  return {
    terminalState: entry.terminalState,
    delivery: entry.delivery === "conditional" ? "respond" : entry.delivery,
    providerCode: entry.providerCode,
    executionErrorName: entry.executionErrorName,
    retryable: entry.retryable,
  };
}

export function runLifecycleCase(root, scenario) {
  const registry = readJson(root, "registry/operation-states.json");
  if (scenario.resume && registry.states.some(
    (state) => state.name === scenario.state && state.terminal,
  )) {
    return {
      state: scenario.state,
      revision: scenario.checkpointRevision,
      effects: [],
      error: "TERMINAL_STATE_RESUME",
    };
  }
  if (scenario.reason && scenario.responseOperation) {
    return {
      state: "cancelled",
      revision: scenario.checkpointRevision,
      effects: [],
      responseDisposition: registry.lateResponsePolicy.disposition,
    };
  }
  const expired =
    timestamp(scenario.trustedNow, "trustedNow") >
    timestamp(scenario.expiresAt, "expiresAt");
  if (!expired) return { effects: structuredClone(scenario.requestedEffects) };
  const partial = registry.expiryPolicy.expiredPartialBroadcast;
  if (
    scenario.broadcastAttempted &&
    scenario.reconcileAttempts < partial.maxAttempts
  ) {
    return { effects: [partial.allowedEffect] };
  }
  const blocked = new Set(registry.expiryPolicy.afterExpiryForbiddenEffects);
  blocked.add(partial.allowedEffect);
  return {
    effects: scenario.requestedEffects.filter((effect) => !blocked.has(effect)),
  };
}

function validateCancellationRegistry(root, registry) {
  const errors = readJson(root, "registry/errors.json");
  const providerCodes = new Set(
    errors.providerErrors.map(({ code }) => code),
  );
  const executionNames = new Set(
    errors.executionErrors.map(({ name }) => name),
  );
  for (const entry of registry.cancellationReasons) {
    if (entry.delivery === "suppress") {
      if (entry.providerCode !== null || entry.executionErrorName !== null) {
        throw new Error(`SUPPRESSED_CANCELLATION_HAS_WIRE_ERROR: ${entry.reason}`);
      }
    } else if (entry.providerCode === null || !providerCodes.has(entry.providerCode)) {
      throw new Error(`CANCELLATION_PROVIDER_CODE_INVALID: ${entry.reason}`);
    }
    if (
      entry.executionErrorName !== null &&
      (!executionNames.has(entry.executionErrorName) || entry.providerCode !== -32000)
    ) {
      throw new Error(`CANCELLATION_EXECUTION_ERROR_INVALID: ${entry.reason}`);
    }
  }
}

export function runCancellationConformance(root) {
  const registry = readJson(root, "registry/operation-states.json");
  const vectors = readJson(root, "test-vectors/checkpoints.json").methodLifecycle;
  const methods = readJson(root, "registry/methods.json").methods.map(
    ({ name }) => name,
  );
  if (
    !sameJson(
      registry.methodPaths.map(({ category }) => category),
      vectors.expectedCategories,
    )
  ) {
    throw new Error("METHOD_LIFECYCLE_CATEGORY_MISMATCH");
  }
  const pathMethods = registry.methodPaths.flatMap(({ methods: names }) => names);
  if (
    new Set(pathMethods).size !== methods.length ||
    !sameJson([...pathMethods].sort(), [...methods].sort())
  ) {
    throw new Error("METHOD_LIFECYCLE_COVERAGE_MISMATCH");
  }
  if (
    methodPathFor(root, "tbc_signTransaction").states.includes("broadcasting") ||
    methodPathFor(root, "tbc_signWorkflow").states.includes("broadcasting") ||
    methodPathFor(root, "tbc_signReviewedTransaction").states.includes("broadcasting") ||
    methodPathFor(root, "tbc_encrypt").states.includes("broadcasting") ||
    methodPathFor(root, "tbc_decrypt").states.includes("broadcasting") ||
    !methodPathFor(root, "tbc_sendTransaction").states.includes("broadcasting") ||
    !methodPathFor(root, "tbc_sendWorkflow").states.includes("broadcasting")
  ) {
    throw new Error("SIGN_ONLY_BROADCAST_PATH");
  }

  const expiry = registry.expiryPolicy;
  if (
    expiry.authorizationWindowSeconds !== 300 ||
    !sameJson(expiry.narrowingSources, EXPIRY_SOURCES) ||
    !sameJson(expiry.afterExpiryForbiddenEffects, [
      "approval.request",
      "signer.sign",
      "crypto.execute",
      "reviewedTransaction.execute",
      "transaction.finalize",
      "broadcast.submit",
      "broadcast.submitBatch",
    ]) ||
    expiry.expiredPartialBroadcast.allowedEffect !== "broadcast.reconcile" ||
    expiry.expiredPartialBroadcast.maxAttempts !== 1
  ) {
    throw new Error("EXPIRY_POLICY_MISMATCH");
  }
  if (
    computeEffectiveExpiry(vectors.expiry.default) !==
      vectors.expiry.default.expected ||
    computeEffectiveExpiry(vectors.expiry.narrowed) !==
      vectors.expiry.narrowed.expected
  ) {
    throw new Error("EFFECTIVE_EXPIRY_MISMATCH");
  }
  let extensionRejected = false;
  try {
    computeEffectiveExpiry(vectors.expiry.attemptedExtension);
  } catch (error) {
    if (error.message !== "EXPIRY_EXTENSION_FORBIDDEN") throw error;
    extensionRejected = true;
  }
  if (!extensionRejected) throw new Error("EXPIRY_EXTENSION_ACCEPTED");
  if (
    vectors.expiredForbiddenEffects.some(
      (scenario) => runLifecycleCase(root, scenario).effects.length !== 0,
    ) ||
    !sameJson(
      runLifecycleCase(root, vectors.expiredPartialBroadcast).effects,
      ["broadcast.reconcile"],
    ) ||
    runLifecycleCase(
      root,
      vectors.expiredPartialBroadcastAfterReconcile,
    ).effects.length !== 0
  ) {
    throw new Error("EXPIRED_EFFECT_GUARD_FAILED");
  }

  if (
    registry.lateResponsePolicy.advancesRevision ||
    registry.lateResponsePolicy.disposition !== "ignore" ||
    vectors.lateResponses.some((scenario) => {
      const outcome = runLifecycleCase(root, scenario);
      return (
        outcome.state !== "cancelled" ||
        outcome.revision !== scenario.checkpointRevision ||
        outcome.effects.length !== 0 ||
        outcome.responseDisposition !== "ignore"
      );
    })
  ) {
    throw new Error("LATE_RESPONSE_ADVANCED_OPERATION");
  }

  validateCancellationRegistry(root, registry);
  for (const scenario of vectors.contextChanges) {
    if (
      evaluateCancellation(root, scenario.reason, true).terminalState !==
      scenario.terminalState
    ) {
      throw new Error(`CONTEXT_CHANGE_MAPPING_MISMATCH: ${scenario.id}`);
    }
  }
  for (const scenario of vectors.terminalResume) {
    if (runLifecycleCase(root, scenario).error !== "TERMINAL_STATE_RESUME") {
      throw new Error(`TERMINAL_STATE_RESUMED: ${scenario.state}`);
    }
  }

  const errorVectors = readJson(root, "test-vectors/errors.json");
  for (const vector of errorVectors.cancellationOutcomes) {
    const disposition = {
      reason: vector.reason,
      ...evaluateCancellation(root, vector.reason, vector.channelReachable),
    };
    if (!sameJson(disposition, vector.disposition)) {
      throw new Error(`CANCELLATION_VECTOR_MISMATCH: ${vector.reason}`);
    }
  }

  return {
    methodPaths: registry.methodPaths.length,
    cancellations: registry.cancellationReasons.length,
    expirySources: expiry.narrowingSources.length,
    forbiddenEffects: expiry.afterExpiryForbiddenEffects.length,
    lateResponses: vectors.lateResponses.length,
    contextChanges: vectors.contextChanges.length,
    terminalResumeBlocks: vectors.terminalResume.length,
    lifecycleCases:
      vectors.expiredForbiddenEffects.length +
      2 +
      vectors.lateResponses.length +
      vectors.terminalResume.length,
  };
}
