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
import {
  decodeSqliteCall,
  decodeSqliteDelivery,
  decodeSqliteLease,
  decodeSqliteOperation,
  decodeSqliteSessionCommit,
  encodeSqliteCanonicalJson,
} from "./sqlite-codec.js";
import { initializeSqliteSchema } from "./sqlite-schema.js";
import type {
  TwsHostCallRecord,
  TwsHostDeliveryRecord,
  TwsHostOperationRecord,
  TwsHostSessionCommitRecord,
  TwsHostStore,
  TwsHostTransitionCommitResult,
} from "./store.js";
import type {
  TwsSqliteHostStoreOptions,
  TwsSqliteRow,
  TwsSqliteTransaction,
} from "./sqlite-types.js";
import type {
  TwsAuthoritySnapshot,
  TwsProviderSessionMutation,
} from "./types.js";

const TERMINAL_STATES = new Set(["completed", "rejected", "failed", "cancelled"]);
const MAX_LEASE_TTL_MS = 86_400_000;

function validateOptions(options: TwsSqliteHostStoreOptions): void {
  if (
    options === null ||
    typeof options !== "object" ||
    options.driver === null ||
    typeof options.driver !== "object" ||
    options.driver.dialect !== "sqlite" ||
    typeof options.driver.transaction !== "function"
  ) {
    throw new TypeError("SQLite Host Store options require a transactional driver.");
  }
  if (
    typeof options.namespace !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(options.namespace)
  ) {
    throw new TypeError("SQLite Host Store namespace is invalid.");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("SQLite Host Store now must be a function.");
  }
}

function assertIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function corrupt(): never {
  throw new TwsHostError(
    "HOST_STORE_CORRUPT",
    "A SQLite Host Store index does not match its canonical record.",
  );
}

function conflict(message: string, operationId?: string): never {
  throw new TwsHostError("HOST_STORE_CONFLICT", message, {
    retryable: true,
    ...(operationId === undefined ? {} : { metadata: { operationId } }),
  });
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

function nextRevision(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) corrupt();
  try {
    return String(BigInt(value) + 1n);
  } catch {
    return corrupt();
  }
}

function snapshot<T>(value: T): T {
  const parsed = JSON.parse(canonicalize(value)) as T;
  const freeze = (current: unknown): void => {
    if (current !== null && typeof current === "object" && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) freeze(child);
      Object.freeze(current);
    }
  };
  freeze(parsed);
  return parsed;
}

function same(left: object, right: object): boolean {
  return canonicalize(left) === canonicalize(right);
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

function callsOf(transition: SchemaCoreTransition): readonly PortCall[] {
  return transition.kind === "waiting"
    ? (transition.calls as readonly PortCall[])
    : [];
}

function mutationOf(
  transition: SchemaCoreTransition,
): TwsProviderSessionMutation | undefined {
  return transition.kind === "commit" ? transition.mutation : undefined;
}

function completionOf(
  transition: SchemaCoreTransition,
): Extract<SchemaCoreTransition, { readonly kind: "complete" }>["completion"] | undefined {
  return transition.kind === "complete" ? transition.completion : undefined;
}

function assertOperationRow(
  row: TwsSqliteRow,
  record: TwsHostOperationRecord,
): void {
  if (
    row.operation_id !== record.operationId ||
    row.release_fingerprint !== record.releaseFingerprint ||
    row.terminal !== (record.terminal ? 1 : 0) ||
    row.created_at !== record.createdAt
  ) {
    corrupt();
  }
}

function assertCallRow(row: TwsSqliteRow, record: TwsHostCallRecord): void {
  if (
    row.call_id !== record.callId ||
    row.operation_id !== record.operationId ||
    row.status !== record.status ||
    row.created_at !== record.createdAt
  ) {
    corrupt();
  }
}

function assertSessionRow(
  row: TwsSqliteRow,
  record: TwsHostSessionCommitRecord,
): void {
  if (
    row.commit_id !== record.commitId ||
    row.operation_id !== record.operationId ||
    row.status !== record.status ||
    row.created_at !== record.createdAt
  ) {
    corrupt();
  }
}

function assertDeliveryRow(
  row: TwsSqliteRow,
  record: TwsHostDeliveryRecord,
): void {
  if (
    row.operation_id !== record.operationId ||
    row.delivery_id !== record.deliveryId ||
    row.status !== record.status ||
    row.created_at !== record.createdAt
  ) {
    corrupt();
  }
}

async function readOperationIn(
  transaction: TwsSqliteTransaction,
  namespace: string,
  operationId: string,
): Promise<TwsHostOperationRecord | null> {
  const row = await transaction.get(
    "SELECT operation_id, release_fingerprint, terminal, created_at, canonical_json FROM tws_host_operations WHERE namespace = :namespace AND operation_id = :operationId",
    { namespace, operationId },
  );
  if (row === null) return null;
  const record = decodeSqliteOperation(row.canonical_json);
  assertOperationRow(row, record);
  return record;
}

async function readCallIn(
  transaction: TwsSqliteTransaction,
  namespace: string,
  callId: string,
): Promise<TwsHostCallRecord | null> {
  const row = await transaction.get(
    "SELECT call_id, operation_id, status, created_at, canonical_json FROM tws_host_calls WHERE namespace = :namespace AND call_id = :callId",
    { namespace, callId },
  );
  if (row === null) return null;
  const record = decodeSqliteCall(row.canonical_json);
  assertCallRow(row, record);
  return record;
}

async function readSessionIn(
  transaction: TwsSqliteTransaction,
  namespace: string,
  commitId: string,
): Promise<TwsHostSessionCommitRecord | null> {
  const row = await transaction.get(
    "SELECT commit_id, operation_id, status, created_at, canonical_json FROM tws_host_session_commits WHERE namespace = :namespace AND commit_id = :commitId",
    { namespace, commitId },
  );
  if (row === null) return null;
  const record = decodeSqliteSessionCommit(row.canonical_json);
  assertSessionRow(row, record);
  return record;
}

async function readDeliveryIn(
  transaction: TwsSqliteTransaction,
  namespace: string,
  operationId: string,
): Promise<TwsHostDeliveryRecord | null> {
  const row = await transaction.get(
    "SELECT operation_id, delivery_id, status, created_at, canonical_json FROM tws_host_deliveries WHERE namespace = :namespace AND operation_id = :operationId",
    { namespace, operationId },
  );
  if (row === null) return null;
  const record = decodeSqliteDelivery(row.canonical_json);
  assertDeliveryRow(row, record);
  return record;
}

async function writeOperationIn(
  transaction: TwsSqliteTransaction,
  namespace: string,
  record: TwsHostOperationRecord,
): Promise<void> {
  await transaction.run(
    `INSERT INTO tws_host_operations
      (namespace, operation_id, release_fingerprint, terminal, created_at, canonical_json)
      VALUES (:namespace, :operationId, :releaseFingerprint, :terminal, :createdAt, :canonicalJson)
      ON CONFLICT (namespace, operation_id) DO UPDATE SET
        release_fingerprint = excluded.release_fingerprint,
        terminal = excluded.terminal,
        created_at = excluded.created_at,
        canonical_json = excluded.canonical_json`,
    {
      namespace,
      operationId: record.operationId,
      releaseFingerprint: record.releaseFingerprint,
      terminal: record.terminal ? 1 : 0,
      createdAt: record.createdAt,
      canonicalJson: encodeSqliteCanonicalJson(record),
    },
  );
}

async function writeCallIn(
  transaction: TwsSqliteTransaction,
  namespace: string,
  record: TwsHostCallRecord,
): Promise<void> {
  await transaction.run(
    `INSERT INTO tws_host_calls
      (namespace, call_id, operation_id, status, created_at, canonical_json)
      VALUES (:namespace, :callId, :operationId, :status, :createdAt, :canonicalJson)
      ON CONFLICT (namespace, call_id) DO UPDATE SET
        operation_id = excluded.operation_id,
        status = excluded.status,
        created_at = excluded.created_at,
        canonical_json = excluded.canonical_json`,
    {
      namespace,
      callId: record.callId,
      operationId: record.operationId,
      status: record.status,
      createdAt: record.createdAt,
      canonicalJson: encodeSqliteCanonicalJson(record),
    },
  );
}

async function writeSessionIn(
  transaction: TwsSqliteTransaction,
  namespace: string,
  record: TwsHostSessionCommitRecord,
): Promise<void> {
  await transaction.run(
    `INSERT INTO tws_host_session_commits
      (namespace, commit_id, operation_id, status, created_at, canonical_json)
      VALUES (:namespace, :commitId, :operationId, :status, :createdAt, :canonicalJson)
      ON CONFLICT (namespace, commit_id) DO UPDATE SET
        operation_id = excluded.operation_id,
        status = excluded.status,
        created_at = excluded.created_at,
        canonical_json = excluded.canonical_json`,
    {
      namespace,
      commitId: record.commitId,
      operationId: record.operationId,
      status: record.status,
      createdAt: record.createdAt,
      canonicalJson: encodeSqliteCanonicalJson(record),
    },
  );
}

async function writeDeliveryIn(
  transaction: TwsSqliteTransaction,
  namespace: string,
  record: TwsHostDeliveryRecord,
): Promise<void> {
  await transaction.run(
    `INSERT INTO tws_host_deliveries
      (namespace, operation_id, delivery_id, status, created_at, canonical_json)
      VALUES (:namespace, :operationId, :deliveryId, :status, :createdAt, :canonicalJson)
      ON CONFLICT (namespace, operation_id) DO UPDATE SET
        delivery_id = excluded.delivery_id,
        status = excluded.status,
        created_at = excluded.created_at,
        canonical_json = excluded.canonical_json`,
    {
      namespace,
      operationId: record.operationId,
      deliveryId: record.deliveryId,
      status: record.status,
      createdAt: record.createdAt,
      canonicalJson: encodeSqliteCanonicalJson(record),
    },
  );
}

export function createSqliteStore(
  options: TwsSqliteHostStoreOptions,
): TwsHostStore {
  validateOptions(options);
  const namespace = options.namespace;
  const now = options.now ?? (() => Date.now());
  const ready = options.driver.transaction((transaction) =>
    initializeSqliteSchema(transaction, namespace),
  );

  function epochNow(): number {
    const value = now();
    if (!Number.isFinite(value)) {
      throw new TypeError("Host store clock must return finite epoch milliseconds");
    }
    return value;
  }

  function timestamp(): string {
    return new Date(epochNow()).toISOString();
  }

  async function currentLease(
    transaction: TwsSqliteTransaction,
    input: Parameters<TwsHostStore["renewLease"]>[0]["lease"],
  ) {
    const row = await transaction.get(
      "SELECT fencing_counter, active, canonical_json FROM tws_host_leases WHERE namespace = :namespace AND operation_id = :operationId",
      { namespace, operationId: input.operationId },
    );
    if (row === null) {
      conflict("The Host lease is absent, expired, or fenced.", input.operationId);
    }
    if (
      typeof row.fencing_counter !== "string" ||
      !/^[1-9][0-9]*$/.test(row.fencing_counter) ||
      (row.active !== 0 && row.active !== 1) ||
      typeof row.canonical_json !== "string"
    ) {
      corrupt();
    }
    const lease = decodeSqliteLease(row.canonical_json);
    if (lease.operationId !== input.operationId || lease.fencingToken !== row.fencing_counter) {
      corrupt();
    }
    if (
      row.active !== 1 ||
      lease.ownerId !== input.ownerId ||
      lease.fencingToken !== input.fencingToken ||
      Date.parse(lease.expiresAt) <= epochNow()
    ) {
      conflict("The Host lease is absent, expired, or fenced.", input.operationId);
    }
    return lease;
  }

  async function callFor<K extends PortOperation>(
    transaction: TwsSqliteTransaction,
    lease: Parameters<TwsHostStore["renewLease"]>[0]["lease"],
    call: PortCall<K>,
  ): Promise<TwsHostCallRecord<K>> {
    await currentLease(transaction, lease);
    const record = await readCallIn(transaction, namespace, call.callId) as
      | TwsHostCallRecord<K>
      | null;
    if (
      record === null ||
      record.operationId !== lease.operationId ||
      record.identity !== deriveHostCallIdentity(call)
    ) {
      conflict("The Host call identity does not match its durable intent.", lease.operationId);
    }
    return record;
  }

  async function sessionFor(
    transaction: TwsSqliteTransaction,
    lease: Parameters<TwsHostStore["renewLease"]>[0]["lease"],
    mutation: TwsProviderSessionMutation,
  ): Promise<TwsHostSessionCommitRecord> {
    await currentLease(transaction, lease);
    const record = await readSessionIn(transaction, namespace, mutation.commitId);
    if (
      record === null ||
      record.operationId !== lease.operationId ||
      record.identity !== deriveHostSessionCommitIdentity(mutation)
    ) {
      conflict(
        "The Provider Session commit identity does not match its durable intent.",
        lease.operationId,
      );
    }
    return record;
  }

  const store: TwsHostStore = {
    storeVersion: "1.0",
    async readOperation(operationId) {
      assertIdentity(operationId, "operationId");
      await ready;
      return options.driver.transaction((transaction) =>
        readOperationIn(transaction, namespace, operationId),
      );
    },
    async listRecoverable(query) {
      assertIdentity(query.releaseFingerprint, "releaseFingerprint");
      if (
        query.limit !== undefined &&
        (!Number.isSafeInteger(query.limit) || query.limit <= 0)
      ) {
        throw new TypeError("Host recoverable limit must be a positive safe integer");
      }
      await ready;
      return options.driver.transaction(async (transaction) => {
        const rows = await transaction.all(
          `SELECT o.operation_id AS operation_id, o.release_fingerprint AS release_fingerprint,
                  o.terminal AS terminal, o.created_at AS created_at, o.canonical_json AS canonical_json
           FROM tws_host_operations o
           LEFT JOIN tws_host_deliveries d
             ON d.namespace = o.namespace AND d.operation_id = o.operation_id
           WHERE o.namespace = :namespace AND o.release_fingerprint = :releaseFingerprint
             AND (o.terminal = 0 OR d.status = 'pending')
           ORDER BY o.created_at ASC, o.operation_id ASC`,
          {
            namespace,
            releaseFingerprint: query.releaseFingerprint,
          },
        );
        const records = rows.map((row) => {
          const record = decodeSqliteOperation(row.canonical_json);
          assertOperationRow(row, record);
          return record;
        });
        return query.limit === undefined ? records : records.slice(0, query.limit);
      });
    },
    async commitTransition(input) {
      await ready;
      return options.driver.transaction(
        async (transaction): Promise<TwsHostTransitionCommitResult> => {
          await currentLease(transaction, input.lease);
          assertTransition(input.transition);
          const transition = snapshot(input.transition);
          const operationId = transition.checkpoint.payload.operationId;
          if (operationId !== input.lease.operationId) {
            conflict("The Core transition belongs to another operation.", operationId);
          }

          const transitionIdentity = deriveHostTransitionIdentity(transition);
          const previous = await readOperationIn(transaction, namespace, operationId);
          if (previous?.transitionIdentity === transitionIdentity) {
            const emittedCalls: TwsHostCallRecord[] = [];
            for (const call of callsOf(transition)) {
              const record = await readCallIn(transaction, namespace, call.callId);
              if (record === null) corrupt();
              emittedCalls.push(record);
            }
            const sessionCommit = transition.kind === "commit"
              ? await readSessionIn(transaction, namespace, transition.mutation.commitId)
              : null;
            const delivery = transition.kind === "complete"
              ? await readDeliveryIn(transaction, namespace, operationId)
              : null;
            if (transition.kind === "commit" && sessionCommit === null) corrupt();
            if (transition.kind === "complete" && delivery === null) corrupt();
            return snapshot({
              operation: previous,
              calls: emittedCalls,
              ...(sessionCommit === null ? {} : { sessionCommit }),
              ...(delivery === null ? {} : { delivery }),
            });
          }

          if (previous === null) {
            if (input.expected !== null) {
              conflict("The initial Host operation CAS must be null.", operationId);
            }
          } else {
            if (previous.terminal) {
              conflict("A terminal Host operation cannot advance.", operationId);
            }
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
            try {
              if (
                BigInt(transition.checkpoint.payload.revision) <=
                BigInt(previous.revision)
              ) {
                conflict("The Core checkpoint revision did not advance.", operationId);
              }
            } catch (error) {
              if (error instanceof TwsHostError) throw error;
              corrupt();
            }
          }

          const at = timestamp();
          const emittedCalls: TwsHostCallRecord[] = [];
          for (const call of callsOf(transition)) {
            const identity = deriveHostCallIdentity(call);
            const existing = await readCallIn(transaction, namespace, call.callId);
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
            await writeCallIn(transaction, namespace, record);
            emittedCalls.push(record);
          }

          let sessionCommit: TwsHostSessionCommitRecord | undefined;
          const mutation = mutationOf(transition);
          if (mutation !== undefined) {
            const identity = deriveHostSessionCommitIdentity(mutation);
            const expectedAuthority = snapshot({
              currentContext: transition.checkpoint.payload.context,
              currentSession: transition.checkpoint.payload.session,
            }) as TwsAuthoritySnapshot;
            const expectedAuthorityIdentity = deriveHostAuthorityIdentity(expectedAuthority);
            const existing = await readSessionIn(
              transaction,
              namespace,
              mutation.commitId,
            );
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
              await writeSessionIn(transaction, namespace, sessionCommit);
            }
          }

          let delivery: TwsHostDeliveryRecord | undefined;
          const completion = completionOf(transition);
          if (completion !== undefined) {
            const completionIdentity = deriveHostCompletionIdentity(completion);
            const deliveryId = deriveHostDeliveryId({ operationId, completionIdentity });
            const existing = await readDeliveryIn(transaction, namespace, operationId);
            if (existing !== null) {
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
                completion,
                status: "pending" as const,
                revision: "0",
                createdAt: at,
                updatedAt: at,
              });
              await writeDeliveryIn(transaction, namespace, delivery);
            }
          }

          const checkpoint = transition.checkpoint;
          const operation = snapshot({
            operationId,
            transition,
            transitionIdentity,
            transitionKind: transition.kind,
            checkpointHash: checkpoint.checkpointHash,
            revision: checkpoint.payload.revision,
            storeRevision: previous === null ? "0" : nextRevision(previous.storeRevision),
            releaseFingerprint: checkpoint.payload.releaseFingerprint,
            terminal:
              transition.kind === "complete" ||
              TERMINAL_STATES.has(String(checkpoint.payload.state)),
            createdAt: previous?.createdAt ?? at,
            updatedAt: at,
          });
          await writeOperationIn(transaction, namespace, operation);

          return snapshot({
            operation,
            calls: emittedCalls,
            ...(sessionCommit === undefined ? {} : { sessionCommit }),
            ...(delivery === undefined ? {} : { delivery }),
          });
        },
      );
    },
    async readCall(callId) {
      assertIdentity(callId, "callId");
      await ready;
      return options.driver.transaction((transaction) =>
        readCallIn(transaction, namespace, callId),
      );
    },
    async markCallUncertain(input) {
      await ready;
      return options.driver.transaction(async (transaction) => {
        const previous = await callFor(transaction, input.lease, input.call);
        if (previous.status === "completed" || previous.status === "uncertain") {
          return previous;
        }
        const record = snapshot({
          ...previous,
          status: "uncertain" as const,
          revision: nextRevision(previous.revision),
          updatedAt: timestamp(),
        });
        await writeCallIn(transaction, namespace, record);
        return record;
      });
    },
    async completeCall(input) {
      await ready;
      return options.driver.transaction(async (transaction) => {
        const previous = await callFor(transaction, input.lease, input.call);
        assertResponse(input.call, input.response);
        if (previous.status === "completed") {
          if (
            previous.response === undefined ||
            !same(previous.response, input.response)
          ) {
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
        }) as typeof previous;
        await writeCallIn(transaction, namespace, record);
        return record;
      });
    },
    async readSessionCommit(commitId) {
      assertIdentity(commitId, "commitId");
      await ready;
      return options.driver.transaction((transaction) =>
        readSessionIn(transaction, namespace, commitId),
      );
    },
    async markSessionCommitUncertain(input) {
      await ready;
      return options.driver.transaction(async (transaction) => {
        const previous = await sessionFor(transaction, input.lease, input.mutation);
        if (previous.status === "completed" || previous.status === "uncertain") {
          return previous;
        }
        const record = snapshot({
          ...previous,
          status: "uncertain" as const,
          revision: nextRevision(previous.revision),
          updatedAt: timestamp(),
        });
        await writeSessionIn(transaction, namespace, record);
        return record;
      });
    },
    async completeSessionCommit(input) {
      await ready;
      return options.driver.transaction(async (transaction) => {
        const previous = await sessionFor(transaction, input.lease, input.mutation);
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
          corrupt();
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
        await writeSessionIn(transaction, namespace, record);
        return record;
      });
    },
    async readDelivery(operationId) {
      assertIdentity(operationId, "operationId");
      await ready;
      return options.driver.transaction((transaction) =>
        readDeliveryIn(transaction, namespace, operationId),
      );
    },
    async markDeliveryDelivered(input) {
      await ready;
      return options.driver.transaction(async (transaction) => {
        await currentLease(transaction, input.lease);
        if (input.lease.operationId !== input.operationId) {
          conflict("The delivery belongs to another operation.", input.operationId);
        }
        const previous = await readDeliveryIn(transaction, namespace, input.operationId);
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
        await writeDeliveryIn(transaction, namespace, record);
        return record;
      });
    },
    async acquireLease(input) {
      assertIdentity(input.operationId, "operationId");
      assertIdentity(input.ownerId, "ownerId");
      assertTtl(input.ttlMs);
      await ready;
      return options.driver.transaction(async (transaction) => {
        const at = epochNow();
        const row = await transaction.get(
          "SELECT fencing_counter, active, canonical_json FROM tws_host_leases WHERE namespace = :namespace AND operation_id = :operationId",
          { namespace, operationId: input.operationId },
        );
        let previousToken = "0";
        if (row !== null) {
          if (
            typeof row.fencing_counter !== "string" ||
            !/^[1-9][0-9]*$/.test(row.fencing_counter) ||
            (row.active !== 0 && row.active !== 1) ||
            typeof row.canonical_json !== "string"
          ) {
            corrupt();
          }
          previousToken = row.fencing_counter;
          const current = decodeSqliteLease(row.canonical_json);
          if (
            current.operationId !== input.operationId ||
            current.fencingToken !== previousToken
          ) {
            corrupt();
          }
          if (row.active === 1 && Date.parse(current.expiresAt) > at) return null;
        }

        const fencingToken = nextRevision(previousToken);
        const lease = snapshot({
          operationId: input.operationId,
          ownerId: input.ownerId,
          fencingToken,
          expiresAt: new Date(at + input.ttlMs).toISOString(),
        });
        await transaction.run(
          `INSERT INTO tws_host_leases
            (namespace, operation_id, fencing_counter, active, canonical_json)
            VALUES (:namespace, :operationId, :fencingCounter, 1, :canonicalJson)
            ON CONFLICT (namespace, operation_id) DO UPDATE SET
              fencing_counter = excluded.fencing_counter,
              active = 1,
              canonical_json = excluded.canonical_json`,
          {
            namespace,
            operationId: input.operationId,
            fencingCounter: fencingToken,
            canonicalJson: encodeSqliteCanonicalJson(lease),
          },
        );
        return lease;
      });
    },
    async renewLease(input) {
      assertTtl(input.ttlMs);
      await ready;
      return options.driver.transaction(async (transaction) => {
        const current = await currentLease(transaction, input.lease);
        const lease = snapshot({
          ...current,
          expiresAt: new Date(epochNow() + input.ttlMs).toISOString(),
        });
        const result = await transaction.run(
          `UPDATE tws_host_leases SET canonical_json = :canonicalJson
            WHERE namespace = :namespace AND operation_id = :operationId
              AND fencing_counter = :fencingCounter AND active = 1`,
          {
            namespace,
            operationId: lease.operationId,
            fencingCounter: lease.fencingToken,
            canonicalJson: encodeSqliteCanonicalJson(lease),
          },
        );
        if (result.changes !== 1) {
          conflict("The Host lease is absent, expired, or fenced.", lease.operationId);
        }
        return lease;
      });
    },
    async releaseLease(input) {
      await ready;
      return options.driver.transaction(async (transaction) => {
        const row = await transaction.get(
          "SELECT fencing_counter, active, canonical_json FROM tws_host_leases WHERE namespace = :namespace AND operation_id = :operationId",
          { namespace, operationId: input.lease.operationId },
        );
        if (row === null) return false;
        if (
          typeof row.fencing_counter !== "string" ||
          !/^[1-9][0-9]*$/.test(row.fencing_counter) ||
          (row.active !== 0 && row.active !== 1) ||
          typeof row.canonical_json !== "string"
        ) {
          corrupt();
        }
        const current = decodeSqliteLease(row.canonical_json);
        if (
          current.operationId !== input.lease.operationId ||
          current.fencingToken !== row.fencing_counter
        ) {
          corrupt();
        }
        if (
          row.active !== 1 ||
          current.ownerId !== input.lease.ownerId ||
          current.fencingToken !== input.lease.fencingToken
        ) {
          return false;
        }
        const result = await transaction.run(
          `UPDATE tws_host_leases SET active = 0
            WHERE namespace = :namespace AND operation_id = :operationId
              AND fencing_counter = :fencingCounter AND active = 1`,
          {
            namespace,
            operationId: current.operationId,
            fencingCounter: current.fencingToken,
          },
        );
        return result.changes === 1;
      });
    },
  };
  return Object.freeze(store);
}
