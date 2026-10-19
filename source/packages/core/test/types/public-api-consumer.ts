import type {
  CancelInput,
  CommitAckInput,
  FinalizeParams,
  FinalizeResult,
  AnyPortCall,
  ClockNowResult,
  NormalizeRequestParams,
  NormalizeRequestResult,
  PlanParams,
  PlanResult,
  ResumeInput,
  PortCall,
  PortOperation,
  PortResponse,
  SignerSignResult,
  SignerSignParams,
  StartInput,
  TransactionEngine,
  TwsCore,
  ValidateParams,
  ValidationResult,
} from "../../src/index.js";

declare const cancelInput: CancelInput;
declare const commitAckInput: CommitAckInput;
declare const finalizeParams: FinalizeParams;
declare const finalizeResult: FinalizeResult;
declare const normalizeRequestParams: NormalizeRequestParams;
declare const normalizeRequestResult: NormalizeRequestResult;
declare const planParams: PlanParams;
declare const planResult: PlanResult;
declare const resumeInput: ResumeInput;
declare const startInput: StartInput;
declare const validateParams: ValidateParams;
declare const validationResult: ValidationResult;
declare const signerSignParams: SignerSignParams;
declare const clockNowResult: ClockNowResult;

const values = [
  cancelInput,
  commitAckInput,
  finalizeParams,
  finalizeResult,
  normalizeRequestParams,
  normalizeRequestResult,
  planParams,
  planResult,
  resumeInput,
  startInput,
  validateParams,
  validationResult,
] as const;

if ("status" in finalizeResult) {
  finalizeResult.continuation.planHash;
  finalizeResult.signingRequests[0]?.taskId;
} else {
  finalizeResult.bundle.transactions;
  finalizeResult.validation.valid;
}

const signerResult: SignerSignResult = {
  taskId: "task-1",
  signatureEncoding: "compact64",
  signature: "00".repeat(64),
};

const invalidSignerResult: SignerSignResult = {
  taskId: "task-1",
  // @ts-expect-error TWS transaction signatures are compact64, never DER.
  signatureEncoding: "der",
  signature: "00".repeat(64),
};

void [values, signerResult, invalidSignerResult];

const portOperations = [
  "accounts.resolve",
  "chainData.resolve",
  "policy.resolve",
  "permissionStore.load",
  "permissionStore.commit",
  "approval.request",
  "signer.sign",
  "crypto.execute",
  "reviewedTransaction.review",
  "reviewedTransaction.execute",
  "broadcast.submit",
  "broadcast.reconcile",
  "clock.now",
  "entropy.randomBytes",
] as const satisfies readonly PortOperation[];

const portOperationCoverage = {
  "accounts.resolve": true,
  "chainData.resolve": true,
  "policy.resolve": true,
  "permissionStore.load": true,
  "permissionStore.commit": true,
  "approval.request": true,
  "signer.sign": true,
  "crypto.execute": true,
  "reviewedTransaction.review": true,
  "reviewedTransaction.execute": true,
  "broadcast.submit": true,
  "broadcast.submitBatch": true,
  "broadcast.reconcile": true,
  "clock.now": true,
  "entropy.randomBytes": true,
} as const satisfies Record<PortOperation, true>;

// @ts-expect-error Unknown operations cannot fall back to a string Port.
const unknownPort: PortOperation = "vault.read";

const signerCall: PortCall<"signer.sign"> = {
  version: "1.0",
  callId: "call-1",
  operation: "signer.sign",
  params: signerSignParams,
};
const anyCall: AnyPortCall = signerCall;
const signerResponse: PortResponse<"signer.sign"> = {
  version: "1.0",
  callId: signerCall.callId,
  result: signerResult,
};
const wrongSignerResponse: PortResponse<"signer.sign"> = {
  version: "1.0",
  callId: signerCall.callId,
  // @ts-expect-error A clock result cannot satisfy a signer response.
  result: clockNowResult,
};

const transactionEngine: TransactionEngine = {
  normalizeRequest: () => normalizeRequestResult,
  plan: () => planResult,
  validate: () => validationResult,
  finalize: () => finalizeResult,
};
const engineWithShortcut: TransactionEngine = {
  ...transactionEngine,
  // @ts-expect-error The public Engine facade must never expose execute.
  execute: () => finalizeResult,
};

declare const core: TwsCore;
void core.start(startInput);
void core.resume(resumeInput);
void core.acknowledgeCommit(commitAckInput);
void core.cancel(cancelInput);
// @ts-expect-error Core start requires the exact schema-derived StartInput.
void core.start({});

void [
  portOperations,
  portOperationCoverage,
  unknownPort,
  anyCall,
  signerResponse,
  wrongSignerResponse,
  transactionEngine,
  engineWithShortcut,
];
