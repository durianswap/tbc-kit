import { canonicalize, hashCanonical } from "@tbc-wallet/core";

const HASH32 = /^[0-9a-f]{64}$/u;
const CHAIN_ID = /^tbc:[a-z0-9_-]{1,32}$/u;
const ACCOUNT_ID = /^tbc:[a-z0-9_-]{1,32}:[1-9A-HJ-NP-Za-km-z]{20,64}$/u;
const CONTRACT_ID = /^[0-9a-f]{64}$/u;
const MAX_TRANSACTIONS = 64;
const MAX_INDEX_REFRESHES = 32;

export type TbcMultiRoundMergeAsset =
  | Readonly<{ readonly kind: "tbc" }>
  | Readonly<{ readonly kind: "ft"; readonly contractId: string }>
  | Readonly<{ readonly kind: "stablecoin"; readonly contractId: string }>
  | Readonly<{ readonly kind: "pool-ft"; readonly poolContractId: string }>
  | Readonly<{ readonly kind: "ftlp"; readonly poolContractId: string }>;

export interface TbcMultiRoundMergePoolIdentity {
  readonly poolContractId: string;
  readonly ftContractId: string;
  readonly currentPoolTxid: string;
}

export interface TbcMultiRoundMergeImpact {
  readonly custody: "active-account" | "pool-contract";
  readonly resultOwner: "active-account" | "pool-contract";
  readonly maxAssetInputsPerTransaction: number;
  readonly poolIdentity?: TbcMultiRoundMergePoolIdentity;
}

export interface TbcMultiRoundMergeAuthority {
  readonly chainId: `tbc:${string}`;
  readonly accountId: string;
  readonly origin: string;
  readonly sessionId: string;
}

export interface TbcMultiRoundMergeLimits {
  readonly targetUtxoCount: number;
  readonly maxTransactions: number;
  readonly maxTotalFee: string;
  readonly expiresAt: string;
  /** Maximum bounded index refreshes after one accepted transaction. */
  readonly maxIndexRefreshes?: number;
  /** Delay is delegated so React Native and browser hosts retain clock control. */
  readonly indexRefreshDelayMs?: number;
}

export interface TbcMultiRoundMergeState {
  readonly version: "1.0";
  readonly authority: TbcMultiRoundMergeAuthority;
  readonly asset: TbcMultiRoundMergeAsset;
  readonly observedAt: string;
  readonly revision: string;
  readonly utxoCount: number;
  /** Required for Pool assets and derived from the authoritative Pool index. */
  readonly poolIdentity?: TbcMultiRoundMergePoolIdentity;
  /** Stable hash of the authoritative index identity; observation time is excluded. */
  readonly stateHash: string;
  /** Accepted parent transactions actually represented by this index view. */
  readonly observedTransactionIds: readonly string[];
}

/** Derive the stable state identity used across bounded index refreshes. */
export function hashTbcMultiRoundMergeState(
  state: Omit<TbcMultiRoundMergeState, "stateHash">,
): string {
  return hashCanonical({
    version: state.version,
    authority: state.authority,
    asset: state.asset,
    revision: state.revision,
    utxoCount: state.utxoCount,
    ...(state.poolIdentity === undefined ? {} : { poolIdentity: state.poolIdentity }),
    observedTransactionIds: state.observedTransactionIds,
  });
}

export interface TbcMultiRoundMergeScope {
  readonly version: "1.0";
  readonly operationKind: "multi-round-merge";
  readonly authority: TbcMultiRoundMergeAuthority;
  readonly asset: TbcMultiRoundMergeAsset;
  /** Approval-display semantics; Pool-held FT remains owned by the Pool. */
  readonly impact: TbcMultiRoundMergeImpact;
  readonly limits: Readonly<Required<TbcMultiRoundMergeLimits>>;
  readonly initialStateHash: string;
  readonly initialUtxoCount: number;
}

export interface TbcMultiRoundMergeApprovalRequest {
  readonly scope: TbcMultiRoundMergeScope;
  readonly scopeHash: string;
}

export type TbcMultiRoundMergeApprovalDecision =
  | Readonly<{ readonly status: "rejected"; readonly scopeHash: string }>
  | Readonly<{
      readonly status: "approved";
      readonly scopeHash: string;
      readonly approvalId: string;
      readonly approvedAt: string;
      readonly expiresAt: string;
    }>;

export interface TbcMultiRoundMergePreparedStep {
  readonly version: "1.0";
  readonly stepId: string;
  readonly stepIndex: number;
  readonly authority: TbcMultiRoundMergeAuthority;
  readonly asset: TbcMultiRoundMergeAsset;
  readonly stateHash: string;
  readonly materialHash: string;
  readonly inputCount: number;
  readonly outputCount: 1;
  /** Production composition uses a remaining-budget cap until Engine returns the exact fee. */
  readonly feeKind?: "exact" | "maximum";
  readonly fee: string;
  readonly expiresAt: string;
  /** Only earlier transactions in this same approved run may appear here. */
  readonly dependsOn: readonly string[];
  /** Opaque exact prepared material consumed once by the Kit execution adapter. */
  readonly prepared: unknown;
}

export type TbcMultiRoundMergeExecutionResult =
  | Readonly<{
      readonly status: "accepted" | "known" | "uncertain";
      readonly stepId: string;
      readonly materialHash: string;
      readonly txid: string;
      readonly fee: string;
      readonly inputsConsumed: number;
      readonly outputsCreated: 1;
    }>
  | Readonly<{
      readonly status: "rejected" | "failed";
      readonly stepId: string;
      readonly materialHash: string;
      readonly error: string;
    }>
  | Readonly<{
      /** A durable pre-broadcast Host operation still owns this exact step. */
      readonly status: "pending";
      readonly stepId: string;
      readonly materialHash: string;
      readonly recoveryId: string;
      readonly error: string;
    }>;

export type TbcMultiRoundMergeReconcileResult = Readonly<{
  readonly txid: string;
  readonly status: "known" | "rejected" | "unknown";
}>;

export interface TbcMultiRoundMergeStepResult {
  readonly stepId: string;
  readonly txid?: string;
  /** Durable Host operation identity retained when submit outcome is uncertain. */
  readonly recoveryId?: string;
  readonly status: "accepted" | "known" | "rejected" | "failed" | "pending" | "uncertain";
  readonly fee: string;
  readonly inputCount: number;
  readonly outputCount: 1;
  readonly dependsOn: readonly string[];
}

export type TbcMultiRoundMergeStopReason =
  | "target-reached"
  | "already-below-target"
  | "approval-rejected"
  | "cancelled"
  | "expired"
  | "transaction-budget-exhausted"
  | "fee-budget-exhausted"
  | "index-stalled"
  | "facts-changed"
  | "step-rejected"
  | "step-failed"
  | "operation-pending"
  | "broadcast-uncertain";

export interface TbcMultiRoundMergeResult {
  readonly version: "1.0";
  readonly status: "complete" | "partial" | "stopped" | "uncertain";
  readonly reason: TbcMultiRoundMergeStopReason;
  readonly scopeHash: string;
  readonly approvalId?: string;
  readonly initialUtxoCount: number;
  readonly finalUtxoCount: number;
  readonly totalFee: string;
  readonly steps: readonly TbcMultiRoundMergeStepResult[];
}

export interface TbcMultiRoundMergeProgress {
  readonly phase: "approval" | "preparing" | "executing" | "reconciling" | "indexing" | "complete";
  readonly stepIndex: number;
  readonly utxoCount: number;
  readonly targetUtxoCount: number;
  readonly transactionCount: number;
  readonly totalFee: string;
}

export interface TbcMultiRoundMergeAdapter {
  /** Must be permission-gated by the wallet before this orchestrator is exposed to a page. */
  readonly readState: (
    authority: TbcMultiRoundMergeAuthority,
    asset: TbcMultiRoundMergeAsset,
  ) => Promise<TbcMultiRoundMergeState>;
  /** One bounded consent. It is not a reusable wallet permission. */
  readonly approve: (
    request: TbcMultiRoundMergeApprovalRequest,
  ) => Promise<TbcMultiRoundMergeApprovalDecision>;
  /**
   * Uses the existing Kit Chain Data, policy and Engine planning path. The
   * returned exact material is still unsigned and unsubmitted.
   */
  readonly prepareStep: (input: Readonly<{
    scope: TbcMultiRoundMergeScope;
    scopeHash: string;
    approval: Extract<TbcMultiRoundMergeApprovalDecision, { status: "approved" }>;
    state: TbcMultiRoundMergeState;
    stepIndex: number;
    remainingFee: string;
    acceptedTxids: readonly string[];
  }>) => Promise<TbcMultiRoundMergePreparedStep>;
  /**
   * Must consume `prepared` once through the shared Kit approval/Signer/Engine/
   * broadcast path and bind the formal per-step approval to `materialHash`.
   */
  readonly executePreparedStep: (input: Readonly<{
    scope: TbcMultiRoundMergeScope;
    scopeHash: string;
    approval: Extract<TbcMultiRoundMergeApprovalDecision, { status: "approved" }>;
    step: TbcMultiRoundMergePreparedStep;
  }>) => Promise<TbcMultiRoundMergeExecutionResult>;
  /** Unknown POST outcomes enter only this path; the step is never re-executed. */
  readonly reconcile: (input: Readonly<{
    scope: TbcMultiRoundMergeScope;
    scopeHash: string;
    approval: Extract<TbcMultiRoundMergeApprovalDecision, { status: "approved" }>;
    step: TbcMultiRoundMergePreparedStep;
    txid: string;
  }>) => Promise<TbcMultiRoundMergeReconcileResult>;
  readonly waitForIndex?: (input: Readonly<{
    attempt: number;
    delayMs: number;
    txid: string;
  }>) => Promise<void>;
  /** Wallet-owned live authority check performed immediately before execution. */
  readonly assertAuthority?: (input: Readonly<{
    scope: TbcMultiRoundMergeScope;
    scopeHash: string;
    approval: Extract<TbcMultiRoundMergeApprovalDecision, { status: "approved" }>;
    step: TbcMultiRoundMergePreparedStep;
  }>) => Promise<void>;
}

export interface TbcMultiRoundMergeRunInput {
  readonly authority: TbcMultiRoundMergeAuthority;
  readonly asset: TbcMultiRoundMergeAsset;
  readonly limits: TbcMultiRoundMergeLimits;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TbcMultiRoundMergeProgress) => void;
}

export class TbcMultiRoundMergeConflictError extends Error {
  override readonly name = "TbcMultiRoundMergeConflictError";
}

export class TbcMultiRoundMergeInputError extends TypeError {
  override readonly name = "TbcMultiRoundMergeInputError";
}

function atomic(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TbcMultiRoundMergeInputError(`Invalid ${label}`);
  }
  return BigInt(value);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TbcMultiRoundMergeInputError(`Invalid ${label}`);
  }
  return Number(value);
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "string") throw new TbcMultiRoundMergeInputError(`Invalid ${label}`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TbcMultiRoundMergeInputError(`Invalid ${label}`);
  return milliseconds;
}

function validateAuthority(value: TbcMultiRoundMergeAuthority): void {
  if (
    value === null || typeof value !== "object" ||
    !CHAIN_ID.test(value.chainId) || !ACCOUNT_ID.test(value.accountId) ||
    !value.accountId.startsWith(`${value.chainId}:`) ||
    typeof value.origin !== "string" || !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/u.test(value.origin) ||
    typeof value.sessionId !== "string" || value.sessionId.length === 0 || value.sessionId.length > 256
  ) throw new TbcMultiRoundMergeInputError("Invalid multi-round merge authority");
}

function validateAsset(value: TbcMultiRoundMergeAsset): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TbcMultiRoundMergeInputError("Invalid multi-round merge asset");
  }
  if (value.kind === "tbc" && Object.keys(value).length === 1) return;
  if (
    (value.kind === "ft" || value.kind === "stablecoin") &&
    Object.keys(value).length === 2 &&
    CONTRACT_ID.test(value.contractId)
  ) return;
  if (
    (value.kind === "pool-ft" || value.kind === "ftlp") &&
    Object.keys(value).length === 2 &&
    CONTRACT_ID.test(value.poolContractId)
  ) return;
  throw new TbcMultiRoundMergeInputError("Invalid multi-round merge asset");
}

/** Validate a page-visible bounded request before permission or private index I/O. */
export function assertTbcMultiRoundMergeInput(
  input: Readonly<{ asset: TbcMultiRoundMergeAsset; limits: TbcMultiRoundMergeLimits }>,
  now?: number,
): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TbcMultiRoundMergeInputError("Invalid multi-round merge input");
  }
  validateAsset(input.asset);
  if (input.limits === null || typeof input.limits !== "object" || Array.isArray(input.limits)) {
    throw new TbcMultiRoundMergeInputError("Invalid multi-round merge limits");
  }
  if (Object.keys(input.limits).some((key) => ![
    "targetUtxoCount",
    "maxTransactions",
    "maxTotalFee",
    "expiresAt",
    "maxIndexRefreshes",
    "indexRefreshDelayMs",
  ].includes(key))) throw new TbcMultiRoundMergeInputError("Invalid multi-round merge limit field");
  integer(input.limits.targetUtxoCount, "target UTXO count", 1, 1_000_000);
  integer(input.limits.maxTransactions, "transaction budget", 1, MAX_TRANSACTIONS);
  integer(input.limits.maxIndexRefreshes ?? 6, "index refresh budget", 0, MAX_INDEX_REFRESHES);
  integer(input.limits.indexRefreshDelayMs ?? 1_000, "index refresh delay", 0, 60_000);
  atomic(input.limits.maxTotalFee, "total fee budget");
  if (now !== undefined && timestamp(input.limits.expiresAt, "merge expiry") <= now) {
    throw new TbcMultiRoundMergeInputError("Multi-round merge is already expired");
  }
}

function impactFor(
  asset: TbcMultiRoundMergeAsset,
  poolIdentity?: TbcMultiRoundMergePoolIdentity,
): TbcMultiRoundMergeImpact {
  if (asset.kind === "tbc") {
    return Object.freeze({
      custody: "active-account",
      resultOwner: "active-account",
      maxAssetInputsPerTransaction: 100,
    });
  }
  if (asset.kind === "ft" || asset.kind === "stablecoin") {
    return Object.freeze({
      custody: "active-account",
      resultOwner: "active-account",
      maxAssetInputsPerTransaction: 5,
    });
  }
  if (
    poolIdentity === undefined ||
    poolIdentity.poolContractId !== asset.poolContractId ||
    !CONTRACT_ID.test(poolIdentity.ftContractId) ||
    !HASH32.test(poolIdentity.currentPoolTxid)
  ) {
    throw new TbcMultiRoundMergeConflictError("Invalid multi-round Pool identity");
  }
  const frozenIdentity = Object.freeze({ ...poolIdentity });
  return Object.freeze({
    custody: asset.kind === "pool-ft" ? "pool-contract" : "active-account",
    resultOwner: asset.kind === "pool-ft" ? "pool-contract" : "active-account",
    maxAssetInputsPerTransaction: asset.kind === "pool-ft" ? 4 : 5,
    poolIdentity: frozenIdentity,
  });
}

function same(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function validateState(
  state: TbcMultiRoundMergeState,
  authority: TbcMultiRoundMergeAuthority,
  asset: TbcMultiRoundMergeAsset,
): void {
  if (
    state.version !== "1.0" || !same(state.authority, authority) || !same(state.asset, asset) ||
    !HASH32.test(state.stateHash) || state.stateHash !== hashTbcMultiRoundMergeState(state) ||
    typeof state.revision !== "string" || state.revision.length === 0 ||
    !Number.isSafeInteger(state.utxoCount) || state.utxoCount < 0 ||
    !Array.isArray(state.observedTransactionIds) ||
    new Set(state.observedTransactionIds).size !== state.observedTransactionIds.length ||
    state.observedTransactionIds.some((txid) => !HASH32.test(txid)) ||
    !Number.isFinite(Date.parse(state.observedAt))
  ) throw new TbcMultiRoundMergeConflictError("Invalid multi-round merge state binding");
  impactFor(asset, state.poolIdentity);
}

function validatePreparedStep(
  step: TbcMultiRoundMergePreparedStep,
  scope: TbcMultiRoundMergeScope,
  state: TbcMultiRoundMergeState,
  stepIndex: number,
  acceptedTxids: readonly string[],
): bigint {
  const maximumInputs = scope.impact.maxAssetInputsPerTransaction;
  const fee = atomic(step.fee, "prepared merge fee");
  if (
    step.version !== "1.0" || step.stepIndex !== stepIndex ||
    step.stepId !== `merge-${String(stepIndex)}` ||
    !same(step.authority, scope.authority) || !same(step.asset, scope.asset) ||
    step.stateHash !== state.stateHash || !HASH32.test(step.materialHash) ||
    !Number.isSafeInteger(step.inputCount) || step.inputCount < 2 ||
    step.inputCount > maximumInputs || step.inputCount > state.utxoCount ||
    step.outputCount !== 1 || timestamp(step.expiresAt, "prepared merge expiry") > timestamp(scope.limits.expiresAt, "merge scope expiry") ||
    !Array.isArray(step.dependsOn) || new Set(step.dependsOn).size !== step.dependsOn.length ||
    step.dependsOn.some((txid) => !acceptedTxids.includes(txid))
  ) throw new TbcMultiRoundMergeConflictError("Prepared merge step is outside its approved scope");
  return fee;
}

function validateExecution(
  result: TbcMultiRoundMergeExecutionResult,
  step: TbcMultiRoundMergePreparedStep,
): bigint | undefined {
  if (result.stepId !== step.stepId || result.materialHash !== step.materialHash) {
    throw new TbcMultiRoundMergeConflictError("Merge execution material binding mismatch");
  }
  if ("error" in result) {
    if (typeof result.error !== "string" || result.error.length === 0) {
      throw new TbcMultiRoundMergeConflictError("Invalid merge execution failure");
    }
    return undefined;
  }
  const executionFee = atomic(result.fee, "merge execution fee");
  if (
    !HASH32.test(result.txid) ||
    (step.feeKind === "maximum" ? executionFee > atomic(step.fee, "prepared merge fee") : result.fee !== step.fee) ||
    result.inputsConsumed !== step.inputCount || result.outputsCreated !== step.outputCount
  ) throw new TbcMultiRoundMergeConflictError("Merge execution result mismatch");
  return executionFee;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function immutableClone<T>(value: T): T {
  const cloned = JSON.parse(canonicalize(value)) as T;
  const freeze = (candidate: unknown): void => {
    if (candidate !== null && typeof candidate === "object" && !Object.isFrozen(candidate)) {
      for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child);
      Object.freeze(candidate);
    }
  };
  freeze(cloned);
  return cloned;
}

function resultStatus(steps: readonly TbcMultiRoundMergeStepResult[]): "partial" | "stopped" {
  return steps.some((step) => step.status === "accepted" || step.status === "known") ? "partial" : "stopped";
}

export function createTbcMultiRoundMergeOrchestrator(
  adapter: TbcMultiRoundMergeAdapter,
  options: Readonly<{ readonly now?: () => number }> = {},
): Readonly<{ readonly run: (input: TbcMultiRoundMergeRunInput) => Promise<TbcMultiRoundMergeResult> }> {
  if (
    adapter === null || typeof adapter !== "object" ||
    typeof adapter.readState !== "function" || typeof adapter.approve !== "function" ||
    typeof adapter.prepareStep !== "function" || typeof adapter.executePreparedStep !== "function" ||
    typeof adapter.reconcile !== "function" ||
    (adapter.waitForIndex !== undefined && typeof adapter.waitForIndex !== "function") ||
    (adapter.assertAuthority !== undefined && typeof adapter.assertAuthority !== "function")
  ) throw new TbcMultiRoundMergeInputError("Invalid multi-round merge adapter");
  const now = options.now ?? Date.now;

  const run = async (input: TbcMultiRoundMergeRunInput): Promise<TbcMultiRoundMergeResult> => {
    const authority = immutableClone(input.authority);
    const asset = immutableClone(input.asset);
    validateAuthority(authority);
    assertTbcMultiRoundMergeInput({ asset, limits: input.limits }, now());
    const targetUtxoCount = integer(input.limits.targetUtxoCount, "target UTXO count", 1, 1_000_000);
    const maxTransactions = integer(input.limits.maxTransactions, "transaction budget", 1, MAX_TRANSACTIONS);
    const maxIndexRefreshes = integer(input.limits.maxIndexRefreshes ?? 6, "index refresh budget", 0, MAX_INDEX_REFRESHES);
    const indexRefreshDelayMs = integer(input.limits.indexRefreshDelayMs ?? 1_000, "index refresh delay", 0, 60_000);
    const maxTotalFee = atomic(input.limits.maxTotalFee, "total fee budget");
    const expiresAt = timestamp(input.limits.expiresAt, "merge expiry");
    if (expiresAt <= now()) throw new TbcMultiRoundMergeInputError("Multi-round merge is already expired");
    const limits = Object.freeze({
      targetUtxoCount,
      maxTransactions,
      maxTotalFee: maxTotalFee.toString(),
      expiresAt: input.limits.expiresAt,
      maxIndexRefreshes,
      indexRefreshDelayMs,
    });
    let state = await adapter.readState(authority, asset);
    validateState(state, authority, asset);
    const initialUtxoCount = state.utxoCount;
    const bareScope = Object.freeze({
      version: "1.0" as const,
      operationKind: "multi-round-merge" as const,
      authority,
      asset,
      impact: impactFor(asset, state.poolIdentity),
      limits,
      initialStateHash: state.stateHash,
      initialUtxoCount,
    });
    const scope = Object.freeze(bareScope) as TbcMultiRoundMergeScope;
    const scopeHash = hashCanonical(scope);
    const steps: TbcMultiRoundMergeStepResult[] = [];
    let totalFee = 0n;
    const progress = (phase: TbcMultiRoundMergeProgress["phase"], stepIndex: number) => {
      try {
        input.onProgress?.(Object.freeze({
          phase,
          stepIndex,
          utxoCount: state.utxoCount,
          targetUtxoCount,
          transactionCount: steps.length,
          totalFee: totalFee.toString(),
        }));
      } catch (error) {
        // Progress observers cannot change execution semantics.
      }
    };
    const finish = (
      status: TbcMultiRoundMergeResult["status"],
      reason: TbcMultiRoundMergeStopReason,
      approvalId?: string,
    ): TbcMultiRoundMergeResult => Object.freeze({
      version: "1.0" as const,
      status,
      reason,
      scopeHash,
      ...(approvalId === undefined ? {} : { approvalId }),
      initialUtxoCount,
      finalUtxoCount: state.utxoCount,
      totalFee: totalFee.toString(),
      steps: Object.freeze([...steps]),
    });

    if (state.utxoCount <= targetUtxoCount) {
      progress("complete", 0);
      return finish("complete", "already-below-target");
    }
    progress("approval", 0);
    const approval = await adapter.approve(Object.freeze({ scope, scopeHash }));
    if (approval.scopeHash !== scopeHash) {
      throw new TbcMultiRoundMergeConflictError("Merge approval scope mismatch");
    }
    if (approval.status === "rejected") return finish("stopped", "approval-rejected");
    if (
      typeof approval.approvalId !== "string" || approval.approvalId.length === 0 ||
      timestamp(approval.approvedAt, "merge approval time") > now() ||
      timestamp(approval.expiresAt, "merge approval expiry") > expiresAt ||
      timestamp(approval.expiresAt, "merge approval expiry") <= now()
    ) throw new TbcMultiRoundMergeConflictError("Invalid merge approval binding");

    const acceptedTxids: string[] = [];
    for (let stepIndex = 1; stepIndex <= maxTransactions; stepIndex += 1) {
      if (isAborted(input.signal)) return finish(resultStatus(steps), "cancelled", approval.approvalId);
      if (now() >= expiresAt || now() >= Date.parse(approval.expiresAt)) {
        return finish(resultStatus(steps), "expired", approval.approvalId);
      }
      if (state.utxoCount <= targetUtxoCount) {
        progress("complete", stepIndex);
        return finish("complete", "target-reached", approval.approvalId);
      }
      if (state.utxoCount > initialUtxoCount) {
        return finish(resultStatus(steps), "facts-changed", approval.approvalId);
      }
      progress("preparing", stepIndex);
      let step: TbcMultiRoundMergePreparedStep;
      try {
        step = await adapter.prepareStep(Object.freeze({
          scope,
          scopeHash,
          approval,
          state,
          stepIndex,
          remainingFee: (maxTotalFee - totalFee).toString(),
          acceptedTxids: Object.freeze([...acceptedTxids]),
        }));
      } catch {
        return finish(resultStatus(steps), "step-failed", approval.approvalId);
      }
      const stepFee = validatePreparedStep(step, scope, state, stepIndex, acceptedTxids);
      if (totalFee + stepFee > maxTotalFee) {
        return finish(resultStatus(steps), "fee-budget-exhausted", approval.approvalId);
      }
      if (isAborted(input.signal)) return finish(resultStatus(steps), "cancelled", approval.approvalId);
      const executionExpiry = Math.min(
        expiresAt,
        Date.parse(approval.expiresAt),
        Date.parse(step.expiresAt),
      );
      if (now() >= executionExpiry) return finish(resultStatus(steps), "expired", approval.approvalId);
      try {
        await adapter.assertAuthority?.(Object.freeze({ scope, scopeHash, approval, step }));
      } catch {
        return finish(resultStatus(steps), "facts-changed", approval.approvalId);
      }
      if (isAborted(input.signal)) return finish(resultStatus(steps), "cancelled", approval.approvalId);
      if (now() >= executionExpiry) return finish(resultStatus(steps), "expired", approval.approvalId);
      progress("executing", stepIndex);
      let execution: TbcMultiRoundMergeExecutionResult;
      try {
        execution = await adapter.executePreparedStep(Object.freeze({ scope, scopeHash, approval, step }));
      } catch (error) {
        if (isAborted(input.signal)) {
          return finish(resultStatus(steps), "cancelled", approval.approvalId);
        }
        if (now() >= executionExpiry) {
          return finish(resultStatus(steps), "expired", approval.approvalId);
        }
        // The callback may have lost a response after POST. Retain the approved
        // exposure and identity instead of reporting that no step happened.
        totalFee += stepFee;
        steps.push(Object.freeze({
          stepId: step.stepId,
          ...(error !== null && typeof error === "object" &&
              typeof Reflect.get(error, "recoveryId") === "string"
            ? { recoveryId: Reflect.get(error, "recoveryId") as string }
            : {}),
          status: "uncertain" as const,
          fee: step.fee,
          inputCount: step.inputCount,
          outputCount: 1 as const,
          dependsOn: step.dependsOn,
        }));
        return finish("uncertain", "broadcast-uncertain", approval.approvalId);
      }
      const executionFee = validateExecution(execution, step);
      if ("error" in execution) {
        if (execution.status === "pending") {
          steps.push(Object.freeze({
            stepId: step.stepId,
            recoveryId: execution.recoveryId,
            status: "pending" as const,
            fee: "0",
            inputCount: step.inputCount,
            outputCount: 1 as const,
            dependsOn: step.dependsOn,
          }));
          return finish("uncertain", "operation-pending", approval.approvalId);
        }
        if (isAborted(input.signal)) {
          return finish(resultStatus(steps), "cancelled", approval.approvalId);
        }
        if (now() >= executionExpiry) {
          return finish(resultStatus(steps), "expired", approval.approvalId);
        }
        steps.push(Object.freeze({
          stepId: step.stepId,
          status: execution.status,
          fee: "0",
          inputCount: step.inputCount,
          outputCount: 1,
          dependsOn: step.dependsOn,
        }));
        return finish(resultStatus(steps), execution.status === "rejected" ? "step-rejected" : "step-failed", approval.approvalId);
      }
      let acceptedStatus: "accepted" | "known" = execution.status === "known" ? "known" : "accepted";
      if (execution.status === "uncertain") {
        progress("reconciling", stepIndex);
        let reconciled: TbcMultiRoundMergeReconcileResult;
        try {
          reconciled = await adapter.reconcile(Object.freeze({
            scope,
            scopeHash,
            approval,
            step,
            txid: execution.txid,
          }));
        } catch {
          totalFee += executionFee!;
          steps.push(Object.freeze({
            stepId: step.stepId,
            txid: execution.txid,
            status: "uncertain" as const,
            fee: execution.fee,
            inputCount: step.inputCount,
            outputCount: 1 as const,
            dependsOn: step.dependsOn,
          }));
          return finish("uncertain", "broadcast-uncertain", approval.approvalId);
        }
        if (reconciled.txid !== execution.txid) {
          throw new TbcMultiRoundMergeConflictError("Merge reconciliation identity mismatch");
        }
        if (reconciled.status === "unknown") {
          // Reserve the full approved fee exposure: the network may have
          // accepted this transaction even though reconciliation is incomplete.
          totalFee += executionFee!;
          steps.push(Object.freeze({
            stepId: step.stepId,
            txid: execution.txid,
            status: "uncertain" as const,
            fee: execution.fee,
            inputCount: step.inputCount,
            outputCount: 1 as const,
            dependsOn: step.dependsOn,
          }));
          return finish("uncertain", "broadcast-uncertain", approval.approvalId);
        }
        if (reconciled.status === "rejected") {
          steps.push(Object.freeze({
            stepId: step.stepId,
            txid: execution.txid,
            status: "rejected" as const,
            fee: "0",
            inputCount: step.inputCount,
            outputCount: 1 as const,
            dependsOn: step.dependsOn,
          }));
          return finish(resultStatus(steps), "step-rejected", approval.approvalId);
        }
        acceptedStatus = "known";
      }
      totalFee += executionFee!;
      acceptedTxids.push(execution.txid);
      steps.push(Object.freeze({
        stepId: step.stepId,
        txid: execution.txid,
        status: acceptedStatus,
        fee: execution.fee,
        inputCount: step.inputCount,
        outputCount: 1 as const,
        dependsOn: step.dependsOn,
      }));

      const previous = state;
      let indexed = false;
      for (let attempt = 0; attempt <= maxIndexRefreshes; attempt += 1) {
        if (isAborted(input.signal)) return finish("partial", "cancelled", approval.approvalId);
        if (attempt > 0) {
          progress("indexing", stepIndex);
          if (adapter.waitForIndex === undefined) {
            await new Promise<void>((resolve) => setTimeout(resolve, indexRefreshDelayMs));
          } else {
            await adapter.waitForIndex({ attempt, delayMs: indexRefreshDelayMs, txid: execution.txid });
          }
        }
        let next: TbcMultiRoundMergeState;
        try {
          next = await adapter.readState(authority, asset);
        } catch {
          return finish("partial", "index-stalled", approval.approvalId);
        }
        validateState(next, authority, asset);
        const approvedPoolIdentity = scope.impact.poolIdentity;
        if (
          approvedPoolIdentity !== undefined &&
          (
            next.poolIdentity === undefined ||
            next.poolIdentity.poolContractId !== approvedPoolIdentity.poolContractId ||
            next.poolIdentity.ftContractId !== approvedPoolIdentity.ftContractId
          )
        ) {
          state = next;
          return finish("partial", "facts-changed", approval.approvalId);
        }
        if (next.utxoCount > initialUtxoCount) {
          state = next;
          return finish("partial", "facts-changed", approval.approvalId);
        }
        if (next.utxoCount < previous.utxoCount) {
          if (!next.observedTransactionIds.includes(execution.txid)) {
            throw new TbcMultiRoundMergeConflictError("Index progress is not bound to the accepted merge");
          }
          const eliminated = step.inputCount - step.outputCount;
          if (previous.utxoCount - next.utxoCount !== eliminated) {
            state = next;
            return finish("partial", "facts-changed", approval.approvalId);
          }
          if (
            asset.kind === "pool-ft" &&
            next.poolIdentity?.currentPoolTxid !== execution.txid
          ) {
            state = next;
            return finish("partial", "facts-changed", approval.approvalId);
          }
          if (
            asset.kind === "ftlp" &&
            next.poolIdentity?.currentPoolTxid !==
              previous.poolIdentity?.currentPoolTxid
          ) {
            state = next;
            return finish("partial", "facts-changed", approval.approvalId);
          }
          state = next;
          indexed = true;
          break;
        }
        if (next.utxoCount !== previous.utxoCount || next.stateHash !== previous.stateHash) {
          state = next;
          return finish("partial", "facts-changed", approval.approvalId);
        }
        state = next;
      }
      if (!indexed) return finish("partial", "index-stalled", approval.approvalId);
      if (state.utxoCount <= targetUtxoCount) {
        progress("complete", stepIndex);
        return finish("complete", "target-reached", approval.approvalId);
      }
    }
    return finish("partial", "transaction-budget-exhausted", approval.approvalId);
  };

  return Object.freeze({ run });
}
