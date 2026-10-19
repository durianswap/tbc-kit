import {
  assertPortResult,
  assertProviderCommitAcknowledgment,
  assertValidTws,
  canonicalize,
  utf8,
  validateAuthoritySnapshot,
  type PortCall,
  type PortOperation,
  type PortResponse,
  type SchemaCoreTransition,
} from "@tbc-wallet/core";
import { TwsHostError } from "./errors.js";
import {
  deriveHostAuthorityIdentity,
  deriveHostCallIdentity,
  deriveHostCompletionIdentity,
  deriveHostDeliveryId,
  deriveHostSessionCommitIdentity,
  deriveHostTransitionIdentity,
} from "./identity.js";
import type {
  TwsHostCallRecord,
  TwsHostDeliveryRecord,
  TwsHostLeaseRecord,
  TwsHostOperationRecord,
  TwsHostSessionCommitRecord,
} from "./store.js";

export const TWS_HOST_SQLITE_MAX_CANONICAL_JSON_BYTES = 4 * 1024 * 1024;

const TERMINAL_STATES = new Set(["completed", "rejected", "failed", "cancelled"]);

function corrupt(): never {
  throw new TwsHostError(
    "HOST_STORE_CORRUPT",
    "A SQLite Host Store record failed durable journal validation.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function decodeCanonical<T>(
  canonicalJson: unknown,
  validate: (value: unknown) => T,
): T {
  try {
    if (
      typeof canonicalJson !== "string" ||
      utf8(canonicalJson).length > TWS_HOST_SQLITE_MAX_CANONICAL_JSON_BYTES
    ) {
      return corrupt();
    }
    const parsed: unknown = JSON.parse(canonicalJson);
    if (canonicalize(parsed) !== canonicalJson) return corrupt();
    return deepFreeze(validate(parsed));
  } catch (error) {
    if (error instanceof TwsHostError && error.code === "HOST_STORE_CORRUPT") {
      throw error;
    }
    return corrupt();
  }
}

export function encodeSqliteCanonicalJson(value: unknown): string {
  try {
    const canonicalJson = canonicalize(value);
    if (utf8(canonicalJson).length > TWS_HOST_SQLITE_MAX_CANONICAL_JSON_BYTES) {
      return corrupt();
    }
    return canonicalJson;
  } catch (error) {
    if (error instanceof TwsHostError && error.code === "HOST_STORE_CORRUPT") {
      throw error;
    }
    return corrupt();
  }
}

function assertTransition(value: SchemaCoreTransition): void {
  try {
    assertValidTws("coreTransition", value);
  } catch {
    corrupt();
  }
}

function assertResponse<K extends PortOperation>(
  call: PortCall<K>,
  response: PortResponse<K>,
): void {
  try {
    assertValidTws("portResponse", response);
    if (response.callId !== call.callId) throw new TypeError("callId mismatch");
    if (response.result !== undefined) {
      assertPortResult(call.operation, response.result);
    }
  } catch {
    corrupt();
  }
}

function checkedOperation(value: unknown): TwsHostOperationRecord {
  if (!isRecord(value) || !isRecord(value.transition)) corrupt();
  const record = value as unknown as TwsHostOperationRecord;
  assertTransition(record.transition);
  const expectedTerminal =
    record.transition.kind === "complete" ||
    TERMINAL_STATES.has(String(record.transition.checkpoint.payload.state));
  if (
    record.operationId !== record.transition.checkpoint.payload.operationId ||
    record.checkpointHash !== record.transition.checkpoint.checkpointHash ||
    record.revision !== record.transition.checkpoint.payload.revision ||
    record.releaseFingerprint !== record.transition.checkpoint.payload.releaseFingerprint ||
    record.transitionIdentity !== deriveHostTransitionIdentity(record.transition) ||
    record.transitionKind !== record.transition.kind ||
    !/^(0|[1-9][0-9]*)$/.test(record.storeRevision) ||
    record.terminal !== expectedTerminal ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    corrupt();
  }
  return record;
}

function checkedCall(value: unknown): TwsHostCallRecord {
  if (!isRecord(value) || !isRecord(value.call)) corrupt();
  const record = value as unknown as TwsHostCallRecord;
  if (
    record.callId !== record.call.callId ||
    record.operation !== record.call.operation ||
    record.identity !== deriveHostCallIdentity(record.call) ||
    typeof record.operationId !== "string" ||
    record.operationId.length === 0 ||
    !["prepared", "uncertain", "completed"].includes(record.status) ||
    !/^(0|[1-9][0-9]*)$/.test(record.revision) ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    corrupt();
  }
  const hasResponse = record.response !== undefined;
  if ((record.status === "completed") !== hasResponse) corrupt();
  if (hasResponse) assertResponse(record.call, record.response);
  return record;
}

function checkedSession(value: unknown): TwsHostSessionCommitRecord {
  if (
    !isRecord(value) ||
    !isRecord(value.mutation) ||
    !isRecord(value.expectedAuthority)
  ) {
    corrupt();
  }
  const record = value as unknown as TwsHostSessionCommitRecord;
  if (
    record.commitId !== record.mutation.commitId ||
    record.identity !== deriveHostSessionCommitIdentity(record.mutation) ||
    record.expectedAuthorityIdentity !== deriveHostAuthorityIdentity(record.expectedAuthority) ||
    typeof record.operationId !== "string" ||
    record.operationId.length === 0 ||
    !["prepared", "uncertain", "completed"].includes(record.status) ||
    !/^(0|[1-9][0-9]*)$/.test(record.revision) ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    corrupt();
  }
  const hasAcknowledgment = record.acknowledgment !== undefined;
  const hasAuthority = record.authority !== undefined;
  if (
    hasAcknowledgment !== hasAuthority ||
    (record.status === "completed") !== (hasAcknowledgment && hasAuthority)
  ) {
    corrupt();
  }
  try {
    validateAuthoritySnapshot(
      record.expectedAuthority.currentContext,
      record.expectedAuthority.currentSession,
    );
    if (hasAcknowledgment && hasAuthority) {
      validateAuthoritySnapshot(
        record.authority.currentContext,
        record.authority.currentSession,
      );
      assertProviderCommitAcknowledgment(
        record.mutation,
        record.acknowledgment,
        record.authority.currentSession,
      );
    }
  } catch {
    corrupt();
  }
  return record;
}

function checkedDelivery(value: unknown): TwsHostDeliveryRecord {
  if (!isRecord(value) || !isRecord(value.completion)) corrupt();
  const record = value as unknown as TwsHostDeliveryRecord;
  const completionIdentity = deriveHostCompletionIdentity(record.completion);
  if (
    typeof record.operationId !== "string" ||
    record.operationId.length === 0 ||
    record.completionIdentity !== completionIdentity ||
    record.deliveryId !== deriveHostDeliveryId({
      operationId: record.operationId,
      completionIdentity,
    }) ||
    !["pending", "delivered"].includes(record.status) ||
    !/^(0|[1-9][0-9]*)$/.test(record.revision) ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    corrupt();
  }
  return record;
}

function checkedLease(value: unknown): TwsHostLeaseRecord {
  if (!isRecord(value)) corrupt();
  const record = value as unknown as TwsHostLeaseRecord;
  if (
    typeof record.operationId !== "string" ||
    record.operationId.length === 0 ||
    typeof record.ownerId !== "string" ||
    record.ownerId.length === 0 ||
    typeof record.fencingToken !== "string" ||
    !/^[1-9][0-9]*$/.test(record.fencingToken) ||
    typeof record.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(record.expiresAt))
  ) {
    corrupt();
  }
  return record;
}

export const decodeSqliteOperation = (value: unknown): TwsHostOperationRecord =>
  decodeCanonical(value, checkedOperation);

export const decodeSqliteCall = (value: unknown): TwsHostCallRecord =>
  decodeCanonical(value, checkedCall);

export const decodeSqliteSessionCommit = (
  value: unknown,
): TwsHostSessionCommitRecord => decodeCanonical(value, checkedSession);

export const decodeSqliteDelivery = (value: unknown): TwsHostDeliveryRecord =>
  decodeCanonical(value, checkedDelivery);

export const decodeSqliteLease = (value: unknown): TwsHostLeaseRecord =>
  decodeCanonical(value, checkedLease);
