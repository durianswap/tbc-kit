import { canonicalize, hashCanonical } from "@tbc-wallet/core";

const HASH32 = /^[0-9a-f]{64}$/u;
const HEX = /^(?:[0-9a-fA-F]{2})+$/u;
const MAX_SERIALIZED_BYTES = 4 * 1024 * 1024;
const MAX_ASSOCIATED_CHILDREN = 32;
const FORBIDDEN_SECRET_FIELDS = Object.freeze([
  ["private", "KeyHex"].join(""),
  ["private", "_key"].join(""),
  ["sca", "lar"].join(""),
]);

export type LegacyAssociatedTransactionResult = Readonly<{
  txraws: readonly string[];
}>;

export interface LegacyAssociatedTransactionExecutor {
  /**
   * Wallet-private execution after the controller has received an explicit
   * approval. The operation digest and public request are the only values that
   * cross this boundary; key material stays inside the platform bridge.
   */
  readonly execute: (input: Readonly<{
    operationDigest: string;
    request: Readonly<Record<string, unknown>>;
  }>) => Promise<unknown>;
}

export type LegacyAssociatedTransactionJournalRecord = Readonly<{
  operationDigest: string;
  state: "prepared" | "completed";
  requestJson: string;
  resultDigest: string | null;
  resultJson: string | null;
}>;

/**
 * Wallet/platform-owned durable storage. Implementations must make prepare and
 * complete atomic and return either the inserted record or the exact existing
 * record. Kit validates every returned byte before using it.
 */
export interface LegacyAssociatedTransactionJournal {
  readonly read: (
    operationDigest: string,
  ) => Promise<LegacyAssociatedTransactionJournalRecord | null>;
  readonly prepare: (
    record: LegacyAssociatedTransactionJournalRecord,
  ) => Promise<LegacyAssociatedTransactionJournalRecord>;
  readonly complete: (
    record: LegacyAssociatedTransactionJournalRecord,
  ) => Promise<LegacyAssociatedTransactionJournalRecord>;
}

export interface LegacyAssociatedTransactionService {
  readonly prepare: (request: unknown) => Promise<
    Readonly<{
      operationDigest: string;
      transactionCount: number;
    }>
  >;
  /** Read the validated public transaction material for a wallet-private Signer. */
  readonly readRequest: (
    operationDigest: string,
  ) => Promise<Readonly<Record<string, unknown>> | null>;
  /** Validate and durably record output produced by the wallet-private Signer. */
  readonly complete: (
    operationDigest: string,
    result: unknown,
  ) => Promise<LegacyAssociatedTransactionResult>;
  readonly read: (
    operationDigest: string,
  ) => Promise<LegacyAssociatedTransactionResult | null>;
}

export class LegacyAssociatedTransactionConflictError extends Error {
  override readonly name = "LegacyAssociatedTransactionConflictError";
}

function conflict(message: string): never {
  throw new LegacyAssociatedTransactionConflictError(message);
}

function frozenCanonicalClone<T>(value: T, message: string): T {
  let cloned: unknown;
  try {
    cloned = JSON.parse(canonicalize(value));
  } catch {
    return conflict(message);
  }
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
    for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
    Object.freeze(item);
  };
  freeze(cloned);
  return cloned as T;
}

function parseCanonical<T>(serialized: string, message: string): T {
  if (
    typeof serialized !== "string" ||
    new TextEncoder().encode(serialized).length > MAX_SERIALIZED_BYTES * 2
  ) {
    return conflict(message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return conflict(message);
  }
  try {
    if (canonicalize(parsed) !== serialized) return conflict(message);
  } catch {
    return conflict(message);
  }
  return frozenCanonicalClone(parsed, message) as T;
}

export function normalizeLegacyAssociatedTransactionRequest(
  request: unknown,
): Readonly<Record<string, unknown>> {
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.getPrototypeOf(request) !== Object.prototype
  ) {
    return conflict("Invalid Legacy associated transaction");
  }
  const value = frozenCanonicalClone(
    request as Record<string, unknown>,
    "Invalid Legacy associated transaction",
  );
  const sourceTxraw = Reflect.get(value, "sourceTxraw");
  const sourceUtxos = Reflect.get(value, "sourceUtxos");
  const inputs = Reflect.get(value, "inputs");
  const outputs = Reflect.get(value, "outputs");
  if (
    FORBIDDEN_SECRET_FIELDS.some((field) => Object.hasOwn(value, field)) ||
    typeof sourceTxraw !== "string" ||
    !HEX.test(sourceTxraw) ||
    !Array.isArray(sourceUtxos) ||
    sourceUtxos.length > 1_000 ||
    (inputs === undefined) !== (outputs === undefined) ||
    (inputs !== undefined &&
      (!Array.isArray(inputs) ||
        !Array.isArray(outputs) ||
        inputs.length !== outputs.length ||
        inputs.length > MAX_ASSOCIATED_CHILDREN)) ||
    new TextEncoder().encode(canonicalize(value)).length > MAX_SERIALIZED_BYTES
  ) {
    return conflict("Invalid Legacy associated transaction");
  }
  return value;
}

export function normalizeLegacyAssociatedTransactionResult(
  result: unknown,
): LegacyAssociatedTransactionResult {
  let candidate = result;
  if (typeof result === "string") {
    try {
      candidate = JSON.parse(result);
    } catch {
      return conflict("Invalid Legacy associated transaction result");
    }
  }
  const value = frozenCanonicalClone(
    candidate,
    "Invalid Legacy associated transaction result",
  );
  const txraws =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Reflect.get(value, "txraws")
      : undefined;
  if (
    !Array.isArray(txraws) ||
    txraws.length === 0 ||
    txraws.length > MAX_ASSOCIATED_CHILDREN + 1 ||
    txraws.some((raw) => typeof raw !== "string" || !HEX.test(raw)) ||
    new TextEncoder().encode(canonicalize(value)).length >
      MAX_SERIALIZED_BYTES * 2
  ) {
    return conflict("Invalid Legacy associated transaction result");
  }
  return Object.freeze({ txraws: Object.freeze([...txraws]) });
}

function transactionCount(request: Readonly<Record<string, unknown>>): number {
  const inputs = Reflect.get(request, "inputs");
  return 1 + (Array.isArray(inputs) ? inputs.length : 0);
}

function validateRecord(
  record: LegacyAssociatedTransactionJournalRecord,
  operationDigest: string,
): Readonly<{
  request: Readonly<Record<string, unknown>>;
  result: LegacyAssociatedTransactionResult | null;
}> {
  if (
    record === null ||
    typeof record !== "object" ||
    record.operationDigest !== operationDigest ||
    !HASH32.test(operationDigest) ||
    (record.state !== "prepared" && record.state !== "completed")
  ) {
    return conflict("Corrupt Legacy associated transaction journal");
  }
  const request = normalizeLegacyAssociatedTransactionRequest(
    parseCanonical(record.requestJson, "Corrupt Legacy associated transaction request"),
  );
  if (hashCanonical({ kind: "signAssociated", request }) !== operationDigest) {
    return conflict("Corrupt Legacy associated transaction identity");
  }
  if (record.state === "prepared") {
    if (record.resultDigest !== null || record.resultJson !== null) {
      return conflict("Corrupt Legacy associated transaction journal");
    }
    return Object.freeze({ request, result: null });
  }
  if (
    typeof record.resultDigest !== "string" ||
    !HASH32.test(record.resultDigest) ||
    typeof record.resultJson !== "string"
  ) {
    return conflict("Corrupt Legacy associated transaction journal");
  }
  const result = normalizeLegacyAssociatedTransactionResult(
    parseCanonical(record.resultJson, "Corrupt Legacy associated transaction result"),
  );
  if (hashCanonical(result) !== record.resultDigest) {
    return conflict("Corrupt Legacy associated transaction result");
  }
  return Object.freeze({ request, result });
}

/**
 * Shared associated-transaction preparation and result service. It never
 * accepts a private key or scalar and never invokes a native signer.
 */
export function createLegacyAssociatedTransactionService(options: Readonly<{
  journal: LegacyAssociatedTransactionJournal;
}>): LegacyAssociatedTransactionService {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.journal?.read !== "function" ||
    typeof options.journal.prepare !== "function" ||
    typeof options.journal.complete !== "function"
  ) {
    throw new TypeError("Legacy associated transaction journal is required");
  }

  async function readValidated(operationDigest: string) {
    if (!HASH32.test(operationDigest)) return null;
    const record = await options.journal.read(operationDigest);
    return record === null ? null : validateRecord(record, operationDigest);
  }

  async function prepare(requestInput: unknown) {
    const request = normalizeLegacyAssociatedTransactionRequest(requestInput);
    const operationDigest = hashCanonical({ kind: "signAssociated", request });
    const requestJson = canonicalize(request);
    const record = await options.journal.prepare(Object.freeze({
      operationDigest,
      state: "prepared" as const,
      requestJson,
      resultDigest: null,
      resultJson: null,
    }));
    const validated = validateRecord(record, operationDigest);
    if (canonicalize(validated.request) !== requestJson) {
      return conflict("Legacy associated transaction journal collision");
    }
    return Object.freeze({
      operationDigest,
      transactionCount: transactionCount(request),
    });
  }

  async function readRequest(operationDigest: string) {
    return (await readValidated(operationDigest))?.request ?? null;
  }

  async function read(operationDigest: string) {
    return (await readValidated(operationDigest))?.result ?? null;
  }

  async function complete(operationDigest: string, resultInput: unknown) {
    const existing = await readValidated(operationDigest);
    if (existing === null) {
      return conflict("Unknown Legacy associated transaction");
    }
    const result = normalizeLegacyAssociatedTransactionResult(resultInput);
    if (existing.result !== null) {
      if (canonicalize(existing.result) !== canonicalize(result)) {
        return conflict("Legacy associated transaction completion conflict");
      }
      return existing.result;
    }
    const resultJson = canonicalize(result);
    const record = await options.journal.complete(Object.freeze({
      operationDigest,
      state: "completed" as const,
      requestJson: canonicalize(existing.request),
      resultDigest: hashCanonical(result),
      resultJson,
    }));
    const validated = validateRecord(record, operationDigest);
    if (
      validated.result === null ||
      canonicalize(validated.result) !== resultJson
    ) {
      return conflict("Legacy associated transaction completion conflict");
    }
    return validated.result;
  }

  return Object.freeze({ prepare, readRequest, complete, read });
}
