import { canonicalize } from "./canonical-json.js";
import {
  base64urlEncode,
  concatBytes,
  hexToBytes,
  utf8,
} from "./encoding.js";
import { sha256Bytes } from "./hash.js";

const NUL = Uint8Array.of(0);
const HASH32 = /^[0-9a-f]{64}$/;
const DETERMINISTIC_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;
const TBC_CHAIN_ID = /^tbc:[a-z0-9_-]{1,32}$/;

function digestId(...parts: readonly Uint8Array[]): string {
  return base64urlEncode(sha256Bytes(concatBytes(...parts)));
}

function hash32Bytes(value: string, label: string): Uint8Array {
  if (!HASH32.test(value)) throw new TypeError(`${label} must be lowercase Hash32`);
  return hexToBytes(value);
}

function assertOperationId(value: string): void {
  if (!DETERMINISTIC_ID.test(value)) {
    throw new TypeError("operationId must encode exactly 32 bytes as base64url");
  }
}

function assertCanonicalDecimal(value: string, label: string): void {
  if (!CANONICAL_DECIMAL.test(value)) {
    throw new TypeError(`${label} must be a canonical decimal string`);
  }
}

export interface OperationIdInput {
  readonly releaseFingerprint: string;
  readonly contextHash: string;
  readonly requestId: unknown;
  readonly operation: unknown;
}

export function deriveOperationId(input: OperationIdInput): string {
  return digestId(
    utf8("TWS/1.0/operation"),
    NUL,
    hash32Bytes(input.releaseFingerprint, "releaseFingerprint"),
    hash32Bytes(input.contextHash, "contextHash"),
    utf8(canonicalize(input.requestId)),
    NUL,
    utf8(canonicalize(input.operation)),
  );
}

export interface CallIdInput {
  readonly operationId: string;
  readonly checkpointRevision: string;
  readonly effectOrdinal: string;
  readonly operationName: string;
}

export function deriveCallId(input: CallIdInput): string {
  assertOperationId(input.operationId);
  assertCanonicalDecimal(input.checkpointRevision, "checkpointRevision");
  assertCanonicalDecimal(input.effectOrdinal, "effectOrdinal");
  if (typeof input.operationName !== "string" || input.operationName.length === 0) {
    throw new TypeError("operationName must be a non-empty string");
  }
  return digestId(
    utf8("TWS/1.0/port-call"),
    NUL,
    utf8(input.operationId),
    NUL,
    utf8(input.checkpointRevision),
    NUL,
    utf8(input.effectOrdinal),
    NUL,
    utf8(input.operationName),
  );
}

export interface PermissionIdInput {
  readonly operationId: string;
  readonly chainId: string;
  readonly parentCapability: string;
  readonly ordinal: number;
}

export function derivePermissionId(input: PermissionIdInput): string {
  assertOperationId(input.operationId);
  if (!TBC_CHAIN_ID.test(input.chainId)) {
    throw new TypeError("chainId must be a TBC Chain ID");
  }
  if (
    typeof input.parentCapability !== "string" ||
    input.parentCapability.length === 0
  ) {
    throw new TypeError("parentCapability must be a non-empty capability name");
  }
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new TypeError("ordinal must be a non-negative safe integer");
  }
  return digestId(
    utf8("TWS/1.0/permission"),
    NUL,
    utf8(input.operationId),
    NUL,
    utf8(input.chainId),
    NUL,
    utf8(input.parentCapability),
    NUL,
    utf8(String(input.ordinal)),
  );
}

export interface BroadcastIdempotencyKeyInput {
  readonly operationId: string;
  readonly txid: string;
}

export function deriveBroadcastIdempotencyKey(
  input: BroadcastIdempotencyKeyInput,
): string {
  assertOperationId(input.operationId);
  if (!HASH32.test(input.txid)) {
    throw new TypeError("txid must be lowercase 32-byte hex");
  }
  return digestId(
    utf8("TWS/1.0/broadcast"),
    NUL,
    utf8(input.operationId),
    NUL,
    hexToBytes(input.txid),
  );
}

export interface ProviderCommitIdInput {
  readonly operationId: string;
  readonly checkpointRevision: string;
  readonly mutationPayload: unknown;
}

export function deriveProviderCommitId(input: ProviderCommitIdInput): string {
  assertOperationId(input.operationId);
  assertCanonicalDecimal(input.checkpointRevision, "checkpointRevision");
  if (
    input.mutationPayload === null ||
    typeof input.mutationPayload !== "object" ||
    Array.isArray(input.mutationPayload)
  ) {
    throw new TypeError("mutationPayload must be an object");
  }
  return digestId(
    utf8("TWS/1.0/provider-commit"),
    NUL,
    utf8(input.operationId),
    NUL,
    utf8(input.checkpointRevision),
    NUL,
    utf8(canonicalize(input.mutationPayload)),
  );
}
