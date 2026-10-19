import {
  assertValidTws,
  canonicalize,
  hashCanonical,
  hexToBytes,
  sha256Hex,
  type BroadcastReconcileResult,
  type BroadcastSubmitParams,
  type BroadcastSubmitResult,
  type BroadcastSubmitBatchParams,
  type BroadcastSubmitBatchResult,
} from "./core-runtime.js";
import type {
  TbcKitBroadcastIdentity,
  TbcKitBroadcastJournal,
  TbcKitBroadcastJournalRecord,
} from "./broadcast-journal.js";
import { TbcKitBroadcastConflictError } from "./broadcast-journal.js";
import {
  isTestnetNodeError,
  type TestnetClient,
  type TestnetTransactionStatus,
} from "./testnet-client.js";
import { assertRawTransaction, turingTransactionId } from "./testnet-validation.js";
import type { KitHostPortCall } from "./wallet-runtime.js";
import {
  assertTbcNetworkContext,
  createTbcNetworkContext,
  type TbcNetworkContext,
} from "./network-context.js";

export interface DefaultTbcBroadcastOptions {
  readonly client: TestnetClient;
  readonly journal: TbcKitBroadcastJournal;
  readonly network: TbcNetworkContext;
  /** New unified runtimes scope recovery by source identity. Legacy wrapper disables this for in-place Testnet recovery. */
  readonly scopeJournal?: boolean;
  /** Wallet-owned active account scope; used only to isolate journal recovery. */
  readonly accountScopeHash?: () => Promise<string>;
}

export interface DefaultTbcBroadcast {
  readonly network: TbcNetworkContext;
  readonly submit: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
  readonly submitBatch: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
  readonly reconcile: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
  /** Lists durable submit-boundary records without resuming Core or signing. */
  readonly listRecovery: (limit?: number) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
  /** Explicit status-only recovery. It never submits transaction bytes. */
  readonly recover: (txids: readonly string[]) => Promise<unknown>;
}

export type DefaultTbcTestnetBroadcastOptions = Omit<DefaultTbcBroadcastOptions, "network">;
export type DefaultTbcTestnetBroadcast = DefaultTbcBroadcast;

const JOURNAL_NETWORK_BINDINGS = new WeakMap<object, string>();

function failure(
  name: "INVALID_INPUT" | "UNAUTHORIZED" | "UNAVAILABLE" | "CONFLICT",
  retryable = false,
  network: "mainnet" | "testnet" = "testnet",
) {
  const label = network === "mainnet" ? "TBC Mainnet" : "TBC Testnet";
  return Object.freeze({
    portError: Object.freeze({
      name,
      retryable,
      message: name === "UNAVAILABLE"
        ? `${label} submission outcome is unknown`
        : `${label} broadcast identity conflict`,
    }),
  });
}

function exactHostCall(
  call: KitHostPortCall | undefined,
  operation: "broadcast.submit" | "broadcast.submitBatch" | "broadcast.reconcile",
  params: unknown,
): boolean {
  try {
    return call !== undefined &&
      call.operation === operation &&
      (call.execution.type === "session-only" || call.execution.type === "durable") &&
      canonicalize(call.params) === canonicalize(params);
  } catch {
    return false;
  }
}

function exactKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validSubmitParams(value: unknown): value is BroadcastSubmitParams {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const params = value as Readonly<Record<string, unknown>>;
  const transaction = params.transaction;
  if (transaction === null || typeof transaction !== "object" || Array.isArray(transaction)) return false;
  const signed = transaction as Readonly<Record<string, unknown>>;
  return exactKeys(params, ["version", "chainId", "transaction", "idempotencyKey"]) &&
    exactKeys(signed, ["id", "txid", "rawTransaction", "role", "dependsOn"]) &&
    params.version === "1.0" &&
    typeof params.chainId === "string" && /^tbc:[a-z0-9_-]{1,32}$/u.test(params.chainId) &&
    typeof params.idempotencyKey === "string" && params.idempotencyKey.length >= 1 && params.idempotencyKey.length <= 256 &&
    typeof signed.id === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(signed.id) &&
    typeof signed.txid === "string" && /^[0-9a-f]{64}$/u.test(signed.txid) &&
    typeof signed.rawTransaction === "string" && /^(?:[0-9a-f]{2})+$/u.test(signed.rawTransaction) &&
    (signed.role === "primary" || signed.role === "prerequisite" || signed.role === "maintenance") &&
    Array.isArray(signed.dependsOn) &&
    new Set(signed.dependsOn).size === signed.dependsOn.length &&
    signed.dependsOn.every((dependency) =>
      typeof dependency === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(dependency));
}

function validSubmitBatchParams(value: unknown): value is BroadcastSubmitBatchParams {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const params = value as Readonly<Record<string, unknown>>;
  if (
    !exactKeys(params, ["version", "chainId", "transactions", "idempotencyKey"]) ||
    params.version !== "1.0" ||
    typeof params.chainId !== "string" || !/^tbc:[a-z0-9_-]{1,32}$/u.test(params.chainId) ||
    typeof params.idempotencyKey !== "string" || params.idempotencyKey.length < 1 || params.idempotencyKey.length > 256 ||
    !Array.isArray(params.transactions) || params.transactions.length < 1 || params.transactions.length > 32
  ) return false;
  const seenTxids = new Set<string>();
  return params.transactions.every((transaction) => {
    const single = { version: "1.0", chainId: params.chainId, transaction, idempotencyKey: params.idempotencyKey };
    if (!validSubmitParams(single)) return false;
    const txid = (transaction as { readonly txid: string }).txid;
    if (seenTxids.has(txid)) return false;
    seenTxids.add(txid);
    return true;
  });
}

function validReconcileParams(value: unknown): value is Readonly<{
  version: "1.0";
  chainId: string;
  txids: readonly string[];
}> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const params = value as Readonly<Record<string, unknown>>;
  return exactKeys(params, ["version", "chainId", "txids"]) &&
    params.version === "1.0" &&
    typeof params.chainId === "string" && /^tbc:[a-z0-9_-]{1,32}$/u.test(params.chainId) &&
    Array.isArray(params.txids) &&
    params.txids.length >= 1 && params.txids.length <= 32 &&
    new Set(params.txids).size === params.txids.length &&
    params.txids.every((txid) => typeof txid === "string" && /^[0-9a-f]{64}$/u.test(txid));
}

function identity(
  params: BroadcastSubmitParams,
  call: KitHostPortCall,
  accountScopeHash?: string,
): TbcKitBroadcastIdentity {
  const raw = assertRawTransaction(params.transaction.rawTransaction);
  const txid = turingTransactionId(raw);
  if (txid !== params.transaction.txid) {
    throw new TbcKitBroadcastConflictError("Signed transaction txid mismatch");
  }
  return Object.freeze({
    idempotencyKey: params.idempotencyKey,
    rawHash: sha256Hex(hexToBytes(raw)),
    txid,
    submitContextHash: hashCanonical(Object.freeze({
      version: "1.0",
      callId: call.callId,
      operation: call.operation,
      params,
    })),
    ...(accountScopeHash === undefined ? {} : { accountScopeHash }),
  });
}

function validStatus(status: TestnetTransactionStatus): boolean {
  if (status.status === "unknown" || status.status === "rejected") {
    return status.confirmations === undefined;
  }
  if (status.confirmations === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(status.confirmations)) {
    return false;
  }
  return status.status === "mempool"
    ? status.confirmations === "0"
    : BigInt(status.confirmations) > 0n;
}

function recordForTxid(
  records: readonly TbcKitBroadcastJournalRecord[],
  txid: string,
): TbcKitBroadcastJournalRecord | undefined {
  return records.find((record) => record.txid === txid);
}

function networkScopedJournal(
  journal: TbcKitBroadcastJournal,
  network: TbcNetworkContext,
): TbcKitBroadcastJournal {
  const prefix = `tbcnet-${network.sourceIdentity.slice(0, 24)}-`;
  const scoped = (identity: TbcKitBroadcastIdentity): TbcKitBroadcastIdentity =>
    identity.idempotencyKey.startsWith(prefix)
      ? identity
      : Object.freeze({
          ...identity,
          idempotencyKey: `${prefix}${hashCanonical({ idempotencyKey: identity.idempotencyKey })}`,
        });
  const scopedJournal: TbcKitBroadcastJournal = {
    async beginSubmit(identity) {
      return journal.beginSubmit(scoped(identity));
    },
    async beginSubmitBatch(identities) {
      return journal.beginSubmitBatch(identities.map(scoped));
    },
    prepare: (identity) => journal.prepare(scoped(identity)),
    markUncertain: (identity) => journal.markUncertain(scoped(identity)),
    complete: (identity, result) => journal.complete(scoped(identity), result),
    abortPreNetwork: (identity, evidence) => journal.abortPreNetwork(scoped(identity), evidence),
    read: (idempotencyKey) => journal.read(
      `${prefix}${hashCanonical({ idempotencyKey })}`,
    ),
    async readByTxids(txids) {
      const records = await journal.readByTxids(txids);
      return Object.freeze(records.filter((record) => record.idempotencyKey.startsWith(prefix)));
    },
    listIncomplete(limit, scope) {
      return journal.listIncomplete(limit, Object.freeze({
        ...scope,
        idempotencyKeyPrefix: prefix,
      }));
    },
  };
  return Object.freeze(scopedJournal);
}

export function createDefaultTbcBroadcast(
  options: DefaultTbcBroadcastOptions,
): DefaultTbcBroadcast {
  if (options === null || typeof options !== "object" || options.journal === undefined) {
    throw new TypeError("A durable Kit broadcast journal is required");
  }
  const network = assertTbcNetworkContext(options.network);
  if (options.scopeJournal !== false) {
    const existingBinding = JOURNAL_NETWORK_BINDINGS.get(options.journal);
    if (existingBinding !== undefined && existingBinding !== network.sourceIdentity) {
      throw new TypeError("A durable broadcast journal cannot be shared across TBC network sources");
    }
    JOURNAL_NETWORK_BINDINGS.set(options.journal, network.sourceIdentity);
  }
  const fail = (
    name: "INVALID_INPUT" | "UNAUTHORIZED" | "UNAVAILABLE" | "CONFLICT",
    retryable = false,
  ) => failure(name, retryable, network.network);
  const journal = options.scopeJournal === false
    ? options.journal
    : networkScopedJournal(options.journal, network);
  async function currentAccountScopeHash(): Promise<string | undefined> {
    const value = await options.accountScopeHash?.();
    if (value !== undefined && !/^[0-9a-f]{64}$/u.test(value)) {
      throw new TbcKitBroadcastConflictError("Invalid broadcast account scope");
    }
    return value;
  }

  async function submit(rawParams: unknown, call?: KitHostPortCall): Promise<unknown> {
    if (!exactHostCall(call, "broadcast.submit", rawParams)) return fail("CONFLICT");
    if (!validSubmitParams(rawParams)) return fail("INVALID_INPUT");
    const params = rawParams;
    if (params.chainId !== network.chainId) return fail("UNAUTHORIZED");
    try {
      const preparedIdentity = identity(params, call!, await currentAccountScopeHash());
      const preparation = await journal.beginSubmit(preparedIdentity);
      const prepared = preparation.record;
      if (prepared.state === "completed" && prepared.result !== undefined) return prepared.result;
      if (prepared.state === "not-submitted") return fail("INVALID_INPUT");
      if (!preparation.created || prepared.state === "uncertain") return fail("UNAVAILABLE", true);
      try {
        await options.client.preflightBroadcast(params.transaction.rawTransaction);
      } catch (error) {
        if (
          isTestnetNodeError(error) &&
          (error.code === "INVALID_INPUT" || error.code === "NODE_RESPONSE_INVALID")
        ) {
          await journal.abortPreNetwork(preparedIdentity, {
            version: "1.0",
            kind: "local-preflight",
            failureCode: error.code,
          });
          return fail("INVALID_INPUT");
        }
        return fail("CONFLICT");
      }
      await journal.markUncertain(preparedIdentity);
      let submitted: Readonly<{ txid: string }>;
      try {
        submitted = await options.client.broadcast(params.transaction.rawTransaction);
      } catch {
        return fail("UNAVAILABLE", true);
      }
      if (submitted.txid !== preparedIdentity.txid) return fail("UNAVAILABLE", true);
      const result: BroadcastSubmitResult = Object.freeze({
        txid: preparedIdentity.txid,
        status: "accepted",
      });
      const completed = await journal.complete(preparedIdentity, result);
      if (completed.result === undefined) throw new TbcKitBroadcastConflictError("Broadcast result was not committed");
      return completed.result;
    } catch (error) {
      if (isTestnetNodeError(error) && error.code === "NODE_REQUEST_FAILED") {
        return fail("UNAVAILABLE", true);
      }
      return fail("CONFLICT");
    }
  }

  async function submitBatch(rawParams: unknown, call?: KitHostPortCall): Promise<unknown> {
    if (!exactHostCall(call, "broadcast.submitBatch", rawParams)) return fail("CONFLICT");
    if (!validSubmitBatchParams(rawParams)) return fail("INVALID_INPUT");
    const params = rawParams;
    if (params.chainId !== network.chainId) return fail("UNAUTHORIZED");
    try {
      const accountScopeHash = await currentAccountScopeHash();
      const identities = params.transactions.map((transaction, index) => {
        const raw = assertRawTransaction(transaction.rawTransaction);
        const txid = turingTransactionId(raw);
        if (txid !== transaction.txid) {
          throw new TbcKitBroadcastConflictError("Signed transaction txid mismatch");
        }
        return Object.freeze({
          idempotencyKey: `${params.idempotencyKey}:${String(index)}`,
          rawHash: sha256Hex(hexToBytes(raw)),
          txid,
          submitContextHash: hashCanonical(Object.freeze({
            version: "1.0",
            callId: call!.callId,
            operation: call!.operation,
            params,
            index,
          })),
          ...(accountScopeHash === undefined ? {} : { accountScopeHash }),
        });
      });
      const existing = await Promise.all(identities.map(({ idempotencyKey }) => journal.read(idempotencyKey)));
      if (existing.some((record) => record !== null)) {
        const preparation = await journal.beginSubmitBatch(identities);
        if (preparation.records.some((record) => record === null)) return fail("CONFLICT");
        const replay: BroadcastSubmitBatchResult = Object.freeze({
          transactions: Object.freeze(preparation.records.map((record) => record!.state === "completed" && record!.result !== undefined
            ? Object.freeze({ ...record!.result })
            : Object.freeze({
                txid: record!.txid,
                status: "unknown" as const,
                reason: "Prior batch submission is unresolved; query status without resending",
              }))),
        });
        return replay;
      }
      try {
        await Promise.all(params.transactions.map(({ rawTransaction }) => options.client.preflightBroadcast(rawTransaction)));
      } catch (error) {
        return isTestnetNodeError(error) && (error.code === "INVALID_INPUT" || error.code === "NODE_RESPONSE_INVALID")
          ? fail("INVALID_INPUT")
          : fail("CONFLICT");
      }
      const preparation = await journal.beginSubmitBatch(identities);
      if (!preparation.created) {
        if (preparation.records.some((record) => record === null)) return fail("CONFLICT");
        const replay: BroadcastSubmitBatchResult = Object.freeze({
          transactions: Object.freeze(preparation.records.map((record) =>
            record!.state === "completed" && record!.result !== undefined
              ? Object.freeze({ ...record!.result })
              : Object.freeze({
                  txid: record!.txid,
                  status: "unknown" as const,
                  reason: "Prior batch submission is unresolved; query status without resending",
                }))),
        });
        return replay;
      }
      await Promise.all(identities.map((item) => journal.markUncertain(item)));
      let networkResults;
      try {
        networkResults = await options.client.broadcastBatch(
          params.transactions.map(({ rawTransaction }) => rawTransaction),
        );
      } catch {
        networkResults = identities.map(({ txid }) => Object.freeze({
          txid,
          status: "unknown" as const,
          reason: "TBC batch submission outcome is unknown",
        }));
      }
      if (
        networkResults.length !== identities.length ||
        networkResults.some((item, index) => item.txid !== identities[index]?.txid)
      ) return fail("CONFLICT");
      const statusByTemplateId = new Map<string, "accepted" | "rejected" | "unknown">();
      const transactions = Object.freeze(networkResults.map((item, index) => {
        const transaction = params.transactions[index]!;
        const blocked = transaction.dependsOn.some((dependency) => {
          const status = statusByTemplateId.get(dependency);
          return status === "rejected" || status === "unknown";
        });
        const result = blocked && item.status === "accepted"
          ? Object.freeze({
              txid: item.txid,
              status: "unknown" as const,
              reason: "A prerequisite transaction was not accepted",
            })
          : Object.freeze({ ...item });
        statusByTemplateId.set(transaction.id, result.status);
        return result;
      }));
      await Promise.all(transactions.map(async (result, index) => {
        if (result.status === "unknown") return;
        const completed: BroadcastSubmitResult = result.status === "rejected"
          ? Object.freeze({
              txid: result.txid,
              status: "rejected" as const,
              reason: result.reason ?? "TBC batch item rejected",
            })
          : Object.freeze({ txid: result.txid, status: "accepted" as const });
        await journal.complete(identities[index]!, completed);
      }));
      const response: BroadcastSubmitBatchResult = Object.freeze({ transactions });
      assertValidTws("broadcastSubmitBatchResult", response);
      return response;
    } catch (error) {
      if (isTestnetNodeError(error) && error.code === "NODE_REQUEST_FAILED") {
        return fail("UNAVAILABLE", true);
      }
      return fail("CONFLICT");
    }
  }

  async function reconcileTxids(
    txids: readonly string[],
    recoveryOnly = false,
  ): Promise<unknown> {
    try {
      const records = await journal.readByTxids(txids);
      if (txids.some((txid) => recordForTxid(records, txid) === undefined)) {
        throw new TbcKitBroadcastConflictError("Reconciliation transaction was not journaled");
      }
      if (recoveryOnly && records.some((record) => record.state !== "uncertain")) {
        throw new TbcKitBroadcastConflictError("Startup recovery accepts only uncertain submissions");
      }
      const accountScopeHash = await currentAccountScopeHash();
      if (
        accountScopeHash !== undefined &&
        records.some((record) => record.accountScopeHash !== accountScopeHash)
      ) {
        throw new TbcKitBroadcastConflictError("Broadcast recovery account scope mismatch");
      }
      const statuses = await Promise.all(txids.map((txid) => options.client.getTransactionStatus(txid)));
      if (statuses.some((status, index) => status.txid !== txids[index] || !validStatus(status))) {
        throw new TbcKitBroadcastConflictError("Broadcast status contradiction");
      }
      for (const status of statuses) {
        if (status.status === "unknown") continue;
        const record = recordForTxid(records, status.txid);
        if (record === undefined) throw new TbcKitBroadcastConflictError("Missing broadcast journal record");
        const result: BroadcastSubmitResult = status.status === "rejected"
          ? Object.freeze({
              txid: status.txid,
              status: "rejected",
              reason: `TBC ${network.network} rejected the transaction`,
            })
          : Object.freeze({ txid: status.txid, status: "known" });
        if (
          record.state === "completed" &&
          record.result?.status === "accepted" &&
          result.status === "rejected"
        ) {
          throw new TbcKitBroadcastConflictError("Accepted broadcast later reported rejected");
        }
        if (record.state !== "completed") await journal.complete(record, result);
      }
      const result: BroadcastReconcileResult = Object.freeze({
        transactions: Object.freeze(statuses.map((status) => Object.freeze({ ...status }))),
      });
      assertValidTws("broadcastReconcileResult", result);
      return result;
    } catch (error) {
      if (isTestnetNodeError(error) && error.code === "NODE_REQUEST_FAILED") {
        return fail("UNAVAILABLE", true);
      }
      return fail("CONFLICT");
    }
  }

  async function reconcile(rawParams: unknown, call?: KitHostPortCall): Promise<unknown> {
    if (!exactHostCall(call, "broadcast.reconcile", rawParams)) return fail("CONFLICT");
    if (!validReconcileParams(rawParams)) return fail("INVALID_INPUT");
    const params = rawParams;
    if (params.chainId !== network.chainId) return fail("UNAUTHORIZED");
    return reconcileTxids(params.txids);
  }

  async function recover(txids: readonly string[]): Promise<unknown> {
    if (
      !Array.isArray(txids) || txids.length < 1 || txids.length > 32 ||
      new Set(txids).size !== txids.length ||
      txids.some((txid) => typeof txid !== "string" || !/^[0-9a-f]{64}$/u.test(txid))
    ) return fail("INVALID_INPUT");
    return reconcileTxids(txids, true);
  }

  return Object.freeze({
    network,
    submit,
    submitBatch,
    reconcile,
    listRecovery: async (limit?: number) => {
      const accountScopeHash = await currentAccountScopeHash();
      return journal.listIncomplete(
        limit,
        accountScopeHash === undefined ? undefined : Object.freeze({ accountScopeHash }),
      );
    },
    recover,
  });
}

export function createDefaultTbcTestnetBroadcast(
  options: DefaultTbcTestnetBroadcastOptions,
): DefaultTbcTestnetBroadcast {
  return createDefaultTbcBroadcast({
    ...options,
    network: createTbcNetworkContext({ network: "testnet" }),
    scopeJournal: false,
  });
}
