import { createApprovalBinding } from "../bindings.js";
import type { OperationCheckpoint } from "../checkpoint.js";
import {
  invokeTransactionEngine,
  type TransactionEngine,
} from "../engine.js";
import { TwsEngineError } from "../errors.js";
import { hashCanonical } from "../hash.js";
import { hexToBytes } from "../encoding.js";
import { canonicalize } from "../canonical-json.js";
import { resolveTransactionSigningAccounts, assertTransactionRoleTasks, type TransactionRoleRequest, type TransactionRoleAccount } from "../transaction-signing-roles.js";
import { resolvePreparedInputDependencies, type PreparedInputDependency } from "../prepared-dependencies.js";
import type { CoreTransition } from "../transitions.js";
import { prepareApprovalWithMemory } from "./approval.js";
import {
  completeError,
  earliestExpiry,
  operationOf,
} from "./shared.js";

interface TransactionArtifacts {
  readonly request: unknown;
  readonly requestHash: string;
  readonly snapshot: unknown;
  readonly policy: unknown;
}

interface ExecutionPlan {
  readonly payload: {
    readonly requestHash: string;
    readonly snapshotHash: string;
    readonly policyHash: string;
    readonly chainId: string;
    readonly accountId: string;
    readonly expiresAt: string;
    readonly preview: unknown;
    readonly transactions?: readonly Readonly<{
      readonly id: string;
      readonly role: string;
      readonly dependsOn: readonly string[];
      readonly unsignedTransaction: string;
      readonly deferredInputs?: readonly PreparedInputDependency[];
      readonly fee: string;
    }>[];
  };
  readonly planHash: string;
}

function expectedProposalEvidence(snapshotValue: unknown): Readonly<Record<string, unknown>> {
  const snapshot = snapshotValue as {
    readonly payload: {
      readonly capturedAt: string;
      readonly parents: readonly Readonly<{ readonly txid: string; readonly rawTransaction: string }>[];
      readonly contracts: readonly Readonly<{
        readonly contractId: string;
        readonly family: string;
        readonly creationTxid?: string;
        readonly sourceTransactionId?: string;
        readonly standardId?: string;
        readonly protocolVersion?: string;
        readonly templateRevision?: string;
        readonly genesisOutpoint?: Readonly<{ readonly txid: string; readonly vout: number }>;
      }>[];
    };
  };
  return Object.freeze({
    observedAt: snapshot.payload.capturedAt,
    parentTransactions: Object.freeze(snapshot.payload.parents.map(({ txid, rawTransaction }) => Object.freeze({ txid, rawTransaction }))),
    contracts: Object.freeze(snapshot.payload.contracts.map((contract) => Object.freeze({
      contractId: contract.contractId,
      family: contract.family,
      sourceTransactionId: contract.sourceTransactionId ?? contract.creationTxid ?? contract.contractId,
      // New-standard fields are one schema-bound identity group. Historical
      // records keep their existing evidence shape (e.g. protocolVersion 4.0
      // alone must not be mistaken for the new Prepared contract profile).
      ...(contract.standardId === undefined ? {} : {
        standardId: contract.standardId,
        protocolVersion: contract.protocolVersion,
        templateRevision: contract.templateRevision,
        ...(contract.genesisOutpoint === undefined ? {} : {
          genesisOutpoint: Object.freeze({
            txid: contract.genesisOutpoint.txid,
            vout: contract.genesisOutpoint.vout,
          }),
        }),
      }),
    }))),
  });
}

function proposalEvidenceMatches(
  proposalValue: unknown,
  createdAt: string,
  snapshotValue: unknown,
): boolean {
  if (proposalValue === null || typeof proposalValue !== "object" || Array.isArray(proposalValue)) {
    return false;
  }
  const proposal = proposalValue as Readonly<Record<string, unknown>>;
  const expected = expectedProposalEvidence(snapshotValue);
  const observedAt = proposal.observedAt;
  const walletObservedAt = expected.observedAt;
  if (
    typeof observedAt !== "string" ||
    typeof walletObservedAt !== "string" ||
    observedAt !== createdAt
  ) {
    return false;
  }
  const { observedAt: _proposalObservedAt, ...proposalMaterial } = proposal;
  const { observedAt: _walletObservedAt, ...walletMaterial } = expected;
  return hashCanonical(proposalMaterial) === hashCanonical(walletMaterial);
}

interface PreparedRequestLike {
    readonly intent: unknown;
    readonly proposal: {
      readonly payload: {
        readonly engineProfile: string;
        readonly createdAt: string;
        readonly expiresAt: string;
        readonly intentHash: string;
        readonly transactions: readonly Readonly<Record<string, unknown>>[];
        readonly evidence: unknown;
        readonly estimatedTotalFee: string;
      };
      readonly proposalHash: string;
    };
}

// Internal request refusal, not a native Engine/transport integrity failure.
// Validate the proposal's own interval. Independent DApp/wallet clocks do not
// establish causal order. Wallet material is revalidated and effective expiry
// is the minimum of the proposal, wallet snapshot, policy, and execution plan.
export class PreparedProposalTimeError extends TwsEngineError {
  constructor() {
    super("ENGINE_ARTIFACT_MISMATCH", "PROPOSAL_STALE: prepared transaction proposal differs from the wallet-verified execution plan time window");
    this.name = "PreparedProposalTimeError";
  }
}

function deferredInputs(
  transaction: NonNullable<ExecutionPlan["payload"]["transactions"]>[number],
  knownIds: ReadonlySet<string>,
): readonly Readonly<{
  inputIndex: number;
  sourceTransactionId: string;
  sourceOutputIndex: number;
}>[] {
  // Same 2MiB structural budget as the Kit transaction decoder. Contract
  // families may impose smaller whole-transaction limits (NFT: 1MiB).
  if (transaction.unsignedTransaction.length > 2 * 2 * 1024 * 1024) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "prepared transaction exceeds byte budget");
  }
  const bytes = hexToBytes(transaction.unsignedTransaction);
  let offset = 0;
  const take = (length: number): Uint8Array => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) {
      throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "prepared transaction template is truncated");
    }
    const value = bytes.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const uint32 = (): number => {
    const value = take(4);
    return new DataView(value.buffer, value.byteOffset, 4).getUint32(0, true);
  };
  const uint64 = (): void => { take(8); };
  const compact = (): number => {
    const first = take(1)[0] as number;
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const value = take(2);
      const result = new DataView(value.buffer, value.byteOffset, 2).getUint16(0, true);
      if (result < 0xfd) throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "prepared transaction compact size is not canonical");
      return result;
    }
    if (first === 0xfe) {
      const result = uint32();
      if (result <= 0xffff) throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "prepared transaction compact size is not canonical");
      return result;
    }
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "prepared transaction compact size exceeds the safe parser limit");
  };
  if (uint32() !== 10) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "prepared transaction template has an unsupported version");
  }
  const count = compact();
  if (count < 1 || count > 10_000) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "prepared transaction template has an invalid input count");
  }
  const zeroInputs: { inputIndex: number; sourceOutputIndex: number }[] = [];
  for (let inputIndex = 0; inputIndex < count; inputIndex += 1) {
    const previous = take(32);
    const sourceOutputIndex = uint32();
    const scriptLength = compact();
    take(scriptLength);
    uint32();
    if (previous.every((byte) => byte === 0)) zeroInputs.push({ inputIndex, sourceOutputIndex });
  }
  const outputCount = compact();
  if (outputCount < 1 || outputCount > 10_000) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "prepared transaction template has an invalid output count");
  }
  for (let index = 0; index < outputCount; index += 1) {
    uint64();
    const scriptLength = compact();
    take(scriptLength);
  }
  uint32();
  if (offset !== bytes.length) {
    throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "prepared transaction template contains trailing bytes");
  }
  return resolvePreparedInputDependencies(zeroInputs, transaction.dependsOn, knownIds, transaction.deferredInputs);
}

export function preparedProposalTransactions(
  planned: NonNullable<ExecutionPlan["payload"]["transactions"]>,
): readonly Readonly<Record<string, unknown>>[] {
  const knownIds = new Set<string>();
  return Object.freeze(planned.map((transaction) => {
    const inputs = deferredInputs(transaction, knownIds);
    const common = {
      id: transaction.id,
      role: transaction.role,
      dependsOn: transaction.dependsOn,
      fee: transaction.fee,
    };
    knownIds.add(transaction.id);
    return inputs.length === 0
      ? Object.freeze({ ...common, kind: "fixed", unsignedTransaction: transaction.unsignedTransaction })
      : Object.freeze({
          ...common,
          kind: "deferred",
          unsignedTransactionTemplate: transaction.unsignedTransaction,
          deferredInputs: inputs,
        });
  }));
}

export function assertPreparedProposalForPlan(
  prepared: PreparedRequestLike,
  snapshot: unknown,
  plan: ExecutionPlan,
): void {
  if (prepared === undefined) return;
  const proposal = prepared.proposal;
  const planned = plan.payload.transactions ?? [];
  const expectedTransactions = preparedProposalTransactions(planned);
  const preview = plan.payload.preview as { readonly totalFee?: unknown };
  if (
    !Number.isFinite(Date.parse(proposal.payload.createdAt)) ||
    !Number.isFinite(Date.parse(proposal.payload.expiresAt)) ||
    Date.parse(proposal.payload.createdAt) > Date.parse(proposal.payload.expiresAt)
  ) throw new PreparedProposalTimeError();
  if (
    hashCanonical(proposal.payload) !== proposal.proposalHash ||
    proposal.payload.engineProfile !== "tbc-engine-plan-v1" ||
    proposal.payload.intentHash !== hashCanonical(prepared.intent) ||
    hashCanonical(proposal.payload.transactions) !== hashCanonical(expectedTransactions) ||
    !proposalEvidenceMatches(
      proposal.payload.evidence,
      proposal.payload.createdAt,
      snapshot,
    ) ||
    proposal.payload.estimatedTotalFee !== preview.totalFee
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "prepared transaction proposal differs from the wallet-verified execution plan",
    );
  }
}

function assertPreparedProposal(checkpoint: OperationCheckpoint, plan: ExecutionPlan): void {
  const prepared = checkpoint.payload.memory.preparedTransaction as PreparedRequestLike | undefined;
  if (prepared !== undefined) {
    assertPreparedProposalForPlan(prepared, checkpoint.payload.memory.chainSnapshot, plan);
  }
}

function isDeterministicInvalidRequest(error: unknown): boolean {
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return false;
  }
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return (
    candidate.name === "TbcEngineError" &&
    candidate.code === "INVALID_REQUEST"
  );
}

function artifacts(checkpoint: OperationCheckpoint): TransactionArtifacts {
  const normalized = checkpoint.payload.memory.normalizedTransaction as {
    readonly request: unknown;
    readonly requestHash: string;
  };
  return {
    request: normalized.request,
    requestHash: normalized.requestHash,
    snapshot: checkpoint.payload.memory.chainSnapshot,
    policy: checkpoint.payload.memory.executionPolicy,
  };
}

function validationParams(
  checkpoint: OperationCheckpoint,
  phase: "plan" | "pre-sign" | "finalized" | "pre-broadcast",
  additional: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const values = artifacts(checkpoint);
  return {
    version: "1.0",
    phase,
    ...values,
    plan: checkpoint.payload.memory.executionPlan,
    ...additional,
  };
}

function assertPlanBindings(
  checkpoint: OperationCheckpoint,
  plan: ExecutionPlan,
): void {
  const snapshot = checkpoint.payload.memory.chainSnapshot as {
    readonly snapshotHash: string;
  };
  const policy = checkpoint.payload.memory.executionPolicy as {
    readonly policyHash: string;
  };
  const request = (checkpoint.payload.memory.normalizedTransaction as {
    readonly request: { readonly chainId: string; readonly from: string };
  }).request;
  if (
    hashCanonical(plan.payload) !== plan.planHash ||
    plan.payload.requestHash !== checkpoint.payload.memory.requestHash ||
    plan.payload.snapshotHash !== snapshot.snapshotHash ||
    plan.payload.policyHash !== policy.policyHash ||
    plan.payload.chainId !== request.chainId ||
    plan.payload.accountId !== `${request.chainId}:${request.from}`
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "transaction plan hash or bound artifact changed",
    );
  }
}

export async function reducePlanning(
  checkpoint: OperationCheckpoint,
  engine: TransactionEngine | undefined,
): Promise<CoreTransition> {
  let plan = checkpoint.payload.memory.executionPlan as ExecutionPlan | undefined;
  if (plan === undefined) {
    const values = artifacts(checkpoint);
    let result: { readonly plan: ExecutionPlan };
    try {
      result = (await invokeTransactionEngine(
        engine,
        "plan",
        "planParams",
        "planResult",
        { version: "1.0", ...values },
      )) as { readonly plan: ExecutionPlan };
    } catch (error) {
      // An expected business refusal must complete this request, not escape
      // through the transport and disconnect the otherwise valid session.
      // Never forward the backend message (it may contain private material).
      if (error !== null && typeof error === "object" &&
          Reflect.get(error, "name") === "TbcEngineError" &&
          Reflect.get(error, "code") === "INSUFFICIENT_FUNDS") {
        return completeError(checkpoint, -32000, "Insufficient spendable funds for the transaction and fee",
          checkpoint.payload.memory, { name: "INSUFFICIENT_FUNDS", stage: "planning", retryable: false });
      }
      if (isDeterministicInvalidRequest(error)) {
        return completeError(
          checkpoint,
          -32602,
          "Transaction planning rejected the invalid request",
        );
      }
      throw error;
    }
    plan = result.plan;
  }

  // Planning is side-effect-free: do not return to Host merely to resume
  // validation of the plan we just computed. The next checkpoint is approval.
  assertPlanBindings(checkpoint, plan);
  const roleRequest = (checkpoint.payload.memory.normalizedTransaction as { readonly request: TransactionRoleRequest }).request;
  if (roleRequest.signingRoles !== undefined) {
    const resolutions = checkpoint.payload.memory.accountResolutions as readonly { readonly result: { readonly accounts: readonly TransactionRoleAccount[] } }[];
    const accounts = resolutions.at(-1)!.result.accounts;
    const payload = plan.payload as typeof plan.payload & { readonly signingTasks: readonly { readonly accountId: string; readonly publicKey: string }[] };
    const preview = payload.preview as { readonly signingRoles?: unknown };
    if (canonicalize(preview.signingRoles) !== canonicalize(resolveTransactionSigningAccounts(roleRequest, accounts).roles)) {
      throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "Plan review changed the trusted signing roles");
    }
    assertTransactionRoleTasks(roleRequest, accounts, payload.signingTasks);
  }
  try {
    assertPreparedProposal(checkpoint, plan);
  } catch (error) {
    if (error instanceof PreparedProposalTimeError) {
      return completeError(checkpoint, 4100, error.message);
    }
    throw error;
  }
  const validation = (await invokeTransactionEngine(
    engine,
    "validate",
    "validateParams",
    "validationResult",
    validationParams(checkpoint, "plan", { plan }),
  )) as { readonly valid: boolean };
  if (!validation.valid) {
    return completeError(checkpoint, -32603, "Transaction plan validation failed");
  }
  const operation = operationOf(checkpoint);
  const context = checkpoint.payload.context as {
    readonly sessionId: string;
    readonly origin: string;
  };
  const binding = createApprovalBinding({
    version: "1.0",
    method: operation.method,
    operationKind: "transaction",
    contextHash: checkpoint.payload.contextHash,
    origin: context.origin,
    sessionId: context.sessionId,
    chainId: plan.payload.chainId,
    accountId: plan.payload.accountId,
    requestHash: plan.payload.requestHash,
    operationHash: plan.planHash,
    expiresAt: earliestExpiry(
      checkpoint.payload.expiresAt,
      plan.payload.expiresAt,
    ),
  });
  return prepareApprovalWithMemory(checkpoint, binding, plan.payload.preview, {
    executionPlan: plan,
  });
}

export { artifacts as transactionArtifacts, validationParams as transactionValidationParams };
