import { canonicalize } from "./canonical-json.js";
import { verifiedCheckpoints as verifiedSnapshots } from "./checkpoint-ownership.js";
import { TwsCheckpointError } from "./errors.js";
import { hashCanonical } from "./hash.js";
import { ownedJsonValues as ownedValues } from "./immutable-json-ownership.js";
import { deriveCallId, deriveOperationId } from "./identifiers.js";
import { TWS_RELEASE } from "./release.js";
import type { AnyPortCall } from "./ports.js";
import { assertValidTws } from "./validation.js";

export interface ProtocolReleaseIdentity {
  readonly version: string;
  readonly schemaBundleSha256: string;
  readonly registryBundleSha256: string;
}

export interface OperationCheckpointPayload {
  readonly release: ProtocolReleaseIdentity;
  readonly releaseFingerprint: string;
  readonly operationId: string;
  readonly revision: string;
  readonly previousCheckpointHash?: string;
  readonly requestId: unknown;
  readonly operation: unknown;
  readonly context: unknown;
  readonly contextHash: string;
  readonly session: unknown;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly expiresAt?: string;
  readonly pendingCalls: readonly AnyPortCall[];
  readonly memory: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface OperationCheckpoint {
  readonly payload: OperationCheckpointPayload;
  readonly checkpointHash: string;
}

// Only snapshots cloned, fully checked and deeply frozen by this module enter
// this set. A caller's Object.freeze(), deserialized copy or Proxy is not proof.

function verifiedSnapshot(checkpoint: OperationCheckpoint): OperationCheckpoint {
  const frozen = deepFreeze(checkpoint);
  verifiedSnapshots.add(frozen);
  return frozen;
}

function cloneJson<T>(value: T, ancestors = new Set<object>()): T {
  if (value === null || typeof value !== "object") {
    return JSON.parse(canonicalize(value)) as T;
  }
  // Structural sharing is only for our own immutable JSON, never a caller's
  // Object.freeze(). A new revision copies its changed branches, not the full
  // transaction/plan/approval history again.
  if (ownedValues.has(value)) return value;
  if (ancestors.has(value)) throw new TypeError("JCS rejects cyclic values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from(value, item => cloneJson(item, ancestors)) as T;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JCS accepts plain objects only");
    }
    if (Object.getOwnPropertySymbols(value).some(symbol =>
      Object.prototype.propertyIsEnumerable.call(value, symbol))) {
      throw new TypeError("JCS rejects enumerable symbol keys");
    }
    return Object.fromEntries(Object.keys(value).sort().map(key => [
      JSON.parse(canonicalize(key)),
      cloneJson((value as Record<string, unknown>)[key], ancestors),
    ])) as T;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !ownedValues.has(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
    ownedValues.add(value);
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return left === right || canonicalize(left) === canonicalize(right);
}

function fail(code: ConstructorParameters<typeof TwsCheckpointError>[0], message: string): never {
  throw new TwsCheckpointError(code, message);
}

function verifyInternalBindings(checkpoint: OperationCheckpoint): void {
  const { payload } = checkpoint;
  if (hashCanonical(payload.release) !== payload.releaseFingerprint) {
    fail(
      "RELEASE_FINGERPRINT_MISMATCH",
      "checkpoint releaseFingerprint does not bind its release",
    );
  }
  if (hashCanonical(payload.context) !== payload.contextHash) {
    fail("CONTEXT_HASH_MISMATCH", "checkpoint contextHash does not bind its context");
  }
  const expectedOperationId = deriveOperationId({
    releaseFingerprint: payload.releaseFingerprint,
    contextHash: payload.contextHash,
    requestId: payload.requestId,
    operation: payload.operation,
  });
  if (payload.operationId !== expectedOperationId) {
    fail("OPERATION_ID_MISMATCH", "checkpoint operationId does not bind its operation");
  }
  const currentRevision = BigInt(payload.revision);
  // A checkpoint can carry at most 32 calls and consumes at most one per
  // revision, so an unconsumed call cannot be older than 31 revisions.
  const earliestRevision = currentRevision > 31n ? currentRevision - 31n : 0n;
  payload.pendingCalls.forEach((call, pendingIndex) => {
    let matched = false;
    // Normal execution issues the pending call in this revision. Check it
    // first instead of hashing up to 31 historical revisions on every resume.
    // Recovery still searches the exact same bounded revision/ordinal set.
    for (
      let issuedRevision = currentRevision;
      issuedRevision >= earliestRevision && !matched;
      issuedRevision -= 1n
    ) {
      for (let effectOrdinal = 0; effectOrdinal < 32; effectOrdinal += 1) {
        if (
          call.callId ===
          deriveCallId({
            operationId: payload.operationId,
            checkpointRevision: String(issuedRevision),
            effectOrdinal: String(effectOrdinal),
            operationName: call.operation,
          })
        ) {
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      fail("CALL_ID_MISMATCH", `pending call ${pendingIndex} has an invalid callId`);
    }
  });
}

export function createCheckpoint(
  payload: OperationCheckpointPayload,
): OperationCheckpoint {
  // Ownership means immutable JSON only. Full Schema and binding validation
  // still run below before verifiedSnapshot records protocol validity.
  const clonedPayload = deepFreeze(cloneJson(payload));
  const checkpoint = {
    payload: clonedPayload,
    checkpointHash: hashCanonical(clonedPayload),
  };
  assertValidTws("operationCheckpoint", checkpoint);
  verifyInternalBindings(checkpoint);
  return verifiedSnapshot(checkpoint);
}

export function verifyCheckpoint(
  checkpoint: OperationCheckpoint,
  expectedRelease: ProtocolReleaseIdentity = TWS_RELEASE,
): OperationCheckpoint {
  if (verifiedSnapshots.has(checkpoint)) {
    if (!sameJson(checkpoint.payload.release, expectedRelease)) {
      fail("RELEASE_MISMATCH", "checkpoint release differs from the loaded Core release");
    }
    return checkpoint;
  }
  const cloned = cloneJson(checkpoint);
  assertValidTws("operationCheckpoint", cloned);
  verifyInternalBindings(cloned);
  if (hashCanonical(cloned.payload) !== cloned.checkpointHash) {
    fail("CHECKPOINT_HASH_MISMATCH", "checkpointHash does not bind its payload");
  }
  if (!sameJson(cloned.payload.release, expectedRelease)) {
    fail("RELEASE_MISMATCH", "checkpoint release differs from the loaded Core release");
  }
  return verifiedSnapshot(cloned);
}

const IMMUTABLE_BASE_FIELDS = [
  "release",
  "releaseFingerprint",
  "operationId",
  "requestId",
  "operation",
  "context",
  "contextHash",
  "session",
] as const;

const NESTED_MONOTONIC_FIELDS = new Set([
  "permissionCommit",
  "broadcastProgress",
  "workflowProgress",
]);

function isPrefix(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return (
    previous.length <= next.length &&
    previous.every((value, index) => sameJson(value, next[index]))
  );
}

const WORKFLOW_STATUS_ORDER = Object.freeze({
  pending: 0,
  signing: 1,
  finalized: 2,
  completed: 3,
  failed: 3,
  skipped: 3,
} as const);

function isNestedMonotonic(
  previous: unknown,
  next: unknown,
  key?: string,
): boolean {
  if (
    typeof previous === "number" &&
    typeof next === "number" &&
    Number.isSafeInteger(previous) &&
    Number.isSafeInteger(next)
  ) {
    return next >= previous;
  }
  if (Array.isArray(previous)) {
    if (key === "steps") {
      return (
        Array.isArray(next) &&
        previous.length === next.length &&
        previous.every((value, index) =>
          isNestedMonotonic(value, next[index]),
        )
      );
    }
    return Array.isArray(next) && isPrefix(previous, next);
  }
  if (
    key === "status" &&
    typeof previous === "string" &&
    typeof next === "string" &&
    previous in WORKFLOW_STATUS_ORDER &&
    next in WORKFLOW_STATUS_ORDER
  ) {
    return (
      WORKFLOW_STATUS_ORDER[next as keyof typeof WORKFLOW_STATUS_ORDER] >=
      WORKFLOW_STATUS_ORDER[previous as keyof typeof WORKFLOW_STATUS_ORDER]
    );
  }
  if (
    previous !== null &&
    next !== null &&
    typeof previous === "object" &&
    typeof next === "object" &&
    !Array.isArray(next)
  ) {
    const nextRecord = next as Record<string, unknown>;
    return Object.entries(previous as Record<string, unknown>).every(
      ([key, value]) =>
        key in nextRecord &&
        (sameJson(value, nextRecord[key]) ||
          isNestedMonotonic(value, nextRecord[key], key)),
    );
  }
  return sameJson(previous, next);
}

function assertMemoryMonotonic(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): void {
  for (const [field, previousValue] of Object.entries(previous)) {
    if (!(field in next)) {
      fail("MEMORY_NOT_MONOTONIC", `checkpoint memory removed ${field}`);
    }
    const nextValue = next[field];
    if (field === "trustedTime") {
      if (
        typeof previousValue !== "string" ||
        typeof nextValue !== "string" ||
        Date.parse(nextValue) < Date.parse(previousValue)
      ) {
        fail("MEMORY_NOT_MONOTONIC", "checkpoint trusted time moved backwards");
      }
      continue;
    }
    if (Array.isArray(previousValue)) {
      if (!Array.isArray(nextValue) || !isPrefix(previousValue, nextValue)) {
        fail("MEMORY_NOT_MONOTONIC", `checkpoint memory rewrote ${field}`);
      }
      continue;
    }
    if (
      NESTED_MONOTONIC_FIELDS.has(field) &&
      isNestedMonotonic(previousValue, nextValue)
    ) {
      continue;
    }
    if (!sameJson(previousValue, nextValue)) {
      fail("MEMORY_NOT_MONOTONIC", `checkpoint memory rewrote ${field}`);
    }
  }
}

export function advanceCheckpoint(
  previousCheckpoint: OperationCheckpoint,
  nextPayload: OperationCheckpointPayload,
  expectedRelease: ProtocolReleaseIdentity = TWS_RELEASE,
): OperationCheckpoint {
  const previous = verifyCheckpoint(previousCheckpoint, expectedRelease);
  const nextRevision = BigInt(nextPayload.revision);
  if (nextRevision !== BigInt(previous.payload.revision) + 1n) {
    fail("REVISION_NOT_MONOTONIC", "checkpoint revision must increase by exactly one");
  }
  if (nextPayload.previousCheckpointHash !== previous.checkpointHash) {
    fail("PREDECESSOR_MISMATCH", "checkpoint does not reference its exact predecessor");
  }
  for (const field of IMMUTABLE_BASE_FIELDS) {
    if (!sameJson(previous.payload[field], nextPayload[field])) {
      fail("CHECKPOINT_BASE_CHANGED", `checkpoint changed immutable ${field}`);
    }
  }
  if (
    previous.payload.createdAt !== undefined &&
    previous.payload.createdAt !== nextPayload.createdAt
  ) {
    fail("CHECKPOINT_BASE_CHANGED", "checkpoint changed createdAt");
  }
  if (
    previous.payload.expiresAt !== undefined &&
    nextPayload.expiresAt !== undefined &&
    Date.parse(nextPayload.expiresAt) > Date.parse(previous.payload.expiresAt)
  ) {
    fail("EXPIRY_EXTENDED", "checkpoint expiresAt cannot be extended");
  }
  if (
    previous.payload.updatedAt !== undefined &&
    nextPayload.updatedAt !== undefined &&
    Date.parse(nextPayload.updatedAt) < Date.parse(previous.payload.updatedAt)
  ) {
    fail("CHECKPOINT_BASE_CHANGED", "checkpoint updatedAt moved backwards");
  }
  assertMemoryMonotonic(previous.payload.memory, nextPayload.memory);
  const next = createCheckpoint(nextPayload);
  // createCheckpoint has already cloned, hashed, validated and frozen this
  // output. Only the caller's expected-release check remains; do not repeat
  // serialization and verification of our own immutable result.
  if (!sameJson(next.payload.release, expectedRelease)) {
    fail("RELEASE_MISMATCH", "checkpoint release differs from the loaded Core release");
  }
  return next;
}
