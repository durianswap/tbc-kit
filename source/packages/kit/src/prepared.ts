import {
  assertValidTws,
  canonicalize,
  hashCanonical,
  resolvePreparedInputDependencies,
  type PreparedInputDependency,
} from "@tbc-wallet/core";
import { preparedChainDataRequirement } from "./prepared-chain-data.js";
import type {
  KitSupportedIntent,
  KitTransactionEngine,
  KitTransactionRequest,
} from "./public-types.js";
import type { KitWalletNetwork } from "./wallet-runtime.js";
import { parseTbcUnsignedTemplate } from "./testnet-validation.js";

export type TbcPreparedProposalTransaction = Readonly<{
  id: string;
  role: string;
  dependsOn: readonly string[];
  fee: string;
}> & (
  | Readonly<{ kind: "fixed"; unsignedTransaction: string }>
  | Readonly<{
      kind: "deferred";
      unsignedTransactionTemplate: string;
      deferredInputs: readonly Readonly<{
        inputIndex: number;
        sourceTransactionId: string;
        sourceOutputIndex: number;
      }>[];
    }>
);

export interface TbcPreparedProposal {
  readonly payload: Readonly<{
    version: "1.0";
    engineProfile: "tbc-engine-plan-v1";
    createdAt: string;
    expiresAt: string;
    intentHash: string;
    transactions: readonly TbcPreparedProposalTransaction[];
    evidence: Readonly<{
      observedAt: string;
      parentTransactions: readonly Readonly<{ txid: string; rawTransaction: string }>[];
      contracts: readonly Readonly<{
        contractId: string;
        family: "collection" | "nft" | "ft" | "stablecoin" | "pool";
        sourceTransactionId: string;
        standardId?: "tbc20-standard" | "tbc721-standard" | "tbc20-stablecoin" | "tbc-amm";
        protocolVersion?: "tbc20" | "tbc721" | "coin" | "pool3";
        templateRevision?: "0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84" | "a97688ec62777b01e93c8486e0505b56701f48dc8cf7947637ece57fe88df104" | "c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3" | "c98ecae0a22452ce37bcaf24be0c836521d3de3a75aa8f16cef587b8b6f031b2" | "cf7f95c0483b56ad24825591acbce6e82e37890aa0047fc63183d3fb7a7a4ffc" | "a821abdb280268430ad7ea7a9421068a719a8e959b84c11265d4456e8d740db7" | "834610c0726fa0829c50aaa75c3a0b58c046105248f0b023257437a22f8aca22";
        /** Genesis Code output (contractId:0), not the Source OriginalUTXO. */
        genesisOutpoint?: Readonly<{ txid: string; vout: 0 }>;
      }>[];
    }>;
    estimatedTotalFee: string;
  }>;
  readonly proposalHash: string;
}

export interface TbcPreparedTransactionRequest<TIntent extends KitSupportedIntent = KitSupportedIntent>
  extends KitTransactionRequest<TIntent> {
  readonly proposal: TbcPreparedProposal;
}

export interface PrepareTbcTransactionOptions<TIntent extends KitSupportedIntent = KitSupportedIntent> {
  readonly request: KitTransactionRequest<TIntent>;
  readonly network: Pick<KitWalletNetwork, "resolveChainData" | "resolvePolicy">;
  /** Explicit opt-in to the transaction Engine subpath; the DApp root stays Engine-free. */
  readonly engine: KitTransactionEngine;
}

export interface TbcWorkflowTransactionStep<TIntent extends KitSupportedIntent = KitSupportedIntent> {
  readonly id: string;
  readonly kind: "transaction";
  readonly dependsOn: readonly string[];
  readonly intent: TIntent;
  readonly signingRoles?: KitTransactionRequest<TIntent>["signingRoles"];
  readonly constraints?: KitTransactionRequest<TIntent>["constraints"];
}

export interface TbcWorkflowTypedDataStep {
  readonly id: string;
  readonly kind: "typedData";
  readonly dependsOn: readonly string[];
  readonly data: Readonly<Record<string, unknown>>;
  readonly bindings: readonly Readonly<Record<string, unknown>>[];
}

export interface TbcWorkflowMessageStep {
  readonly id: string;
  readonly kind: "message";
  readonly dependsOn: readonly string[];
  readonly message: Readonly<{
    readonly encoding: "utf8" | "hex" | "base64";
    readonly data: string;
  }>;
  /** Deterministically inject transaction IDs from one reviewed predecessor into a UTF-8 JSON object. */
  readonly bindings?: readonly Readonly<{
    target: string;
    source: Readonly<{
      stepId: string;
      output: "transactionIds";
    }>;
  }>[];
}

export type TbcReviewedTransactionInput = Readonly<{
  payload:
    | Readonly<{
        format: "raw";
        transactions: readonly Readonly<{
          rawTransaction: string;
          inputs: readonly Readonly<{ satoshis: string; scriptPubKey: string }>[];
        }>[];
      }>
    | Readonly<{
        format: "associated";
        sourceTransaction: string;
        sourceInputs: readonly Readonly<Record<string, unknown>>[];
        children: readonly Readonly<{
          inputs: readonly Readonly<Record<string, unknown>>[];
          outputs: readonly Readonly<{ satoshis: string; scriptPubKey: string }>[];
        }>[];
      }>;
}>;

export interface TbcWorkflowReviewedTransactionStep {
  readonly id: string;
  readonly kind: "reviewedTransaction";
  readonly dependsOn: readonly string[];
  readonly request: TbcReviewedTransactionInput;
}

export type TbcMessageCryptoAlgorithm =
  "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";

export interface TbcWorkflowEncryptStep {
  readonly id: string;
  readonly kind: "encrypt";
  readonly dependsOn: readonly string[];
  readonly algorithm: TbcMessageCryptoAlgorithm;
  readonly message: TbcWorkflowMessageStep["message"];
}

export interface TbcWorkflowDecryptStep {
  readonly id: string;
  readonly kind: "decrypt";
  readonly dependsOn: readonly string[];
  readonly algorithm: TbcMessageCryptoAlgorithm;
  readonly ciphertext: string;
}

export type TbcWorkflowStep =
  | TbcWorkflowTransactionStep
  | TbcWorkflowReviewedTransactionStep
  | TbcWorkflowMessageStep
  | TbcWorkflowEncryptStep
  | TbcWorkflowDecryptStep
  | TbcWorkflowTypedDataStep;

export interface TbcWorkflowRequest {
  readonly version: "1.0";
  readonly chainId: `tbc:${string}`;
  readonly from: string;
  readonly clientRequestId?: string;
  readonly expiresAt?: string;
  readonly maxTotalFee?: string;
  /** Defaults to atomic. Independent continuation never bypasses the one bound approval. */
  readonly failureMode?: "atomic" | "continue-independent";
  readonly steps: readonly TbcWorkflowStep[];
}

export type TbcWorkflowComposition<
  TSteps extends readonly TbcWorkflowStep[] = readonly TbcWorkflowStep[],
> = Readonly<
  Omit<TbcWorkflowRequest, "version" | "chainId" | "from" | "steps"> &
  Readonly<{ readonly steps: TSteps }>
>;

export interface TbcPreparedWorkflowRequest extends Omit<TbcWorkflowRequest, "steps"> {
  readonly steps: readonly (
    | Readonly<Omit<TbcWorkflowTransactionStep, "kind"> & {
        kind: "preparedTransaction";
        proposal: TbcPreparedProposal;
      }>
    | TbcWorkflowReviewedTransactionStep
    | TbcWorkflowMessageStep
    | TbcWorkflowEncryptStep
    | TbcWorkflowDecryptStep
    | TbcWorkflowTypedDataStep
  )[];
}

export interface PrepareTbcWorkflowOptions {
  readonly request: TbcWorkflowRequest;
  readonly network: Pick<KitWalletNetwork, "resolveChainData" | "resolvePolicy">;
  /** Explicit opt-in to the transaction Engine subpath; the DApp root stays Engine-free. */
  readonly engine: KitTransactionEngine;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Builds the page-owned portion of a Standard workflow without creating a
 * second executor. Dependencies must point to an earlier step, which makes the
 * ordered result relationship explicit and rejects cycles before Provider I/O.
 */
export function composeTbcWorkflow<const TSteps extends readonly TbcWorkflowStep[]>(
  input: TbcWorkflowComposition<TSteps>,
): TbcWorkflowComposition<TSteps> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Invalid TBC workflow composition");
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || ![
    "clientRequestId",
    "expiresAt",
    "maxTotalFee",
    "failureMode",
    "steps",
  ].includes(key))) throw new TypeError("Invalid TBC workflow composition field");
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 5) {
    throw new TypeError("TBC workflow composition requires 1 to 5 steps");
  }
  const prior = new Set<string>();
  for (const step of input.steps) {
    if (
      step === null || typeof step !== "object" || Array.isArray(step) ||
      typeof step.id !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(step.id) ||
      prior.has(step.id) || !Array.isArray(step.dependsOn) ||
      new Set(step.dependsOn).size !== step.dependsOn.length ||
      step.dependsOn.some((dependency: unknown) => typeof dependency !== "string" || !prior.has(dependency))
    ) throw new TypeError("Invalid TBC workflow step dependency graph");
    prior.add(step.id);
  }
  const clone = JSON.parse(canonicalize(input)) as TbcWorkflowComposition<TSteps>;
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(clone);
  return clone;
}

interface NormalizedPreparation<TIntent extends KitSupportedIntent> {
  readonly request: KitTransactionRequest<TIntent>;
  readonly requestHash: string;
}
type PreparationSnapshot = Readonly<{
  readonly payload: Readonly<Record<string, unknown>>;
  readonly snapshotHash: string;
}>;

function rejectPreparationPortFailure(result: unknown, stage: "chain-data" | "policy"): void {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError(`Invalid TBC preparation ${stage} result`);
  }
  if (!("portError" in result)) return;
  const failure = result.portError as Readonly<{ name?: unknown; retryable?: unknown }> | null;
  if (failure === null || typeof failure !== "object" || Array.isArray(failure) ||
      typeof failure.name !== "string" || typeof failure.retryable !== "boolean" ||
      !["INVALID_INPUT", "UNAVAILABLE", "NOT_FOUND", "CONFLICT", "UNAUTHORIZED", "REJECTED",
        "SIGNATURE_FAILED", "BROADCAST_REJECTED", "INTERNAL_ERROR"].includes(failure.name)) {
    throw new TypeError(`Invalid TBC preparation ${stage} failure`);
  }
  // Preserve the Port category, never propagate arbitrary upstream messages,
  // details or causes. A retryable read failure does not trigger an auto-retry.
  throw Object.assign(new Error(`TBC preparation ${stage} failed: ${failure.name}`), {
    code: failure.name, retryable: failure.retryable, stage,
  });
}

async function normalizePreparation<TIntent extends KitSupportedIntent>(
  options: PrepareTbcTransactionOptions<TIntent>,
): Promise<NormalizedPreparation<TIntent>> {
  const normalized = await options.engine.normalizeRequest({ version: "1.0", request: options.request }) as NormalizedPreparation<TIntent>;
  if (hashCanonical(normalized.request) !== normalized.requestHash) throw new Error("Normalized request hash mismatch");
  if ((options.request.signingRoles !== undefined || normalized.request.signingRoles !== undefined) &&
      (normalized.request.from !== options.request.from || normalized.request.chainId !== options.request.chainId ||
       canonicalize(normalized.request.signingRoles ?? []) !== canonicalize(options.request.signingRoles ?? []))) {
    throw new Error("Normalized signing role selection changed");
  }
  return normalized;
}

async function readPreparationSnapshot(
  network: PrepareTbcTransactionOptions["network"],
  request: KitTransactionRequest<KitSupportedIntent>,
): Promise<PreparationSnapshot> {
  const snapshot = await network.resolveChainData({
    version: "1.0",
    chainId: request.chainId,
    accountId: `${request.chainId}:${request.from}`,
    requirement: preparedChainDataRequirement(request),
    ...(request.signingRoles === undefined ? {} : { signingRoles: request.signingRoles }),
  }) as PreparationSnapshot;
  rejectPreparationPortFailure(snapshot, "chain-data");
  if (hashCanonical(snapshot.payload) !== snapshot.snapshotHash) throw new Error("Chain snapshot hash mismatch");
  return snapshot;
}

/**
 * Builds a fixed or structurally deferred DApp proposal with the same Rust
 * Engine used by the wallet. Deferred inputs are parsed transaction inputs;
 * byte offsets and arbitrary template substitution are never accepted.
 */
export async function prepareTbcTransaction<TIntent extends KitSupportedIntent>(
  options: PrepareTbcTransactionOptions<TIntent>,
): Promise<TbcPreparedTransactionRequest<TIntent>> {
  const normalized = await normalizePreparation(options);
  const snapshot = await readPreparationSnapshot(options.network, normalized.request);
  return prepareWithSnapshot(options, normalized, snapshot);
}

async function prepareWithSnapshot<TIntent extends KitSupportedIntent>(
  options: PrepareTbcTransactionOptions<TIntent>,
  normalized: NormalizedPreparation<TIntent>,
  snapshot: PreparationSnapshot,
): Promise<TbcPreparedTransactionRequest<TIntent>> {
  const engine = options.engine;
  const request = normalized.request;
  const policy = await options.network.resolvePolicy({
    version: "1.0",
    requestHash: normalized.requestHash,
    request,
    snapshotHash: snapshot.snapshotHash,
  }) as Readonly<{ readonly payload: Readonly<Record<string, unknown>>; readonly policyHash: string }>;
  rejectPreparationPortFailure(policy, "policy");
  if (hashCanonical(policy.payload) !== policy.policyHash) throw new Error("Execution policy hash mismatch");
  const planned = await engine.plan({ version: "1.0", request, requestHash: normalized.requestHash, snapshot, policy }) as {
    readonly plan: Readonly<{
      readonly payload: Readonly<{
        readonly expiresAt: string;
        readonly transactions: readonly Readonly<{
          readonly id: string;
          readonly role: string;
          readonly dependsOn: readonly string[];
          readonly unsignedTransaction: string;
          readonly deferredInputs?: readonly PreparedInputDependency[];
          readonly fee: string;
        }>[];
        readonly preview: Readonly<{ readonly totalFee: string }>;
      }>;
      readonly planHash: string;
    }>;
  };
  if (hashCanonical(planned.plan.payload) !== planned.plan.planHash) throw new Error("Execution plan hash mismatch");
  const validation = await engine.validate({
    version: "1.0",
    phase: "plan",
    request,
    requestHash: normalized.requestHash,
    snapshot,
    policy,
    plan: planned.plan,
  }) as { readonly valid: boolean };
  if (!validation.valid) throw new Error("Prepared execution plan validation failed");

  const snapshotPayload = record(snapshot.payload, "snapshot payload") as Readonly<{
    capturedAt: string;
    parents: readonly Readonly<{ txid: string; rawTransaction: string }>[];
    contracts: readonly Readonly<Record<string, unknown>>[];
  }>;
  const knownIds = new Set<string>();
  const transactions = Object.freeze(planned.plan.payload.transactions.map((transaction) => {
    const common = Object.freeze({
      id: transaction.id,
      role: transaction.role,
      dependsOn: Object.freeze([...transaction.dependsOn]),
      fee: transaction.fee,
    });
    const zeroInputs = parseTbcUnsignedTemplate(transaction.unsignedTransaction).inputs
      .map((input, inputIndex) => ({ input, inputIndex }))
      .filter(({ input }) => input.txid === "0".repeat(64));
    const deferredInputs = resolvePreparedInputDependencies(zeroInputs.map(({ input, inputIndex }) => ({
      inputIndex, sourceOutputIndex: input.vout,
    })), transaction.dependsOn, knownIds, transaction.deferredInputs);
    knownIds.add(transaction.id);
    if (zeroInputs.length === 0) {
      return Object.freeze({
        ...common,
        kind: "fixed" as const,
        unsignedTransaction: transaction.unsignedTransaction,
      });
    }
    return Object.freeze({
      ...common,
      kind: "deferred" as const,
      unsignedTransactionTemplate: transaction.unsignedTransaction,
      deferredInputs,
    });
  }));
  const contracts = Object.freeze(snapshotPayload.contracts.map((value) => {
    const contract = record(value, "snapshot contract");
    const sourceTransactionId = contract.sourceTransactionId ?? contract.creationTxid ?? contract.contractId;
    if (
      typeof contract.contractId !== "string" ||
      !["collection", "nft", "ft", "stablecoin", "pool"].includes(String(contract.family)) ||
      typeof sourceTransactionId !== "string"
    ) throw new TypeError("Invalid snapshot contract evidence");
    return Object.freeze({
      contractId: contract.contractId,
      family: contract.family as "collection" | "nft" | "ft" | "stablecoin" | "pool",
      sourceTransactionId,
      // These are proposal evidence, never authority. Core compares the complete
      // tuple with its own snapshot; Engine independently verifies script identity.
      ...(contract.standardId === undefined ? {} : {
        standardId: contract.standardId,
        protocolVersion: contract.protocolVersion,
        templateRevision: contract.templateRevision,
        genesisOutpoint: Object.freeze({ ...record(contract.genesisOutpoint, "contract Genesis outpoint") }),
      }),
    });
  }));
  const payload = Object.freeze({
    version: "1.0" as const,
    engineProfile: "tbc-engine-plan-v1" as const,
    createdAt: snapshotPayload.capturedAt,
    expiresAt: planned.plan.payload.expiresAt,
    intentHash: hashCanonical(request.intent),
    transactions,
    evidence: Object.freeze({
      observedAt: snapshotPayload.capturedAt,
      parentTransactions: Object.freeze(snapshotPayload.parents.map(({ txid, rawTransaction }) => Object.freeze({ txid, rawTransaction }))),
      contracts,
    }),
    estimatedTotalFee: planned.plan.payload.preview.totalFee,
  });
  const prepared = Object.freeze({
    ...request,
    proposal: Object.freeze({ payload, proposalHash: hashCanonical(payload) }),
  }) as TbcPreparedTransactionRequest<TIntent>;
  assertValidTws("preparedTransactionRequest", prepared);
  return prepared;
}

/** Prepares every transaction step and preserves typed-data dependencies. */
export async function prepareTbcWorkflow(
  options: PrepareTbcWorkflowOptions,
): Promise<TbcPreparedWorkflowRequest> {
  // Freeze the caller's logical input by value before the first await. At most
  // five steps are permitted; this is read preparation, not parallel execution
  // of Host operations, signing, broadcast, or dependency resolution.
  const request = JSON.parse(canonicalize(options.request)) as TbcWorkflowRequest;
  assertValidTws("workflowRequest", request);
  const normalizedSteps = new Map<number, NormalizedPreparation<KitSupportedIntent>>();
  for (const [index, step] of request.steps.entries()) {
    if (step.kind !== "transaction") continue;
    const normalized = await normalizePreparation({
      request: {
        version: "1.0", chainId: request.chainId, from: request.from,
        intent: step.intent,
        ...(step.signingRoles === undefined ? {} : { signingRoles: step.signingRoles }),
        ...(step.constraints === undefined ? {} : { constraints: step.constraints }),
      },
      network: options.network, engine: options.engine,
    });
    normalizedSteps.set(index, normalized);
  }
  // Shared transport single-flight deduplicates identical in-flight reads.
  // Do not retain mutable spend-state across requests, nor parallelize Engine
  // calls (custom/native bridges may be strictly sequential). Drain failed
  // preparations before returning so no orphan read work outlives this call.
  const entries = [...normalizedSteps.entries()];
  const results = await Promise.allSettled(entries.map(([, normalized]) =>
    readPreparationSnapshot(options.network, normalized.request)));
  const snapshots = new Map<number, PreparationSnapshot>();
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") throw result.reason;
    snapshots.set(entries[index]![0], result.value);
  }
  const steps: TbcPreparedWorkflowRequest["steps"][number][] = [];
  const usedInputOutpoints = new Set<string>();
  for (const [index, step] of request.steps.entries()) {
    if (
      step.kind === "typedData" ||
      step.kind === "reviewedTransaction" ||
      step.kind === "message" ||
      step.kind === "encrypt" ||
      step.kind === "decrypt"
    ) {
      steps.push(step);
      continue;
    }
    const normalized = normalizedSteps.get(index)!;
    const prepared = await prepareWithSnapshot({
      request: normalized.request,
      network: options.network,
      engine: options.engine,
    }, normalized, snapshots.get(index)!);
    for (const transaction of prepared.proposal.payload.transactions) {
      const raw = transaction.kind === "fixed"
        ? transaction.unsignedTransaction
        : transaction.unsignedTransactionTemplate;
      for (const input of parseTbcUnsignedTemplate(raw).inputs) {
        if (input.txid === "0".repeat(64)) continue;
        const outpoint = `${input.txid}:${String(input.vout)}`;
        if (usedInputOutpoints.has(outpoint)) {
          throw new Error("Prepared workflow transaction steps select the same input outpoint");
        }
        usedInputOutpoints.add(outpoint);
      }
    }
    steps.push(Object.freeze({
      id: step.id,
      kind: "preparedTransaction" as const,
      dependsOn: Object.freeze([...step.dependsOn]),
      intent: step.intent,
      proposal: prepared.proposal,
      ...(step.signingRoles === undefined ? {} : { signingRoles: Object.freeze(
        step.signingRoles.map(role => Object.freeze({ ...role })),
      ) }),
      ...(step.constraints === undefined ? {} : { constraints: step.constraints }),
    }));
  }
  const prepared = Object.freeze({
    ...request,
    steps: Object.freeze(steps),
  }) as TbcPreparedWorkflowRequest;
  assertValidTws("preparedWorkflowRequest", prepared);
  return prepared;
}
