import {
  TWS_RELEASE_FINGERPRINT,
  assertValidTws,
  validateAuthoritySnapshot,
  type CancelInput,
  type CommitAckInput,
  type PortCall,
  type PortResponse,
  type ResumeInput,
  type SchemaCoreTransition,
} from "@tbc-wallet/core";
import { TwsHostError } from "./errors.js";
import { inspectHostOperation } from "./inspection.js";
import { assertHostPorts, dispatchHostPort } from "./port-dispatch.js";
import type {
  TwsHostLeaseRecord,
  TwsHostOperationRecord,
} from "./store.js";
import type {
  TwsAuthoritySnapshot,
  TwsHost,
  TwsHostFailure,
  TwsHostOperationResult,
  TwsHostOptions,
  TwsHostStartInput,
} from "./types.js";
import { deriveHostAuthorityIdentity } from "./identity.js";

const DEFAULT_LEASE_TTL_MS = 15_000;
const DEFAULT_MAX_STEPS = 256;
const MAX_STEPS_LIMIT = 10_000;
const MAX_PENDING_CANCELLATIONS = 1_024;

function hostError(
  code: ConstructorParameters<typeof TwsHostError>[0],
  message: string,
  operationId?: string,
): TwsHostError {
  return new TwsHostError(code, message, {
    ...(operationId === undefined ? {} : { metadata: { operationId } }),
  });
}

function asFailure(error: unknown, operationId: string): TwsHostFailure {
  if (error instanceof TwsHostError) {
    return Object.freeze({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
    });
  }
  return Object.freeze({
    code: "HOST_INTERNAL",
    message: "The Host operation failed.",
    retryable: false,
    metadata: Object.freeze({ operationId }),
  });
}

function failed(error: unknown, operationId: string): TwsHostOperationResult {
  return Object.freeze({
    status: "failed",
    operationId,
    error: asFailure(error, operationId),
  });
}

function waiting(record: TwsHostOperationRecord): TwsHostOperationResult {
  return Object.freeze({
    status: "waiting",
    operationId: record.operationId,
    revision: record.revision,
    state: record.transition.checkpoint.payload.state,
  });
}

function assertDriverNumber(
  value: number,
  label: string,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer up to ${maximum}`);
  }
}

function assertRelease(record: TwsHostOperationRecord): void {
  if (record.releaseFingerprint !== TWS_RELEASE_FINGERPRINT) {
    throw hostError(
      "HOST_RELEASE_MISMATCH",
      "The stored operation uses a different TWS release.",
      record.operationId,
    );
  }
}

function checkedTransition(value: unknown): SchemaCoreTransition {
  try {
    assertValidTws("coreTransition", value);
  } catch {
    throw hostError("HOST_INTERNAL", "The Core returned an invalid transition.");
  }
  return value as SchemaCoreTransition;
}

export function createDurableTwsHost(options: TwsHostOptions): TwsHost {
  if (typeof options.ownerId !== "string" || options.ownerId.length === 0) {
    throw new TypeError("Host ownerId must be a non-empty string");
  }
  if (typeof options.scheduleLeaseHeartbeat !== "function") {
    throw new TypeError("Host scheduleLeaseHeartbeat must be a function");
  }
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (
    options.deferDeliveryAcknowledgment !== undefined &&
    typeof options.deferDeliveryAcknowledgment !== "boolean"
  ) {
    throw new TypeError("Host deferDeliveryAcknowledgment must be a boolean");
  }
  const deferDeliveryAcknowledgment =
    options.deferDeliveryAcknowledgment === true;
  assertDriverNumber(leaseTtlMs, "Host leaseTtlMs", 86_400_000);
  assertDriverNumber(maxSteps, "Host maxSteps", MAX_STEPS_LIMIT);
  assertHostPorts(options.ports);
  const pendingCancellations = new Map<string, CancelInput["reason"]>();

  async function authority(): Promise<TwsAuthoritySnapshot> {
    try {
      const current = await options.authority.read();
      validateAuthoritySnapshot(
        current.currentContext,
        current.currentSession,
      );
      return current;
    } catch {
      throw new TwsHostError(
        "HOST_AUTHORITY_FAILURE",
        "The wallet authority source failed.",
      );
    }
  }

  async function invokeCore(
    invoke: () => Promise<unknown>,
    operationId?: string,
  ): Promise<SchemaCoreTransition> {
    try {
      return checkedTransition(await invoke());
    } catch (error) {
      if (error instanceof TwsHostError) throw error;
      throw hostError(
        "HOST_INTERNAL",
        "The Core transition failed.",
        operationId,
      );
    }
  }

  async function completeResult(
    record: TwsHostOperationRecord,
    lease: TwsHostLeaseRecord,
  ): Promise<TwsHostOperationResult> {
    if (record.transition.kind !== "complete") {
      throw hostError(
        "HOST_STORE_CORRUPT",
        "A terminal operation is missing its completion transition.",
        record.operationId,
      );
    }
    const delivery = await options.store.readDelivery(record.operationId);
    if (delivery === null) {
      throw hostError(
        "HOST_STORE_CORRUPT",
        "A completed operation is missing its delivery intent.",
        record.operationId,
      );
    }
    const delivered = deferDeliveryAcknowledgment
      ? delivery
      : await options.store.markDeliveryDelivered({
          lease,
          operationId: record.operationId,
          deliveryId: delivery.deliveryId,
          completionIdentity: delivery.completionIdentity,
        });
    const base = {
      operationId: record.operationId,
      revision: record.revision,
      completion: record.transition.completion,
      deliveryId: delivered.deliveryId,
    } as const;
    return record.transition.checkpoint.payload.state === "cancelled"
      ? Object.freeze({ status: "cancelled" as const, ...base })
      : Object.freeze({ status: "complete" as const, ...base });
  }

  async function dispatchCall(
    lease: TwsHostLeaseRecord,
    call: PortCall,
  ): Promise<PortResponse> {
    const durable = await options.store.readCall(call.callId);
    if (durable === null) {
      throw hostError(
        "HOST_STORE_CORRUPT",
        "A waiting transition is missing its durable call intent.",
        lease.operationId,
      );
    }
    if (durable.status === "completed") {
      if (durable.response === undefined) {
        throw hostError(
          "HOST_STORE_CORRUPT",
          "A completed call journal is missing its response.",
          lease.operationId,
        );
      }
      return durable.response;
    }
    await options.store.markCallUncertain({ lease, call });
    await options.store.renewLease({ lease, ttlMs: leaseTtlMs });
    let stopped = false;
    let leaseLost = false;
    let leaseFailure: unknown;
    let cancelHeartbeat: (() => void) | undefined;
    let renewalInFlight: Promise<void> = Promise.resolve();

    function scheduleHeartbeat(): void {
      if (stopped || leaseLost) return;
      cancelHeartbeat = options.scheduleLeaseHeartbeat(leaseTtlMs / 3, () => {
        cancelHeartbeat = undefined;
        if (stopped || leaseLost) return;
        renewalInFlight = (async () => {
          try {
            await options.store.renewLease({ lease, ttlMs: leaseTtlMs });
          } catch (error) {
            leaseLost = true;
            leaseFailure = error;
          }
        })().finally(scheduleHeartbeat);
      });
      if (typeof cancelHeartbeat !== "function") {
        throw new TypeError(
          "Host scheduleLeaseHeartbeat must return a cancellation function",
        );
      }
    }

    async function stopHeartbeatAndRenew(): Promise<void> {
      stopped = true;
      const cancel = cancelHeartbeat;
      cancelHeartbeat = undefined;
      if (cancel !== undefined) cancel();
      await renewalInFlight;
      if (leaseLost) throw leaseFailure;
      try {
        await options.store.renewLease({ lease, ttlMs: leaseTtlMs });
      } catch (error) {
        leaseLost = true;
        leaseFailure = error;
        throw error;
      }
    }

    scheduleHeartbeat();
    let response: PortResponse;
    try {
      response = await dispatchHostPort(options.ports, call);
    } finally {
      await stopHeartbeatAndRenew();
    }
    const completed = await options.store.completeCall({
      lease,
      call,
      response,
    });
    if (completed.response === undefined) {
      throw hostError(
        "HOST_STORE_CORRUPT",
        "A completed call journal is missing its response.",
        lease.operationId,
      );
    }
    return completed.response;
  }

  async function commitProviderSession(
    record: TwsHostOperationRecord,
    lease: TwsHostLeaseRecord,
  ): Promise<TwsHostOperationRecord> {
    if (record.transition.kind !== "commit") {
      throw hostError(
        "HOST_STORE_CORRUPT",
        "A Provider Session commit operation has no commit transition.",
        record.operationId,
      );
    }
    const mutation = record.transition.mutation;
    const journal = await options.store.readSessionCommit(mutation.commitId);
    if (journal === null) {
      throw hostError(
        "HOST_STORE_CORRUPT",
        "A commit transition is missing its durable session intent.",
        record.operationId,
      );
    }
    let completed = journal;
    if (completed.status !== "completed") {
      await options.store.markSessionCommitUncertain({ lease, mutation });
      let result;
      try {
        result = await options.authority.compareAndSwapSession({
          operationId: record.operationId,
          commitId: mutation.commitId,
          mutation,
          expected: journal.expectedAuthority,
        });
      } catch {
        throw new TwsHostError(
          "HOST_AUTHORITY_FAILURE",
          "The wallet Authority session commit failed.",
          {
            metadata: {
              operationId: record.operationId,
              commitId: mutation.commitId,
            },
          },
        );
      }
      completed = await options.store.completeSessionCommit({
        lease,
        mutation,
        acknowledgment: result.acknowledgment,
        authority: result.authority,
      });
    }
    const acknowledgment = completed.acknowledgment;
    const committedAuthority = completed.authority;
    if (acknowledgment === undefined || committedAuthority === undefined) {
      throw hostError(
        "HOST_STORE_CORRUPT",
        "A completed session journal is missing its acknowledgment.",
        record.operationId,
      );
    }
    const next = await invokeCore(
      () =>
        options.core.acknowledgeCommit({
          version: "1.0",
          checkpoint: record.transition.checkpoint as CommitAckInput["checkpoint"],
          acknowledgment,
          ...committedAuthority,
        }),
      record.operationId,
    );
    const committed = await options.store.commitTransition({
      lease,
      expected: {
        storeRevision: record.storeRevision,
        checkpointHash: record.checkpointHash,
      },
      transition: next,
    });
    return committed.operation;
  }

  async function drive(
    operationId: string,
    lease: TwsHostLeaseRecord,
  ): Promise<TwsHostOperationResult> {
    const initialRecord = await options.store.readOperation(operationId);
    if (initialRecord === null) {
      throw hostError(
        "HOST_NOT_FOUND",
        "The Host operation does not exist.",
        operationId,
      );
    }
    let record = initialRecord;
    for (let step = 0; step < maxSteps; step += 1) {
      await options.store.renewLease({ lease, ttlMs: leaseTtlMs });
      assertRelease(record);

      if (record.transition.kind === "complete") {
        pendingCancellations.delete(operationId);
        return completeResult(record, lease);
      }
      const cancellationReason = pendingCancellations.get(operationId);
      if (cancellationReason !== undefined) {
        const currentAuthority = await authority();
        const next = await invokeCore(
          () =>
            options.core.cancel({
              version: "1.0",
              checkpoint: record.transition.checkpoint as CancelInput["checkpoint"],
              reason: cancellationReason,
              ...currentAuthority,
            }),
          operationId,
        );
        const committed = await options.store.commitTransition({
          lease,
          expected: {
            storeRevision: record.storeRevision,
            checkpointHash: record.checkpointHash,
          },
          transition: next,
        });
        record = committed.operation;
        pendingCancellations.delete(operationId);
        continue;
      }
      if (record.transition.kind === "commit") {
        record = await commitProviderSession(record, lease);
        continue;
      }

      let response: PortResponse | undefined;
      if (record.transition.kind === "waiting") {
        const call = record.transition.calls[0] as PortCall | undefined;
        if (call === undefined) {
          throw hostError(
            "HOST_STORE_CORRUPT",
            "A waiting transition has no registered call.",
            operationId,
          );
        }
        response = await dispatchCall(lease, call);
      }

      const currentAuthority = await authority();
      const next = await invokeCore(
        () =>
          options.core.resume({
            version: "1.0",
            checkpoint: record.transition.checkpoint as ResumeInput["checkpoint"],
            ...(response === undefined ? {} : {
              response: response as NonNullable<ResumeInput["response"]>,
            }),
            ...currentAuthority,
          }),
        operationId,
      );
      const committed = await options.store.commitTransition({
        lease,
        expected: {
          storeRevision: record.storeRevision,
          checkpointHash: record.checkpointHash,
        },
        transition: next,
      });
      record = committed.operation;
    }
    throw new TwsHostError(
      "HOST_STEP_LIMIT",
      "The Host operation exceeded its bounded transition count.",
      { metadata: { operationId } },
    );
  }

  async function runExisting(
    operationId: string,
    action: (lease: TwsHostLeaseRecord) => Promise<TwsHostOperationResult>,
  ): Promise<TwsHostOperationResult> {
    try {
      const record = await options.store.readOperation(operationId);
      if (record === null) {
        throw hostError(
          "HOST_NOT_FOUND",
          "The Host operation does not exist.",
          operationId,
        );
      }
      assertRelease(record);
      const lease = await options.store.acquireLease({
        operationId,
        ownerId: options.ownerId,
        ttlMs: leaseTtlMs,
      });
      if (lease === null) {
        return Object.freeze({
          status: "busy",
          operationId,
          retryable: true,
        });
      }
      try {
        return await action(lease);
      } finally {
        await options.store.releaseLease({ lease }).catch(() => false);
      }
    } catch (error) {
      return failed(error, operationId);
    }
  }

  async function startOperation(
    input: TwsHostStartInput,
  ): Promise<TwsHostOperationResult> {
    const currentAuthority = await authority();
    const expectedAuthorityIdentity = input.expectedAuthorityIdentity;
    if (
      expectedAuthorityIdentity !== undefined &&
      (!/^[0-9a-f]{64}$/.test(expectedAuthorityIdentity) ||
        deriveHostAuthorityIdentity(currentAuthority) !==
          expectedAuthorityIdentity)
    ) {
      throw new TwsHostError(
        "HOST_AUTHORITY_FAILURE",
        "The wallet Authority changed before operation start.",
      );
    }
    const { expectedAuthorityIdentity: _expected, ...startInput } = input;
    const transition = await invokeCore(() =>
      options.core.start({ ...startInput, ...currentAuthority }),
    );
    const operationId = transition.checkpoint.payload.operationId;
    if (transition.checkpoint.payload.releaseFingerprint !== TWS_RELEASE_FINGERPRINT) {
      return failed(
        hostError(
          "HOST_RELEASE_MISMATCH",
          "The Core transition uses a different TWS release.",
          operationId,
        ),
        operationId,
      );
    }
    const lease = await options.store.acquireLease({
      operationId,
      ownerId: options.ownerId,
      ttlMs: leaseTtlMs,
    });
    if (lease === null) {
      return Object.freeze({ status: "busy", operationId, retryable: true });
    }
    try {
      const existing = await options.store.readOperation(operationId);
      if (existing === null) {
        await options.store.commitTransition({
          lease,
          expected: null,
          transition,
        });
      } else {
        assertRelease(existing);
      }
      return await drive(operationId, lease);
    } catch (error) {
      return failed(error, operationId);
    } finally {
      await options.store.releaseLease({ lease }).catch(() => false);
    }
  }

  async function resumeOperation(input: {
    readonly operationId: string;
  }): Promise<TwsHostOperationResult> {
    return runExisting(input.operationId, (lease) =>
      drive(input.operationId, lease),
    );
  }

  async function recoverPendingOperations(input: {
    readonly limit?: number;
  } = {}): Promise<readonly {
    readonly operationId: string;
    readonly result: TwsHostOperationResult;
  }[]> {
    const records = await options.store.listRecoverable({
      releaseFingerprint: TWS_RELEASE_FINGERPRINT,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    const recovered = [];
    for (const record of records) {
      recovered.push(
        Object.freeze({
          operationId: record.operationId,
          result: await resumeOperation({ operationId: record.operationId }),
        }),
      );
    }
    return Object.freeze(recovered);
  }

  async function cancelOperation(input: {
    readonly operationId: string;
    readonly reason: Parameters<TwsHost["cancelOperation"]>[0]["reason"];
  }): Promise<TwsHostOperationResult> {
    function queueCancellation(): TwsHostOperationResult {
      if (!pendingCancellations.has(input.operationId)) {
        if (pendingCancellations.size >= MAX_PENDING_CANCELLATIONS) {
          return failed(
            new TwsHostError(
              "HOST_BUSY",
              "The Host cancellation queue is full.",
              { retryable: true, metadata: { operationId: input.operationId } },
            ),
            input.operationId,
          );
        }
        pendingCancellations.set(input.operationId, input.reason);
      }
      return Object.freeze({
        status: "busy" as const,
        operationId: input.operationId,
        retryable: true as const,
      });
    }
    const cancelWithLease = (lease: TwsHostLeaseRecord) => (async () => {
      const record = await options.store.readOperation(input.operationId);
      if (record === null) {
        throw hostError(
          "HOST_NOT_FOUND",
          "The Host operation does not exist.",
          input.operationId,
        );
      }
      if (record.transition.kind === "complete") {
        pendingCancellations.delete(input.operationId);
        return completeResult(record, lease);
      }
      const currentAuthority = await authority();
      const next = await invokeCore(
        () =>
          options.core.cancel({
            version: "1.0",
            checkpoint: record.transition.checkpoint as CancelInput["checkpoint"],
            reason: input.reason,
            ...currentAuthority,
          }),
        input.operationId,
      );
      await options.store.commitTransition({
        lease,
        expected: {
          storeRevision: record.storeRevision,
          checkpointHash: record.checkpointHash,
        },
        transition: next,
      });
      pendingCancellations.delete(input.operationId);
      return drive(input.operationId, lease);
    })();
    const result = await runExisting(input.operationId, cancelWithLease);
    if (
      result.status !== "busy" &&
      !(
        result.status === "failed" &&
        result.error.code === "HOST_NOT_FOUND"
      )
    ) {
      return result;
    }
    const queued = queueCancellation();
    if (queued.status === "failed") return queued;
    const retry = await runExisting(input.operationId, cancelWithLease);
    if (
      retry.status !== "busy" &&
      !(
        retry.status === "failed" &&
        retry.error.code === "HOST_NOT_FOUND"
      )
    ) {
      return retry;
    }
    return queued;
  }

  async function inspectOperation(input: {
    readonly operationId: string;
  }) {
    const record = await options.store.readOperation(input.operationId);
    if (record === null) {
      throw hostError(
        "HOST_NOT_FOUND",
        "The Host operation does not exist.",
        input.operationId,
      );
    }
    return inspectHostOperation(record);
  }

  return Object.freeze({
    startOperation,
    resumeOperation,
    recoverPendingOperations,
    cancelOperation,
    inspectOperation,
  });
}
