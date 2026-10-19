import {
  assertPortResult,
  assertProviderCommitAcknowledgment,
  assertValidTws,
  canonicalize,
  validateAuthoritySnapshot,
  verifyCheckpoint,
  type OperationCheckpoint,
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
  TwsProviderSessionCommitAck,
  TwsProviderSessionMutation,
} from "./types.js";

const TERMINAL_STATES = new Set(["completed", "rejected", "failed", "cancelled"]);
const MAX_LEASE_TTL_MS = 86_400_000;

export interface TwsMemoryHostStoreOptions {
  readonly now?: () => number;
}

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
  return left === right || canonicalize(left) === canonicalize(right);
}

function nextRevision(value: string): string {
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

function assertTtl(ttlMs: number): void {
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_LEASE_TTL_MS
  ) {
    throw new TypeError("Host lease ttlMs must be a positive safe integer up to one day");
  }
}

function assertIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function snapshotTransition(value: SchemaCoreTransition): SchemaCoreTransition {
  try {
    const { checkpoint: inputCheckpoint, calls: inputCalls, ...body } = value as
      SchemaCoreTransition & { readonly calls?: readonly PortCall[] };
    const checkpoint = verifyCheckpoint(
      inputCheckpoint as unknown as OperationCheckpoint,
      inputCheckpoint.payload.release,
    );
    const transition = deepFreeze({
      ...snapshot(body),
      checkpoint,
      ...("calls" in value ? {
        calls: inputCalls === checkpoint.payload.pendingCalls
          ? checkpoint.payload.pendingCalls
          : snapshot(inputCalls),
      } : {}),
    }) as SchemaCoreTransition;
    assertValidTws("coreTransition", transition);
    return transition;
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

function operationIdOf(transition: SchemaCoreTransition): string {
  return transition.checkpoint.payload.operationId;
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

export function createMemoryTwsHostStore(
  options: TwsMemoryHostStoreOptions = {},
): TwsHostStore {
  const now = options.now ?? (() => Date.now());
  let operations = new Map<string, TwsHostOperationRecord>();
  let calls = new Map<string, TwsHostCallRecord>();
  let sessionCommits = new Map<string, TwsHostSessionCommitRecord>();
  let deliveries = new Map<string, TwsHostDeliveryRecord>();
  let leases = new Map<string, TwsHostLeaseRecord>();
  let leaseCounters = new Map<string, string>();
  let tail: Promise<void> = Promise.resolve();

  function timestamp(): string {
    const value = now();
    if (!Number.isFinite(value)) {
      throw new TypeError("Host store clock must return finite epoch milliseconds");
    }
    return new Date(value).toISOString();
  }

  function transact<T>(work: () => T | Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function currentLease(input: TwsHostLeaseRecord): TwsHostLeaseRecord {
    const current = leases.get(input.operationId);
    if (
      current === undefined ||
      current.ownerId !== input.ownerId ||
      current.fencingToken !== input.fencingToken ||
      Date.parse(current.expiresAt) <= now()
    ) {
      conflict("The Host lease is absent, expired, or fenced.", input.operationId);
    }
    return current;
  }

  function callFor<K extends PortOperation>(
    lease: TwsHostLeaseRecord,
    call: PortCall<K>,
  ): TwsHostCallRecord<K> {
    currentLease(lease);
    const record = calls.get(call.callId) as TwsHostCallRecord<K> | undefined;
    if (
      record === undefined ||
      record.operationId !== lease.operationId ||
      (record.call !== call && record.identity !== deriveHostCallIdentity(call))
    ) {
      conflict("The Host call identity does not match its durable intent.", lease.operationId);
    }
    return record;
  }

  function sessionFor(
    lease: TwsHostLeaseRecord,
    mutation: TwsProviderSessionMutation,
  ): TwsHostSessionCommitRecord {
    currentLease(lease);
    const record = sessionCommits.get(mutation.commitId);
    if (
      record === undefined ||
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

  function markCallUncertain<K extends PortOperation>(input: {
    readonly lease: TwsHostLeaseRecord;
    readonly call: PortCall<K>;
  }): Promise<TwsHostCallRecord<K>> {
    return transact<TwsHostCallRecord<K>>(() => {
      const previous = callFor(input.lease, input.call);
      if (previous.status === "completed" || previous.status === "uncertain") {
        return previous;
      }
      const record = deepFreeze({
        ...previous,
        status: "uncertain" as const,
        revision: nextRevision(previous.revision),
        updatedAt: timestamp(),
      });
      const nextCalls = new Map(calls);
      nextCalls.set(previous.callId, record);
      calls = nextCalls;
      return record;
    });
  }

  function completeCall<K extends PortOperation>(input: {
    readonly lease: TwsHostLeaseRecord;
    readonly call: PortCall<K>;
    readonly response: PortResponse<K>;
  }): Promise<TwsHostCallRecord<K>> {
    return transact<TwsHostCallRecord<K>>(() => {
      const previous = callFor(input.lease, input.call);
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
      const record = deepFreeze({
        ...previous,
        status: "completed" as const,
        response: snapshot(input.response),
        revision: nextRevision(previous.revision),
        updatedAt: timestamp(),
      }) as TwsHostCallRecord<K>;
      const nextCalls = new Map(calls);
      nextCalls.set(previous.callId, record);
      calls = nextCalls;
      return record;
    });
  }

  const store: TwsHostStore = {
    storeVersion: "1.0",

    readOperation: (operationId) =>
      transact(() => {
        assertIdentity(operationId, "operationId");
        const record = operations.get(operationId);
        return record ?? null;
      }),

    listRecoverable: (query) =>
      transact(() => {
        assertIdentity(query.releaseFingerprint, "releaseFingerprint");
        if (
          query.limit !== undefined &&
          (!Number.isSafeInteger(query.limit) || query.limit <= 0)
        ) {
          throw new TypeError("Host recoverable limit must be a positive safe integer");
        }
        const records = [...operations.values()]
          .filter(
            (record) =>
              (!record.terminal ||
                deliveries.get(record.operationId)?.status === "pending") &&
              record.releaseFingerprint === query.releaseFingerprint,
          )
          .sort((left, right) =>
            left.operationId < right.operationId
              ? -1
              : left.operationId > right.operationId
                ? 1
                : 0,
          );
        return deepFreeze(
          query.limit === undefined ? records : records.slice(0, query.limit),
        );
      }),

    commitTransition: (input) =>
      transact((): TwsHostTransitionCommitResult => {
        currentLease(input.lease);
        const transition = snapshotTransition(input.transition);
        const operationId = operationIdOf(transition);
        if (operationId !== input.lease.operationId) {
          conflict("The Core transition belongs to another operation.", operationId);
        }

        const transitionIdentity = deriveHostTransitionIdentity(transition);
        const previous = operations.get(operationId);
        if (previous?.transitionIdentity === transitionIdentity) {
          return deepFreeze({
            operation: previous,
            calls: callsOf(transition).map((call) => {
              const record = calls.get(call.callId);
              if (record === undefined) corrupt("A transition call intent is missing.", operationId);
              return record;
            }),
            ...(transition.kind === "commit"
              ? {
                  sessionCommit: sessionCommits.get(transition.mutation.commitId) ??
                    corrupt("A transition session intent is missing.", operationId),
                }
              : {}),
            ...(transition.kind === "complete"
              ? {
                  delivery: deliveries.get(operationId) ??
                    corrupt("A transition delivery intent is missing.", operationId),
                }
              : {}),
          });
        }

        if (previous === undefined) {
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
          if (
            BigInt(transition.checkpoint.payload.revision) <=
            BigInt(previous.revision)
          ) {
            conflict("The Core checkpoint revision did not advance.", operationId);
          }
        }

        const at = timestamp();
        const nextCalls = new Map(calls);
        const emittedCalls: TwsHostCallRecord[] = [];
        for (const call of callsOf(transition)) {
          const identity = deriveHostCallIdentity(call);
          const existing = nextCalls.get(call.callId);
          if (existing !== undefined) {
            if (existing.operationId !== operationId || existing.identity !== identity) {
              conflict("A callId was reused with different canonical content.", operationId);
            }
            emittedCalls.push(existing);
            continue;
          }
          const record = deepFreeze({
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
          nextCalls.set(call.callId, record);
          emittedCalls.push(record);
        }

        const nextSessionCommits = new Map(sessionCommits);
        let sessionCommit: TwsHostSessionCommitRecord | undefined;
        const mutation = mutationOf(transition);
        if (mutation !== undefined) {
          const identity = deriveHostSessionCommitIdentity(mutation);
          const expectedAuthority = deepFreeze({
            currentContext: transition.checkpoint.payload.context,
            currentSession: transition.checkpoint.payload.session,
          }) as TwsAuthoritySnapshot;
          const expectedAuthorityIdentity =
            deriveHostAuthorityIdentity(expectedAuthority);
          const existing = nextSessionCommits.get(mutation.commitId);
          if (existing !== undefined) {
            if (
              existing.operationId !== operationId ||
              existing.identity !== identity ||
              existing.expectedAuthorityIdentity !== expectedAuthorityIdentity
            ) {
              conflict("A commitId was reused with different canonical content.", operationId);
            }
            sessionCommit = existing;
          } else {
            sessionCommit = deepFreeze({
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
            nextSessionCommits.set(mutation.commitId, sessionCommit);
          }
        }

        const nextDeliveries = new Map(deliveries);
        let delivery: TwsHostDeliveryRecord | undefined;
        const completion = completionOf(transition);
        if (completion !== undefined) {
          const completionIdentity = deriveHostCompletionIdentity(completion);
          const deliveryId = deriveHostDeliveryId({
            operationId,
            completionIdentity,
          });
          const existing = nextDeliveries.get(operationId);
          if (existing !== undefined) {
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
            nextDeliveries.set(operationId, delivery);
          }
        }

        const checkpoint = transition.checkpoint;
        const operation = deepFreeze({
          operationId,
          transition,
          transitionIdentity,
          transitionKind: transition.kind,
          checkpointHash: checkpoint.checkpointHash,
          revision: checkpoint.payload.revision,
          storeRevision:
            previous === undefined ? "0" : nextRevision(previous.storeRevision),
          releaseFingerprint: checkpoint.payload.releaseFingerprint,
          terminal:
            transition.kind === "complete" ||
            TERMINAL_STATES.has(String(checkpoint.payload.state)),
          createdAt: previous?.createdAt ?? at,
          updatedAt: at,
        });

        const nextOperations = new Map(operations);
        nextOperations.set(operationId, operation);
        operations = nextOperations;
        calls = nextCalls;
        sessionCommits = nextSessionCommits;
        deliveries = nextDeliveries;

        return deepFreeze({
          operation,
          calls: emittedCalls,
          ...(sessionCommit === undefined ? {} : { sessionCommit }),
          ...(delivery === undefined ? {} : { delivery }),
        });
      }),

    readCall: (callId) =>
      transact(() => {
        assertIdentity(callId, "callId");
        const record = calls.get(callId);
        return record ?? null;
      }),

    markCallUncertain,

    completeCall,

    readSessionCommit: (commitId) =>
      transact(() => {
        assertIdentity(commitId, "commitId");
        const record = sessionCommits.get(commitId);
        return record ?? null;
      }),

    markSessionCommitUncertain: (input) =>
      transact(() => {
        const previous = sessionFor(input.lease, input.mutation);
        if (previous.status === "completed" || previous.status === "uncertain") {
          return previous;
        }
        const record = deepFreeze({
          ...previous,
          status: "uncertain" as const,
          revision: nextRevision(previous.revision),
          updatedAt: timestamp(),
        });
        const next = new Map(sessionCommits);
        next.set(previous.commitId, record);
        sessionCommits = next;
        return record;
      }),

    completeSessionCommit: (input) =>
      transact(() => {
        const previous = sessionFor(input.lease, input.mutation);
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
            conflict("A completed Provider Session commit cannot be replaced.", previous.operationId);
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
        const next = new Map(sessionCommits);
        next.set(previous.commitId, record);
        sessionCommits = next;
        return record;
      }),

    readDelivery: (operationId) =>
      transact(() => {
        assertIdentity(operationId, "operationId");
        const record = deliveries.get(operationId);
        return record ?? null;
      }),

    markDeliveryDelivered: (input) =>
      transact(() => {
        currentLease(input.lease);
        if (input.lease.operationId !== input.operationId) {
          conflict("The delivery belongs to another operation.", input.operationId);
        }
        const previous = deliveries.get(input.operationId);
        if (
          previous === undefined ||
          previous.deliveryId !== input.deliveryId ||
          previous.completionIdentity !== input.completionIdentity
        ) {
          conflict("The completion delivery identity does not match.", input.operationId);
        }
        if (previous.status === "delivered") return previous;
        const record = deepFreeze({
          ...previous,
          status: "delivered" as const,
          revision: nextRevision(previous.revision),
          updatedAt: timestamp(),
        });
        const next = new Map(deliveries);
        next.set(input.operationId, record);
        deliveries = next;
        return record;
      }),

    acquireLease: (input) =>
      transact(() => {
        assertIdentity(input.operationId, "operationId");
        assertIdentity(input.ownerId, "ownerId");
        assertTtl(input.ttlMs);
        const at = now();
        const current = leases.get(input.operationId);
        if (current !== undefined && Date.parse(current.expiresAt) > at) {
          return null;
        }
        const previousToken = leaseCounters.get(input.operationId) ?? "0";
        const fencingToken = nextRevision(previousToken);
        const lease = snapshot({
          operationId: input.operationId,
          ownerId: input.ownerId,
          fencingToken,
          expiresAt: new Date(at + input.ttlMs).toISOString(),
        });
        const nextLeases = new Map(leases);
        const nextCounters = new Map(leaseCounters);
        nextLeases.set(input.operationId, lease);
        nextCounters.set(input.operationId, fencingToken);
        leases = nextLeases;
        leaseCounters = nextCounters;
        return lease;
      }),

    renewLease: (input) =>
      transact(() => {
        assertTtl(input.ttlMs);
        const current = currentLease(input.lease);
        const lease = snapshot({
          ...current,
          expiresAt: new Date(now() + input.ttlMs).toISOString(),
        });
        const next = new Map(leases);
        next.set(lease.operationId, lease);
        leases = next;
        return lease;
      }),

    releaseLease: (input) =>
      transact(() => {
        const current = leases.get(input.lease.operationId);
        if (
          current === undefined ||
          current.ownerId !== input.lease.ownerId ||
          current.fencingToken !== input.lease.fencingToken
        ) {
          return false;
        }
        const next = new Map(leases);
        next.delete(input.lease.operationId);
        leases = next;
        return true;
      }),
  };

  return Object.freeze(store);
}
