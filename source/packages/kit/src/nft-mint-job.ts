import { assertValidTws, canonicalize, hashCanonical, parseProtocolTimestamp } from "@tbc-wallet/core";
import type { KitTransactionRequest, Tbc721StandardBatchMintIntent, Tbc721StandardMintItem } from "./public-types.js";

const HASH = /^[0-9a-f]{64}$/u;
const ATOMIC = /^(?:0|[1-9][0-9]{0,19})$/u;
const MAX_ITEMS = 2_000; // The existing collection supply limit, not a transaction limit.
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_JOB_PLAN_BYTES = 32 * 1024 * 1024;

export interface TbcNftMintJobAuthority {
  readonly chainId: `tbc:${string}`;
  readonly accountId: string;
  readonly address: string;
  readonly origin: string;
  readonly sessionId: string;
}

export interface TbcNftMintJobLimits {
  /** Atomic units, across every sub-batch; not a fresh allowance per sub-batch. */
  readonly maxTotalFee: string;
  readonly expiresAt: string;
  readonly maxItemsPerBatch?: number;
  /** Local serialized Engine plan budget. Cannot exceed the Engine's 4 MiB bound. */
  readonly maxPlanBytes?: number;
  readonly maxTotalPlanBytes?: number;
}

export interface TbcNftMintJobScope {
  readonly operationKind: "tbc721.batchMint";
  readonly authority: TbcNftMintJobAuthority;
  readonly collectionId: string;
  /** Ordered, immutable and with every recipient made explicit before consent. */
  readonly items: readonly Tbc721StandardMintItem[];
  readonly limits: Readonly<Required<TbcNftMintJobLimits>>;
}

export type TbcNftMintJobApproval =
  | Readonly<{ status: "rejected"; scopeHash: string }>
  | Readonly<{ status: "approved"; scopeHash: string; approvalId: string; approvedAt: string; expiresAt: string }>;

export interface TbcNftMintJobPreparedBatch {
  readonly status: "ready";
  readonly request: KitTransactionRequest<Tbc721StandardBatchMintIntent>;
  readonly planHash: string;
  readonly totalFee: string;
  readonly transactionCount: number;
  readonly serializedPlanBytes: number;
  /** Opaque, exact, unsigned material owned by the shared executor, never page assertions. */
  readonly prepared: unknown;
}

export type TbcNftMintJobPreparation = TbcNftMintJobPreparedBatch | Readonly<{
  /** Only the shared planner's proven byte/resource excess may produce this result. */
  status: "resource-limit";
  resource: "plan-bytes" | "continuation-bytes" | "inputs" | "outputs";
}>;

export interface TbcNftMintJobTransaction {
  readonly txid: string;
  readonly fee: string;
  readonly status: "accepted" | "known" | "uncertain" | "rejected" | "not-submitted";
}

export interface TbcNftMintJobExecution {
  readonly status: "complete" | "partial" | "uncertain" | "failed" | "pending";
  readonly transactions: readonly TbcNftMintJobTransaction[];
  readonly recoveryId?: string;
  /** Validated signed parents/change, for the next prepare; never refetched from the API. */
  readonly continuation?: unknown;
}

export interface TbcNftMintJobBatchResult {
  readonly offset: number;
  readonly count: number;
  readonly planHash: string;
  readonly status: TbcNftMintJobExecution["status"];
  readonly transactions: readonly TbcNftMintJobTransaction[];
  readonly recoveryId?: string;
}

export type TbcNftMintJobStopReason = "complete" | "rejected" | "cancelled" | "expired"
  | "authority-changed" | "preparation-failed" | "resource-limit" | "fee-budget"
  | "execution-failed" | "operation-pending" | "submission-uncertain";

export interface TbcNftMintJobResult {
  readonly status: "complete" | "partial" | "stopped" | "uncertain";
  readonly reason: TbcNftMintJobStopReason;
  readonly scopeHash: string;
  readonly requested: number;
  /** Only accepted/known transactions count as minted, never an unknown POST. */
  readonly minted: number;
  readonly confirmedSubmissionFee: string;
  readonly batches: readonly TbcNftMintJobBatchResult[];
}

export interface TbcNftMintJobAdapter {
  /** The composition must permission-gate the job before this read or the consent UI. */
  readonly begin: (scope: TbcNftMintJobScope) => Promise<unknown>;
  readonly approve: (input: Readonly<{ scope: TbcNftMintJobScope; scopeHash: string }>) => Promise<TbcNftMintJobApproval>;
  /** Wallet-owned live origin/session/account check. Not a network observation. */
  readonly assertAuthority: (scope: TbcNftMintJobScope) => Promise<void>;
  readonly prepare: (input: Readonly<{
    scope: TbcNftMintJobScope;
    scopeHash: string;
    request: KitTransactionRequest<Tbc721StandardBatchMintIntent>;
    offset: number;
    context: unknown;
    continuation?: unknown;
  }>) => Promise<TbcNftMintJobPreparation>;
  /**
   * Reuse Core/Host's exact binding, Signer, Engine validation and broadcaster.
   * This consent is not a signing credential: issue/check the exact per-plan
   * credential without another UI. Unknown effects must retain their journal.
   */
  readonly execute: (input: Readonly<{
    scope: TbcNftMintJobScope;
    scopeHash: string;
    approval: Extract<TbcNftMintJobApproval, { status: "approved" }>;
    batch: TbcNftMintJobPreparedBatch;
    offset: number;
    context: unknown;
    signal?: AbortSignal;
  }>) => Promise<TbcNftMintJobExecution>;
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function bytes(value: unknown): number { return new TextEncoder().encode(canonicalize(value)).length; }
function amount(value: string): bigint {
  if (typeof value !== "string" || !ATOMIC.test(value)) throw new Error("Invalid NFT job atomic fee");
  return BigInt(value);
}
function time(value: string): number {
  return parseProtocolTimestamp(value);
}
function integer(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Invalid NFT job resource bound");
}
function batchRequest(scope: TbcNftMintJobScope, offset: number, count: number, maxFee: string,
  expiresAt = scope.limits.expiresAt): KitTransactionRequest<Tbc721StandardBatchMintIntent> {
  return frozen({ version: "1.0", chainId: scope.authority.chainId, from: scope.authority.address,
    intent: { version: "1.0", type: "tbc721-standard-batch-mint", collectionId: scope.collectionId,
      items: scope.items.slice(offset, offset + count) }, constraints: { maxFee, expiresAt } });
}

/** Synchronous: take ownership and validate every item before any asynchronous callback. */
export function createTbcNftMintJobScope(input: Readonly<{
  authority: TbcNftMintJobAuthority;
  collectionId: string;
  items: readonly Tbc721StandardMintItem[];
  limits: TbcNftMintJobLimits;
}>): TbcNftMintJobScope {
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_ITEMS) {
    throw new Error("NFT job must contain 1–2000 items");
  }
  // The Provider boundary supplies plain JSON. Canonical ownership also rejects
  // cyclic/non-JSON data for trusted native callers and binds UTF-8, not JS units.
  if (bytes(input) > MAX_MANIFEST_BYTES) throw new Error("NFT job manifest exceeds 8 MiB");
  const owned = JSON.parse(canonicalize(input)) as typeof input;
  if (Object.keys(owned).some(k => !["authority", "collectionId", "items", "limits"].includes(k)) ||
      Object.keys(owned.limits).some(k => !["maxTotalFee", "expiresAt", "maxItemsPerBatch", "maxPlanBytes", "maxTotalPlanBytes"].includes(k))) {
    throw new Error("Unknown NFT job field");
  }
  const authority = owned.authority;
  if (!/^tbc:[a-z0-9_-]{1,32}$/u.test(authority.chainId) ||
      authority.accountId !== `${authority.chainId}:${authority.address}` ||
      typeof authority.sessionId !== "string" || !authority.sessionId.length || authority.sessionId.length > 256 ||
      new URL(authority.origin).origin !== authority.origin || !HASH.test(owned.collectionId)) {
    throw new Error("Invalid NFT job authority or collection");
  }
  amount(owned.limits.maxTotalFee); time(owned.limits.expiresAt);
  const limits = { maxItemsPerBatch: 100, maxPlanBytes: MAX_PLAN_BYTES, maxTotalPlanBytes: MAX_JOB_PLAN_BYTES, ...owned.limits };
  integer(limits.maxItemsPerBatch, 1, 100);
  integer(limits.maxPlanBytes, 1, MAX_PLAN_BYTES);
  integer(limits.maxTotalPlanBytes, limits.maxPlanBytes, MAX_JOB_PLAN_BYTES);
  const items = owned.items.map(item => ({ ...item, to: item.to ?? authority.address }));
  if (new Set(items.map(i => i.slot)).size !== items.length) throw new Error("Duplicate NFT job slot");
  const scope = frozen({ operationKind: "tbc721.batchMint" as const, authority,
    collectionId: owned.collectionId, items, limits });
  // Use the existing transaction schema, including media and metadata budgets;
  // never introduce a second looser item validator just for the job API.
  for (let offset = 0; offset < items.length; offset += 100) {
    assertValidTws("transactionRequest", batchRequest(scope, offset, 100, limits.maxTotalFee));
  }
  return scope;
}

/**
 * Task-scoped coordinator, with no UI, keys, persistence, fetch or automatic
 * retry. It selects exact contiguous slices of a single immutable consent.
 * The default wallet composition supplies the existing shared executor.
 */
export function createTbcNftMintJobOrchestrator(adapter: TbcNftMintJobAdapter, options: Readonly<{
  now?: () => number;
  /** Executor-local work budget; may only narrow the approved per-batch maximum. */
  executionBatchSize?: number;
}> = {}) {
  const now = options.now ?? Date.now;
  const executionBatchSize = options.executionBatchSize ?? 100;
  integer(executionBatchSize, 1, 100);
  let running = false;
  return Object.freeze({ async run(input: Parameters<typeof createTbcNftMintJobScope>[0] & Readonly<{ signal?: AbortSignal }>): Promise<TbcNftMintJobResult> {
    if (running) throw new Error("An NFT mint job is already active");
    const { signal, ...scopeInput } = input;
    const scope = createTbcNftMintJobScope(scopeInput);
    const scopeHash = hashCanonical(scope);
    running = true;
    const batches: TbcNftMintJobBatchResult[] = [];
    let minted = 0, paid = 0n, totalBytes = 0, continuation: unknown;
    let expires = time(scope.limits.expiresAt);
    const result = (reason: TbcNftMintJobStopReason): TbcNftMintJobResult => frozen({
      status: reason === "complete" ? "complete" : reason === "submission-uncertain" || reason === "operation-pending"
        ? "uncertain" : minted > 0 ? "partial" : "stopped",
      reason, scopeHash, requested: scope.items.length, minted,
      confirmedSubmissionFee: paid.toString(), batches,
    });
    const stopped = (): TbcNftMintJobStopReason | undefined => signal?.aborted ? "cancelled" : now() >= expires ? "expired" : undefined;
    try {
      if (stopped()) return result(stopped()!);
      try { await adapter.assertAuthority(scope); } catch { return result("authority-changed"); }
      // Reads run in parallel with the one consent UI. Suppress a rejection
      // while the user decides, but never turn failed reads into empty assets.
      const context = Promise.resolve().then(() => adapter.begin(scope)).then(
        value => ({ ok: true as const, value }), () => ({ ok: false as const }));
      const decision = frozen(JSON.parse(canonicalize(await adapter.approve({ scope, scopeHash }))) as TbcNftMintJobApproval);
      if (decision.scopeHash !== scopeHash) throw new Error("NFT job consent binding mismatch");
      if (decision.status === "rejected") return result("rejected");
      if (decision.status !== "approved" || typeof decision.approvalId !== "string" || !decision.approvalId.length ||
          time(decision.approvedAt) > now() || time(decision.expiresAt) > expires ||
          time(decision.approvedAt) >= time(decision.expiresAt)) throw new Error("Invalid NFT job approval");
      expires = time(decision.expiresAt);
      const loaded = await context;
      if (stopped()) return result(stopped()!);
      if (!loaded.ok) return result("preparation-failed");
      const seenTxids = new Set<string>();
      let offset = 0, batchLimit = Math.min(scope.limits.maxItemsPerBatch, executionBatchSize);
      while (offset < scope.items.length) {
        if (stopped()) return result(stopped()!);
        try { await adapter.assertAuthority(scope); } catch { return result("authority-changed"); }
        const remaining = amount(scope.limits.maxTotalFee) - paid;
        let count = Math.min(batchLimit, scope.items.length - offset), prepared: TbcNftMintJobPreparedBatch;
        for (;;) {
          if (stopped()) return result(stopped()!);
          const request = batchRequest(scope, offset, count, remaining.toString(), new Date(expires).toISOString());
          let candidate: TbcNftMintJobPreparation;
          try {
            candidate = await adapter.prepare({ scope, scopeHash, request, offset, context: loaded.value,
              ...(continuation === undefined ? {} : { continuation }) });
          } catch { return result("preparation-failed"); }
          if (candidate.status === "resource-limit") {
            if (!["plan-bytes", "continuation-bytes", "inputs", "outputs"].includes(candidate.resource)) throw new Error("Unknown NFT preparation limit");
          } else {
            if (candidate.status !== "ready" || canonicalize(candidate.request) !== canonicalize(request) ||
                !HASH.test(candidate.planHash) || candidate.transactionCount !== count) throw new Error("NFT batch left the approved job scope");
            integer(candidate.serializedPlanBytes, 1, Number.MAX_SAFE_INTEGER);
            if (amount(candidate.totalFee) > remaining) return result("fee-budget");
            if (candidate.serializedPlanBytes <= scope.limits.maxPlanBytes) { prepared = Object.freeze({ ...candidate, request }); break; }
          }
          if (count === 1) return result("resource-limit");
          // Bounded local re-planning, no new reads, signatures or POSTs.
          count = Math.max(1, Math.floor(count / 2));
          batchLimit = count;
        }
        if (totalBytes + prepared.serializedPlanBytes > scope.limits.maxTotalPlanBytes) return result("resource-limit");
        if (stopped()) return result(stopped()!);
        try { await adapter.assertAuthority(scope); } catch { return result("authority-changed"); }
        if (stopped()) return result(stopped()!);
        let execution: TbcNftMintJobExecution;
        try {
          execution = await adapter.execute({ scope, scopeHash, approval: decision, batch: prepared, offset,
            context: loaded.value, ...(signal === undefined ? {} : { signal }) });
        } catch {
          // The adapter may already have dispatched an effect. Never silently
          // rebuild, advance inputs, or claim that a thrown callback spent nothing.
          batches.push(frozen({ offset, count, planHash: prepared.planHash, status: "uncertain", transactions: [] }));
          return result("submission-uncertain");
        }
        let accepted = 0, batchPaid = 0n, uncertain = false, interrupted = false;
        try {
        uncertain = execution.status === "uncertain";
        if (!["complete", "partial", "uncertain", "failed", "pending"].includes(execution.status)) throw new Error("Invalid NFT batch execution status");
        if (!Array.isArray(execution.transactions) || execution.transactions.length > count) throw new Error("Invalid NFT batch result count");
        for (const tx of execution.transactions) {
          if (!HASH.test(tx.txid) || seenTxids.has(tx.txid)) throw new Error("Invalid or reused NFT result transaction");
          seenTxids.add(tx.txid);
          const fee = amount(tx.fee);
          if (tx.status === "accepted" || tx.status === "known") {
            if (interrupted) throw new Error("NFT dependent transaction accepted after an interrupted predecessor");
            accepted++; batchPaid += fee;
          } else {
            if (!["uncertain", "rejected", "not-submitted"].includes(tx.status)) throw new Error("Invalid NFT transaction outcome");
            interrupted = true; uncertain ||= tx.status === "uncertain";
          }
        }
        if (batchPaid > amount(prepared.totalFee) || paid + batchPaid > amount(scope.limits.maxTotalFee)) throw new Error("NFT execution exceeded approved fee");
        if (execution.status === "complete" && accepted === count && batchPaid !== amount(prepared.totalFee)) {
          throw new Error("NFT completed fee differs from the validated plan");
        }
        } catch {
          // A malformed executor reply is not evidence of zero effects. Keep
          // the confirmed earlier batches and an explicit unresolved identity;
          // do not throw away the job's partial result or continue signing.
          batches.push(frozen({ offset, count, planHash: prepared.planHash, status: "uncertain", transactions: [],
            ...(typeof execution?.recoveryId === "string" ? { recoveryId: execution.recoveryId } : {}) }));
          return result("submission-uncertain");
        }
        minted += accepted; paid += batchPaid; totalBytes += prepared.serializedPlanBytes;
        batches.push(frozen({ offset, count, planHash: prepared.planHash, status: execution.status,
          transactions: execution.transactions.map(tx => ({ ...tx })),
          ...(execution.recoveryId === undefined ? {} : { recoveryId: execution.recoveryId }) }));
        if (uncertain) return result("submission-uncertain");
        if (execution.status === "pending") return result("operation-pending");
        if (execution.status !== "complete" || accepted !== count) return result(stopped() ?? "execution-failed");
        continuation = execution.continuation;
        offset += count;
      }
      return result("complete");
    } finally { running = false; }
  } });
}
