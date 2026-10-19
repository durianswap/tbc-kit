import {
  assertPortResult,
  assertProviderCommitAcknowledgment,
  assertValidTws,
  canonicalize,
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
  TwsHostStore,
  TwsHostTransitionCommitResult,
} from "./store.js";
import type {
  TwsAuthoritySnapshot,
  TwsProviderSessionMutation,
} from "./types.js";

export const TWS_HOST_INDEXEDDB_STORES = Object.freeze([
  "operations",
  "calls",
  "sessionCommits",
  "deliveries",
  "leases",
] as const);

type StoreName = (typeof TWS_HOST_INDEXEDDB_STORES)[number];

export interface TwsIndexedDbHostStoreOptions {
  readonly factory: IDBFactory;
  readonly databaseName: string;
  readonly now?: () => number;
}

interface LeaseValue {
  readonly key: string;
  readonly kind: "lease";
  readonly active?: boolean;
  readonly value: TwsHostLeaseRecord;
}

interface StoredLeaseValue {
  readonly active: boolean;
  readonly lease: TwsHostLeaseRecord;
}

interface CounterValue {
  readonly key: string;
  readonly kind: "counter";
  readonly value: string;
}

const DATABASE_VERSION = 1;
const MAX_LEASE_TTL_MS = 86_400_000;
const TERMINAL_STATES = new Set(["completed", "rejected", "failed", "cancelled"]);

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(canonicalize(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot<T>(value: T): T {
  return deepFreeze(clone(value));
}

function same(left: object, right: object): boolean {
  return canonicalize(left) === canonicalize(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nextRevision(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TwsHostError(
      "HOST_STORE_CORRUPT",
      "A durable journal revision is invalid.",
    );
  }
  try {
    return String(BigInt(value) + 1n);
  } catch {
    throw new TwsHostError(
      "HOST_STORE_CORRUPT",
      "A durable journal revision is invalid.",
    );
  }
}

function conflict(message: string, operationId?: string): never {
  throw new TwsHostError("HOST_STORE_CONFLICT", message, {
    retryable: true,
    ...(operationId === undefined ? {} : { metadata: { operationId } }),
  });
}

function corrupt(message: string, operationId?: string): never {
  throw new TwsHostError("HOST_STORE_CORRUPT", message, {
    ...(operationId === undefined ? {} : { metadata: { operationId } }),
  });
}

function assertIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertTtl(ttlMs: number): void {
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_LEASE_TTL_MS
  ) {
    throw new TypeError("Host lease ttlMs must be a positive safe integer up to one day");
  }
}

function assertTransition(value: SchemaCoreTransition): void {
  try {
    assertValidTws("coreTransition", value);
  } catch {
    corrupt("A Core transition failed the frozen TWS Schema.");
  }
}

function assertResponse<K extends PortOperation>(
  call: PortCall<K>,
  response: PortResponse<K>,
): void {
  try {
    assertValidTws("portResponse", response);
    if (response.callId !== call.callId) throw new TypeError("callId mismatch");
    if (response.result !== undefined) assertPortResult(call.operation, response.result);
  } catch {
    corrupt("A Host Port response failed its registered result Schema.");
  }
}

function checkedOperation(value: unknown): TwsHostOperationRecord {
  if (!isRecord(value) || !isRecord(value.transition)) {
    corrupt("An IndexedDB operation record is malformed.");
  }
  const record = value as unknown as TwsHostOperationRecord;
  assertTransition(record.transition);
  const expectedTerminal =
    record.transition.kind === "complete" ||
    TERMINAL_STATES.has(String(record.transition.checkpoint.payload.state));
  if (
    record.operationId !== record.transition.checkpoint.payload.operationId ||
    record.checkpointHash !== record.transition.checkpoint.checkpointHash ||
    record.revision !== record.transition.checkpoint.payload.revision ||
    record.releaseFingerprint !==
      record.transition.checkpoint.payload.releaseFingerprint ||
    record.transitionIdentity !== deriveHostTransitionIdentity(record.transition) ||
    record.transitionKind !== record.transition.kind ||
    !/^(0|[1-9][0-9]*)$/.test(record.storeRevision) ||
    record.terminal !== expectedTerminal ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    corrupt("An IndexedDB operation record has inconsistent bindings.");
  }
  return snapshot(record);
}

function checkedCall(value: unknown): TwsHostCallRecord {
  if (!isRecord(value) || !isRecord(value.call)) {
    corrupt("An IndexedDB call record is malformed.");
  }
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
    corrupt("An IndexedDB call record has inconsistent bindings.");
  }
  const hasResponse = record.response !== undefined;
  if ((record.status === "completed") !== hasResponse) {
    corrupt("An IndexedDB call has an impossible journal state.");
  }
  if (hasResponse) assertResponse(record.call, record.response);
  return snapshot(record);
}

function checkedSession(value: unknown): TwsHostSessionCommitRecord {
  if (!isRecord(value) || !isRecord(value.mutation) || !isRecord(value.expectedAuthority)) {
    corrupt("An IndexedDB session commit record is malformed.");
  }
  const record = value as unknown as TwsHostSessionCommitRecord;
  if (
    record.commitId !== record.mutation.commitId ||
    record.identity !== deriveHostSessionCommitIdentity(record.mutation) ||
    record.expectedAuthorityIdentity !==
      deriveHostAuthorityIdentity(record.expectedAuthority) ||
    typeof record.operationId !== "string" ||
    record.operationId.length === 0 ||
    !["prepared", "uncertain", "completed"].includes(record.status) ||
    !/^(0|[1-9][0-9]*)$/.test(record.revision) ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    corrupt("An IndexedDB session commit has inconsistent bindings.");
  }
  const hasAcknowledgment = record.acknowledgment !== undefined;
  const hasAuthority = record.authority !== undefined;
  if (
    hasAcknowledgment !== hasAuthority ||
    (record.status === "completed") !== (hasAcknowledgment && hasAuthority)
  ) {
    corrupt("An IndexedDB session commit has an impossible journal state.");
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
    corrupt("An IndexedDB session commit failed authority validation.");
  }
  return snapshot(record);
}

function checkedDelivery(value: unknown): TwsHostDeliveryRecord {
  if (!isRecord(value) || !isRecord(value.completion)) {
    corrupt("An IndexedDB delivery record is malformed.");
  }
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
    corrupt("An IndexedDB delivery record has inconsistent bindings.");
  }
  return snapshot(record);
}

function checkedLease(value: unknown): TwsHostLeaseRecord {
  if (!isRecord(value)) corrupt("An IndexedDB lease record is malformed.");
  const lease = value as unknown as TwsHostLeaseRecord;
  if (
    typeof lease.operationId !== "string" ||
    lease.operationId.length === 0 ||
    typeof lease.ownerId !== "string" ||
    lease.ownerId.length === 0 ||
    typeof lease.fencingToken !== "string" ||
    !/^[1-9][0-9]*$/.test(lease.fencingToken) ||
    typeof lease.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(lease.expiresAt))
  ) {
    corrupt("An IndexedDB lease record is malformed.");
  }
  return snapshot(lease);
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB request failed")),
      { once: true },
    );
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed")),
      { once: true },
    );
  });
}

function openDatabase(factory: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, DATABASE_VERSION);
    } catch {
      reject(new TwsHostError(
        "HOST_STORE_CORRUPT",
        "The IndexedDB Host database could not be opened.",
      ));
      return;
    }
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("operations")) {
        const operations = database.createObjectStore("operations", {
          keyPath: "operationId",
        });
        operations.createIndex("releaseFingerprint", "releaseFingerprint");
      }
      if (!database.objectStoreNames.contains("calls")) {
        const calls = database.createObjectStore("calls", { keyPath: "callId" });
        calls.createIndex("operationId", "operationId");
      }
      if (!database.objectStoreNames.contains("sessionCommits")) {
        const commits = database.createObjectStore("sessionCommits", {
          keyPath: "commitId",
        });
        commits.createIndex("operationId", "operationId");
      }
      if (!database.objectStoreNames.contains("deliveries")) {
        const deliveries = database.createObjectStore("deliveries", {
          keyPath: "operationId",
        });
        deliveries.createIndex("deliveryId", "deliveryId", { unique: true });
      }
      if (!database.objectStoreNames.contains("leases")) {
        const leases = database.createObjectStore("leases", { keyPath: "key" });
        leases.createIndex("kind", "kind");
      }
    });
    request.addEventListener(
      "success",
      () => {
        const openedDatabase = request.result;
        openedDatabase.addEventListener("versionchange", () => openedDatabase.close());
        resolve(openedDatabase);
      },
      { once: true },
    );
    request.addEventListener(
      "blocked",
      () => reject(new TwsHostError(
        "HOST_STORE_CONFLICT",
        "The IndexedDB Host database upgrade is blocked.",
        { retryable: true },
      )),
      { once: true },
    );
    request.addEventListener(
      "error",
      () => reject(new TwsHostError(
        "HOST_STORE_CORRUPT",
        "The IndexedDB Host database could not be opened.",
      )),
      { once: true },
    );
  });
}

function leaseKey(operationId: string): string {
  return `lease:${operationId}`;
}

function counterKey(operationId: string): string {
  return `counter:${operationId}`;
}

function callsOf(transition: SchemaCoreTransition): readonly PortCall[] {
  return transition.kind === "waiting"
    ? (transition.calls as readonly PortCall[])
    : [];
}

export function createIndexedDbTwsHostStore(
  options: TwsIndexedDbHostStoreOptions,
): TwsHostStore {
  if (typeof options.databaseName !== "string" || options.databaseName.length === 0) {
    throw new TypeError("IndexedDB Host databaseName must be a non-empty string");
  }
  if (options.factory === null || typeof options.factory?.open !== "function") {
    throw new TypeError("IndexedDB Host factory must implement IDBFactory");
  }
  const now = options.now ?? (() => Date.now());
  const database = openDatabase(options.factory, options.databaseName);

  function epoch(): number {
    const value = now();
    if (!Number.isFinite(value)) {
      throw new TypeError("Host store clock must return finite epoch milliseconds");
    }
    return value;
  }

  function timestamp(): string {
    return new Date(epoch()).toISOString();
  }

  async function transaction<T>(
    names: readonly StoreName[],
    mode: IDBTransactionMode,
    work: (value: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    let current: IDBTransaction;
    try {
      current = (await database).transaction([...names], mode);
    } catch (error) {
      if (error instanceof TwsHostError) throw error;
      corrupt("The IndexedDB Host transaction could not start.");
    }
    const completed = transactionCompletion(current);
    let result: T;
    try {
      result = await work(current);
    } catch (error) {
      try {
        current.abort();
      } catch {
        // The transaction may already have aborted; preserve the stable error.
      }
      await completed.catch(() => undefined);
      if (error instanceof TwsHostError || error instanceof TypeError) throw error;
      corrupt("The IndexedDB Host transaction failed.");
    }
    try {
      await completed;
    } catch {
      corrupt("The IndexedDB Host transaction failed.");
    }
    return snapshot(result);
  }

  async function readLease(
    current: IDBTransaction,
    operationId: string,
  ): Promise<StoredLeaseValue | null> {
    const raw = await requestValue<LeaseValue | undefined>(
      current.objectStore("leases").get(leaseKey(operationId)),
    );
    if (raw === undefined) return null;
    if (
      raw.kind !== "lease" ||
      raw.key !== leaseKey(operationId) ||
      (raw.active !== undefined && typeof raw.active !== "boolean")
    ) {
      corrupt("An IndexedDB lease wrapper is malformed.", operationId);
    }
    const lease = checkedLease(raw.value);
    if (lease.operationId !== operationId) {
      corrupt("An IndexedDB lease wrapper has inconsistent bindings.", operationId);
    }
    return { active: raw.active ?? true, lease };
  }

  async function currentLease(
    current: IDBTransaction,
    input: TwsHostLeaseRecord,
  ): Promise<TwsHostLeaseRecord> {
    const stored = await readLease(current, input.operationId);
    if (
      stored === null ||
      !stored.active ||
      stored.lease.ownerId !== input.ownerId ||
      stored.lease.fencingToken !== input.fencingToken ||
      Date.parse(stored.lease.expiresAt) <= epoch()
    ) {
      conflict("The Host lease is absent, expired, or fenced.", input.operationId);
    }
    return stored.lease;
  }

  async function readCallIn(
    current: IDBTransaction,
    callId: string,
  ): Promise<TwsHostCallRecord | null> {
    const raw = await requestValue<unknown>(current.objectStore("calls").get(callId));
    return raw === undefined ? null : checkedCall(raw);
  }

  async function readSessionIn(
    current: IDBTransaction,
    commitId: string,
  ): Promise<TwsHostSessionCommitRecord | null> {
    const raw = await requestValue<unknown>(
      current.objectStore("sessionCommits").get(commitId),
    );
    return raw === undefined ? null : checkedSession(raw);
  }

  async function markCallUncertain<K extends PortOperation>(input: {
    readonly lease: TwsHostLeaseRecord;
    readonly call: PortCall<K>;
  }): Promise<TwsHostCallRecord<K>> {
    return transaction(["leases", "calls"], "readwrite", async (current) => {
      await currentLease(current, input.lease);
      const previous = await readCallIn(current, input.call.callId) as
        | TwsHostCallRecord<K>
        | null;
      if (
        previous === null ||
        previous.operationId !== input.lease.operationId ||
        previous.identity !== deriveHostCallIdentity(input.call)
      ) {
        conflict(
          "The Host call identity does not match its durable intent.",
          input.lease.operationId,
        );
      }
      if (previous.status === "completed" || previous.status === "uncertain") {
        return previous;
      }
      const record = snapshot({
        ...previous,
        status: "uncertain" as const,
        revision: nextRevision(previous.revision),
        updatedAt: timestamp(),
      });
      await requestValue(current.objectStore("calls").put(record));
      return record;
    });
  }

  async function completeCall<K extends PortOperation>(input: {
    readonly lease: TwsHostLeaseRecord;
    readonly call: PortCall<K>;
    readonly response: PortResponse<K>;
  }): Promise<TwsHostCallRecord<K>> {
    return transaction(["leases", "calls"], "readwrite", async (current) => {
      await currentLease(current, input.lease);
      const previous = await readCallIn(current, input.call.callId) as
        | TwsHostCallRecord<K>
        | null;
      if (
        previous === null ||
        previous.operationId !== input.lease.operationId ||
        previous.identity !== deriveHostCallIdentity(input.call)
      ) {
        conflict(
          "The Host call identity does not match its durable intent.",
          input.lease.operationId,
        );
      }
      assertResponse(input.call, input.response);
      if (previous.status === "completed") {
        if (previous.response === undefined || !same(previous.response, input.response)) {
          conflict("A completed call response cannot be replaced.", previous.operationId);
        }
        return previous;
      }
      if (previous.status !== "uncertain") {
        conflict("A Host call must be uncertain before it can complete.", previous.operationId);
      }
      const record = snapshot({
        ...previous,
        status: "completed" as const,
        response: input.response,
        revision: nextRevision(previous.revision),
        updatedAt: timestamp(),
      }) as TwsHostCallRecord<K>;
      await requestValue(current.objectStore("calls").put(record));
      return record;
    });
  }

  const store: TwsHostStore = {
    storeVersion: "1.0",

    readOperation: async (operationId) => {
      assertIdentity(operationId, "operationId");
      return transaction(["operations"], "readonly", async (current) => {
        const raw = await requestValue<unknown>(
          current.objectStore("operations").get(operationId),
        );
        return raw === undefined ? null : checkedOperation(raw);
      });
    },

    listRecoverable: async (query) => {
      assertIdentity(query.releaseFingerprint, "releaseFingerprint");
      if (
        query.limit !== undefined &&
        (!Number.isSafeInteger(query.limit) || query.limit <= 0)
      ) {
        throw new TypeError("Host recoverable limit must be a positive safe integer");
      }
      return transaction(
        ["operations", "deliveries"],
        "readonly",
        async (current) => {
        const raw = await requestValue<unknown[]>(
          current.objectStore("operations").getAll(),
        );
        const rawDeliveries = await requestValue<unknown[]>(
          current.objectStore("deliveries").getAll(),
        );
        const pending = new Set(
          rawDeliveries
            .map(checkedDelivery)
            .filter(({ status }) => status === "pending")
            .map(({ operationId }) => operationId),
        );
        const records = raw
          .map(checkedOperation)
          .filter(
            (record) =>
              (!record.terminal || pending.has(record.operationId)) &&
              record.releaseFingerprint === query.releaseFingerprint,
          )
          .sort((left, right) =>
            left.operationId < right.operationId
              ? -1
              : left.operationId > right.operationId
                ? 1
                : 0,
          );
        return query.limit === undefined ? records : records.slice(0, query.limit);
        },
      );
    },

    commitTransition: async (input) =>
      transaction(
        TWS_HOST_INDEXEDDB_STORES,
        "readwrite",
        async (current): Promise<TwsHostTransitionCommitResult> => {
          await currentLease(current, input.lease);
          assertTransition(input.transition);
          const transition = snapshot(input.transition);
          const operationId = transition.checkpoint.payload.operationId;
          if (operationId !== input.lease.operationId) {
            conflict("The Core transition belongs to another operation.", operationId);
          }
          const operationStore = current.objectStore("operations");
          const rawPrevious = await requestValue<unknown>(operationStore.get(operationId));
          const previous = rawPrevious === undefined
            ? null
            : checkedOperation(rawPrevious);
          const transitionIdentity = deriveHostTransitionIdentity(transition);
          if (previous?.transitionIdentity === transitionIdentity) {
            const emittedCalls = [];
            for (const call of callsOf(transition)) {
              const record = await readCallIn(current, call.callId);
              if (record === null) corrupt("A transition call intent is missing.", operationId);
              emittedCalls.push(record);
            }
            const sessionCommit = transition.kind === "commit"
              ? await readSessionIn(current, transition.mutation.commitId)
              : null;
            const rawDelivery = transition.kind === "complete"
              ? await requestValue<unknown>(
                  current.objectStore("deliveries").get(operationId),
                )
              : undefined;
            const delivery = rawDelivery === undefined
              ? null
              : checkedDelivery(rawDelivery);
            if (transition.kind === "commit" && sessionCommit === null) {
              corrupt("A transition session intent is missing.", operationId);
            }
            if (transition.kind === "complete" && delivery === null) {
              corrupt("A transition delivery intent is missing.", operationId);
            }
            return {
              operation: previous,
              calls: emittedCalls,
              ...(sessionCommit === null ? {} : { sessionCommit }),
              ...(delivery === null ? {} : { delivery }),
            };
          }

          if (previous === null) {
            if (input.expected !== null) {
              conflict("The initial Host operation CAS must be null.", operationId);
            }
          } else {
            if (previous.terminal) conflict("A terminal Host operation cannot advance.", operationId);
            if (
              input.expected === null ||
              input.expected.storeRevision !== previous.storeRevision ||
              input.expected.checkpointHash !== previous.checkpointHash
            ) {
              conflict("The Host operation compare-and-swap is stale.", operationId);
            }
            if (
              transition.checkpoint.payload.releaseFingerprint !==
              previous.releaseFingerprint
            ) {
              throw new TwsHostError(
                "HOST_RELEASE_MISMATCH",
                "The Core protocol release changed during an operation.",
                { metadata: { operationId } },
              );
            }
            if (
              transition.checkpoint.payload.previousCheckpointHash !==
              previous.checkpointHash
            ) {
              conflict("The Core checkpoint chain is discontinuous.", operationId);
            }
            if (
              BigInt(transition.checkpoint.payload.revision) <= BigInt(previous.revision)
            ) {
              conflict("The Core checkpoint revision did not advance.", operationId);
            }
          }

          const at = timestamp();
          const emittedCalls: TwsHostCallRecord[] = [];
          const callStore = current.objectStore("calls");
          for (const call of callsOf(transition)) {
            const identity = deriveHostCallIdentity(call);
            const existing = await readCallIn(current, call.callId);
            if (existing !== null) {
              if (existing.operationId !== operationId || existing.identity !== identity) {
                conflict("A callId was reused with different canonical content.", operationId);
              }
              emittedCalls.push(existing);
              continue;
            }
            const record = snapshot({
              callId: call.callId,
              operationId,
              operation: call.operation,
              identity,
              call,
              status: "prepared" as const,
              revision: "0",
              createdAt: at,
              updatedAt: at,
            }) as TwsHostCallRecord;
            await requestValue(callStore.put(record));
            emittedCalls.push(record);
          }

          let sessionCommit: TwsHostSessionCommitRecord | undefined;
          if (transition.kind === "commit") {
            const mutation = transition.mutation;
            const identity = deriveHostSessionCommitIdentity(mutation);
            const expectedAuthority = snapshot({
              currentContext: transition.checkpoint.payload.context,
              currentSession: transition.checkpoint.payload.session,
            }) as TwsAuthoritySnapshot;
            const expectedAuthorityIdentity = deriveHostAuthorityIdentity(expectedAuthority);
            const existing = await readSessionIn(current, mutation.commitId);
            if (existing !== null) {
              if (
                existing.operationId !== operationId ||
                existing.identity !== identity ||
                existing.expectedAuthorityIdentity !== expectedAuthorityIdentity
              ) {
                conflict("A commitId was reused with different canonical content.", operationId);
              }
              sessionCommit = existing;
            } else {
              sessionCommit = snapshot({
                commitId: mutation.commitId,
                operationId,
                identity,
                mutation,
                expectedAuthorityIdentity,
                expectedAuthority,
                status: "prepared" as const,
                revision: "0",
                createdAt: at,
                updatedAt: at,
              });
              await requestValue(
                current.objectStore("sessionCommits").put(sessionCommit),
              );
            }
          }

          let delivery: TwsHostDeliveryRecord | undefined;
          if (transition.kind === "complete") {
            const completionIdentity = deriveHostCompletionIdentity(
              transition.completion,
            );
            const deliveryId = deriveHostDeliveryId({
              operationId,
              completionIdentity,
            });
            const deliveryStore = current.objectStore("deliveries");
            const rawExisting = await requestValue<unknown>(
              deliveryStore.get(operationId),
            );
            if (rawExisting !== undefined) {
              const existing = checkedDelivery(rawExisting);
              if (
                existing.deliveryId !== deliveryId ||
                existing.completionIdentity !== completionIdentity
              ) {
                conflict("An operation produced a different completion identity.", operationId);
              }
              delivery = existing;
            } else {
              delivery = snapshot({
                operationId,
                deliveryId,
                completionIdentity,
                completion: transition.completion,
                status: "pending" as const,
                revision: "0",
                createdAt: at,
                updatedAt: at,
              });
              await requestValue(deliveryStore.put(delivery));
            }
          }

          const operation = snapshot({
            operationId,
            transition,
            transitionIdentity,
            transitionKind: transition.kind,
            checkpointHash: transition.checkpoint.checkpointHash,
            revision: transition.checkpoint.payload.revision,
            storeRevision:
              previous === null ? "0" : nextRevision(previous.storeRevision),
            releaseFingerprint: transition.checkpoint.payload.releaseFingerprint,
            terminal:
              transition.kind === "complete" ||
              TERMINAL_STATES.has(String(transition.checkpoint.payload.state)),
            createdAt: previous?.createdAt ?? at,
            updatedAt: at,
          });
          await requestValue(operationStore.put(operation));
          return {
            operation,
            calls: emittedCalls,
            ...(sessionCommit === undefined ? {} : { sessionCommit }),
            ...(delivery === undefined ? {} : { delivery }),
          };
        },
      ),

    readCall: async (callId) => {
      assertIdentity(callId, "callId");
      return transaction(["calls"], "readonly", (current) =>
        readCallIn(current, callId),
      );
    },

    markCallUncertain,
    completeCall,

    readSessionCommit: async (commitId) => {
      assertIdentity(commitId, "commitId");
      return transaction(["sessionCommits"], "readonly", (current) =>
        readSessionIn(current, commitId),
      );
    },

    markSessionCommitUncertain: async (input) =>
      transaction(
        ["leases", "sessionCommits"],
        "readwrite",
        async (current) => {
          await currentLease(current, input.lease);
          const previous = await readSessionIn(current, input.mutation.commitId);
          if (
            previous === null ||
            previous.operationId !== input.lease.operationId ||
            previous.identity !== deriveHostSessionCommitIdentity(input.mutation)
          ) {
            conflict(
              "The Provider Session commit identity does not match its durable intent.",
              input.lease.operationId,
            );
          }
          if (previous.status === "completed" || previous.status === "uncertain") {
            return previous;
          }
          const record = snapshot({
            ...previous,
            status: "uncertain" as const,
            revision: nextRevision(previous.revision),
            updatedAt: timestamp(),
          });
          await requestValue(
            current.objectStore("sessionCommits").put(record),
          );
          return record;
        },
      ),

    completeSessionCommit: async (input) =>
      transaction(
        ["leases", "sessionCommits"],
        "readwrite",
        async (current) => {
          await currentLease(current, input.lease);
          const previous = await readSessionIn(current, input.mutation.commitId);
          if (
            previous === null ||
            previous.operationId !== input.lease.operationId ||
            previous.identity !== deriveHostSessionCommitIdentity(input.mutation)
          ) {
            conflict(
              "The Provider Session commit identity does not match its durable intent.",
              input.lease.operationId,
            );
          }
          try {
            validateAuthoritySnapshot(
              input.authority.currentContext,
              input.authority.currentSession,
            );
            assertProviderCommitAcknowledgment(
              input.mutation,
              input.acknowledgment,
              input.authority.currentSession,
            );
          } catch {
            corrupt("A Provider Session acknowledgment failed authority validation.");
          }
          if (previous.status === "completed") {
            if (
              previous.acknowledgment === undefined ||
              previous.authority === undefined ||
              !same(previous.acknowledgment, input.acknowledgment) ||
              !same(previous.authority, input.authority)
            ) {
              conflict(
                "A completed Provider Session commit cannot be replaced.",
                previous.operationId,
              );
            }
            return previous;
          }
          if (previous.status !== "uncertain") {
            conflict(
              "A Provider Session commit must be uncertain before it can complete.",
              previous.operationId,
            );
          }
          const record = snapshot({
            ...previous,
            status: "completed" as const,
            acknowledgment: input.acknowledgment,
            authority: input.authority,
            revision: nextRevision(previous.revision),
            updatedAt: timestamp(),
          });
          await requestValue(
            current.objectStore("sessionCommits").put(record),
          );
          return record;
        },
      ),

    readDelivery: async (operationId) => {
      assertIdentity(operationId, "operationId");
      return transaction(["deliveries"], "readonly", async (current) => {
        const raw = await requestValue<unknown>(
          current.objectStore("deliveries").get(operationId),
        );
        return raw === undefined ? null : checkedDelivery(raw);
      });
    },

    markDeliveryDelivered: async (input) =>
      transaction(
        ["leases", "deliveries"],
        "readwrite",
        async (current) => {
          await currentLease(current, input.lease);
          if (input.lease.operationId !== input.operationId) {
            conflict("The delivery belongs to another operation.", input.operationId);
          }
          const raw = await requestValue<unknown>(
            current.objectStore("deliveries").get(input.operationId),
          );
          const previous = raw === undefined ? null : checkedDelivery(raw);
          if (
            previous === null ||
            previous.deliveryId !== input.deliveryId ||
            previous.completionIdentity !== input.completionIdentity
          ) {
            conflict("The completion delivery identity does not match.", input.operationId);
          }
          if (previous.status === "delivered") return previous;
          const record = snapshot({
            ...previous,
            status: "delivered" as const,
            revision: nextRevision(previous.revision),
            updatedAt: timestamp(),
          });
          await requestValue(current.objectStore("deliveries").put(record));
          return record;
        },
      ),

    acquireLease: async (input) => {
      assertIdentity(input.operationId, "operationId");
      assertIdentity(input.ownerId, "ownerId");
      assertTtl(input.ttlMs);
      return transaction(["leases"], "readwrite", async (current) => {
        const at = epoch();
        const stored = await readLease(current, input.operationId);
        const leaseStore = current.objectStore("leases");
        const rawCounter = await requestValue<CounterValue | undefined>(
          leaseStore.get(counterKey(input.operationId)),
        );
        if (
          rawCounter !== undefined &&
          (rawCounter.kind !== "counter" ||
            rawCounter.key !== counterKey(input.operationId) ||
            typeof rawCounter.value !== "string" ||
            !/^(0|[1-9][0-9]*)$/.test(rawCounter.value))
        ) {
          corrupt("An IndexedDB lease counter is malformed.", input.operationId);
        }
        if ((stored === null) !== (rawCounter === undefined)) {
          corrupt(
            "An IndexedDB lease and its counter must exist together.",
            input.operationId,
          );
        }
        if (
          stored !== null &&
          rawCounter !== undefined &&
          rawCounter.value !== stored.lease.fencingToken
        ) {
          corrupt(
            "An IndexedDB lease counter does not match its durable lease.",
            input.operationId,
          );
        }
        if (
          stored !== null &&
          stored.active &&
          Date.parse(stored.lease.expiresAt) > at
        ) {
          return null;
        }
        const fencingToken = nextRevision(rawCounter?.value ?? "0");
        const lease = snapshot({
          operationId: input.operationId,
          ownerId: input.ownerId,
          fencingToken,
          expiresAt: new Date(at + input.ttlMs).toISOString(),
        });
        await requestValue(leaseStore.put({
          key: leaseKey(input.operationId),
          kind: "lease",
          active: true,
          value: lease,
        } satisfies LeaseValue));
        await requestValue(leaseStore.put({
          key: counterKey(input.operationId),
          kind: "counter",
          value: fencingToken,
        } satisfies CounterValue));
        return lease;
      });
    },

    renewLease: async (input) => {
      assertTtl(input.ttlMs);
      return transaction(["leases"], "readwrite", async (current) => {
        const previous = await currentLease(current, input.lease);
        const lease = snapshot({
          ...previous,
          expiresAt: new Date(epoch() + input.ttlMs).toISOString(),
        });
        await requestValue(current.objectStore("leases").put({
          key: leaseKey(lease.operationId),
          kind: "lease",
          active: true,
          value: lease,
        } satisfies LeaseValue));
        return lease;
      });
    },

    releaseLease: async (input) =>
      transaction(["leases"], "readwrite", async (current) => {
        const previous = await readLease(current, input.lease.operationId);
        if (
          previous === null ||
          !previous.active ||
          previous.lease.ownerId !== input.lease.ownerId ||
          previous.lease.fencingToken !== input.lease.fencingToken
        ) {
          return false;
        }
        await requestValue(
          current.objectStore("leases").put({
            key: leaseKey(input.lease.operationId),
            kind: "lease",
            active: false,
            value: previous.lease,
          } satisfies LeaseValue),
        );
        return true;
      }),
  };

  return Object.freeze(store);
}
