import {
  assertWalletActionApprovalEvidence as assertCoreWalletActionApprovalEvidence,
  canonicalize,
  hashCanonical,
  hexToBytes,
  sha256Hex,
  utf8,
} from "@tbc-wallet/core";

import { parseTbcTransaction } from "./testnet-validation.js";

export type ApprovalHostEvidencePerformanceStage =
  | "call-read"
  | "call-clone"
  | "params-clone"
  | "operation-read"
  | "operation-clone";

export interface ApprovalHostEvidencePerformanceEvent {
  readonly component: "approval-host-evidence";
  readonly stage: ApprovalHostEvidencePerformanceStage;
  readonly durationMs: number;
  readonly count: 1;
  /** UTF-8 canonical JSON bytes for clone stages; zero for store reads. */
  readonly bytes: number;
}

export class ApprovalHostEvidenceConflictError extends Error {
  override readonly name = "ApprovalHostEvidenceConflictError";
}

export interface ApprovalHostRequestShape {
  readonly binding: Readonly<{ readonly bindingHash: string }>;
  readonly preview: unknown;
}

export interface ApprovalHostEvidenceEnvelope<
  Request extends ApprovalHostRequestShape,
> {
  readonly callId: string;
  readonly operationId: string;
  readonly releaseFingerprint: string;
  readonly call: Readonly<Record<string, unknown>>;
  readonly params: Request;
  readonly operation: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly memory: Readonly<Record<string, unknown>>;
}

export interface ApprovalHostEvidenceReader<
  Request extends ApprovalHostRequestShape,
> {
  readonly read: (
    callId: string,
    bindingHash: string,
  ) => Promise<ApprovalHostEvidenceEnvelope<Request>>;
}

export interface WalletActionApprovalHostRequest
  extends ApprovalHostRequestShape {
  readonly version: "1.0";
}

export type WalletActionApprovalTaskSummary =
  | Readonly<{
      readonly purpose: "reviewedTransaction";
      readonly taskId: string;
      readonly requestHash: string;
      readonly reviewHash: string;
    }>
  | Readonly<{
      readonly purpose: "encrypt" | "decrypt";
      readonly taskId: string;
      readonly algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
    }>;

export interface WalletActionApprovalEvidence {
  readonly kind: "reviewed-transaction" | "crypto";
  readonly method:
    | "tbc_signReviewedTransaction"
    | "tbc_encrypt"
    | "tbc_decrypt";
  readonly request: Readonly<Record<string, unknown>>;
  readonly requestHash: string;
  readonly contextHash: string;
  readonly origin: string;
  readonly chainId: string;
  readonly accountId: string;
  readonly from: string;
  readonly expiresAt: string;
  readonly planHash: string;
  readonly approvalBinding: Readonly<{
    readonly payload: Readonly<{
      readonly version: "1.0";
      readonly method: string;
      readonly operationKind: string;
      readonly contextHash: string;
      readonly origin: string;
      readonly sessionId: string;
      readonly chainId?: string;
      readonly chainIds?: readonly string[];
      readonly accountId?: string;
      readonly requestHash: string;
      readonly operationHash: string;
      readonly expiresAt: string;
    }>;
    readonly bindingHash: string;
  }>;
  readonly preview: Readonly<Record<string, unknown>>;
  readonly task: WalletActionApprovalTaskSummary;
}

export interface StablecoinApprovalHostRequest
  extends ApprovalHostRequestShape {
  readonly version: "1.0";
}

export interface StablecoinApprovalEvidence {
  readonly kind: "stablecoin";
  readonly operation: "transfer" | "merge";
  readonly requestHash: string;
  readonly planHash: string;
  readonly approvalBindingHash: string;
  readonly chainId: string;
  readonly accountId: string;
  readonly source: string;
  readonly recipient: string;
  readonly contractId: string;
  /** The contract genesis transaction. It is not the coinNFT contract id. */
  readonly creationTxid: string;
  readonly rawAmount: string;
  readonly assetInputCount: number;
  readonly feeAtomic: string;
  /** Every planned transaction input, in transaction then input order. */
  readonly inputOutpoints: readonly Readonly<{
    readonly txid: string;
    readonly vout: number;
  }>[];
  readonly transactionCount: number;
  readonly preview: Readonly<Record<string, unknown>>;
}

/**
 * Validates and projects stablecoin approval display data from the exact Host
 * checkpoint that requested approval. This is a pure, read-free boundary: it
 * neither refreshes chain material nor signs or persists anything.
 */
export function assertStablecoinApprovalEvidence(
  evidence: ApprovalHostEvidenceEnvelope<StablecoinApprovalHostRequest>,
): StablecoinApprovalEvidence {
  const conflict = (): never => {
    throw new ApprovalHostEvidenceConflictError(
      "Stablecoin approval evidence is invalid",
    );
  };
  const record = (value: unknown): Readonly<Record<string, unknown>> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return conflict();
    }
    return value as Readonly<Record<string, unknown>>;
  };
  const array = (value: unknown): readonly unknown[] =>
    Array.isArray(value) ? value : conflict();
  const string = (value: unknown): string =>
    typeof value === "string" && value.length > 0 ? value : conflict();
  const hash = (value: unknown): string => {
    const result = string(value);
    return /^[0-9a-f]{64}$/u.test(result) ? result : conflict();
  };
  const amount = (value: unknown): string => {
    const result = string(value);
    return /^(?:0|[1-9][0-9]*)$/u.test(result) ? result : conflict();
  };
  const integer = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : conflict();
  const freeze = <Value>(value: Value): Value => {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };

  try {
    if (evidence.params.version !== "1.0") conflict();
    const memory = record(evidence.memory);
    const normalized = record(memory.normalizedTransaction);
    const request = record(normalized.request);
    const intent = record(request.intent);
    const intentType = string(intent.type);
    const operation =
      intentType === "tbc.stablecoin.transfer"
        ? "transfer"
        : intentType === "tbc.stablecoin.merge"
          ? "merge"
          : conflict();
    const chainId = string(request.chainId);
    const source = string(request.from);
    const accountId = `${chainId}:${source}`;
    const contractId = hash(intent.contractId);
    const requestHash = hash(normalized.requestHash);
    if (
      hashCanonical(request) !== requestHash ||
      memory.requestHash !== requestHash
    ) {
      conflict();
    }

    const snapshot = record(memory.chainSnapshot);
    const snapshotPayload = record(snapshot.payload);
    const snapshotHash = hash(snapshot.snapshotHash);
    const account = record(snapshotPayload.account);
    if (
      hashCanonical(snapshotPayload) !== snapshotHash ||
      snapshotPayload.chainId !== chainId ||
      account.chainId !== chainId ||
      account.accountId !== accountId ||
      account.address !== source
    ) {
      conflict();
    }
    const publicKey = string(account.publicKey);
    const contracts = array(snapshotPayload.contracts).map(record);
    const matchingContracts = contracts.filter(
      (candidate) => candidate.contractId === contractId,
    );
    if (
      matchingContracts.length !== 1 ||
      matchingContracts[0]?.family !== "stablecoin"
    ) {
      conflict();
    }
    const contract = matchingContracts[0]!;
    const creationTxid = hash(contract.creationTxid);
    const currentOutpoint = record(contract.currentOutpoint);
    hash(currentOutpoint.txid);
    integer(currentOutpoint.vout);
    string(contract.protocolVersion);

    const policy = record(memory.executionPolicy);
    const policyPayload = record(policy.payload);
    const policyHash = hash(policy.policyHash);
    if (
      hashCanonical(policyPayload) !== policyHash ||
      policyPayload.chainId !== chainId ||
      policyPayload.sighashType !== 65
    ) {
      conflict();
    }

    const plan = record(memory.executionPlan);
    const planPayload = record(plan.payload);
    const planHash = hash(plan.planHash);
    if (
      hashCanonical(planPayload) !== planHash ||
      planPayload.requestHash !== requestHash ||
      planPayload.snapshotHash !== snapshotHash ||
      planPayload.policyHash !== policyHash ||
      planPayload.chainId !== chainId ||
      planPayload.accountId !== accountId
    ) {
      conflict();
    }

    const binding = record(memory.approvalBinding);
    const bindingPayload = record(binding.payload);
    const approvalBindingHash = hash(binding.bindingHash);
    const method = string(bindingPayload.method);
    if (
      hashCanonical(bindingPayload) !== approvalBindingHash ||
      ![
        "tbc_signTransaction",
        "tbc_signPreparedTransaction",
        "tbc_sendTransaction",
        "tbc_sendPreparedTransaction",
      ].includes(method) ||
      bindingPayload.operationKind !== "transaction" ||
      bindingPayload.requestHash !== requestHash ||
      bindingPayload.operationHash !== planHash ||
      bindingPayload.chainId !== chainId ||
      bindingPayload.accountId !== accountId ||
      canonicalize(binding) !== canonicalize(evidence.params.binding)
    ) {
      conflict();
    }

    const preview = record(planPayload.preview);
    if (
      preview.operationKind !== "transaction" ||
      preview.irreversible !== true ||
      canonicalize(preview) !== canonicalize(memory.approvalPreview) ||
      canonicalize(preview) !== canonicalize(evidence.params.preview)
    ) {
      conflict();
    }
    const transactions = array(planPayload.transactions).map(record);
    const transactionCount = integer(preview.transactionCount);
    if (
      transactions.length === 0 ||
      transactionCount !== transactions.length
    ) {
      conflict();
    }
    const transactionInputs = new Map<
      string,
      ReturnType<typeof parseTbcTransaction>["inputs"]
    >();
    const inputOutpoints: Readonly<{ txid: string; vout: number }>[] = [];
    let feeTotal = 0n;
    for (const transaction of transactions) {
      const id = string(transaction.id);
      if (transactionInputs.has(id)) conflict();
      const raw = string(transaction.unsignedTransaction);
      if (hash(transaction.templateHash) !== sha256Hex(hexToBytes(raw))) {
        conflict();
      }
      const inputs = parseTbcTransaction(raw).inputs;
      transactionInputs.set(id, inputs);
      inputOutpoints.push(
        ...inputs.map((input) =>
          Object.freeze({ txid: input.txid, vout: input.vout }),
        ),
      );
      feeTotal += BigInt(amount(transaction.fee));
      array(transaction.dependsOn).forEach(string);
      string(transaction.role);
    }
    const feeAtomic = amount(preview.totalFee);
    if (feeTotal !== BigInt(feeAtomic)) conflict();

    const signingTasks = array(planPayload.signingTasks).map(record);
    const signedInputs = new Set<string>();
    for (const task of signingTasks) {
      const templateId = string(task.transactionTemplateId);
      const inputIndex = integer(task.inputIndex);
      const inputs = transactionInputs.get(templateId);
      const key = `${templateId}:${inputIndex}`;
      if (
        inputs?.[inputIndex] === undefined ||
        signedInputs.has(key) ||
        task.purpose !== "transaction" ||
        task.algorithm !== "secp256k1-ecdsa-sha256d" ||
        task.signatureEncoding !== "compact64" ||
        task.sighashType !== 65 ||
        task.accountId !== accountId ||
        task.publicKey !== publicKey
      ) {
        conflict();
      }
      hash(task.digest);
      string(task.taskId);
      signedInputs.add(key);
    }
    const taskTransactionIds = new Set(
      signingTasks.map((task) => string(task.transactionTemplateId)),
    );
    if (signedInputs.size === 0) conflict();
    for (const templateId of taskTransactionIds) {
      const inputs = transactionInputs.get(templateId);
      if (
        inputs === undefined ||
        inputs.some((_input, inputIndex) =>
          !signedInputs.has(`${templateId}:${inputIndex}`),
        )
      ) {
        conflict();
      }
    }

    const utxos = array(snapshotPayload.utxos).map(record);
    const snapshotUtxos = new Map<string, Readonly<Record<string, unknown>>>();
    for (const utxo of utxos) {
      const txid = hash(utxo.txid);
      const vout = integer(utxo.vout);
      const key = `${txid}:${vout}`;
      if (snapshotUtxos.has(key)) conflict();
      snapshotUtxos.set(key, utxo);
    }
    const selected = new Map<string, Readonly<{ txid: string; vout: number }>>();
    for (const inputs of transactionInputs.values()) {
      for (const input of inputs) {
        const key = `${input.txid}:${input.vout}`;
        const utxo = snapshotUtxos.get(key);
        if (
          utxo?.classification === "stablecoin" &&
          utxo.contractId === contractId
        ) {
          selected.set(key, Object.freeze({ txid: input.txid, vout: input.vout }));
        }
      }
    }
    const availableAssets = utxos.filter(
      (utxo) =>
        utxo.classification === "stablecoin" && utxo.contractId === contractId,
    );
    if (
      selected.size === 0 ||
      selected.size !== availableAssets.length ||
      (operation === "merge" && selected.size < 2)
    ) {
      conflict();
    }

    const flows = array(preview.assetFlows).map(record);
    const assetFlows = flows.filter((flow) => flow.kind === "stablecoin");
    const feeFlows = flows.filter(
      (flow) => flow.kind === "native" && flow.direction === "fee",
    );
    if (
      assetFlows.length !== 1 ||
      feeFlows.length !== 1 ||
      amount(feeFlows[0]!.amount) !== feeAtomic ||
      feeFlows[0]!.from !== source
    ) {
      conflict();
    }
    const assetFlow = assetFlows[0]!;
    const rawAmount = amount(assetFlow.amount);
    const recipient = operation === "transfer" ? string(intent.to) : source;
    if (
      assetFlow.direction !== (operation === "transfer" ? "send" : "merge") ||
      assetFlow.from !== source ||
      assetFlow.to !== recipient ||
      (operation === "transfer" && amount(intent.amount) !== rawAmount)
    ) {
      conflict();
    }

    return freeze({
      kind: "stablecoin" as const,
      operation,
      requestHash,
      planHash,
      approvalBindingHash,
      chainId,
      accountId,
      source,
      recipient,
      contractId,
      creationTxid,
      rawAmount,
      assetInputCount: selected.size,
      feeAtomic,
      inputOutpoints: Object.freeze(inputOutpoints),
      transactionCount,
      preview: freeze(JSON.parse(canonicalize(preview))) as Readonly<
        Record<string, unknown>
      >,
    });
  } catch (error) {
    if (error instanceof ApprovalHostEvidenceConflictError) throw error;
    return conflict();
  }
}

/**
 * Validates and projects a wallet-action approval from one detached Host
 * evidence envelope. This function performs no I/O and cannot turn DApp/page
 * input into trusted authority. Pass only the result of the trusted wallet's
 * createApprovalHostEvidenceReader instance.
 */
export function assertWalletActionApprovalEvidence(
  evidence: ApprovalHostEvidenceEnvelope<WalletActionApprovalHostRequest>,
): WalletActionApprovalEvidence {
  try {
    const transition = (evidence.operation as {
      readonly transition?: unknown;
    }).transition as { readonly checkpoint?: unknown } | undefined;
    if (transition?.checkpoint === undefined) {
      throw new TypeError("wallet action Host checkpoint is unavailable");
    }
    return assertCoreWalletActionApprovalEvidence({
      checkpoint: transition.checkpoint,
      approvalCall: evidence.call,
      approvalRequest: evidence.params,
    });
  } catch {
    throw new ApprovalHostEvidenceConflictError(
      "Wallet action approval evidence is invalid",
    );
  }
}

/**
 * Minimal read-only structural boundary accepted from any Host release.
 * Runtime record identity and shape are verified inside this module.
 */
export interface ApprovalHostEvidenceStoreReader {
  readonly readCall: (callId: string) => Promise<unknown | null>;
  readonly readOperation: (operationId: string) => Promise<unknown | null>;
}

export interface ApprovalHostEvidenceReaderOptions<
  Request extends ApprovalHostRequestShape,
> {
  readonly store: ApprovalHostEvidenceStoreReader;
  /** Exact release fingerprint of the Host that owns `store`; no default. */
  readonly releaseFingerprint: string;
  readonly parseApprovalRequest: (value: unknown) => Request;
  /** Wallet-specific error identity; it cannot change conflict semantics. */
  readonly createConflictError?: (message: string) => Error;
  /** Sanitized diagnostics only. Observer failures never alter evidence reads. */
  readonly onPerformance?: (
    event: ApprovalHostEvidencePerformanceEvent,
  ) => void;
}

/**
 * Reads and verifies the generic authoritative Host envelope for one approval.
 * Operation-specific artifacts, material re-reads, display and policy remain
 * outside this reader and must consume the returned exact payload and memory.
 */
export function createApprovalHostEvidenceReader<
  Request extends ApprovalHostRequestShape,
>(
  options: ApprovalHostEvidenceReaderOptions<Request>,
): ApprovalHostEvidenceReader<Request> {
  const conflict = (message: string): never => {
    const error =
      options.createConflictError?.(message) ??
      new ApprovalHostEvidenceConflictError(message);
    throw error instanceof Error
      ? error
      : new ApprovalHostEvidenceConflictError(message);
  };
  const record = (
    value: unknown,
  ): Readonly<Record<string, unknown>> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      conflict("Host approval evidence is unavailable");
    }
    return value as Readonly<Record<string, unknown>>;
  };
  const deepFreeze = (value: unknown): unknown => {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };
  const performanceNow = (): number =>
    globalThis.performance?.now() ?? Date.now();
  const reportPerformance = (
    event: ApprovalHostEvidencePerformanceEvent,
  ): void => {
    try {
      options.onPerformance?.(Object.freeze(event));
    } catch {
      // Diagnostics cannot change evidence or conflict semantics.
    }
  };
  const cloneFrozen = <Value>(
    value: Value,
    message: string,
    stage: Extract<
      ApprovalHostEvidencePerformanceStage,
      "call-clone" | "params-clone" | "operation-clone"
    >,
  ): Value => {
    const startedAt =
      options.onPerformance === undefined ? undefined : performanceNow();
    try {
      const canonical = canonicalize(value);
      const result = deepFreeze(JSON.parse(canonical)) as Value;
      if (startedAt !== undefined) {
        reportPerformance({
          component: "approval-host-evidence",
          stage,
          durationMs: performanceNow() - startedAt,
          count: 1,
          bytes: utf8(canonical).length,
        });
      }
      return result;
    } catch {
      return conflict(message);
    }
  };
  if (!/^[0-9a-f]{64}$/u.test(options.releaseFingerprint)) {
    throw new TypeError("Invalid Host release fingerprint");
  }

  const read = async (
    callId: string,
    bindingHash: string,
  ): Promise<ApprovalHostEvidenceEnvelope<Request>> => {
    if (!/^[0-9a-f]{64}$/u.test(bindingHash)) {
      conflict("Approval binding hash is invalid");
    }
    let rawCallValue: Awaited<ReturnType<typeof options.store.readCall>> = null;
    const callReadStartedAt =
      options.onPerformance === undefined ? undefined : performanceNow();
    try {
      rawCallValue = await options.store.readCall(callId);
    } catch {
      conflict("Host approval evidence is unavailable");
    }
    if (callReadStartedAt !== undefined) {
      reportPerformance({
        component: "approval-host-evidence",
        stage: "call-read",
        durationMs: performanceNow() - callReadStartedAt,
        count: 1,
        bytes: 0,
      });
    }
    const callValue =
      rawCallValue === null
        ? null
        : cloneFrozen(
            rawCallValue,
            "Host approval evidence is unavailable",
            "call-clone",
          );
    const call = callValue === null ? null : record(callValue);
    const callEnvelope = call === null ? null : record(call.call);
    let params: Request | null = null;
    if (callEnvelope !== null) {
      try {
        params = cloneFrozen(
          options.parseApprovalRequest(callEnvelope.params),
          "Approval Host request is invalid",
          "params-clone",
        );
      } catch {
        conflict("Approval Host request is invalid");
      }
    }
    if (
      call === null ||
      callEnvelope === null ||
      call.operation !== "approval.request" ||
      call.callId !== callId ||
      params === null ||
      params.binding.bindingHash !== bindingHash
    ) {
      conflict("Approval Port call identity mismatch");
    }
    const authoritativeCall = call as Readonly<Record<string, unknown>>;
    const authoritativeEnvelope = callEnvelope as Readonly<
      Record<string, unknown>
    >;
    const approvalParams = params as Request;
    if (
      typeof authoritativeCall.operationId !== "string" ||
      authoritativeCall.operationId.length === 0
    ) {
      conflict("Approval Host operation is unavailable");
    }
    const operationId = authoritativeCall.operationId as string;
    let rawOperationValue: Awaited<
      ReturnType<typeof options.store.readOperation>
    > = null;
    const operationReadStartedAt =
      options.onPerformance === undefined ? undefined : performanceNow();
    try {
      rawOperationValue = await options.store.readOperation(operationId);
    } catch {
      conflict("Host approval evidence is unavailable");
    }
    if (operationReadStartedAt !== undefined) {
      reportPerformance({
        component: "approval-host-evidence",
        stage: "operation-read",
        durationMs: performanceNow() - operationReadStartedAt,
        count: 1,
        bytes: 0,
      });
    }
    const operationValue =
      rawOperationValue === null
        ? null
        : cloneFrozen(
            rawOperationValue,
            "Host approval evidence is unavailable",
            "operation-clone",
          );
    const operation = operationValue === null ? null : record(operationValue);
    const transition = operation === null ? null : record(operation.transition);
    const checkpoint =
      transition === null ? null : record(transition.checkpoint);
    const payload = checkpoint === null ? null : record(checkpoint.payload);
    if (
      operation === null ||
      operation.operationId !== authoritativeCall.operationId ||
      operation.releaseFingerprint !== options.releaseFingerprint ||
      payload === null ||
      payload.operationId !== authoritativeCall.operationId ||
      payload.releaseFingerprint !== options.releaseFingerprint ||
      payload.releaseFingerprint !== operation.releaseFingerprint
    ) {
      conflict("Approval Host operation is unavailable");
    }
    const authoritativePayload = payload as Readonly<Record<string, unknown>>;
    const pendingMatches =
      Array.isArray(authoritativePayload.pendingCalls) &&
      authoritativePayload.pendingCalls.some(
        (candidate) =>
          canonicalize(candidate) === canonicalize(authoritativeEnvelope),
      );
    if (authoritativePayload.state !== "approval" || !pendingMatches) {
      conflict("Approval Host checkpoint is not authoritative");
    }
    const memory = record(authoritativePayload.memory);
    if (
      canonicalize(memory.approvalBinding) !==
        canonicalize(approvalParams.binding) ||
      canonicalize(memory.approvalPreview) !==
        canonicalize(approvalParams.preview)
    ) {
      conflict("Approval Host checkpoint binding mismatch");
    }
    return Object.freeze({
      callId,
      operationId,
      releaseFingerprint: options.releaseFingerprint,
      call: authoritativeEnvelope,
      params: approvalParams,
      operation: operation as Readonly<Record<string, unknown>>,
      payload: authoritativePayload,
      memory,
    });
  };

  return Object.freeze({ read });
}
