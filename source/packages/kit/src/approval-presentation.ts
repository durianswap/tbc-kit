import { assertValidTws, canonicalize, hashCanonical, resolveTransactionSigningAccounts, resolveWorkflowSigningAccounts,
  type WorkflowRoleRequest, type TransactionRoleRequest, type TransactionRoleAccount } from "./core-runtime.js";
import { htlcClaimDisclosureWarnings } from "./htlc-privacy.js";
import { describeAmmFeePolicy } from "./amm-fee-policy.js";
import {
  ApprovalHostEvidenceConflictError,
  type ApprovalHostEvidenceEnvelope,
  type ApprovalHostRequestShape,
} from "./approval-host-evidence.js";

export type TbcApprovalPresentationSource =
  | "core-binding"
  | "engine-preview"
  | "engine-plan"
  | "bound-request"
  | "preparation-scope";

export type TbcApprovalPresentationField<Value> =
  | Readonly<{
      status: "known";
      value: Value;
      source: TbcApprovalPresentationSource;
    }>
  | Readonly<{
      status: "unknown";
      reason: "NOT_BOUND" | "NOT_AVAILABLE";
    }>;

export interface TbcApprovalPresentationAmount {
  /** Canonical smallest-unit integer from the bound Engine preview. */
  readonly atomic: string;
  readonly precision: TbcApprovalPresentationField<number>;
  readonly display: TbcApprovalPresentationField<string>;
}

export interface TbcApprovalPresentationAsset {
  readonly kind: string;
  readonly direction: string;
  readonly contractId: TbcApprovalPresentationField<string>;
  readonly symbol: TbcApprovalPresentationField<string>;
  readonly amount: TbcApprovalPresentationAmount;
  readonly from: TbcApprovalPresentationField<string>;
  readonly to: TbcApprovalPresentationField<string>;
  readonly source: "engine-preview";
}

export interface TbcApprovalContractExecution {
  readonly businessType: string;
  readonly implementation: string;
  readonly generation: "current" | "historical";
}

export interface TbcApprovalPresentationStep {
  readonly id: string;
  readonly kind: string;
  readonly dependsOn: readonly string[];
  readonly businessType: TbcApprovalPresentationField<string>;
  readonly contractExecution: TbcApprovalPresentationField<TbcApprovalContractExecution>;
  /** Bound intent display projection; HTLC preimages are omitted, not unbound. */
  readonly businessTerms: TbcApprovalPresentationField<Readonly<Record<string, unknown>>>;
  readonly assets: readonly TbcApprovalPresentationAsset[];
  readonly actualFeeAtomic: TbcApprovalPresentationField<string>;
  readonly signingTaskCount: TbcApprovalPresentationField<number>;
  /** Step-local warnings. Never attribute a flattened batch warning to every step. */
  readonly warnings: readonly string[];
  /** Chain transactions, not workflow steps. Never duplicate aggregate flows. */
  readonly transactions: readonly TbcApprovalPresentationTransaction[];
  readonly transactionsStatus: "not-bound" | "available" | "not-available" | "not-applicable";
}

export interface TbcApprovalPresentationTransaction {
  readonly id: string;
  readonly role: TbcApprovalPresentationField<string>;
  readonly dependsOn: readonly string[];
  /** A template commitment, never presented as a broadcast txid. */
  readonly templateHash: TbcApprovalPresentationField<string>;
  readonly feeAtomic: TbcApprovalPresentationField<string>;
  readonly assets: readonly TbcApprovalPresentationAsset[];
  readonly assetsStatus: "available" | "step-summary-only";
  readonly warnings: readonly string[];
  /** Exact output balances, NOT net user debits. Includes change/internal/pool
   * outputs; do not sum with the business summary or with network fees. */
  readonly outputs: readonly TbcApprovalPresentationOutput[];
  readonly outputsStatus: "available" | "partial" | "not-available";
}

export interface TbcApprovalPresentationOutput {
  readonly outputIndices: readonly number[];
  readonly kind: string;
  /** Code identity / NFT origin, not an invented API contract ID. */
  readonly assetIdentity: TbcApprovalPresentationField<string>;
  readonly amountAtomic: TbcApprovalPresentationField<string>;
  readonly recipient: TbcApprovalPresentationField<string>;
  readonly nativeValueAtomic: string;
  readonly lockTime: TbcApprovalPresentationField<number>;
  readonly warnings: readonly string[];
}

export interface TbcApprovalPresentation {
  readonly version: "1.0";
  readonly phase: "preparation" | "formal";
  readonly trust: "intent-bounded" | "binding-verified";
  readonly method: string;
  readonly operationKind: string;
  readonly prepared: boolean;
  readonly businessType: TbcApprovalPresentationField<string>;
  /** Actual successful Engine route; unknown during early consent, never inferred from an API label. */
  readonly contractExecution: TbcApprovalPresentationField<TbcApprovalContractExecution>;
  /** Bound intent display projection, excluding HTLC preimages and Prepared material. */
  readonly businessTerms: TbcApprovalPresentationField<Readonly<Record<string, unknown>>>;
  readonly requester: TbcApprovalPresentationField<Readonly<{
    transport: string;
    origin: string;
    topOrigin: string;
    frame: string;
  }>>;
  readonly chainId: TbcApprovalPresentationField<string>;
  readonly accountId: TbcApprovalPresentationField<string>;
  /** Additional authority; workflow roles apply only to the named step, not the entire batch. */
  readonly signingRoles?: TbcApprovalPresentationField<readonly Readonly<{ role: "pool-controller" | "coin-admin"; accountId: string; stepId?: string }>[]>;
  readonly expiresAt: TbcApprovalPresentationField<string>;
  readonly fees: Readonly<{
    maximumAtomic: TbcApprovalPresentationField<string>;
    actualAtomic: TbcApprovalPresentationField<string>;
  }>;
  readonly counts: Readonly<{
    steps: TbcApprovalPresentationField<number>;
    transactions: TbcApprovalPresentationField<number>;
    signingTasks: TbcApprovalPresentationField<number>;
  }>;
  readonly assets: readonly TbcApprovalPresentationAsset[];
  readonly steps: readonly TbcApprovalPresentationStep[];
  readonly transactions: readonly TbcApprovalPresentationTransaction[];
  readonly transactionsStatus: TbcApprovalPresentationStep["transactionsStatus"];
  readonly warnings: readonly string[];
  readonly binding: Readonly<{
    status: "not-created" | "verified";
    requestHash: string;
    operationHash?: string;
    bindingHash?: string;
  }>;
  readonly evidence: Readonly<{
    sources: readonly TbcApprovalPresentationSource[];
    previewHash?: string;
    callId?: string;
    operationId?: string;
    releaseFingerprint?: string;
  }>;
  /** Fields intentionally unavailable from the currently bound evidence. */
  readonly unknown: readonly string[];
}

export interface TbcApprovalPreparationPresentationInput {
  readonly method: string;
  readonly operationKind: string;
  readonly requestHash: string;
  readonly chainId?: string;
  readonly accountId?: string;
  readonly suggestedFeeCapAtomic?: string;
  readonly warningScope: readonly string[];
  readonly expiresAt: number;
  readonly request: unknown;
}

const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const HASH32 = /^[0-9a-f]{64}$/u;

function conflict(message = "Approval presentation evidence is invalid"): never {
  throw new ApprovalHostEvidenceConflictError(message);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return conflict();
  return value as Readonly<Record<string, unknown>>;
}

function records(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return conflict();
  return value.map(record);
}

function text(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : conflict();
}

function decimal(value: unknown): string {
  const result = text(value);
  return DECIMAL.test(result) ? result : conflict();
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : conflict();
}

function known<Value>(
  value: Value,
  source: TbcApprovalPresentationSource,
): TbcApprovalPresentationField<Value> {
  return Object.freeze({ status: "known", value, source });
}

function unknown<Value>(
  reason: "NOT_BOUND" | "NOT_AVAILABLE" = "NOT_BOUND",
): TbcApprovalPresentationField<Value> {
  return Object.freeze({ status: "unknown", reason });
}

function freeze<Value>(value: Value): Value {
  const clone = JSON.parse(canonicalize(value)) as Value;
  const visit = (entry: unknown): void => {
    if (entry !== null && typeof entry === "object" && !Object.isFrozen(entry)) {
      for (const child of Object.values(entry as Readonly<Record<string, unknown>>)) visit(child);
      Object.freeze(entry);
    }
  };
  visit(clone);
  return clone;
}

function preparedMethod(method: string): boolean {
  return method.includes("Prepared");
}

function requestIntent(request: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  const intent = request.intent;
  return intent !== null && typeof intent === "object" && !Array.isArray(intent)
    ? intent as Readonly<Record<string, unknown>>
    : undefined;
}

function businessType(
  operationKind: string,
  request: Readonly<Record<string, unknown>>,
): TbcApprovalPresentationField<string> {
  if (operationKind === "transaction") {
    const type = requestIntent(request)?.type;
    return typeof type === "string" ? known(type, "bound-request") : unknown();
  }
  return known(operationKind, "bound-request");
}

function businessTerms(
  request: Readonly<Record<string, unknown>>,
  preview?: Readonly<Record<string, unknown>>,
): TbcApprovalPresentationField<Readonly<Record<string, unknown>>> {
  const intent = requestIntent(request);
  if (intent === undefined && preview?.lopOrders !== undefined) {
    return known(freeze({ type: "tbc-lop", orders: preview.lopOrders,
      ...(preview.timeLocks === undefined ? {} : { timeLocks: preview.timeLocks }),
      ...(preview.htlcLocks === undefined ? {} : { htlcLocks: preview.htlcLocks }),
      ...(preview.coinLocks === undefined ? {} : { coinLocks: preview.coinLocks }) }), "engine-preview");
  }
  if (intent === undefined && preview?.htlcLocks !== undefined) {
    return known(freeze({ type: "tbc-htlc", htlcLocks: preview.htlcLocks,
      ...(preview.timeLocks === undefined ? {} : { timeLocks: preview.timeLocks }),
      ...(preview.coinLocks === undefined ? {} : { coinLocks: preview.coinLocks }) }), "engine-preview");
  }
  if (intent === undefined && preview?.coinLocks !== undefined) {
    return known(freeze({ type: "tbc20-stablecoin", coinLocks: preview.coinLocks,
      ...(preview.timeLocks === undefined ? {} : { timeLocks: preview.timeLocks }) }), "engine-preview");
  }
  if (intent === undefined && preview?.timeLocks !== undefined) {
    return known(freeze({ type: "tbc-timelock", timeLocks: preview.timeLocks }), "engine-preview");
  }
  return intent === undefined
    ? unknown<Readonly<Record<string, unknown>>>()
    : known(displayIntent(intent), "bound-request");
}

function displayIntent(intent: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (intent.type === "tbc-amm-create") return freeze({ ...intent, feeSummary: describeAmmFeePolicy(intent.feePolicy) });
  if (intent.type !== "tbc-htlc-claim") return freeze(intent);
  // Display-only omission. Binding and Engine verification always retain the
  // exact original request including the preimage; no replacement is signed.
  const { preimage: _preimage, ...terms } = intent;
  return freeze(terms);
}

function metadataForIntent(intent: Readonly<Record<string, unknown>> | undefined): Readonly<{
  precision?: number;
  symbol?: string;
}> {
  if (intent?.type !== "tbc.ft.create" && intent?.type !== "tbc20-standard-create" && intent?.type !== "tbc20-stablecoin-create") return Object.freeze({});
  const precision = intent.decimals;
  const symbol = intent.symbol;
  return Object.freeze({
    ...(typeof precision === "number" && Number.isSafeInteger(precision) && precision >= 0
      ? { precision }
      : {}),
    ...(typeof symbol === "string" && symbol.length > 0 ? { symbol } : {}),
  });
}

function displayAmount(atomic: string, precision: number): string {
  if (precision === 0) return atomic;
  const padded = atomic.padStart(precision + 1, "0");
  const whole = padded.slice(0, -precision);
  const fraction = padded.slice(-precision).replace(/0+$/u, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function assetsFromFlows(
  value: unknown,
  intent?: Readonly<Record<string, unknown>>,
): readonly TbcApprovalPresentationAsset[] {
  const metadata = metadataForIntent(intent);
  return Object.freeze(records(value).map((flow) => {
    const atomic = decimal(flow.amount);
    // FT-create metadata describes the created FT only. A single Engine
    // preview can also contain native fee/change flows, which must never
    // inherit the token's symbol or decimal precision.
    const flowMetadata: Readonly<{ precision?: number; symbol?: string }> =
      flow.kind === "ft" || (flow.kind === "stablecoin" && intent?.type === "tbc20-stablecoin-create") ? metadata : Object.freeze({});
    const precision = flowMetadata.precision === undefined
      ? unknown<number>()
      : known(flowMetadata.precision, "bound-request");
    return Object.freeze({
      kind: text(flow.kind),
      direction: text(flow.direction),
      contractId: typeof flow.contractId === "string"
        ? known(flow.contractId, "engine-preview")
        : unknown<string>("NOT_AVAILABLE"),
      symbol: flowMetadata.symbol === undefined
        ? unknown<string>()
        : known(flowMetadata.symbol, "bound-request"),
      amount: Object.freeze({
        atomic,
        precision,
        display: flowMetadata.precision === undefined
          ? unknown<string>()
          : known(displayAmount(atomic, flowMetadata.precision), "bound-request"),
      }),
      from: typeof flow.from === "string"
        ? known(flow.from, "engine-preview")
        : unknown<string>("NOT_AVAILABLE"),
      to: typeof flow.to === "string"
        ? known(flow.to, "engine-preview")
        : poolDestination(flow, intent),
      source: "engine-preview" as const,
    });
  }));
}

const POOL_DESTINATION_TYPES = new Set([
  "tbc-amm-add-liquidity", "amm.addLiquidity", "tbc-amm-remove-liquidity", "amm.removeLiquidity",
  "tbc-amm-swap", "amm.swap", "tbc.pool.swap.exactTbcForToken", "tbc.pool.swap.exactTokenForTbc",
  "tbc.pool.liquidity.add", "tbc.pool.liquidity.remove", "tbc.pool.ft.merge", "amm.mergeToken",
]);

function poolDestination(flow: Readonly<Record<string, unknown>>, intent?: Readonly<Record<string, unknown>>): TbcApprovalPresentationField<string> {
  const pool = intent?.poolContractId;
  return flow.direction === "send" && POOL_DESTINATION_TYPES.has(String(intent?.type)) &&
      typeof pool === "string" && HASH32.test(pool)
    ? known(`pool:${pool}`, "bound-request") : unknown("NOT_AVAILABLE");
}

function chainTransactions(payload: Readonly<Record<string, unknown>> | undefined,
  assets: readonly TbcApprovalPresentationAsset[], warnings: readonly string[],
): readonly TbcApprovalPresentationTransaction[] {
  if (!Array.isArray(payload?.transactions)) return Object.freeze([]);
  const rows = records(payload.transactions);
  return Object.freeze(rows.map(tx => {
    const seen = new Set<number>();
    const outputs = Object.freeze(tx.outputReview === undefined ? [] : records(tx.outputReview).map(o => {
      if (!Array.isArray(o.outputIndices) || o.outputIndices.length === 0) return conflict();
      const indices = o.outputIndices.map(v => { const n = integer(v);
        if (seen.has(n) || n !== seen.size) return conflict(); seen.add(n); return n; });
      return Object.freeze({
        outputIndices: Object.freeze(indices), kind: text(o.kind),
        assetIdentity: o.assetIdentity === undefined ? unknown<string>("NOT_AVAILABLE") : known(text(o.assetIdentity), "engine-plan"),
        amountAtomic: o.amountAtomic === undefined ? unknown<string>("NOT_AVAILABLE") : known(decimal(o.amountAtomic), "engine-plan"),
        recipient: o.recipient === undefined ? unknown<string>("NOT_AVAILABLE") : known(text(o.recipient), "engine-plan"),
        nativeValueAtomic: decimal(o.nativeValueAtomic),
        lockTime: o.lockTime === undefined ? unknown<number>("NOT_AVAILABLE") : known(integer(o.lockTime), "engine-plan"),
        warnings: Object.freeze(strings(o.warnings)),
      });
    }));
    return Object.freeze({
    id: text(tx.id), role: typeof tx.role === "string" ? known(tx.role, "engine-plan") : unknown<string>("NOT_AVAILABLE"),
    dependsOn: Object.freeze(tx.dependsOn === undefined ? [] : strings(tx.dependsOn)),
    templateHash: typeof tx.templateHash === "string" && HASH32.test(tx.templateHash)
      ? known(tx.templateHash, "engine-plan") : unknown<string>("NOT_AVAILABLE"),
    feeAtomic: tx.fee === undefined ? unknown<string>("NOT_AVAILABLE") : known(decimal(tx.fee), "engine-plan"),
    // The current Engine exposes step-level assetFlows. Attribution is exact
    // only for a single transaction; never label all flows as every child.
    assets: rows.length === 1 ? assets : Object.freeze([]),
    assetsStatus: rows.length === 1 ? "available" as const : "step-summary-only" as const,
    warnings: Object.freeze(rows.length === 1 ? [...warnings] : outputs.length ? [] : ["PER_TRANSACTION_ASSET_DETAILS_UNAVAILABLE"]),
    outputs,
    outputsStatus: tx.outputReview === undefined ? "not-available" as const
      : outputs.some(o => o.kind === "unrecognized") ? "partial" as const : "available" as const,
  });}));
}

function transactionDetailsStatus(kind: string, payload: Readonly<Record<string, unknown>> | undefined,
  phase: "preparation" | "formal",
): TbcApprovalPresentationStep["transactionsStatus"] {
  if (!["transaction", "preparedTransaction", "reviewedTransaction"].includes(kind)) return "not-applicable";
  if (phase === "preparation") return "not-bound";
  return Array.isArray(payload?.transactions) ? "available" : "not-available";
}

function maximumFee(
  operationKind: string,
  request: Readonly<Record<string, unknown>>,
): TbcApprovalPresentationField<string> {
  const candidate = operationKind === "workflow"
    ? request.maxTotalFee
    : request.maxFee !== undefined ? request.maxFee
    : request.constraints !== null && typeof request.constraints === "object"
      ? Reflect.get(request.constraints, "maxFee")
      : undefined;
  return typeof candidate === "string" && DECIMAL.test(candidate)
    ? known(candidate, "bound-request")
    : unknown();
}

function transactionSigningCount(planPayload: Readonly<Record<string, unknown>>): TbcApprovalPresentationField<number> {
  const direct = Array.isArray(planPayload.signingTasks) ? planPayload.signingTasks.length : 0;
  const preview = record(planPayload.preview);
  if (preview.signingTaskCount !== undefined) {
    const total = integer(preview.signingTaskCount);
    if (total < direct || total > 4096) return conflict();
    return known(total, "engine-plan");
  }
  // A reviewed wallet action owns one execution task, not an Engine transaction
  // list. That task may produce many signatures; don't invent a count or throw
  // because the unrelated Engine `transactions` collection is absent.
  if (planPayload.task !== undefined && record(planPayload.task).purpose === "reviewedTransaction") {
    return unknown("NOT_AVAILABLE");
  }
  // Without a bound total, a multi-transaction plan may expose only its first
  // stage. Never present that partial collection as a completed total.
  if (records(planPayload.transactions).length > 1) return unknown("NOT_AVAILABLE");
  return known(direct, "engine-plan");
}

function signingCount(planPayload: Readonly<Record<string, unknown>>): TbcApprovalPresentationField<number> {
  if (!Array.isArray(planPayload.transactionPlans)) return transactionSigningCount(planPayload);
  // A real Core WorkflowPlan copies every transaction-plan signing task into
  // immediateSigningTasks. Adding both collections double-counts them.
  const immediate = Array.isArray(planPayload.immediateSigningTasks)
    ? planPayload.immediateSigningTasks.length
    : 0;
  const deferred = Array.isArray(planPayload.deferredSigningTasks)
    ? planPayload.deferredSigningTasks.length
    : 0;
  const reviewed = Array.isArray(planPayload.reviewedTransactionTasks)
    ? planPayload.reviewedTransactionTasks.length
    : 0;
  let total = immediate + deferred + reviewed;
  for (const entry of records(planPayload.transactionPlans)) {
    const payload = record(record(entry.plan).payload);
    const count = transactionSigningCount(payload);
    if (count.status === "unknown") return count;
    // Initial tasks already occur in immediateSigningTasks; add only the later stages.
    total += count.value - (Array.isArray(payload.signingTasks) ? payload.signingTasks.length : 0);
  }
  return known(total, "engine-plan");
}

function transactionCount(planPayload: Readonly<Record<string, unknown>>, preview: Readonly<Record<string, unknown>>): number {
  if (typeof preview.transactionCount === "number") return integer(preview.transactionCount);
  if (Array.isArray(planPayload.transactionPlans)) {
    const planned = records(planPayload.transactionPlans).reduce((total, entry) => {
      const payload = record(record(entry.plan).payload);
      return total + records(payload.transactions).length;
    }, 0);
    const reviewed = Array.isArray(preview.steps)
      ? records(preview.steps).reduce((total, step) => {
          if (step.kind !== "reviewedTransaction") return total;
          const reviewedPreview = record(step.reviewedTransactionPreview);
          return total + integer(reviewedPreview.transactionCount);
        }, 0)
      : 0;
    return planned + reviewed;
  }
  return conflict();
}

function workflowStepSigningCount(
  id: string,
  requestStep: Readonly<Record<string, unknown>> | undefined,
  stepPlanPayload: Readonly<Record<string, unknown>> | undefined,
  planPayload: Readonly<Record<string, unknown>>,
): TbcApprovalPresentationField<number> {
  if (stepPlanPayload !== undefined) {
    return transactionSigningCount(stepPlanPayload);
  }
  const immediate = Array.isArray(planPayload.immediateSigningTasks)
    ? records(planPayload.immediateSigningTasks).filter((task) => task.stepId === id).length
    : 0;
  const deferred = Array.isArray(planPayload.deferredSigningTasks)
    ? records(planPayload.deferredSigningTasks).filter((task) => task.targetStepId === id).length
    : 0;
  const reviewedRequestHash = requestStep?.kind === "reviewedTransaction" && requestStep.request !== undefined
    ? hashCanonical(requestStep.request)
    : undefined;
  const reviewed = reviewedRequestHash !== undefined && Array.isArray(planPayload.reviewedTransactionTasks)
    ? records(planPayload.reviewedTransactionTasks).filter((task) => task.requestHash === reviewedRequestHash).length
    : 0;
  return known(immediate + deferred + reviewed, "engine-plan");
}

function contractExecution(preview: Readonly<Record<string, unknown>> | undefined,
  request: Readonly<Record<string, unknown>> | undefined,
): TbcApprovalPresentationField<TbcApprovalContractExecution> {
  if (preview?.contractExecution === undefined) return unknown("NOT_AVAILABLE");
  const value = record(preview.contractExecution);
  if (Object.keys(value).length !== 3 || value.businessType !== (request === undefined ? undefined : requestIntent(request)?.type) ||
      (value.generation !== "current" && value.generation !== "historical")) return conflict("Approval contract execution differs from bound request");
  return known(Object.freeze({businessType:text(value.businessType), implementation:text(value.implementation), generation:value.generation}), "engine-preview");
}

function workflowSteps(
  preview: Readonly<Record<string, unknown>>,
  request: Readonly<Record<string, unknown>>,
  planPayload: Readonly<Record<string, unknown>>,
): readonly TbcApprovalPresentationStep[] {
  if (!Array.isArray(preview.steps)) return Object.freeze([]);
  const requestSteps = Array.isArray(request.steps) ? records(request.steps) : [];
  const transactionPlans = Array.isArray(planPayload.transactionPlans)
    ? records(planPayload.transactionPlans)
    : [];
  return Object.freeze(records(preview.steps).map((step) => {
    const id = text(step.id);
    const requestStep = requestSteps.find((candidate) => candidate.id === id);
    const planEntry = transactionPlans.find((candidate) => candidate.stepId === id);
    const stepPlanPayload = planEntry === undefined
      ? undefined
      : record(record(planEntry.plan).payload);
    const stepPreview = step.kind === "reviewedTransaction" && step.reviewedTransactionPreview !== undefined
      ? record(step.reviewedTransactionPreview)
      : stepPlanPayload?.preview === undefined ? step : record(stepPlanPayload.preview);
    const stepFee = stepPreview.totalFee === undefined
      ? unknown<string>("NOT_AVAILABLE")
      : known(decimal(stepPreview.totalFee), "engine-preview");
    const stepSigning = workflowStepSigningCount(id, requestStep, stepPlanPayload, planPayload);
    const assets = Array.isArray(stepPreview.assetFlows)
      ? assetsFromFlows(stepPreview.assetFlows, requestStep === undefined ? undefined : requestIntent(requestStep))
      : Array.isArray(step.assetFlows) ? assetsFromFlows(step.assetFlows, requestStep === undefined ? undefined : requestIntent(requestStep)) : Object.freeze([]);
    const warnings = approvalWarnings(requestStep ?? {}, stepPreview.warnings);
    return Object.freeze({
      id,
      kind: text(step.kind),
      dependsOn: Array.isArray(step.dependsOn) ? Object.freeze(step.dependsOn.map(text)) : conflict(),
      businessType: requestStep === undefined
        ? unknown<string>("NOT_AVAILABLE")
        : businessType("transaction", requestStep),
      contractExecution: contractExecution(stepPlanPayload?.preview === undefined ? undefined : record(stepPlanPayload.preview), requestStep),
      businessTerms: requestStep === undefined
        ? unknown<Readonly<Record<string, unknown>>>("NOT_AVAILABLE")
        : businessTerms(requestStep, step.kind === "reviewedTransaction" && step.reviewedTransactionPreview !== undefined
          ? record(step.reviewedTransactionPreview) : undefined),
      assets,
      actualFeeAtomic: stepFee,
      signingTaskCount: stepSigning,
      warnings,
      transactions: chainTransactions(stepPlanPayload, assets, warnings),
      transactionsStatus: transactionDetailsStatus(text(step.kind), stepPlanPayload, "formal"),
    });
  }));
}

// Display-only risk classification; not an authorization policy. These labels
// never replace Engine warnings, change bindings or require another data read.
function approvalWarnings(request: Readonly<Record<string, unknown>>, warnings?: unknown, operationKind?: string): readonly string[] {
  const type = String(requestIntent(request)?.type ?? "");
  const kind = request.kind ?? operationKind;
  return Object.freeze([...new Set([
    ...(Array.isArray(warnings) ? warnings.map(text) : []),
    ...htlcClaimDisclosureWarnings(request),
    ...(/(?:[.-]burn)$/.test(type) ? ["ASSET_DESTRUCTION_NO_WITHDRAWAL"] : []),
    ...(/(?:[.-]lock)$/.test(type) ? ["ASSET_LOCKED_UNTIL_CONDITIONS_MET"] : []),
    ...(kind === "message" || kind === "typedData" ? ["SIGNATURE_MAY_AUTHORIZE_ACTIONS"] : []),
    ...(kind === "reviewedTransaction" ? ["REVIEW_ALL_TRANSACTION_OUTPUTS"] : []),
    ...(operationKind === "workflow" ? ["BATCH_NOT_ATOMIC"] : []),
  ])]);
}

/**
 * Purely projects one already validated Host approval checkpoint into a UI
 * model. It performs no I/O, metadata lookup, planning, signing or persistence.
 */
export function projectTbcApprovalPresentation(
  evidence: ApprovalHostEvidenceEnvelope<ApprovalHostRequestShape>,
): TbcApprovalPresentation {
  const request = record(evidence.params);
  try {
    assertValidTws("approvalRequestParams", request);
  } catch {
    return conflict();
  }
  const binding = record(request.binding);
  const bindingPayload = record(binding.payload);
  const bindingHash = text(binding.bindingHash);
  if (!HASH32.test(bindingHash) || hashCanonical(bindingPayload) !== bindingHash) return conflict();
  const preview = record(request.preview);
  const memory = record(evidence.memory);
  // evidence.operation is the Host store row. The business request is bound
  // inside the authoritative checkpoint payload returned by the reader.
  const operation = record(evidence.payload.operation);
  if (
    evidence.callId !== evidence.call.callId ||
    evidence.operationId !== evidence.payload.operationId ||
    evidence.call.operation !== "approval.request" ||
    canonicalize(evidence.call.params) !== canonicalize(request) ||
    canonicalize(memory.approvalBinding) !== canonicalize(binding) ||
    canonicalize(memory.approvalPreview) !== canonicalize(preview) ||
    operation.method !== bindingPayload.method ||
    preview.operationKind !== bindingPayload.operationKind
  ) return conflict();
  const operationKind = text(bindingPayload.operationKind);
  const plan = operationKind === "workflow"
    ? record(memory.workflowPlan)
    : operationKind === "transaction"
      ? record(memory.executionPlan ?? memory.walletActionPlan)
      : undefined;
  const planPayload: Readonly<Record<string, unknown>> = plan === undefined
    ? Object.freeze({})
    : record(plan.payload);
  const operationHash = plan === undefined
    ? text(bindingPayload.operationHash)
    : text(plan.workflowPlanHash ?? plan.planHash);
  if (
    operationHash !== bindingPayload.operationHash ||
    (plan !== undefined && hashCanonical(planPayload) !== operationHash)
  ) return conflict();
  // Match Core's permission normalization: requestAccounts has no wire params
  // and requests one account on the checkpoint's active chain. Other permission
  // requests retain the complete positional array. Never derive authority from
  // display data or an unverified proposal alone.
  const permissionRequest = operationKind === "permission" && operation.method === "tbc_requestAccounts"
    ? [{ tbc_accounts: { chains: [text(record(record(evidence.payload.session).state).activeChainId)], maxAccounts: 1 } }]
    : operation.params;
  if (operationKind === "permission") {
    const proposal = record(memory.permissionProposal);
    const proposalPayload = record(proposal.payload);
    if (proposal.permissionProposalHash !== operationHash ||
        hashCanonical(proposalPayload) !== operationHash ||
        proposalPayload.origin !== bindingPayload.origin ||
        canonicalize(proposalPayload.requested) !== canonicalize(permissionRequest)) return conflict();
  }
  const boundRequest: Readonly<Record<string, unknown>> = operationKind === "transaction" && memory.normalizedTransaction !== undefined
    ? record(record(memory.normalizedTransaction).request)
    : operationKind === "workflow"
      ? record(operation.params)
      : operationKind === "permission" ? Object.freeze({}) : record(operation.params ?? {});
  const expectedRequestHash = hashCanonical(operationKind === "permission" ? permissionRequest : boundRequest);
  if (expectedRequestHash !== bindingPayload.requestHash || memory.requestHash !== expectedRequestHash ||
      (operationKind === "transaction" && memory.normalizedTransaction !== undefined &&
        record(memory.normalizedTransaction).requestHash !== expectedRequestHash)) {
    return conflict();
  }
  if (
    plan !== undefined &&
    (planPayload.requestHash !== expectedRequestHash ||
      canonicalize(planPayload.preview) !== canonicalize(preview))
  ) return conflict();
  const warnings = Array.isArray(preview.warnings)
    ? Object.freeze(preview.warnings.map(text))
    : Object.freeze([]);
  let signingRoles: TbcApprovalPresentation["signingRoles"];
  if (boundRequest.signingRoles !== undefined) {
    if (operationKind !== "transaction") return conflict();
    const resolutions = records(memory.accountResolutions);
    const trusted = records(record(resolutions.at(-1)?.result).accounts) as unknown as readonly TransactionRoleAccount[];
    const resolved = resolveTransactionSigningAccounts(boundRequest as unknown as TransactionRoleRequest, trusted);
    if (canonicalize(preview.signingRoles) !== canonicalize(resolved.roles)) return conflict("Approval signing roles differ from trusted accounts");
    signingRoles = known(Object.freeze(resolved.roles.map(({ role, account }) => Object.freeze({ role, accountId: account.accountId }))), "engine-preview");
  } else if (operationKind === "workflow" && Array.isArray(boundRequest.steps) &&
      boundRequest.steps.some(step => record(step).signingRoles !== undefined)) {
    const resolutions = records(memory.accountResolutions);
    const trusted = records(record(resolutions.at(-1)?.result).accounts) as unknown as readonly TransactionRoleAccount[];
    const resolved = resolveWorkflowSigningAccounts(boundRequest as unknown as WorkflowRoleRequest, trusted);
    const roles = resolved.steps.flatMap(step => step.roles.map(role => ({ stepId: step.stepId, ...role })));
    if (canonicalize(preview.signingRoles) !== canonicalize(roles)) return conflict("Workflow approval signing roles differ from trusted steps");
    signingRoles = known(Object.freeze(roles.map(({ stepId, role, account }) => Object.freeze({ stepId, role, accountId: account.accountId }))), "engine-preview");
  } else if (preview.signingRoles !== undefined) return conflict("Approval added an unrequested signing role");
  const transactionAssets = operationKind === "transaction" && Array.isArray(preview.assetFlows)
    ? assetsFromFlows(preview.assetFlows, requestIntent(boundRequest))
    : Object.freeze([]);
  const steps = operationKind === "workflow"
    ? workflowSteps(preview, boundRequest, planPayload)
    : Object.freeze([]);
  const assets = operationKind === "workflow"
    ? Object.freeze(steps.flatMap((step) => step.assets))
    : transactionAssets;
  const actualFee = typeof preview.totalFee === "string" && DECIMAL.test(preview.totalFee)
    ? known(preview.totalFee, "engine-preview")
    : unknown<string>("NOT_AVAILABLE");
  const requester = record(request.requester);
  const signingTasks = plan === undefined ? unknown<number>("NOT_AVAILABLE") : signingCount(planPayload);
  const result: TbcApprovalPresentation = {
    version: "1.0",
    phase: "formal",
    trust: "binding-verified",
    method: text(bindingPayload.method),
    operationKind,
    prepared: preparedMethod(text(bindingPayload.method)),
    businessType: businessType(operationKind, boundRequest),
    contractExecution: operationKind === "transaction" ? contractExecution(preview, boundRequest) : unknown("NOT_AVAILABLE"),
    businessTerms: businessTerms(boundRequest, preview),
    ...(signingRoles === undefined ? {} : { signingRoles }),
    requester: known(Object.freeze({
      transport: text(requester.transport),
      origin: text(requester.origin),
      topOrigin: text(requester.topOrigin),
      frame: text(requester.frame),
    }), "core-binding"),
    chainId: typeof bindingPayload.chainId === "string"
      ? known(bindingPayload.chainId, "core-binding")
      : unknown("NOT_AVAILABLE"),
    accountId: typeof bindingPayload.accountId === "string"
      ? known(bindingPayload.accountId, "core-binding")
      : unknown("NOT_AVAILABLE"),
    expiresAt: known(text(bindingPayload.expiresAt), "core-binding"),
    fees: Object.freeze({
      maximumAtomic: maximumFee(operationKind, boundRequest),
      actualAtomic: actualFee,
    }),
    counts: Object.freeze({
      steps: operationKind === "workflow"
        ? known<number>(steps.length, "engine-preview")
        : known<number>(1, "engine-preview"),
      transactions: operationKind === "transaction" || operationKind === "workflow"
        ? known<number>(transactionCount(planPayload, preview), "engine-plan")
        : unknown<number>("NOT_AVAILABLE"),
      signingTasks,
    }),
    assets,
    steps,
    transactions: operationKind === "transaction" ? chainTransactions(planPayload, transactionAssets, approvalWarnings(boundRequest, warnings, operationKind)) : Object.freeze([]),
    transactionsStatus: operationKind === "workflow" ? "not-applicable" : transactionDetailsStatus(operationKind, planPayload, "formal"),
    warnings: approvalWarnings(boundRequest, warnings, operationKind),
    binding: Object.freeze({
      status: "verified",
      requestHash: expectedRequestHash,
      operationHash,
      bindingHash,
    }),
    evidence: Object.freeze({
      sources: Object.freeze(["core-binding", "bound-request", "engine-plan", "engine-preview"] as const),
      previewHash: hashCanonical(preview),
      callId: evidence.callId,
      operationId: evidence.operationId,
      releaseFingerprint: evidence.releaseFingerprint,
    }),
    unknown: Object.freeze([
      ...(signingTasks.status === "unknown" ? ["counts.signingTasks"] : []),
      ...(maximumFee(operationKind, boundRequest).status === "unknown" ? ["fees.maximumAtomic"] : []),
      ...(businessTerms(boundRequest, preview).status === "unknown" ? ["businessTerms"] : []),
      ...steps.flatMap((step, index) => [
        ...(step.businessTerms.status === "unknown" ? [`steps.${index}.businessTerms`] : []),
        ...(step.signingTaskCount.status === "unknown" ? [`steps.${index}.signingTaskCount`] : []),
      ]),
      ...assets.flatMap((asset, index) => [
        ...(asset.amount.precision.status === "unknown" ? [`assets.${index}.amount.precision`] : []),
        ...(asset.amount.display.status === "unknown" ? [`assets.${index}.amount.display`] : []),
        ...(asset.symbol.status === "unknown" ? [`assets.${index}.symbol`] : []),
      ]),
    ]),
  };
  return freeze(result);
}

/**
 * Projects the early bounded-intent phase without waiting for Chain Data or an
 * Engine plan. It is deliberately not formal approval and does not infer asset
 * flows, actual fees or signing counts from business intent.
 */
export function projectTbcApprovalPreparation(
  input: TbcApprovalPreparationPresentationInput,
): TbcApprovalPresentation {
  if (
    typeof input.method !== "string" || input.method.length === 0 ||
    typeof input.operationKind !== "string" || input.operationKind.length === 0 ||
    !HASH32.test(input.requestHash) ||
    !Array.isArray(input.warningScope) ||
    !Number.isFinite(input.expiresAt)
  ) return conflict("Approval preparation presentation input is invalid");
  const request = record(input.request);
  if (hashCanonical(request) !== input.requestHash) {
    return conflict("Approval preparation request hash mismatch");
  }
  const type = requestIntent(request)?.type;
  const earlySteps: readonly TbcApprovalPresentationStep[] = input.operationKind === "workflow"
    ? records(request.steps).map(step => Object.freeze({
      id: text(step.id), kind: text(step.kind),
      dependsOn: Object.freeze(strings(step.dependsOn)),
      businessType: businessType("transaction", step),
      contractExecution: unknown<TbcApprovalContractExecution>(),
      businessTerms: requestIntent(step) === undefined
        ? unknown<Readonly<Record<string, unknown>>>()
        : known(displayIntent(requestIntent(step)!), "preparation-scope"),
      // Intent amounts/limits are in businessTerms, not invented Engine flows.
      assets: Object.freeze([]), actualFeeAtomic: unknown<string>(),
      signingTaskCount: unknown<number>(), warnings: approvalWarnings(step),
      transactions: Object.freeze([]), transactionsStatus: transactionDetailsStatus(text(step.kind), undefined, "preparation"),
    })) : Object.freeze([]);
  let signingRoles: TbcApprovalPresentation["signingRoles"];
  if (request.signingRoles !== undefined) {
    assertValidTws(preparedMethod(input.method) ? "preparedTransactionRequest" : "transactionRequest", request);
    signingRoles = known(freeze((request as unknown as TransactionRoleRequest).signingRoles!), "preparation-scope");
  } else if (input.operationKind === "workflow" && Array.isArray(request.steps) &&
      request.steps.some(step => record(step).signingRoles !== undefined)) {
    assertValidTws(preparedMethod(input.method) ? "preparedWorkflowRequest" : "workflowRequest", request);
    const selected = (request.steps as readonly (TransactionRoleRequest & { id: string })[])
      .flatMap(step => (step.signingRoles ?? []).map(role => Object.freeze({ ...role, stepId: step.id })));
    signingRoles = known(Object.freeze(selected), "preparation-scope");
  }
  const result: TbcApprovalPresentation = {
    version: "1.0",
    phase: "preparation",
    trust: "intent-bounded",
    ...(signingRoles === undefined ? {} : { signingRoles }),
    method: input.method,
    operationKind: input.operationKind,
    prepared: preparedMethod(input.method),
    businessType: typeof type === "string"
      ? known(type, "preparation-scope")
      : known(input.operationKind, "preparation-scope"),
    contractExecution: unknown(),
    businessTerms: requestIntent(request) === undefined
      ? unknown<Readonly<Record<string, unknown>>>()
      : known(displayIntent(requestIntent(request)!), "preparation-scope"),
    requester: unknown(),
    chainId: input.chainId === undefined ? unknown() : known(input.chainId, "preparation-scope"),
    accountId: input.accountId === undefined ? unknown() : known(input.accountId, "preparation-scope"),
    expiresAt: known(new Date(input.expiresAt).toISOString(), "preparation-scope"),
    fees: Object.freeze({
      maximumAtomic: input.suggestedFeeCapAtomic === undefined
        ? unknown<string>()
        : known<string>(decimal(input.suggestedFeeCapAtomic), "preparation-scope"),
      actualAtomic: unknown<string>(),
    }),
    counts: Object.freeze({
      steps: input.operationKind === "workflow" ? known(earlySteps.length, "preparation-scope") : known(1, "preparation-scope"),
      transactions: unknown<number>(),
      signingTasks: unknown<number>(),
    }),
    assets: Object.freeze([]),
    steps: earlySteps,
    transactions: Object.freeze([]), transactionsStatus: transactionDetailsStatus(input.operationKind, undefined, "preparation"),
    warnings: approvalWarnings(request, input.warningScope, input.operationKind),
    binding: Object.freeze({ status: "not-created", requestHash: input.requestHash }),
    evidence: Object.freeze({ sources: Object.freeze(["preparation-scope"] as const) }),
    unknown: Object.freeze([
      "requester",
      "contractExecution",
      "fees.actualAtomic",
      "counts.transactions",
      "counts.signingTasks",
      "assets",
      ...earlySteps.flatMap((step, index) => [
        `steps.${index}.assets`, `steps.${index}.actualFeeAtomic`, `steps.${index}.signingTaskCount`,
        ...(step.businessTerms.status === "unknown" ? [`steps.${index}.businessTerms`] : []),
      ]),
      ...(requestIntent(request) === undefined ? ["businessTerms"] : []),
      ...(input.suggestedFeeCapAtomic === undefined ? ["fees.maximumAtomic"] : []),
    ]),
  };
  return freeze(result);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return conflict();
  return value.map(text);
}
