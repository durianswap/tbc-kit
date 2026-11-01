import {
  assertApprovalBinding,
  createApprovalBinding,
  type ApprovalReceipt,
} from "../bindings.js";
import {
  cryptoTask, reviewedTransactionTask, reviewedSigningRoleContext, assertCryptoOutcome, assertReviewedOutcome,
  type AccountIdentity, type CryptoTask, type CryptoResult,
  type ReviewedTransactionTask, type ReviewedTransactionReview,
  type ReviewedTransactionResult, type SignedBundle,
} from "./private-action-kernel.js";
import { canonicalize } from "../canonical-json.js";
import type { OperationCheckpoint } from "../checkpoint.js";
import {
  invokeTransactionEngine,
  type LegacyBitcoinMessageDigest,
  type TransactionEngine,
} from "../engine.js";
import {
  base64Encode,
  bytesToHex,
  hexToBytes,
} from "../encoding.js";
import { TwsEngineError, TwsStateError } from "../errors.js";
import { hashCanonical } from "../hash.js";
import { resolveWorkflowSigningAccounts } from "../workflow-signing-roles.js";
import { resolveReviewedSigningRoles } from "../reviewed-signing-roles.js";
import { assertTransactionSigningSnapshot, assertTransactionRoleTasks, resolveTransactionSigningAccounts, type TransactionRoleRequest } from "../transaction-signing-roles.js";
import type { PortCall } from "../ports.js";
import {
  canonicalSigningEnvelope,
  signingEnvelopeDigest,
  signingPayload,
} from "../signing-artifacts.js";
import type { CoreTransition } from "../transitions.js";
import {
  completeTransition,
  continueTransition,
  waitingTransition,
} from "../transitions.js";
import { readApprovalDecision } from "./approval.js";
import { prepareApprovalWithMemory } from "./approval.js";
import {
  chainDataRequirement,
  workflowChainDataRequirement,
  type TransactionRequestLike,
} from "./chain-data-requirements.js";
import {
  assertRecoverableSignature,
  normalizeTypedDataTypes,
} from "./messages.js";
import { assertPreparedProposalForPlan, PreparedProposalTimeError } from "./planning.js";
import {
  advance,
  completeError,
  completeSuccess,
  earliestExpiry,
  makeCalls,
  nextRevision,
  operationOf,
} from "./shared.js";


interface WorkflowRequest {
  readonly version: "1.0";
  readonly chainId: string;
  readonly from: string;
  readonly expiresAt?: string;
  readonly maxTotalFee?: string;
  readonly failureMode?: "atomic" | "continue-independent";
  readonly steps: readonly WorkflowStep[];
}

function readTransactionVarInt(
  bytes: Uint8Array,
  offset: number,
): Readonly<{ value: number; offset: number }> {
  const prefix = bytes[offset];
  if (prefix === undefined) throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "workflow transaction is truncated");
  if (prefix < 0xfd) return { value: prefix, offset: offset + 1 };
  const length = prefix === 0xfd ? 2 : prefix === 0xfe ? 4 : 8;
  if (offset + 1 + length > bytes.length) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "workflow transaction varint is truncated");
  }
  let value = 0n;
  for (let index = 0; index < length; index += 1) {
    value |= BigInt(bytes[offset + 1 + index]!) << BigInt(index * 8);
  }
  if (value > 10_000n) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "workflow transaction input count is unbounded");
  }
  return { value: Number(value), offset: offset + 1 + length };
}

function transactionInputOutpoints(rawTransaction: string): readonly string[] {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(rawTransaction);
  } catch {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "workflow transaction bytes are invalid");
  }
  if (bytes.length < 10) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "workflow transaction bytes are truncated");
  }
  const count = readTransactionVarInt(bytes, 4);
  if (count.value < 1) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "workflow transaction has no inputs");
  }
  let offset = count.offset;
  const outpoints: string[] = [];
  for (let input = 0; input < count.value; input += 1) {
    if (offset + 36 > bytes.length) {
      throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "workflow transaction input is truncated");
    }
    const txid = bytesToHex(bytes.slice(offset, offset + 32).reverse());
    offset += 32;
    const vout = (bytes[offset]! | (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
    offset += 4;
    const scriptLength = readTransactionVarInt(bytes, offset);
    offset = scriptLength.offset + scriptLength.value;
    if (offset + 4 > bytes.length) {
      throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "workflow transaction input script is truncated");
    }
    offset += 4;
    if (txid !== "0".repeat(64)) outpoints.push(`${txid}:${String(vout)}`);
  }
  return Object.freeze(outpoints);
}

function reserveWorkflowPlanInputs(
  used: Set<string>,
  plan: ExecutionPlan,
): void {
  for (const transaction of plan.payload.transactions) {
    for (const outpoint of transactionInputOutpoints(transaction.unsignedTransaction)) {
      if (used.has(outpoint)) {
        throw new TwsEngineError(
          "ENGINE_INPUT_INVALID",
          "workflow transaction steps select the same input outpoint",
        );
      }
      used.add(outpoint);
    }
  }
}

type WorkflowStep =
  | TransactionStep
  | PreparedTransactionStep
  | ReviewedTransactionStep
  | MessageStep
  | CryptoStep
  | TypedDataStep;

interface TransactionStep {
  readonly id: string;
  readonly kind: "transaction";
  readonly dependsOn: readonly string[];
  readonly intent: Readonly<Record<string, unknown>>;
  readonly signingRoles?: TransactionRoleRequest["signingRoles"];
  readonly constraints?: Readonly<Record<string, unknown>>;
}

interface PreparedTransactionStep {
  readonly id: string;
  readonly kind: "preparedTransaction";
  readonly dependsOn: readonly string[];
  readonly intent: Readonly<Record<string, unknown>>;
  readonly signingRoles?: TransactionRoleRequest["signingRoles"];
  readonly proposal: Readonly<Record<string, unknown>>;
  readonly constraints?: Readonly<Record<string, unknown>>;
}

type TransactionLikeStep = TransactionStep | PreparedTransactionStep;

interface ReviewedTransactionStep {
  readonly signingRoles?: TransactionRoleRequest["signingRoles"];
  readonly id: string;
  readonly kind: "reviewedTransaction";
  readonly dependsOn: readonly string[];
  readonly request: Readonly<Record<string, unknown>>;
}

interface MessageStep {
  readonly id: string;
  readonly kind: "message";
  readonly dependsOn: readonly string[];
  readonly message: Readonly<{
    readonly encoding: "utf8" | "hex" | "base64";
    readonly data: string;
  }>;
  readonly bindings?: readonly {
    readonly target: string;
    readonly source: { readonly stepId: string; readonly output: string };
  }[];
}

type CryptoStep = EncryptStep | DecryptStep;

interface EncryptStep {
  readonly id: string;
  readonly kind: "encrypt";
  readonly dependsOn: readonly string[];
  readonly algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
  readonly message: MessageStep["message"];
}

interface DecryptStep {
  readonly id: string;
  readonly kind: "decrypt";
  readonly dependsOn: readonly string[];
  readonly algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
  readonly ciphertext: string;
}


interface TypedDataStep {
  readonly id: string;
  readonly kind: "typedData";
  readonly dependsOn: readonly string[];
  readonly data: {
    readonly domain: Readonly<Record<string, unknown>>;
    readonly types: Readonly<
      Record<string, readonly Readonly<Record<string, unknown>>[]>
    >;
    readonly primaryType: string;
    readonly message: Readonly<Record<string, unknown>>;
  };
  readonly bindings: readonly {
    readonly target: string;
    readonly source: { readonly stepId: string; readonly output: string };
  }[];
}

interface SigningTask {
  readonly taskId: string;
  readonly purpose: "transaction" | "message" | "typedData";
  readonly signatureEncoding: string;
  readonly digest: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly [key: string]: unknown;
}

interface ExecutionPlan {
  readonly payload: {
    readonly requestHash: string;
    readonly snapshotHash: string;
    readonly policyHash: string;
    readonly chainId: string;
    readonly accountId: string;
    readonly expiresAt: string;
    readonly transactions: readonly {
      readonly id: string;
      readonly role: string;
      readonly dependsOn: readonly string[];
      readonly unsignedTransaction: string;
      readonly fee: string;
      readonly [key: string]: unknown;
    }[];
    readonly signingTasks: readonly SigningTask[];
    readonly preview: {
      readonly assetFlows: readonly unknown[];
      readonly warnings: readonly string[];
      readonly [key: string]: unknown;
    };
  };
  readonly planHash: string;
}

interface WorkflowPlan {
  readonly payload: {
    readonly version: "1.0";
    readonly requestHash: string;
    readonly chainId: string;
    readonly accountId: string;
    readonly expiresAt: string;
    readonly failureMode: "atomic" | "continue-independent";
    readonly stepOrder: readonly string[];
    readonly transactionPlans: readonly {
      readonly stepId: string;
      readonly plan: ExecutionPlan;
    }[];
    readonly immediateSigningTasks: readonly {
      readonly stepId: string;
      readonly envelope?: Readonly<Record<string, unknown>>;
      readonly task: SigningTask;
    }[];
    readonly deferredSigningTasks: readonly DeferredSigningTask[];
    readonly legacyBitcoinMessageStepIds: readonly string[];
    readonly cryptoTasks: readonly CryptoTask[];
    readonly reviewedTransactionTasks: readonly ReviewedTransactionTask[];
    readonly maxTotalFee: string;
    readonly totalFee: string;
    readonly preview: Readonly<Record<string, unknown>>;
  };
  readonly workflowPlanHash: string;
}

interface DeferredSigningTask {
  readonly taskId: string;
  readonly source: { readonly stepId: string; readonly output: string };
  readonly targetStepId: string;
  readonly target: string;
  readonly targetType: "bytes32" | "bytes32[]" | "json-string-array";
  readonly purpose: "message" | "typedData";
  readonly publicKey: string;
  readonly envelopeTemplate: Readonly<Record<string, unknown>>;
}

interface ResolvedDeferredSigningTask {
  readonly planTaskId: string;
  readonly source: DeferredSigningTask["source"];
  readonly sourceValue: string | readonly string[];
  readonly targetStepId: string;
  readonly target: string;
  readonly targetType: DeferredSigningTask["targetType"];
  readonly purpose: DeferredSigningTask["purpose"];
  readonly resolvedEnvelope: Readonly<Record<string, unknown>>;
  readonly canonical: string;
  readonly digest: string;
  readonly concreteTask: SigningTask;
}

interface WorkflowStepProgress {
  readonly stepId: string;
  readonly status: "pending" | "signing" | "finalized" | "completed" | "failed" | "skipped";
  readonly signingTasks?: readonly (SigningTask | CryptoTask | ReviewedTransactionTask)[];
  readonly signatures?: readonly SignerResult[];
  readonly finalizationStages?: readonly Readonly<{
    readonly continuation: FinalizeContinuation;
    readonly signatureStart: number;
  }>[];
  readonly finalizedBundle?: SignedBundle;
  readonly resolvedDeferredSigningTasks?: readonly ResolvedDeferredSigningTask[];
  readonly cryptoResult?: CryptoResult;
  readonly reviewedTransactionResult?: ReviewedTransactionResult;
  readonly error?: Readonly<{ readonly code: string; readonly message: string }>;
}

interface WorkflowProgress {
  readonly steps: readonly WorkflowStepProgress[];
  readonly completedStepIds: readonly string[];
}

interface SignerResult {
  readonly taskId: string;
  readonly signatureEncoding: string;
  readonly signature: string;
}


interface FinalizeContinuation {
  readonly version: "1.0";
  readonly method: "finalize";
  readonly family: "ft" | "pool" | "stablecoin" | "collection" | "nft";
  readonly requestHash: string;
  readonly planHash: string;
  readonly bindingHash: string;
  readonly approvalId: string;
  readonly stage: number;
  readonly signingStage?: Readonly<{
    readonly signingRequests?: readonly Readonly<{
      readonly taskId?: string;
      readonly task_id?: string;
      readonly transactionId?: string;
      readonly transaction_id?: string;
      readonly inputIndex?: number;
      readonly input_index?: number;
    }>[];
  }>;
  readonly [key: string]: unknown;
}

interface PendingFinalizeResult {
  readonly status: "pending";
  readonly continuation: FinalizeContinuation;
  readonly signingRequests: readonly SigningTask[];
}

interface WorkflowPolicyEntry {
  readonly stepId: string;
  readonly policy: Readonly<{
    readonly payload: { readonly expiresAt: string };
    readonly policyHash: string;
  }>;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function requestOf(checkpoint: OperationCheckpoint): WorkflowRequest {
  const operation = operationOf(checkpoint);
  if (
    operation.method !== "tbc_signWorkflow" &&
    operation.method !== "tbc_signPreparedWorkflow" &&
    operation.method !== "tbc_sendWorkflow" &&
    operation.method !== "tbc_sendPreparedWorkflow"
  ) {
    throw new TwsEngineError(
      "ENGINE_INPUT_INVALID",
      "workflow reducer received a different Provider method",
    );
  }
  const request = operation.params as WorkflowRequest;
  const validKinds = operation.method === "tbc_signPreparedWorkflow" ||
    operation.method === "tbc_sendPreparedWorkflow"
    ? new Set(["preparedTransaction", "reviewedTransaction", "message", "encrypt", "decrypt", "typedData"])
    : new Set(["transaction", "reviewedTransaction", "message", "encrypt", "decrypt", "typedData"]);
  if (request.steps.some((step) => !validKinds.has(step.kind))) {
    throw new TwsEngineError("ENGINE_INPUT_INVALID", "workflow step kind does not match the Provider method");
  }
  return request;
}

function accountFromMemory(
  checkpoint: OperationCheckpoint,
  memory: Readonly<Record<string, unknown>> = checkpoint.payload.memory,
): AccountIdentity {
  const request = requestOf(checkpoint);
  const resolutions = memory.accountResolutions as readonly {
    readonly result: { readonly accounts: readonly AccountIdentity[] };
  }[];
  const account = resolutions
    .flatMap(({ result }) => result.accounts)
    .find(
      (candidate) =>
        candidate.chainId === request.chainId &&
        candidate.address === request.from &&
        candidate.accountId === `${request.chainId}:${request.from}`,
    );
  if (account === undefined) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow account resolution is missing",
    );
  }
  return account;
}

function transactionRequestFor(
  workflow: WorkflowRequest,
  step: TransactionLikeStep,
): Readonly<Record<string, unknown>> & TransactionRoleRequest {
  // Match Engine canonicalization at every workflow request/hash checkpoint,
  // not only initial planning. Other arrays retain their semantic order.
  const controllers = step.intent.controllers;
  const intent = step.intent.type === "tbc-amm-create" && Array.isArray(controllers)
    ? { ...step.intent, controllers: [...controllers].sort() }
    : step.intent;
  return Object.freeze({
    version: "1.0",
    chainId: workflow.chainId,
    from: workflow.from,
    intent,
    ...(step.signingRoles === undefined ? {} : { signingRoles: step.signingRoles }),
    ...(step.constraints === undefined ? {} : { constraints: step.constraints }),
  });
}

function transactionSteps(request: WorkflowRequest): readonly TransactionLikeStep[] {
  return request.steps.filter(
    (step): step is TransactionLikeStep =>
      step.kind === "transaction" || step.kind === "preparedTransaction",
  );
}

function usesStepMaterials(request: WorkflowRequest): boolean {
  const steps = transactionSteps(request);
  // Different businesses cannot share a union labelled with only the first
  // intent: that drops exact-input and family-specific material semantics.
  // Reuse the existing per-step path and its shared bounded read scope.
  return steps.some(step => step.signingRoles !== undefined) ||
    (steps.length > 1 && steps.some(step => String(step.intent.type).startsWith("tbc-lop-"))) ||
    new Set(steps.map(step => step.intent.type)).size > 1;
}

function workflowSnapshotForStep(request: WorkflowRequest, stepId: string, memory: Readonly<Record<string, unknown>>) {
  type Snapshot = { readonly payload: { readonly expiresAt: string }; readonly snapshotHash: string };
  if (!usesStepMaterials(request)) return memory.chainSnapshot as Snapshot | undefined;
  const material = memory.workflowSnapshots as { readonly steps: readonly { readonly stepId: string; readonly snapshot: Snapshot }[] } | undefined;
  const selected = material?.steps.filter(step => step.stepId === stepId);
  if (selected?.length !== 1) throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "Workflow step snapshot is missing or ambiguous");
  return selected[0]!.snapshot;
}

function workflowRolePreview(request: WorkflowRequest, memory: Readonly<Record<string, unknown>>) {
  if (!request.steps.some(step => ("signingRoles" in step && step.signingRoles !== undefined) || step.kind === "reviewedTransaction")) return undefined;
  const resolutions = memory.accountResolutions as readonly { result: { accounts: readonly AccountIdentity[] } }[];
  const accounts = resolutions.at(-1)!.result.accounts;
  const roles = resolveWorkflowSigningAccounts(request, accounts).steps
    .filter(step => !reviewedTransactionSteps(request).some(reviewed => reviewed.id === step.stepId))
    .flatMap(step => step.roles.map(role => ({ stepId: step.stepId, ...role })));
  for (const step of reviewedTransactionSteps(request)) {
    const selected = resolveReviewedSigningRoles({ chainId: request.chainId, from: request.from,
      request: step.request, signingRoles: step.signingRoles }, accounts);
    for (const role of selected ?? []) roles.push({ stepId: step.id, ...role });
  }
  return roles.length === 0 ? undefined : roles;
}

function assertWorkflowTransactionRoles(request: WorkflowRequest, step: TransactionLikeStep, plan: ExecutionPlan,
  memory: Readonly<Record<string, unknown>>): void {
  if (!transactionSteps(request).some(item => item.signingRoles !== undefined)) return;
  const resolutions = memory.accountResolutions as readonly { result: { accounts: readonly AccountIdentity[] } }[];
  const accounts = resolutions.at(-1)!.result.accounts;
  const selected = transactionRequestFor(request, step);
  const roles = resolveTransactionSigningAccounts(selected, accounts).roles;
  if (!sameJson(plan.payload.preview.signingRoles ?? [], roles)) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "Workflow transaction preview replaced its signing roles");
  }
  assertTransactionRoleTasks(selected, accounts, plan.payload.signingTasks);
}

function reviewedTransactionSteps(
  request: WorkflowRequest,
): readonly ReviewedTransactionStep[] {
  return request.steps.filter(
    (step): step is ReviewedTransactionStep => step.kind === "reviewedTransaction",
  );
}


function workflowPolicies(
  memory: Readonly<Record<string, unknown>>,
): readonly WorkflowPolicyEntry[] {
  return (memory.workflowPolicies ?? []) as readonly WorkflowPolicyEntry[];
}

function policyForStep(
  memory: Readonly<Record<string, unknown>>,
  stepId: string,
): WorkflowPolicyEntry["policy"] {
  const policy = workflowPolicies(memory).find((entry) => entry.stepId === stepId)?.policy;
  if (policy === undefined) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow transaction policy is missing",
    );
  }
  return policy;
}

function typedDataSteps(request: WorkflowRequest): readonly TypedDataStep[] {
  return request.steps.filter(
    (step): step is TypedDataStep => step.kind === "typedData",
  );
}

function messageSteps(request: WorkflowRequest): readonly MessageStep[] {
  return request.steps.filter(
    (step): step is MessageStep => step.kind === "message",
  );
}

function cryptoSteps(request: WorkflowRequest): readonly CryptoStep[] {
  return request.steps.filter(
    (step): step is CryptoStep => step.kind === "encrypt" || step.kind === "decrypt",
  );
}


function assertWorkflowTopology(request: WorkflowRequest): void {
  const positions = new Map<string, number>();
  request.steps.forEach((step, index) => {
    if (positions.has(step.id)) {
      throw new TwsEngineError(
        "ENGINE_INPUT_INVALID",
        "workflow step IDs must be unique",
      );
    }
    positions.set(step.id, index);
  });
  request.steps.forEach((step, index) => {
    if (
      step.dependsOn.some((dependency) => {
        const dependencyIndex = positions.get(dependency);
        return dependencyIndex === undefined || dependencyIndex >= index;
      })
    ) {
      throw new TwsEngineError(
        "ENGINE_INPUT_INVALID",
        "workflow steps must be in a valid topological order",
      );
    }
  });
}

function waitFor(
  checkpoint: OperationCheckpoint,
  operation: string,
  params: unknown,
  memory: Readonly<Record<string, unknown>>,
  expiresAt: string | undefined = checkpoint.payload.expiresAt,
): CoreTransition {
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [{ operation, params }]);
  const next = advance(checkpoint, {
    state: "resolving",
    expiresAt,
    pendingCalls: calls,
    memory,
    data: { resolvedInputs: { account: accountFromMemory(checkpoint, memory) } },
  });
  return waitingTransition(next);
}

export async function beginWorkflowResolution(
  checkpoint: OperationCheckpoint,
  account: AccountIdentity,
  memory: Readonly<Record<string, unknown>>,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<CoreTransition> {
  if (!sameJson(accountFromMemory(checkpoint, memory), account)) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow resolution account differs from the request",
    );
  }
  const request = requestOf(checkpoint);
  assertWorkflowTopology(request);
  const steps = transactionSteps(request);
  let roleAccounts: readonly AccountIdentity[] | undefined;
  if (steps.some(step => step.signingRoles !== undefined)) {
    const resolutions = memory.accountResolutions as readonly { result: { accounts: readonly AccountIdentity[] } }[];
    roleAccounts = resolutions.at(-1)!.result.accounts;
    resolveWorkflowSigningAccounts(request, roleAccounts);
  }
  const reviewed = reviewedTransactionSteps(request);
  if (steps.length === 0 && reviewed.length === 0) {
    return enterWorkflowApproval(
      checkpoint,
      await buildWorkflowPlan(
        checkpoint,
        undefined,
        memory,
        legacyBitcoinMessageDigest,
      ),
      memory,
    );
  }
  const context = checkpoint.payload.context as {
    readonly origin: string;
    readonly sessionId: string;
  };
  const effects = [
    ...(steps.length === 0 ? [] : [{
      operation: "chainData.resolve",
      params: {
        version: "1.0",
        chainId: account.chainId,
        accountId: account.accountId,
        requirement: usesStepMaterials(request) ? chainDataRequirement(steps[0]! as unknown as TransactionRequestLike) : workflowChainDataRequirement(
          steps.map((step) => ({ intent: step.intent, constraints: step.constraints })) as unknown as readonly TransactionRequestLike[],
        ),
        ...(usesStepMaterials(request) ? { workflowSteps: steps.map(step => {
          const stepRequest = transactionRequestFor(request, step);
          const selected = resolveTransactionSigningAccounts(stepRequest, roleAccounts ?? [account]);
          return { stepId: step.id, requirement: chainDataRequirement(stepRequest as unknown as TransactionRequestLike),
            ...(step.signingRoles === undefined ? {} : { signingRoles: step.signingRoles }),
            ...(selected.additional.length === 0 ? {} : { signingAccounts: selected.additional }),
          };
        }) } : {}),
      },
    }]),
    ...reviewed.map((step) => ({
      operation: "reviewedTransaction.review",
      params: {
        version: "1.0",
        taskId: `review-${step.id}`,
        ...(() => { const { roles } = reviewedSigningRoleContext(checkpoint, step, account, memory);
          return roles === undefined ? {} : { signingRoles: roles }; })(),
        contextHash: checkpoint.payload.contextHash,
        origin: context.origin,
        sessionId: context.sessionId,
        chainId: account.chainId,
        accountId: account.accountId,
        publicKey: account.publicKey,
        requestHash: hashCanonical(step.request),
        request: step.request,
      },
    })),
  ];
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, effects);
  const next = advance(checkpoint, {
    state: "resolving",
    pendingCalls: calls,
    memory: {
      ...memory,
      ...(reviewed.length === 0 ? {} : { reviewedTransactionReviews: Object.freeze([]) }),
    },
    data: { resolvedInputs: { account } },
  });
  return waitingTransition(next);
}

function typedEnvelope(
  checkpoint: OperationCheckpoint,
  step: TypedDataStep,
  account: AccountIdentity,
) {
  const context = checkpoint.payload.context as { readonly origin: string };
  if (
    step.data.domain.chainId !== account.chainId ||
    (step.data.domain.origin !== undefined && step.data.domain.origin !== context.origin)
  ) {
    throw new TwsEngineError(
      "ENGINE_INPUT_INVALID",
      "workflow typed-data domain differs from the trusted chain or origin",
    );
  }
  return Object.freeze({
    type: "tbc.typedData",
    version: "1.0",
    domain: Object.freeze({ ...step.data.domain }),
    types: normalizeTypedDataTypes(step.data.types),
    primaryType: step.data.primaryType,
    message: step.data.message,
  });
}

function messageEnvelope(step: MessageStep) {
  return Object.freeze({
    type: "tbc.message",
    version: "1.0",
    message: Object.freeze({ ...step.message }),
  });
}

function workflowFailureMode(
  request: WorkflowRequest,
): "atomic" | "continue-independent" {
  return request.failureMode ?? "atomic";
}

function messageBindings(step: MessageStep): NonNullable<MessageStep["bindings"]> {
  return step.bindings ?? Object.freeze([]);
}

function assertJsonMessageBinding(step: MessageStep, target: string): void {
  if (step.message.encoding !== "utf8") {
    throw new TwsEngineError(
      "ENGINE_INPUT_INVALID",
      "workflow message binding requires a UTF-8 JSON object",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(step.message.data);
  } catch {
    throw new TwsEngineError(
      "ENGINE_INPUT_INVALID",
      "workflow message binding requires a UTF-8 JSON object",
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype ||
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(target) ||
    ["__proto__", "constructor", "prototype"].includes(target) ||
    Reflect.ownKeys(parsed).some((key) =>
      typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)
    ) ||
    (Object.hasOwn(parsed, target) && !Array.isArray(Reflect.get(parsed, target)))
  ) {
    throw new TwsEngineError(
      "ENGINE_INPUT_INVALID",
      "workflow message binding target is invalid",
    );
  }
}

function bindJsonMessage(
  envelopeTemplate: Readonly<Record<string, unknown>>,
  target: string,
  value: string | readonly string[],
): Readonly<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow JSON message binding requires transaction IDs",
    );
  }
  const envelope = cloneJson(envelopeTemplate) as {
    message: { encoding: string; data: string };
  };
  if (envelope.message.encoding !== "utf8") {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow JSON message template changed",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope.message.data);
  } catch {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow JSON message template changed",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow JSON message template changed",
    );
  }
  const record = parsed as Record<string, unknown>;
  const resolved = Object.fromEntries([
    ...Object.entries(record).map(([key, item]) =>
      key === target ? [key, [...value]] : [key, item]
    ),
    ...(Object.hasOwn(record, target) ? [] : [[target, [...value]]]),
  ]);
  envelope.message.data = JSON.stringify(resolved);
  return Object.freeze(envelope);
}

async function trustedLegacyDigest(
  checkpoint: OperationCheckpoint,
  message: MessageStep["message"],
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<string | undefined> {
  if (legacyBitcoinMessageDigest === undefined) return undefined;
  const digest = await legacyBitcoinMessageDigest(Object.freeze({
    version: "1.0",
    requestId: checkpoint.payload.requestId as string | number,
    message: Object.freeze({ ...message }),
  }));
  if (digest !== undefined && !/^[0-9a-f]{64}$/u.test(digest)) {
    throw new TwsEngineError(
      "ENGINE_RESULT_INVALID",
      "Trusted Legacy Bitcoin workflow message digest is invalid",
    );
  }
  return digest;
}

function recoverableTask(
  taskId: string,
  envelope: Readonly<Record<string, unknown>>,
  account: AccountIdentity,
  origin: string,
  purpose: "message" | "typedData" = "typedData",
  digest: string = signingEnvelopeDigest(envelope),
): SigningTask {
  return Object.freeze({
    taskId,
    purpose,
    algorithm: "secp256k1-recoverable-ecdsa-sha256d",
    digest,
    signatureEncoding: "compact65-recoverable",
    origin,
    accountId: account.accountId,
    publicKey: account.publicKey,
  });
}

async function normalizeStep(
  workflow: WorkflowRequest,
  step: TransactionLikeStep,
  engine: TransactionEngine | undefined,
) {
  const requested = transactionRequestFor(workflow, step);
  const normalized = (await invokeTransactionEngine(
    engine,
    "normalizeRequest",
    "normalizeRequestParams",
    "normalizeRequestResult",
    { version: "1.0", request: requested },
  )) as {
    readonly request: Readonly<Record<string, unknown>>;
    readonly requestHash: string;
  };
  if (
    hashCanonical(normalized.request) !== normalized.requestHash ||
    !sameJson(normalized.request, requested) ||
    normalized.request.chainId !== workflow.chainId ||
    normalized.request.from !== workflow.from ||
    !sameJson(normalized.request.intent, requested.intent)
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow transaction normalization changed the bound step",
    );
  }
  return normalized;
}

function assertTransactionPlan(
  workflow: WorkflowRequest,
  normalized: { readonly requestHash: string },
  plan: ExecutionPlan,
  snapshotHash: string,
  policyHash: string,
): void {
  if (
    hashCanonical(plan.payload) !== plan.planHash ||
    plan.payload.requestHash !== normalized.requestHash ||
    plan.payload.snapshotHash !== snapshotHash ||
    plan.payload.policyHash !== policyHash ||
    plan.payload.chainId !== workflow.chainId ||
    plan.payload.accountId !== `${workflow.chainId}:${workflow.from}`
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow transaction plan differs from its bound inputs",
    );
  }
}

function targetType(step: TypedDataStep, target: string): "bytes32" | "bytes32[]" {
  const match = /^\/message\/([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(target);
  const fields = step.data.types[step.data.primaryType];
  const field = fields?.find((candidate) => candidate.name === match?.[1]);
  if (field?.type !== "bytes32" && field?.type !== "bytes32[]") {
    throw new TwsEngineError(
      "ENGINE_INPUT_INVALID",
      "workflow binding target has an incompatible typed-data field",
    );
  }
  return field.type;
}

function expectedTargetType(output: string): "bytes32" | "bytes32[]" {
  return output === "transactionIds" ? "bytes32[]" : "bytes32";
}

function assertBindingPlaceholder(step: TypedDataStep, target: string): void {
  const field = target.slice("/message/".length);
  if (!sameJson(step.data.message[field], { $tbcBinding: "unresolved" })) {
    throw new TwsEngineError(
      "ENGINE_INPUT_INVALID",
      "workflow binding target is not the sole approved placeholder",
    );
  }
}

async function buildWorkflowPlan(
  checkpoint: OperationCheckpoint,
  engine: TransactionEngine | undefined,
  memory: Readonly<Record<string, unknown>> = checkpoint.payload.memory,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<WorkflowPlan> {
  const request = requestOf(checkpoint);
  const account = accountFromMemory(checkpoint, memory);
  const planned: { readonly stepId: string; readonly plan: ExecutionPlan }[] = [];
  const usedInputOutpoints = new Set<string>();
  for (const step of transactionSteps(request)) {
    const snapshot = workflowSnapshotForStep(request, step.id, memory);
    if (snapshot === undefined) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "workflow transaction planning inputs are missing",
      );
    }
    const policy = policyForStep(memory, step.id);
    const normalized = await normalizeStep(request, step, engine);
    const result = (await invokeTransactionEngine(
      engine,
      "plan",
      "planParams",
      "planResult",
      {
        version: "1.0",
        request: normalized.request,
        requestHash: normalized.requestHash,
        snapshot,
        policy,
      },
    )) as { readonly plan: ExecutionPlan };
    assertTransactionPlan(
      request,
      normalized,
      result.plan,
      snapshot.snapshotHash,
      policy.policyHash,
    );
    assertWorkflowTransactionRoles(request, step, result.plan, memory);
    if (step.kind === "preparedTransaction") {
      assertPreparedProposalForPlan(
        { intent: step.intent, proposal: step.proposal as never },
        snapshot,
        result.plan,
      );
    }
    const validation = (await invokeTransactionEngine(
      engine,
      "validate",
      "validateParams",
      "validationResult",
      {
        version: "1.0",
        phase: "plan",
        request: normalized.request,
        requestHash: normalized.requestHash,
        snapshot,
        policy,
        plan: result.plan,
      },
    )) as { readonly valid: boolean };
    if (!validation.valid) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "workflow transaction plan validation failed",
      );
    }
    reserveWorkflowPlanInputs(usedInputOutpoints, result.plan);
    planned.push(Object.freeze({ stepId: step.id, plan: result.plan }));
  }

  const reviews = (memory.reviewedTransactionReviews ?? []) as readonly ReviewedTransactionReview[];
  const reviewedSteps = reviewedTransactionSteps(request);
  if (
    reviews.length !== reviewedSteps.length ||
    reviewedSteps.some((step) => !reviews.some((review) => review.stepId === step.id))
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow reviewed transaction artifacts are missing",
    );
  }
  const reviewedTasks = Object.freeze(reviewedSteps.map((step) => {
    const review = reviews.find((candidate) => candidate.stepId === step.id);
    if (review === undefined) throw new Error("reviewed transaction artifact missing");
    return reviewedTransactionTask(checkpoint, step, review, account, memory);
  }));

  const totalFee = planned.reduce(
    (total, entry) =>
      total + entry.plan.payload.transactions.reduce(
        (stepTotal, transaction) => stepTotal + BigInt(transaction.fee),
        0n,
      ),
    0n,
  ) + reviews.reduce((total, review) => total + BigInt(review.payload.totalFee), 0n);
  const maxTotalFee = request.maxTotalFee ?? String(totalFee);
  if (totalFee > BigInt(maxTotalFee)) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow transaction plans exceed maxTotalFee",
    );
  }
  const expiresAt = earliestExpiry(
    checkpoint.payload.expiresAt,
    request.expiresAt,
    ...planned.map((entry) => entry.plan.payload.expiresAt),
    ...reviews.map((review) => review.payload.expiresAt),
  );
  const typed = typedDataSteps(request);
  const messages = messageSteps(request);
  const crypto = cryptoSteps(request);
  const origin = (checkpoint.payload.context as { readonly origin: string }).origin;
  const envelopeByStep = new Map(
    typed.map((step) => [
      step.id,
      typedEnvelope(checkpoint, step, account),
    ]),
  );
  const immediateSigningTasks: {
    stepId: string;
    envelope?: Readonly<Record<string, unknown>>;
    task: SigningTask;
  }[] = planned.flatMap((entry) =>
    entry.plan.payload.signingTasks.map((task) => ({ stepId: entry.stepId, task })),
  );
  const deferredSigningTasks: DeferredSigningTask[] = [];
  const legacyBitcoinMessageStepIds: string[] = [];
  for (const step of messages) {
    const envelope = messageEnvelope(step);
    const bindings = messageBindings(step);
    const legacyDigest = await trustedLegacyDigest(
      checkpoint,
      step.message,
      legacyBitcoinMessageDigest,
    );
    if (legacyDigest !== undefined) legacyBitcoinMessageStepIds.push(step.id);
    if (bindings.length === 0) {
      immediateSigningTasks.push({
        stepId: step.id,
        envelope,
        task: recoverableTask(
          `sign-${step.id}`,
          envelope,
          account,
          origin,
          "message",
          legacyDigest ?? signingEnvelopeDigest(envelope),
        ),
      });
      continue;
    }
    const binding = bindings[0];
    if (binding === undefined) throw new Error("workflow message binding missing");
    const source = request.steps.find((candidate) => candidate.id === binding.source.stepId);
    if (
      (source?.kind !== "transaction" &&
        source?.kind !== "preparedTransaction" &&
        source?.kind !== "reviewedTransaction") ||
      !step.dependsOn.includes(source.id) ||
      binding.source.output !== "transactionIds"
    ) {
      throw new TwsEngineError(
        "ENGINE_INPUT_INVALID",
        "workflow deferred message source is invalid",
      );
    }
    assertJsonMessageBinding(step, binding.target);
    deferredSigningTasks.push(Object.freeze({
      taskId: `sign-${step.id}`,
      source: binding.source,
      targetStepId: step.id,
      target: `/message/${binding.target}`,
      targetType: "json-string-array" as const,
      purpose: "message" as const,
      publicKey: account.publicKey,
      envelopeTemplate: envelope,
    }));
  }
  for (const step of typed) {
    const envelope = envelopeByStep.get(step.id);
    if (envelope === undefined) throw new Error("typed envelope missing");
    if (step.bindings.length === 0) {
      immediateSigningTasks.push({
        stepId: step.id,
        envelope,
        task: recoverableTask(`sign-${step.id}`, envelope, account, origin),
      });
      continue;
    }
    const binding = step.bindings[0];
    if (binding === undefined) throw new Error("workflow binding missing");
    const source = request.steps.find((candidate) => candidate.id === binding.source.stepId);
    if (
      (source?.kind !== "transaction" && source?.kind !== "preparedTransaction") ||
      !step.dependsOn.includes(source.id) ||
      targetType(step, binding.target) !== expectedTargetType(binding.source.output)
    ) {
      throw new TwsEngineError(
        "ENGINE_INPUT_INVALID",
        "workflow deferred binding source or type is invalid",
      );
    }
    assertBindingPlaceholder(step, binding.target);
    deferredSigningTasks.push(Object.freeze({
      taskId: `sign-${step.id}`,
      source: binding.source,
      targetStepId: step.id,
      target: binding.target,
      targetType: targetType(step, binding.target),
      purpose: "typedData" as const,
      publicKey: account.publicKey,
      envelopeTemplate: envelope,
    }));
  }
  const taskIds = [
    ...immediateSigningTasks.map(({ stepId, task }) => `${stepId}\u0000${task.taskId}`),
    ...deferredSigningTasks.map(({ targetStepId, taskId }) => `${targetStepId}\u0000${taskId}`),
    ...crypto.map((step) => `${step.id}\u0000crypto-${step.id}`),
    ...reviewedTasks.map(({ taskId }) => `${taskId}\u0000${taskId}`),
  ];
  if (new Set(taskIds).size !== taskIds.length) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow signing task IDs are not unique within a step",
    );
  }
  const planByStep = new Map(planned.map((entry) => [entry.stepId, entry.plan]));
  const previewBindings = deferredSigningTasks.map((task) => ({
    sourceStepId: task.source.stepId,
    sourceOutput: task.source.output,
    target: task.target,
    targetType: task.targetType,
  }));
  const warnings = Object.freeze([
    ...new Set([
      ...planned.flatMap((entry) => entry.plan.payload.preview.warnings),
      ...reviews.flatMap((review) => review.payload.preview.warnings as readonly string[]),
      ...(previewBindings.length === 0 ? [] : ["DYNAMIC_BINDING"]),
    ]),
  ]);
  const signingRoles = workflowRolePreview(request, memory);
  const preview = Object.freeze({
    operationKind: "workflow",
    ...(signingRoles === undefined ? {} : { signingRoles }),
    failureMode: workflowFailureMode(request),
    steps: request.steps.map((step) =>
      step.kind === "transaction" || step.kind === "preparedTransaction"
        ? {
            id: step.id,
            kind: step.kind,
            dependsOn: step.dependsOn,
            assetFlows: planByStep.get(step.id)?.payload.preview.assetFlows,
          }
        : step.kind === "reviewedTransaction"
          ? {
              id: step.id,
              kind: step.kind,
              dependsOn: step.dependsOn,
              reviewedTransactionPreview: reviews.find(
                (review) => review.stepId === step.id,
              )?.payload.preview,
            }
        : step.kind === "message"
          ? {
              id: step.id,
              kind: step.kind,
              dependsOn: step.dependsOn,
              message: step.message,
            }
          : step.kind === "encrypt"
            ? {
                id: step.id,
                kind: step.kind,
                dependsOn: step.dependsOn,
                algorithm: step.algorithm,
                message: step.message,
              }
            : step.kind === "decrypt"
              ? {
                  id: step.id,
                  kind: step.kind,
                  dependsOn: step.dependsOn,
                  algorithm: step.algorithm,
                  ciphertext: step.ciphertext,
                }
              : {
                  id: step.id,
                  kind: step.kind,
                  dependsOn: step.dependsOn,
                  typedData: step.data,
                },
    ),
    bindings: previewBindings,
    totalFee: String(totalFee),
    warnings,
  });
  const payload = Object.freeze({
    version: "1.0" as const,
    requestHash: hashCanonical(request),
    chainId: request.chainId,
    accountId: account.accountId,
    expiresAt,
    failureMode: workflowFailureMode(request),
    stepOrder: request.steps.map((step) => step.id),
    transactionPlans: planned,
    immediateSigningTasks,
    deferredSigningTasks,
    legacyBitcoinMessageStepIds: Object.freeze(legacyBitcoinMessageStepIds),
    cryptoTasks: Object.freeze(crypto.map((step) => cryptoTask(step, account, origin))),
    reviewedTransactionTasks: reviewedTasks,
    maxTotalFee,
    totalFee: String(totalFee),
    preview,
  });
  return Object.freeze({ payload, workflowPlanHash: hashCanonical(payload) });
}

function enterWorkflowApproval(
  checkpoint: OperationCheckpoint,
  plan: WorkflowPlan,
  memory: Readonly<Record<string, unknown>> = checkpoint.payload.memory,
): CoreTransition {
  return prepareWorkflowApproval(
    checkpoint,
    assertWorkflowPlan(checkpoint, plan, memory),
    memory,
  );
}

async function enterWorkflowApprovalAfterPlanning(
  checkpoint: OperationCheckpoint,
  engine: TransactionEngine | undefined,
  memory: Readonly<Record<string, unknown>>,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<CoreTransition> {
  try {
    return enterWorkflowApproval(
      checkpoint,
      await buildWorkflowPlan(
        checkpoint,
        engine,
        memory,
        legacyBitcoinMessageDigest,
      ),
      memory,
    );
  } catch (error) {
    if (error instanceof PreparedProposalTimeError) {
      return completeError(checkpoint, 4100, error.message, memory);
    }
    if (
      error !== null &&
      typeof error === "object" &&
      !Array.isArray(error) &&
      (error as { readonly name?: unknown }).name === "TbcEngineError" &&
      (error as { readonly code?: unknown }).code === "INVALID_REQUEST"
    ) {
      return completeError(
        checkpoint,
        -32602,
        "Workflow planning rejected the invalid request",
        memory,
      );
    }
    throw error;
  }
}

export async function reduceWorkflowResolvingResponse(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
  engine: TransactionEngine | undefined,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<CoreTransition> {
  const request = requestOf(checkpoint);
  if (call.operation === "chainData.resolve") {
    if (usesStepMaterials(request)) {
      const result = resultValue as { readonly steps: readonly { readonly stepId: string;
        readonly snapshot: { readonly payload: { readonly expiresAt: string; readonly chainId: string; readonly account: AccountIdentity;
          readonly signingAccounts?: readonly AccountIdentity[] }; readonly snapshotHash: string } }[] };
      const steps = transactionSteps(request);
      if (!Array.isArray(result.steps) || result.steps.length !== steps.length ||
          result.steps.some((entry, index) => entry.stepId !== steps[index]!.id ||
            hashCanonical(entry.snapshot.payload) !== entry.snapshot.snapshotHash)) {
        throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "Workflow step snapshots do not match the requested steps");
      }
      const resolutions = checkpoint.payload.memory.accountResolutions as readonly { result: { accounts: readonly AccountIdentity[] } }[];
      const accounts = resolutions.at(-1)!.result.accounts;
      for (const [index, entry] of result.steps.entries()) {
        assertTransactionSigningSnapshot(transactionRequestFor(request, steps[index]!), accounts, entry.snapshot.payload);
      }
      const memory = { ...checkpoint.payload.memory, workflowSnapshots: result, workflowPolicies: Object.freeze([]) };
      const policyCalls = makeCalls(checkpoint, nextRevision(checkpoint), steps.map((step, index) => {
        const transactionRequest = transactionRequestFor(request, step);
        return { operation: "policy.resolve", params: { version: "1.0", request: transactionRequest,
          requestHash: hashCanonical(transactionRequest), snapshotHash: result.steps[index]!.snapshot.snapshotHash } };
      }));
      const next = advance(checkpoint, {
        state: "resolving",
        expiresAt: earliestExpiry(checkpoint.payload.expiresAt, ...result.steps.map(entry => entry.snapshot.payload.expiresAt)),
        pendingCalls: Object.freeze([...checkpoint.payload.pendingCalls.filter(candidate => candidate.callId !== call.callId), ...policyCalls]),
        memory, data: { resolvedInputs: { account: accountFromMemory(checkpoint, memory) } },
      });
      return waitingTransition(next);
    }
    const snapshot = resultValue as {
      readonly payload: { readonly expiresAt: string };
      readonly snapshotHash: string;
    };
    if (hashCanonical(snapshot.payload) !== snapshot.snapshotHash) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "workflow chain snapshot hash does not match its payload",
      );
    }
    const steps = transactionSteps(request);
    if (steps.length === 0) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "workflow resolved chain data without a transaction step",
      );
    }
    const revision = nextRevision(checkpoint);
    const policyCalls = makeCalls(checkpoint, revision, steps.map((step) => {
      const transactionRequest = transactionRequestFor(request, step);
      return {
        operation: "policy.resolve",
        params: {
          version: "1.0",
          requestHash: hashCanonical(transactionRequest),
          request: transactionRequest,
          snapshotHash: snapshot.snapshotHash,
        },
      };
    }));
    const memory = {
      ...checkpoint.payload.memory,
      chainSnapshot: snapshot,
      workflowPolicies: Object.freeze([]),
    };
    const next = advance(checkpoint, {
      state: "resolving",
      expiresAt: earliestExpiry(checkpoint.payload.expiresAt, snapshot.payload.expiresAt),
      pendingCalls: Object.freeze([
        ...checkpoint.payload.pendingCalls.filter((candidate) => candidate.callId !== call.callId),
        ...policyCalls,
      ]),
      memory,
      data: { resolvedInputs: { account: accountFromMemory(checkpoint, memory) } },
    });
    return waitingTransition(next);
  }
  if (call.operation === "policy.resolve") {
    const policy = resultValue as {
      readonly payload: { readonly expiresAt: string };
      readonly policyHash: string;
    };
    if (hashCanonical(policy.payload) !== policy.policyHash) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "workflow execution policy hash does not match its payload",
      );
    }
    const callRequest = (call.params as {
      readonly request: Readonly<Record<string, unknown>>;
      readonly requestHash: string;
    }).request;
    const step = transactionSteps(request).find((candidate) =>
      sameJson(transactionRequestFor(request, candidate), callRequest) &&
      workflowSnapshotForStep(request, candidate.id, checkpoint.payload.memory)?.snapshotHash ===
        (call.params as { readonly snapshotHash: string }).snapshotHash &&
      !workflowPolicies(checkpoint.payload.memory).some(entry => entry.stepId === candidate.id)
    );
    if (
      step === undefined ||
      hashCanonical(callRequest) !== (call.params as { readonly requestHash: string }).requestHash ||
      workflowPolicies(checkpoint.payload.memory).some((entry) => entry.stepId === step.id)
    ) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "workflow execution policy does not identify one pending transaction step",
      );
    }
    const entries = Object.freeze([
      ...workflowPolicies(checkpoint.payload.memory),
      Object.freeze({ stepId: step.id, policy }),
    ]);
    const remaining = checkpoint.payload.pendingCalls.filter(
      (candidate) => candidate.callId !== call.callId,
    );
    const memory = { ...checkpoint.payload.memory, workflowPolicies: entries };
    if (remaining.length > 0) {
      const next = advance(checkpoint, {
        state: "resolving",
        expiresAt: earliestExpiry(checkpoint.payload.expiresAt, policy.payload.expiresAt),
        pendingCalls: remaining,
        memory,
        data: { resolvedInputs: { account: accountFromMemory(checkpoint, memory) } },
      });
      return waitingTransition(next);
    }
    return enterWorkflowApprovalAfterPlanning(
      checkpoint,
      engine,
      memory,
      legacyBitcoinMessageDigest,
    );
  }
  if (call.operation === "reviewedTransaction.review") {
    const params = call.params as {
      readonly signingRoles?: unknown;
      readonly taskId: string;
      readonly contextHash: string;
      readonly chainId: string;
      readonly accountId: string;
      readonly publicKey: string;
      readonly requestHash: string;
      readonly request: Readonly<Record<string, unknown>>;
    };
    const result = resultValue as {
      readonly payload: ReviewedTransactionReview["payload"];
      readonly reviewHash: string;
    };
    const step = reviewedTransactionSteps(request).find(
      (candidate) => `review-${candidate.id}` === params.taskId,
    );
    const account = accountFromMemory(checkpoint);
    const existing = (checkpoint.payload.memory.reviewedTransactionReviews ?? []) as readonly ReviewedTransactionReview[];
    if (
      step === undefined ||
      params.contextHash !== checkpoint.payload.contextHash ||
      params.chainId !== account.chainId ||
      params.accountId !== account.accountId ||
      params.publicKey !== account.publicKey ||
      !sameJson(params.signingRoles ?? [], step === undefined ? [] : reviewedSigningRoleContext(checkpoint, step, account).roles ?? []) ||
      params.requestHash !== hashCanonical(step.request) ||
      !sameJson(params.request, step.request) ||
      result.reviewHash !== hashCanonical(result.payload) ||
      result.payload.preview.operationKind !== "transaction" ||
      existing.some((entry) => entry.stepId === step.id)
    ) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "reviewed transaction result differs from its exact request and context",
      );
    }
    const artifact = Object.freeze({
      stepId: step.id,
      payload: result.payload,
      reviewHash: result.reviewHash,
    });
    const reviews = Object.freeze([...existing, artifact]);
    const remaining = checkpoint.payload.pendingCalls.filter(
      (candidate) => candidate.callId !== call.callId,
    );
    const memory = { ...checkpoint.payload.memory, reviewedTransactionReviews: reviews };
    if (remaining.length > 0) {
      const next = advance(checkpoint, {
        state: "resolving",
        expiresAt: earliestExpiry(checkpoint.payload.expiresAt, result.payload.expiresAt),
        pendingCalls: remaining,
        memory,
        data: { resolvedInputs: { account } },
      });
      return waitingTransition(next);
    }
    return enterWorkflowApprovalAfterPlanning(
      checkpoint,
      engine,
      memory,
      legacyBitcoinMessageDigest,
    );
  }
  throw new TwsStateError(
    "PORT_RESULT_INVALID",
    `unexpected workflow resolving operation: ${call.operation}`,
  );
}

function assertWorkflowPlan(
  checkpoint: OperationCheckpoint,
  plan: WorkflowPlan = checkpoint.payload.memory.workflowPlan as WorkflowPlan,
  memory: Readonly<Record<string, unknown>> = checkpoint.payload.memory,
): WorkflowPlan {
  const request = requestOf(checkpoint);
  const account = accountFromMemory(checkpoint, memory);
  assertWorkflowTopology(request);
  if (
    hashCanonical(plan.payload) !== plan.workflowPlanHash ||
    plan.payload.requestHash !== hashCanonical(request) ||
    memory.requestHash !== plan.payload.requestHash ||
    plan.payload.chainId !== request.chainId ||
    plan.payload.accountId !== account.accountId ||
    plan.payload.failureMode !== workflowFailureMode(request) ||
    !sameJson(plan.payload.stepOrder, request.steps.map((step) => step.id)) ||
    (request.expiresAt !== undefined &&
      Date.parse(plan.payload.expiresAt) > Date.parse(request.expiresAt)) ||
    (request.maxTotalFee !== undefined && plan.payload.maxTotalFee !== request.maxTotalFee) ||
    BigInt(plan.payload.totalFee) > BigInt(plan.payload.maxTotalFee)
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow plan differs from its request or hash",
    );
  }
  const transactionEntries = plan.payload.transactionPlans;
  const expectedTransactions = transactionSteps(request);
  if (
    !sameJson(
      transactionEntries.map(({ stepId }) => stepId),
      expectedTransactions.map(({ id }) => id),
    ) ||
    transactionEntries.some(({ plan: transactionPlan }) =>
      hashCanonical(transactionPlan.payload) !== transactionPlan.planHash ||
      transactionPlan.payload.chainId !== request.chainId ||
      transactionPlan.payload.accountId !== account.accountId ||
      // The aggregate approval must not outlive any child. A child may stay
      // valid longer than the batch's earlier proposal/request deadline.
      Date.parse(transactionPlan.payload.expiresAt) < Date.parse(plan.payload.expiresAt)
    ) ||
    transactionEntries.some((entry) => {
      const step = expectedTransactions.find(({ id }) => id === entry.stepId);
      return (
        step === undefined ||
        entry.plan.payload.requestHash !==
          hashCanonical(transactionRequestFor(request, step)) ||
        entry.plan.payload.snapshotHash !== workflowSnapshotForStep(request, step.id, memory)?.snapshotHash ||
        entry.plan.payload.policyHash !== policyForStep(memory, step.id).policyHash
      );
    })
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow transaction plans changed after planning",
    );
  }
  for (const entry of transactionEntries) {
    assertWorkflowTransactionRoles(request, expectedTransactions.find(step => step.id === entry.stepId)!, entry.plan, memory);
  }
  const plannedTransactionTasks = transactionEntries.flatMap((entry) =>
    entry.plan.payload.signingTasks.map((task) => ({ stepId: entry.stepId, task })),
  );
  const reviews = (memory.reviewedTransactionReviews ?? []) as readonly ReviewedTransactionReview[];
  const expectedReviewedTasks = reviewedTransactionSteps(request).map((step) => {
    const review = reviews.find((candidate) => candidate.stepId === step.id);
    if (review === undefined) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "workflow reviewed transaction artifact changed after planning",
      );
    }
    return reviewedTransactionTask(checkpoint, step, review, account);
  });
  if (
    !sameJson(plan.payload.reviewedTransactionTasks, expectedReviewedTasks) ||
    reviews.some((review) => Date.parse(review.payload.expiresAt) < Date.parse(plan.payload.expiresAt))
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow reviewed transaction tasks changed after planning",
    );
  }
  const totalFee = transactionEntries.reduce(
    (total, entry) => total + entry.plan.payload.transactions.reduce(
      (stepTotal, transaction) => stepTotal + BigInt(transaction.fee),
      0n,
    ),
    0n,
  ) + reviews.reduce((total, review) => total + BigInt(review.payload.totalFee), 0n);
  if (plan.payload.totalFee !== String(totalFee)) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow total fee differs from its transaction plans",
    );
  }
  const expectedImmediate: {
    stepId: string;
    envelope?: Readonly<Record<string, unknown>>;
    task: SigningTask;
  }[] = [...plannedTransactionTasks];
  const expectedDeferred: DeferredSigningTask[] = [];
  if (
    plannedTransactionTasks.some((expected) =>
      !plan.payload.immediateSigningTasks.some((actual) => sameJson(actual, expected)),
    )
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow immediate transaction tasks changed after planning",
    );
  }
  for (const step of messageSteps(request)) {
    const envelope = messageEnvelope(step);
    const bindings = messageBindings(step);
    if (bindings.length === 0) {
      const immediate = plan.payload.immediateSigningTasks.find(
        (candidate) => candidate.stepId === step.id,
      );
      const legacy = plan.payload.legacyBitcoinMessageStepIds.includes(step.id);
      if (
        immediate?.envelope === undefined ||
        immediate.task.purpose !== "message" ||
        !sameJson(immediate.envelope, envelope) ||
        (!legacy && immediate.task.digest !== signingEnvelopeDigest(immediate.envelope)) ||
        !sameJson(
          immediate.task,
          recoverableTask(
            `sign-${step.id}`,
            envelope,
            account,
            (checkpoint.payload.context as { readonly origin: string }).origin,
            "message",
            immediate.task.digest,
          ),
        )
      ) {
        throw new TwsEngineError(
          "ENGINE_ARTIFACT_MISMATCH",
          "workflow message task changed after planning",
        );
      }
      expectedImmediate.push(immediate);
      continue;
    }
    const binding = bindings[0];
    const deferred = plan.payload.deferredSigningTasks.find(
      (candidate) => candidate.targetStepId === step.id,
    );
    if (
      binding === undefined ||
      deferred === undefined ||
      deferred.purpose !== "message" ||
      !sameJson(deferred.source, binding.source) ||
      deferred.target !== `/message/${binding.target}` ||
      deferred.targetType !== "json-string-array" ||
      deferred.publicKey !== account.publicKey ||
      !sameJson(deferred.envelopeTemplate, envelope)
    ) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "workflow deferred message task changed after planning",
      );
    }
    assertJsonMessageBinding(step, binding.target);
    expectedDeferred.push(deferred);
  }
  for (const step of typedDataSteps(request)) {
    if (step.bindings.length === 0) {
      const immediate = plan.payload.immediateSigningTasks.find(
        (candidate) => candidate.stepId === step.id,
      );
      if (
        immediate?.envelope === undefined ||
        immediate.task.purpose !== "typedData" ||
        !sameJson(immediate.envelope, {
          type: "tbc.typedData",
          version: "1.0",
          domain: step.data.domain,
          types: normalizeTypedDataTypes(step.data.types),
          primaryType: step.data.primaryType,
          message: step.data.message,
        }) ||
        immediate.task.digest !== signingEnvelopeDigest(immediate.envelope) ||
        !sameJson(
          immediate.task,
          recoverableTask(
            `sign-${step.id}`,
            immediate.envelope,
            account,
            (checkpoint.payload.context as { readonly origin: string }).origin,
          ),
        )
      ) {
        throw new TwsEngineError(
          "ENGINE_ARTIFACT_MISMATCH",
          "workflow immediate typed-data task changed after planning",
        );
      }
      expectedImmediate.push(immediate);
    } else {
      const binding = step.bindings[0];
      const deferred = plan.payload.deferredSigningTasks.find(
        (candidate) => candidate.targetStepId === step.id,
      );
      if (
        binding === undefined ||
        deferred === undefined ||
        deferred.purpose !== "typedData" ||
        !sameJson(deferred.source, binding.source) ||
        deferred.target !== binding.target ||
        deferred.targetType !== targetType(step, binding.target) ||
        deferred.publicKey !== account.publicKey ||
        !sameJson(deferred.envelopeTemplate, {
          type: "tbc.typedData",
          version: "1.0",
          domain: step.data.domain,
          types: normalizeTypedDataTypes(step.data.types),
          primaryType: step.data.primaryType,
          message: step.data.message,
        })
      ) {
        throw new TwsEngineError(
          "ENGINE_ARTIFACT_MISMATCH",
          "workflow deferred task changed after planning",
        );
      }
      assertBindingPlaceholder(step, binding.target);
      expectedDeferred.push(deferred);
    }
  }
  const expectedCrypto = cryptoSteps(request).map((step) =>
    cryptoTask(
      step,
      account,
      (checkpoint.payload.context as { readonly origin: string }).origin,
    )
  );
  if (
    !sameJson(plan.payload.immediateSigningTasks, expectedImmediate) ||
    !sameJson(plan.payload.deferredSigningTasks, expectedDeferred) ||
    plan.payload.legacyBitcoinMessageStepIds.some((stepId) =>
      !messageSteps(request).some((step) => step.id === stepId)
    ) ||
    !sameJson(plan.payload.cryptoTasks, expectedCrypto) ||
    !sameJson(plan.payload.reviewedTransactionTasks, expectedReviewedTasks)
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow signing task registry differs from its request and plans",
    );
  }
  const planByStep = new Map(
    transactionEntries.map((entry) => [entry.stepId, entry.plan]),
  );
  const signingRoles = workflowRolePreview(request, memory);
  const expectedPreview = {
    operationKind: "workflow",
    ...(signingRoles === undefined ? {} : { signingRoles }),
    failureMode: workflowFailureMode(request),
    steps: request.steps.map((step) =>
      step.kind === "transaction" || step.kind === "preparedTransaction"
        ? {
            id: step.id,
            kind: step.kind,
            dependsOn: step.dependsOn,
            assetFlows: planByStep.get(step.id)?.payload.preview.assetFlows,
          }
        : step.kind === "reviewedTransaction"
          ? {
              id: step.id,
              kind: step.kind,
              dependsOn: step.dependsOn,
              reviewedTransactionPreview: reviews.find(
                (review) => review.stepId === step.id,
              )?.payload.preview,
            }
        : step.kind === "message"
          ? {
              id: step.id,
              kind: step.kind,
              dependsOn: step.dependsOn,
              message: step.message,
            }
          : step.kind === "encrypt"
            ? {
                id: step.id,
                kind: step.kind,
                dependsOn: step.dependsOn,
                algorithm: step.algorithm,
                message: step.message,
              }
            : step.kind === "decrypt"
              ? {
                  id: step.id,
                  kind: step.kind,
                  dependsOn: step.dependsOn,
                  algorithm: step.algorithm,
                  ciphertext: step.ciphertext,
                }
              : {
                  id: step.id,
                  kind: step.kind,
                  dependsOn: step.dependsOn,
                  typedData: step.data,
                },
    ),
    bindings: expectedDeferred.map((task) => ({
      sourceStepId: task.source.stepId,
      sourceOutput: task.source.output,
      target: task.target,
      targetType: task.targetType,
    })),
    totalFee: plan.payload.totalFee,
    warnings: [
      ...new Set([
        ...transactionEntries.flatMap((entry) => entry.plan.payload.preview.warnings),
        ...reviews.flatMap((review) => review.payload.preview.warnings as readonly string[]),
        ...(expectedDeferred.length === 0 ? [] : ["DYNAMIC_BINDING"]),
      ]),
    ],
  };
  if (!sameJson(plan.payload.preview, expectedPreview)) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow preview differs from its approved steps",
    );
  }
  return plan;
}

export function assertWorkflowApprovalArtifacts(checkpoint: OperationCheckpoint) {
  const plan = assertWorkflowPlan(checkpoint);
  const request = requestOf(checkpoint);
  const context = checkpoint.payload.context as {
    readonly origin: string;
    readonly sessionId: string;
  };
  const expected = createApprovalBinding({
    version: "1.0",
    method: operationOf(checkpoint).method,
    operationKind: "workflow",
    contextHash: checkpoint.payload.contextHash,
    origin: context.origin,
    sessionId: context.sessionId,
    chainId: request.chainId,
    accountId: plan.payload.accountId,
    requestHash: plan.payload.requestHash,
    operationHash: plan.workflowPlanHash,
    expiresAt: plan.payload.expiresAt,
  });
  assertApprovalBinding(
    checkpoint.payload.memory.approvalBinding as typeof expected,
    expected.payload,
  );
  if (!sameJson(checkpoint.payload.memory.approvalPreview, plan.payload.preview)) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow approval preview differs from its plan",
    );
  }
  return { plan, request, account: accountFromMemory(checkpoint), binding: expected };
}

export function reduceWorkflowPlanning(checkpoint: OperationCheckpoint): CoreTransition {
  return prepareWorkflowApproval(checkpoint, assertWorkflowPlan(checkpoint));
}

function prepareWorkflowApproval(
  checkpoint: OperationCheckpoint,
  plan: WorkflowPlan,
  memory: Readonly<Record<string, unknown>> = checkpoint.payload.memory,
): CoreTransition {
  const request = requestOf(checkpoint);
  const context = checkpoint.payload.context as {
    readonly origin: string;
    readonly sessionId: string;
  };
  const binding = createApprovalBinding({
    version: "1.0",
    method: operationOf(checkpoint).method,
    operationKind: "workflow",
    contextHash: checkpoint.payload.contextHash,
    origin: context.origin,
    sessionId: context.sessionId,
    chainId: request.chainId,
    accountId: plan.payload.accountId,
    requestHash: plan.payload.requestHash,
    operationHash: plan.workflowPlanHash,
    expiresAt: plan.payload.expiresAt,
  });
  return prepareApprovalWithMemory(checkpoint, binding, plan.payload.preview, {
    ...memory,
    workflowPlan: plan,
  });
}

function rejection(checkpoint: OperationCheckpoint): CoreTransition {
  const completion = Object.freeze({
    delivery: "respond",
    response: {
      jsonrpc: "2.0",
      id: checkpoint.payload.requestId,
      error: { code: 4001, message: "User rejected the request" },
    },
    events: [],
  });
  const next = advance(checkpoint, {
    state: "rejected",
    pendingCalls: [],
    data: { cancellationReason: "USER_REJECTED" },
  });
  return completeTransition(next, completion);
}

function replaceStep(
  progress: WorkflowProgress,
  nextStep: WorkflowStepProgress,
  completedStepIds: readonly string[] = progress.completedStepIds,
): WorkflowProgress {
  return Object.freeze({
    steps: progress.steps.map((step) =>
      step.stepId === nextStep.stepId ? Object.freeze(nextStep) : step,
    ),
    completedStepIds: Object.freeze([...completedStepIds]),
  });
}

function sourceValue(
  output: string,
  bundle: SignedBundle,
): string | readonly string[] {
  if (output === "transactionIds") {
    return Object.freeze(bundle.transactions.map(({ txid }) => txid));
  }
  if (output === "primaryTransactionId") {
    const primary = bundle.transactions.filter(({ role }) => role === "primary");
    if (primary.length === 1) return String(primary[0]?.txid);
  }
  if (output.startsWith("artifacts.")) {
    const value = bundle.artifacts?.[output.slice("artifacts.".length)];
    if (value !== undefined) return value;
  }
  throw new TwsEngineError(
    "ENGINE_ARTIFACT_MISMATCH",
    "workflow deferred source is absent from the finalized bundle",
  );
}

async function deriveDeferredTask(
  checkpoint: OperationCheckpoint,
  deferred: DeferredSigningTask,
  progress: WorkflowProgress,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<ResolvedDeferredSigningTask> {
  const sourceProgress = progress.steps.find(
    (step) => step.stepId === deferred.source.stepId,
  );
  const sourceBundle = sourceProgress?.finalizedBundle ??
    sourceProgress?.reviewedTransactionResult?.bundle;
  if (sourceProgress?.status !== "completed" || sourceBundle === undefined) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow deferred source has not been finalized",
    );
  }
  const value = sourceValue(deferred.source.output, sourceBundle);
  let resolvedEnvelope: Readonly<Record<string, unknown>>;
  if (deferred.purpose === "message") {
    resolvedEnvelope = bindJsonMessage(
      deferred.envelopeTemplate,
      deferred.target.slice("/message/".length),
      value,
    );
  } else {
    const resolvedTypedData = cloneJson(deferred.envelopeTemplate) as {
      message: Record<string, unknown>;
    };
    const field = deferred.target.slice("/message/".length);
    if (!sameJson(resolvedTypedData.message[field], { $tbcBinding: "unresolved" })) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "workflow deferred template no longer contains its approved placeholder",
      );
    }
    resolvedTypedData.message[field] = cloneJson(value);
    resolvedEnvelope = Object.freeze(resolvedTypedData);
  }
  const plan = assertWorkflowPlan(checkpoint);
  const legacy = deferred.purpose === "message" &&
    plan.payload.legacyBitcoinMessageStepIds.includes(deferred.targetStepId);
  const legacyDigest = legacy
    ? await trustedLegacyDigest(
        checkpoint,
        (resolvedEnvelope as { readonly message: MessageStep["message"] }).message,
        legacyBitcoinMessageDigest,
      )
    : undefined;
  if (legacy && legacyDigest === undefined) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "trusted Legacy workflow message authority is unavailable",
    );
  }
  const digest = legacyDigest ?? signingEnvelopeDigest(resolvedEnvelope);
  const concreteTask: SigningTask = Object.freeze({
    taskId: deferred.taskId,
    purpose: deferred.purpose,
    algorithm: "secp256k1-recoverable-ecdsa-sha256d",
    digest,
    signatureEncoding: "compact65-recoverable",
    origin: (checkpoint.payload.context as { readonly origin: string }).origin,
    accountId: plan.payload.accountId,
    publicKey: deferred.publicKey,
  });
  return Object.freeze({
    planTaskId: deferred.taskId,
    source: deferred.source,
    sourceValue: value,
    targetStepId: deferred.targetStepId,
    target: deferred.target,
    targetType: deferred.targetType,
    purpose: deferred.purpose,
    resolvedEnvelope,
    canonical: canonicalSigningEnvelope(resolvedEnvelope),
    digest,
    concreteTask,
  });
}

/** Reuses Core's approved dependency resolution at a private native boundary. */
export async function assertWorkflowDeferredSigningTask(
  checkpoint: OperationCheckpoint,
  stepId: string,
  task: unknown,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<void> {
  const { plan } = assertWorkflowApprovalArtifacts(checkpoint);
  const deferred = plan.payload.deferredSigningTasks.find(entry => entry.targetStepId === stepId);
  if (deferred === undefined) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "Deferred task not approved");
  }
  // Recompute from the approved template and finalized source, never a digest
  // supplied by the page. Legacy remains fail-closed without trusted authority.
  const resolved = await deriveDeferredTask(checkpoint, deferred,
    checkpoint.payload.memory.workflowProgress as WorkflowProgress, legacyBitcoinMessageDigest);
  if (!sameJson(resolved.concreteTask, task)) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "Deferred task dependency mismatch");
  }
}

function messageOrTypedResult(
  checkpoint: OperationCheckpoint,
  stepId: string,
  progress: WorkflowProgress,
) {
  const plan = assertWorkflowPlan(checkpoint);
  const step = progress.steps.find((candidate) => candidate.stepId === stepId);
  const task = step?.signingTasks?.[0];
  const signature = step?.signatures?.[0];
  if (
    task === undefined ||
    signature === undefined ||
    (task.purpose !== "message" && task.purpose !== "typedData")
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "completed workflow message step lacks its signature",
    );
  }
  const immediate = plan.payload.immediateSigningTasks.find(
    (candidate) => candidate.stepId === stepId && candidate.envelope !== undefined,
  );
  const envelope = immediate?.envelope ?? step?.resolvedDeferredSigningTasks?.[0]?.resolvedEnvelope;
  const legacy = task.purpose === "message" &&
    plan.payload.legacyBitcoinMessageStepIds.includes(stepId);
  if (
    envelope === undefined ||
    (!legacy && signingEnvelopeDigest(envelope) !== task.digest)
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "completed workflow message envelope changed",
    );
  }
  const recoverable = assertRecoverableSignature(task as never, signature.signature);
  const account = accountFromMemory(checkpoint);
  return Object.freeze({
    version: "1.0",
    scheme: legacy
      ? "legacy-bitcoin-message"
      : task.purpose === "message"
        ? "tbc-message"
        : "tbc-typed-data",
    algorithm: task.algorithm,
    address: account.address,
    accountId: account.accountId,
    publicKey: account.publicKey,
    envelope,
    canonical: canonicalSigningEnvelope(envelope),
    ...(!legacy ? { signingPayload: base64Encode(signingPayload(envelope)) } : {}),
    digest: task.digest,
    signature: base64Encode(recoverable),
  });
}

function completeWorkflow(
  checkpoint: OperationCheckpoint,
  memory: Readonly<Record<string, unknown>>,
): CoreTransition {
  const plan = assertWorkflowPlan(checkpoint);
  const request = requestOf(checkpoint);
  const progress = memory.workflowProgress as WorkflowProgress;
  const approval = memory.approvalReceipt as ApprovalReceipt;
  if (progress.completedStepIds.length !== request.steps.length) {
    throw new TwsStateError(
      "STATE_MISMATCH",
      "workflow cannot complete before every step",
    );
  }
  const steps = request.steps.map((step) => {
    const state = progress.steps.find((candidate) => candidate.stepId === step.id);
    if (state?.status === "failed" || state?.status === "skipped") {
      if (state.error === undefined) {
        throw new TwsEngineError(
          "ENGINE_ARTIFACT_MISMATCH",
          "completed workflow failed step lacks its bound error",
        );
      }
      return {
        id: step.id,
        kind: step.kind,
        status: state.status,
        error: state.error,
      };
    }
    if (step.kind === "transaction" || step.kind === "preparedTransaction") {
      if (state?.finalizedBundle === undefined) {
        throw new TwsEngineError(
          "ENGINE_ARTIFACT_MISMATCH",
          "completed workflow transaction lacks its finalized bundle",
        );
      }
      return { id: step.id, kind: step.kind, result: state.finalizedBundle };
    }
    if (step.kind === "encrypt" || step.kind === "decrypt") {
      if (state?.cryptoResult === undefined) {
        throw new TwsEngineError(
          "ENGINE_ARTIFACT_MISMATCH",
          "completed workflow crypto step lacks its bound result",
        );
      }
      return { id: step.id, kind: step.kind, result: state.cryptoResult };
    }
    if (step.kind === "reviewedTransaction") {
      if (state?.reviewedTransactionResult === undefined) {
        throw new TwsEngineError(
          "ENGINE_ARTIFACT_MISMATCH",
          "completed reviewed transaction step lacks its bound result",
        );
      }
      return { id: step.id, kind: step.kind, result: state.reviewedTransactionResult.bundle };
    }
    return {
      id: step.id,
      kind: step.kind,
      result: messageOrTypedResult(checkpoint, step.id, progress),
    };
  });
  const workflowResult = Object.freeze({
    version: "1.0",
    chainId: request.chainId,
    from: request.from,
    requestHash: plan.payload.requestHash,
    workflowPlanHash: plan.workflowPlanHash,
    approvalId: approval.approvalId,
    failureMode: plan.payload.failureMode,
    steps,
    totalFee: plan.payload.totalFee,
  });
  const method = operationOf(checkpoint).method;
  if (method !== "tbc_sendWorkflow" && method !== "tbc_sendPreparedWorkflow") {
    return completeSuccess(checkpoint, workflowResult, memory);
  }
  const orderedSteps = plan.payload.stepOrder.map((stepId) =>
    steps.find((step) => step.id === stepId),
  );
  const transactions = orderedSteps.flatMap((step) => {
    if (
      step === undefined ||
      !(step.kind === "transaction" || step.kind === "preparedTransaction" || step.kind === "reviewedTransaction") ||
      !("result" in step)
    ) return [];
    return (step.result as SignedBundle).transactions;
  });
  if (
    transactions.length < 1 ||
    transactions.length > 32 ||
    new Set(transactions.map(({ txid }) => txid)).size !== transactions.length
  ) {
    return completeError(
      checkpoint,
      -32602,
      "Workflow batch must contain between 1 and 32 unique transactions",
      memory,
    );
  }
  const finalizedBundle = Object.freeze({
    version: "1.0" as const,
    chainId: request.chainId,
    from: request.from,
    requestHash: plan.payload.requestHash,
    approvalId: approval.approvalId,
    transactions: Object.freeze(transactions),
    totalFee: plan.payload.totalFee,
  });
  const broadcastProgress = Object.freeze({
    attempts: Object.freeze([]),
    submittedTransactionIds: Object.freeze([]),
    reconciliationAttempts: 0,
  });
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "clock.now", params: { version: "1.0" } },
  ]);
  const next = advance(checkpoint, {
    state: "broadcasting",
    pendingCalls: calls,
    memory: { ...memory, workflowResult, finalizedBundle, broadcastProgress },
    data: { finalizedBundle },
  });
  return waitingTransition(next);
}

async function scheduleNextStep(
  checkpoint: OperationCheckpoint,
  memory: Readonly<Record<string, unknown>>,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<CoreTransition> {
  const plan = assertWorkflowPlan(checkpoint);
  const request = requestOf(checkpoint);
  const progress = memory.workflowProgress as WorkflowProgress;
  if (progress.completedStepIds.length === request.steps.length) {
    return completeWorkflow(checkpoint, memory);
  }
  const completed = new Set(progress.completedStepIds);
  const step = request.steps.find(
    (candidate) =>
      !completed.has(candidate.id) &&
      progress.steps.find(({ stepId }) => stepId === candidate.id)?.status === "pending" &&
      candidate.dependsOn.every((dependency) => completed.has(dependency)),
  );
  if (step === undefined) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow has no runnable step",
    );
  }
  let tasks: readonly (SigningTask | CryptoTask | ReviewedTransactionTask)[];
  let resolvedDeferredSigningTasks: readonly ResolvedDeferredSigningTask[] | undefined;
  if (step.kind === "transaction" || step.kind === "preparedTransaction") {
    const transactionPlan = plan.payload.transactionPlans.find(
      (entry) => entry.stepId === step.id,
    );
    if (transactionPlan === undefined) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "workflow transaction step has no approved plan",
      );
    }
    tasks = transactionPlan.plan.payload.signingTasks;
  } else if (step.kind === "reviewedTransaction") {
    const task = plan.payload.reviewedTransactionTasks.find(
      (entry) => entry.taskId === `review-${step.id}`,
    );
    if (task === undefined) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "workflow reviewed transaction step has no approved task",
      );
    }
    tasks = Object.freeze([task]);
  } else if (step.kind === "message") {
    const immediate = plan.payload.immediateSigningTasks.find(
      (entry) => entry.stepId === step.id && entry.task.purpose === "message",
    );
    if (immediate !== undefined) {
      tasks = Object.freeze([immediate.task]);
    } else {
      const deferred = plan.payload.deferredSigningTasks.find(
        (entry) => entry.targetStepId === step.id && entry.purpose === "message",
      );
      if (deferred === undefined) {
        throw new TwsEngineError(
          "ENGINE_ARTIFACT_MISMATCH",
          "workflow message step has no approved task",
        );
      }
      const resolved = await deriveDeferredTask(
        checkpoint,
        deferred,
        progress,
        legacyBitcoinMessageDigest,
      );
      tasks = Object.freeze([resolved.concreteTask]);
      resolvedDeferredSigningTasks = Object.freeze([resolved]);
    }
  } else if (step.kind === "encrypt" || step.kind === "decrypt") {
    const task = plan.payload.cryptoTasks.find(
      (entry) => entry.taskId === `crypto-${step.id}`,
    );
    if (task === undefined) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "workflow crypto step has no approved task",
      );
    }
    tasks = Object.freeze([task]);
  } else {
    const immediate = plan.payload.immediateSigningTasks.find(
      (entry) => entry.stepId === step.id && entry.task.purpose === "typedData",
    );
    if (immediate !== undefined) {
      tasks = Object.freeze([immediate.task]);
    } else {
      const deferred = plan.payload.deferredSigningTasks.find(
        (entry) => entry.targetStepId === step.id,
      );
      if (deferred === undefined) {
        throw new TwsEngineError(
          "ENGINE_ARTIFACT_MISMATCH",
          "workflow typed-data step has no approved task",
        );
      }
      const resolved = await deriveDeferredTask(
        checkpoint,
        deferred,
        progress,
        legacyBitcoinMessageDigest,
      );
      tasks = Object.freeze([resolved.concreteTask]);
      resolvedDeferredSigningTasks = Object.freeze([resolved]);
    }
  }
  const current = progress.steps.find((candidate) => candidate.stepId === step.id);
  if (current === undefined || tasks.length === 0) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow runnable step has no signing task",
    );
  }
  const nextStep: WorkflowStepProgress = Object.freeze({
    ...current,
    status: "signing",
    signingTasks: tasks,
    signatures: Object.freeze([]),
    ...(resolvedDeferredSigningTasks === undefined
      ? {}
      : { resolvedDeferredSigningTasks }),
  });
  const workflowProgress = replaceStep(progress, nextStep);
  const signingTasks = Object.freeze([
    ...((memory.signingTasks ?? []) as readonly (SigningTask | CryptoTask | ReviewedTransactionTask)[]),
    ...tasks,
  ]);
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "clock.now", params: { version: "1.0" } },
  ]);
  const next = advance(checkpoint, {
    state: "signing",
    pendingCalls: calls,
    memory: {
      ...memory,
      signingTasks,
      signatures: (memory.signatures ?? []) as readonly SignerResult[],
      cryptoResults: (memory.cryptoResults ?? []) as readonly CryptoResult[],
      reviewedTransactionResults:
        (memory.reviewedTransactionResults ?? []) as readonly ReviewedTransactionResult[],
      workflowProgress,
    },
    data: {
      approvalReceipt: memory.approvalReceipt,
      signingTask: tasks[0],
    },
  });
  return waitingTransition(next);
}

export async function reduceWorkflowPortFailure(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  portError: Readonly<{ readonly name: string }>,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<CoreTransition> {
  const { request, plan } = assertWorkflowApprovalArtifacts(checkpoint);
  if (
    plan.payload.failureMode !== "continue-independent" ||
    checkpoint.payload.state !== "signing" ||
    !new Set(["signer.sign", "crypto.execute", "reviewedTransaction.execute"]).has(
      call.operation,
    )
  ) {
    throw new TwsStateError(
      "STATE_MISMATCH",
      "workflow Port failure is not independently recoverable",
    );
  }
  const progress = checkpoint.payload.memory.workflowProgress as WorkflowProgress;
  const active = progress.steps.find((step) =>
    step.status === "signing" &&
    step.signingTasks?.some((task) => task.taskId ===
      (call.params as { readonly task?: { readonly taskId?: unknown } }).task?.taskId)
  );
  if (active === undefined) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "workflow Port failure does not identify the active step",
    );
  }
  const failedError = Object.freeze({
    code: `HOST_${String(portError.name).replace(/[^A-Z0-9_]/gu, "_").slice(0, 58)}`,
    message: `Workflow step failed: ${call.operation}`,
  });
  const states = progress.steps.map((state) =>
    state.stepId === active.stepId
      ? Object.freeze({ ...state, status: "failed" as const, error: failedError })
      : state
  );
  const terminalIds = new Set([...progress.completedStepIds, active.stepId]);
  const unavailable = new Set([active.stepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of request.steps) {
      if (terminalIds.has(step.id) || !step.dependsOn.some((id) => unavailable.has(id))) continue;
      const index = states.findIndex((state) => state.stepId === step.id);
      const current = states[index];
      if (index < 0 || current === undefined || current.status !== "pending") continue;
      states[index] = Object.freeze({
        ...current,
        status: "skipped" as const,
        error: Object.freeze({
          code: "DEPENDENCY_FAILED",
          message: "Workflow dependency failed",
        }),
      });
      terminalIds.add(step.id);
      unavailable.add(step.id);
      changed = true;
    }
  }
  const workflowProgress: WorkflowProgress = Object.freeze({
    steps: Object.freeze(states),
    completedStepIds: Object.freeze(request.steps
      .map(({ id }) => id)
      .filter((id) => terminalIds.has(id))),
  });
  return scheduleNextStep(
    checkpoint,
    { ...checkpoint.payload.memory, workflowProgress },
    legacyBitcoinMessageDigest,
  );
}

async function validateWorkflowPreSign(
  checkpoint: OperationCheckpoint,
  engine: TransactionEngine | undefined,
  receipt: ApprovalReceipt,
): Promise<boolean> {
  const plan = assertWorkflowPlan(checkpoint);
  const request = requestOf(checkpoint);
  for (const entry of plan.payload.transactionPlans) {
    const step = transactionSteps(request).find(({ id }) => id === entry.stepId);
    if (step === undefined) return false;
    const snapshot = workflowSnapshotForStep(request, step.id, checkpoint.payload.memory);
    const normalized = await normalizeStep(request, step, engine);
    if (normalized.requestHash !== entry.plan.payload.requestHash) return false;
    const policy = policyForStep(checkpoint.payload.memory, step.id);
    const result = (await invokeTransactionEngine(
      engine,
      "validate",
      "validateParams",
      "validationResult",
      {
        version: "1.0",
        phase: "pre-sign",
        request: normalized.request,
        requestHash: normalized.requestHash,
        snapshot,
        policy,
        plan: entry.plan,
        binding: checkpoint.payload.memory.approvalBinding,
        approval: receipt,
      },
    )) as { readonly valid: boolean };
    if (!result.valid) return false;
  }
  return true;
}

export async function reduceWorkflowApproval(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
  engine: TransactionEngine | undefined,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<CoreTransition> {
  const { request } = assertWorkflowApprovalArtifacts(checkpoint);
  const decision = readApprovalDecision(checkpoint, call, resultValue);
  if (decision.status === "rejected") return rejection(checkpoint);
  if (!(await validateWorkflowPreSign(checkpoint, engine, decision.receipt))) {
    return completeError(checkpoint, -32603, "Workflow pre-sign validation failed");
  }
  const workflowProgress: WorkflowProgress = Object.freeze({
    steps: Object.freeze(request.steps.map((step) => Object.freeze({
      stepId: step.id,
      status: "pending" as const,
    }))),
    completedStepIds: Object.freeze([]),
  });
  return scheduleNextStep(checkpoint, {
    ...checkpoint.payload.memory,
    approvalReceipt: decision.receipt,
    signingTasks: Object.freeze([]),
    signatures: Object.freeze([]),
    cryptoResults: Object.freeze([]),
    reviewedTransactionResults: Object.freeze([]),
    workflowProgress,
  }, legacyBitcoinMessageDigest);
}

export async function reduceWorkflowCryptoResponse(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<CoreTransition> {
  const { plan } = assertWorkflowApprovalArtifacts(checkpoint);
  const params = call.params as {
    readonly approval: ApprovalReceipt;
    readonly task: CryptoTask;
  };
  const result = resultValue as CryptoResult;
  const approved = plan.payload.cryptoTasks.find(
    (task) => task.taskId === params.task.taskId,
  );
  if (approved === undefined) throw new TwsStateError("PORT_RESULT_INVALID", "crypto task was not approved");
  assertCryptoOutcome(call.params, result, approved, checkpoint.payload.memory.approvalReceipt as ApprovalReceipt);
  const progress = checkpoint.payload.memory.workflowProgress as WorkflowProgress;
  const active = progress.steps.find((step) =>
    step.status === "signing" &&
    step.signingTasks?.some((task) => task.taskId === approved.taskId),
  );
  if (active === undefined) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "workflow crypto task is not part of the active step",
    );
  }
  const workflowProgress = replaceStep(
    progress,
    Object.freeze({ ...active, status: "completed", cryptoResult: result }),
    Object.freeze([...progress.completedStepIds, active.stepId]),
  );
  return scheduleNextStep(checkpoint, {
    ...checkpoint.payload.memory,
    cryptoResults: Object.freeze([
      ...((checkpoint.payload.memory.cryptoResults ?? []) as readonly CryptoResult[]),
      result,
    ]),
    workflowProgress,
  }, legacyBitcoinMessageDigest);
}

export async function reduceWorkflowReviewedTransactionResponse(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<CoreTransition> {
  const { plan, request, account } = assertWorkflowApprovalArtifacts(checkpoint);
  const params = call.params as {
    readonly version: "1.0";
    readonly approval: ApprovalReceipt;
    readonly task: ReviewedTransactionTask;
  };
  const result = resultValue as ReviewedTransactionResult;
  const approved = plan.payload.reviewedTransactionTasks.find(
    (task) => task.taskId === params.task.taskId,
  );
  const review = (checkpoint.payload.memory.reviewedTransactionReviews as readonly ReviewedTransactionReview[])
    .find((candidate) => `review-${candidate.stepId}` === params.task.taskId);
  if (approved === undefined || review === undefined) throw new TwsStateError("PORT_RESULT_INVALID", "reviewed task was not approved");
  assertReviewedOutcome(call.params, result, approved, review, account, checkpoint.payload.memory.approvalReceipt as ApprovalReceipt);
  const progress = checkpoint.payload.memory.workflowProgress as WorkflowProgress;
  const active = progress.steps.find((step) =>
    step.status === "signing" &&
    step.signingTasks?.some((task) => task.taskId === approved.taskId),
  );
  if (active === undefined) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "reviewed transaction task is not part of the active step",
    );
  }
  const workflowProgress = replaceStep(
    progress,
    Object.freeze({
      ...active,
      status: "completed",
      reviewedTransactionResult: result,
    }),
    Object.freeze([...progress.completedStepIds, active.stepId]),
  );
  return scheduleNextStep(checkpoint, {
    ...checkpoint.payload.memory,
    reviewedTransactionResults: Object.freeze([
      ...((checkpoint.payload.memory.reviewedTransactionResults ?? []) as readonly ReviewedTransactionResult[]),
      result,
    ]),
    workflowProgress,
  }, legacyBitcoinMessageDigest);
}

export async function reduceWorkflowSigningResponse(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<CoreTransition> {
  assertWorkflowApprovalArtifacts(checkpoint);
  const approval = checkpoint.payload.memory.approvalReceipt as ApprovalReceipt;
  const signatures = (checkpoint.payload.memory.signatures ?? []) as readonly SignerResult[];
  const params = call.params as {
    readonly version: "1.0";
    readonly approval: ApprovalReceipt;
    readonly task: SigningTask;
  };
  const result = resultValue as SignerResult;
  const progress = checkpoint.payload.memory.workflowProgress as WorkflowProgress;
  const active = progress.steps.find((step) =>
    step.status === "signing" &&
    step.signingTasks?.some(({ taskId }) => taskId === params.task.taskId),
  );
  const task = active?.signingTasks?.find(({ taskId }) => taskId === params.task.taskId);
  if (
    active === undefined ||
    task === undefined ||
    task.purpose === "encrypt" ||
    task.purpose === "decrypt" ||
    task.purpose === "reviewedTransaction"
  ) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "workflow signer result differs from its approved task",
    );
  }
  const signingTask = task as SigningTask;
  if (
    !sameJson(params, { version: "1.0", approval, task: signingTask }) ||
    result.taskId !== signingTask.taskId ||
    result.signatureEncoding !== signingTask.signatureEncoding
  ) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "workflow signer result differs from its approved task",
    );
  }
  if (signingTask.purpose === "message" || signingTask.purpose === "typedData") {
    assertRecoverableSignature(signingTask as never, result.signature);
  }
  const stepSignatures = Object.freeze([...(active.signatures ?? []), result]);
  const nextSignatures = Object.freeze([...signatures, result]);
  const complete = stepSignatures.length === active.signingTasks?.length;
  const workflowProgress = replaceStep(
    progress,
    Object.freeze({
      ...active,
      status: complete && (task.purpose === "message" || task.purpose === "typedData")
        ? "completed"
        : "signing",
      signatures: stepSignatures,
    }),
    complete && (task.purpose === "message" || task.purpose === "typedData")
      ? Object.freeze([...progress.completedStepIds, active.stepId])
      : progress.completedStepIds,
  );
  const memory = {
    ...checkpoint.payload.memory,
    signatures: nextSignatures,
    workflowProgress,
  };
  if (complete && (task.purpose === "message" || task.purpose === "typedData")) {
    return scheduleNextStep(checkpoint, memory, legacyBitcoinMessageDigest);
  }
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "clock.now", params: { version: "1.0" } },
  ]);
  const next = advance(checkpoint, {
    state: complete ? "finalizing" : "signing",
    pendingCalls: calls,
    memory,
    data: complete
      ? { signatures: nextSignatures }
      : {
          approvalReceipt: approval,
          signingTask: active.signingTasks?.[stepSignatures.length],
        },
  });
  return waitingTransition(next);
}

function activeTransaction(
  request: WorkflowRequest,
  progress: WorkflowProgress,
): { readonly step: TransactionLikeStep; readonly state: WorkflowStepProgress } {
  const state = progress.steps.find(
    (candidate) => candidate.status === "signing" || candidate.status === "finalized",
  );
  const step = request.steps.find(
    (candidate): candidate is TransactionLikeStep =>
      candidate.id === state?.stepId &&
      (candidate.kind === "transaction" || candidate.kind === "preparedTransaction"),
  );
  if (state === undefined || step === undefined) {
    throw new TwsStateError(
      "STATE_MISMATCH",
      "workflow finalizing state has no active transaction step",
    );
  }
  return { step, state };
}

export async function reduceWorkflowFinalizing(
  checkpoint: OperationCheckpoint,
  engine: TransactionEngine | undefined,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<CoreTransition> {
  const plan = assertWorkflowPlan(checkpoint);
  const request = requestOf(checkpoint);
  const progress = checkpoint.payload.memory.workflowProgress as WorkflowProgress;
  const active = activeTransaction(request, progress);
  if (active.state.status === "finalized") {
    const workflowProgress = replaceStep(
      progress,
      Object.freeze({ ...active.state, status: "completed" }),
      Object.freeze([...progress.completedStepIds, active.step.id]),
    );
    return scheduleNextStep(checkpoint, {
      ...checkpoint.payload.memory,
      workflowProgress,
    }, legacyBitcoinMessageDigest);
  }
  const entry = plan.payload.transactionPlans.find(
    (candidate) => candidate.stepId === active.step.id,
  );
  if (entry === undefined || active.state.signatures === undefined) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow finalizing step is missing plan or signatures",
    );
  }
  // Match the single-transaction path: stage history is append-only, while only
  // the current stage's signatures are passed back to the keyless Engine.
  const finalizationStages = active.state.finalizationStages ?? [];
  const currentStage = finalizationStages.at(-1);
  const currentContinuation = currentStage?.continuation;
  const signatureStart = currentStage?.signatureStart ?? 0;
  const stageTasks = (active.state.signingTasks ?? entry.plan.payload.signingTasks).slice(signatureStart);
  const stageSignatures = active.state.signatures.slice(signatureStart);
  if (stageSignatures.length !== stageTasks.length || stageTasks.length === 0 ||
      stageTasks.some((task, index) => task.taskId !== stageSignatures[index]?.taskId)) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow finalization stage signatures do not match its continuation",
    );
  }
  const normalized = await normalizeStep(request, active.step, engine);
  if (normalized.requestHash !== entry.plan.payload.requestHash) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "workflow transaction request changed before finalization",
    );
  }
  const common = {
    request: normalized.request,
    requestHash: normalized.requestHash,
    snapshot: workflowSnapshotForStep(request, active.step.id, checkpoint.payload.memory),
    policy: policyForStep(checkpoint.payload.memory, active.step.id),
  };
  const result = (await invokeTransactionEngine(
    engine,
    "finalize",
    "finalizeParams",
    "finalizeResult",
    {
      version: "1.0",
      ...common,
      plan: entry.plan,
      binding: checkpoint.payload.memory.approvalBinding,
      approval: checkpoint.payload.memory.approvalReceipt,
      signatures: stageSignatures,
      ...(currentContinuation === undefined
        ? {}
        : { continuation: currentContinuation }),
    },
  )) as PendingFinalizeResult | {
    readonly bundle: SignedBundle;
    readonly validation: { readonly valid: boolean };
  };
  const approval = checkpoint.payload.memory.approvalReceipt as ApprovalReceipt;
  if ("status" in result) {
    if (transactionSteps(request).some(step => step.signingRoles !== undefined)) {
      const resolutions = checkpoint.payload.memory.accountResolutions as readonly { result: { accounts: readonly AccountIdentity[] } }[];
      assertTransactionRoleTasks(transactionRequestFor(request, active.step), resolutions.at(-1)!.result.accounts, result.signingRequests);
    }
    const continuation = result.continuation;
    if (
      continuation.requestHash !== normalized.requestHash ||
      continuation.planHash !== entry.plan.planHash ||
      continuation.bindingHash !==
        (checkpoint.payload.memory.approvalBinding as { readonly bindingHash: string }).bindingHash ||
      continuation.approvalId !== approval.approvalId ||
      continuation.stage <= (currentContinuation?.stage ?? 0) ||
      result.signingRequests.length === 0
    ) {
      return completeError(checkpoint, -32603, "Workflow continuation binding failed");
    }
    const validation = (await invokeTransactionEngine(
      engine,
      "validate",
      "validateParams",
      "validationResult",
      {
        version: "1.0",
        phase: "finalized",
        ...common,
        plan: entry.plan,
        binding: checkpoint.payload.memory.approvalBinding,
        approval,
        signatures: stageSignatures,
        pending: result,
        ...(currentContinuation === undefined
          ? {}
          : { continuation: currentContinuation }),
      },
    )) as { readonly valid: boolean };
    if (!validation.valid) {
      return completeError(
        checkpoint,
        -32603,
        "Workflow pending finalization validation failed",
      );
    }
    const workflowProgress = replaceStep(
      progress,
      Object.freeze({
        ...active.state,
        status: "signing",
        signingTasks: Object.freeze([
          ...(active.state.signingTasks ?? []),
          ...result.signingRequests,
        ]),
        signatures: active.state.signatures,
        finalizationStages: Object.freeze([
          ...finalizationStages,
          Object.freeze({ continuation, signatureStart: active.state.signatures.length }),
        ]),
      }),
    );
    const signingTasks = Object.freeze([
      ...((checkpoint.payload.memory.signingTasks ?? []) as readonly (SigningTask | CryptoTask)[]),
      ...result.signingRequests,
    ]);
    const revision = nextRevision(checkpoint);
    const calls = makeCalls(checkpoint, revision, [
      { operation: "clock.now", params: { version: "1.0" } },
    ]);
    const next = advance(checkpoint, {
      state: "signing",
      pendingCalls: calls,
      memory: { ...checkpoint.payload.memory, signingTasks, workflowProgress },
      data: {
        approvalReceipt: approval,
        signingTask: result.signingRequests[0],
      },
    });
    return waitingTransition(next);
  }
  if (
    !result.validation.valid ||
    result.bundle.chainId !== request.chainId ||
    result.bundle.from !== request.from ||
    result.bundle.requestHash !== normalized.requestHash ||
    result.bundle.approvalId !== approval.approvalId
  ) {
    return completeError(checkpoint, -32603, "Workflow transaction finalization failed");
  }
  const validation = (await invokeTransactionEngine(
    engine,
    "validate",
    "validateParams",
    "validationResult",
    {
      version: "1.0",
      phase: "finalized",
      ...common,
      plan: entry.plan,
      binding: checkpoint.payload.memory.approvalBinding,
      approval,
      signatures: stageSignatures,
      bundle: result.bundle,
      ...(currentContinuation === undefined
        ? {}
        : { continuation: currentContinuation }),
    },
  )) as { readonly valid: boolean };
  if (!validation.valid) {
    return completeError(checkpoint, -32603, "Workflow finalized transaction validation failed");
  }
  const workflowProgress = replaceStep(
    progress,
    Object.freeze({
      ...active.state,
      status: "finalized",
      finalizedBundle: result.bundle,
    }),
  );
  const next = advance(checkpoint, {
    state: "finalizing",
    pendingCalls: [],
    memory: { ...checkpoint.payload.memory, workflowProgress },
    data: { signatures: checkpoint.payload.memory.signatures },
  });
  return continueTransition(next);
}
