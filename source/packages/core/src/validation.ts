import { cryptoInputHasValidByteBudget } from "./crypto-input-budget.js";
import {
  validateSignReviewedTransactionRequest,
  validateEncryptRequest,
  validateDecryptRequest,
  validateApprovalBinding,
  validateApprovalPreview,
  validateApprovalReceipt,
  validateApprovalRequestParams,
  validateAccountsResolveResult,
  validateApprovalRequestResult,
  validateBroadcastReconcileResult,
  validateBroadcastSubmitResult,
  validateBroadcastSubmitBatchResult,
  validateCancelInput,
  validateChainDataResolveResult,
  validateChainDataResolveParams,
  validateClockNowResult,
  validateCommitAckInput,
  validateCoreTransition,
  validateEntropyRandomBytesResult,
  validateGetAccountParams,
  validateGetCapabilitiesParams,
  validateMessageRequest,
  validateNormalizeRequestParams,
  validateNormalizeRequestResult,
  validateOperationCheckpoint,
  validatePermissionStoreCommitResult,
  validatePermissionStoreLoadResult,
  validatePreparedTransactionRequest,
  validatePreparedWorkflowRequest,
  validatePolicyResolveResult,
  validatePlanParams,
  validatePlanResult,
  validatePortResponse,
  validateResumeInput,
  validateRequestPermissionsParams,
  validateSignerSignResult,
  validateCryptoExecuteResult,
  validateReviewedTransactionReviewResult,
  validateReviewedTransactionExecuteResult,
  validateSignedTransactionBundle,
  validateStartInput,
  validateSwitchChainParams,
  validateTransactionRequest,
  validateSubmittedTransactionBundle,
  validateTypedDataRequest,
  validateWorkflowRequest,
  validateValidateParams,
  validateValidationResult,
  validateFinalizeParams,
  validateFinalizeResult,
} from "./generated/validators.js";

export const TWS_VALIDATOR_NAMES = Object.freeze([
  "signReviewedTransactionRequest",
  "encryptRequest",
  "decryptRequest",
  "startInput",
  "resumeInput",
  "commitAckInput",
  "cancelInput",
  "operationCheckpoint",
  "portResponse",
  "coreTransition",
  "accountsResolveResult",
  "chainDataResolveResult",
  "chainDataResolveParams",
  "policyResolveResult",
  "permissionStoreLoadResult",
  "permissionStoreCommitResult",
  "approvalRequestResult",
  "signerSignResult",
  "cryptoExecuteResult",
  "reviewedTransactionReviewResult",
  "reviewedTransactionExecuteResult",
  "broadcastSubmitResult",
  "broadcastSubmitBatchResult",
  "broadcastReconcileResult",
  "clockNowResult",
  "entropyRandomBytesResult",
  "getAccountParams",
  "getCapabilitiesParams",
  "switchChainParams",
  "messageRequest",
  "typedDataRequest",
  "transactionRequest",
  "preparedTransactionRequest",
  "workflowRequest",
  "preparedWorkflowRequest",
  "requestPermissionsParams",
  "approvalBinding",
  "approvalPreview",
  "approvalRequestParams",
  "approvalReceipt",
  "normalizeRequestParams",
  "normalizeRequestResult",
  "planParams",
  "planResult",
  "validateParams",
  "validationResult",
  "finalizeParams",
  "finalizeResult",
  "signedTransactionBundle",
  "submittedTransactionBundle",
] as const);

export type TwsValidatorName = (typeof TWS_VALIDATOR_NAMES)[number];

export interface TwsValidationIssue {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message?: string;
}

interface GeneratedValidator {
  (value: unknown): boolean;
  errors?: readonly {
    instancePath?: string;
    schemaPath?: string;
    keyword?: string;
    message?: string;
  }[] | null;
}

const VALIDATORS: Readonly<Record<TwsValidatorName, GeneratedValidator>> =
  Object.freeze({
    startInput: validateStartInput,
    resumeInput: validateResumeInput,
    commitAckInput: validateCommitAckInput,
    cancelInput: validateCancelInput,
    operationCheckpoint: validateOperationCheckpoint,
    portResponse: validatePortResponse,
    coreTransition: validateCoreTransition,
    accountsResolveResult: validateAccountsResolveResult,
    chainDataResolveResult: validateChainDataResolveResult,
    chainDataResolveParams: validateChainDataResolveParams,
    policyResolveResult: validatePolicyResolveResult,
    permissionStoreLoadResult: validatePermissionStoreLoadResult,
    permissionStoreCommitResult: validatePermissionStoreCommitResult,
    approvalRequestResult: validateApprovalRequestResult,
    signerSignResult: validateSignerSignResult,
    cryptoExecuteResult: validateCryptoExecuteResult,
    reviewedTransactionReviewResult: validateReviewedTransactionReviewResult,
    reviewedTransactionExecuteResult: validateReviewedTransactionExecuteResult,
    broadcastSubmitResult: validateBroadcastSubmitResult,
    broadcastSubmitBatchResult: validateBroadcastSubmitBatchResult,
    broadcastReconcileResult: validateBroadcastReconcileResult,
    clockNowResult: validateClockNowResult,
    entropyRandomBytesResult: validateEntropyRandomBytesResult,
    getAccountParams: validateGetAccountParams,
    getCapabilitiesParams: validateGetCapabilitiesParams,
    switchChainParams: validateSwitchChainParams,
    messageRequest: validateMessageRequest,
    signReviewedTransactionRequest: validateSignReviewedTransactionRequest,
    encryptRequest: validateEncryptRequest,
    decryptRequest: validateDecryptRequest,
    typedDataRequest: validateTypedDataRequest,
    transactionRequest: validateTransactionRequest,
    preparedTransactionRequest: validatePreparedTransactionRequest,
    workflowRequest: validateWorkflowRequest,
    preparedWorkflowRequest: validatePreparedWorkflowRequest,
    requestPermissionsParams: validateRequestPermissionsParams,
    approvalBinding: validateApprovalBinding,
    approvalPreview: validateApprovalPreview,
    approvalRequestParams: validateApprovalRequestParams,
    approvalReceipt: validateApprovalReceipt,
    normalizeRequestParams: validateNormalizeRequestParams,
    normalizeRequestResult: validateNormalizeRequestResult,
    planParams: validatePlanParams,
    planResult: validatePlanResult,
    validateParams: validateValidateParams,
    validationResult: validateValidationResult,
    finalizeParams: validateFinalizeParams,
    finalizeResult: validateFinalizeResult,
    signedTransactionBundle: validateSignedTransactionBundle,
    submittedTransactionBundle: validateSubmittedTransactionBundle,
  });

const PORT_RESULTS: Readonly<Record<string, TwsValidatorName>> = Object.freeze({
  "accounts.resolve": "accountsResolveResult",
  "chainData.resolve": "chainDataResolveResult",
  "policy.resolve": "policyResolveResult",
  "permissionStore.load": "permissionStoreLoadResult",
  "permissionStore.commit": "permissionStoreCommitResult",
  "approval.request": "approvalRequestResult",
  "signer.sign": "signerSignResult",
  "crypto.execute": "cryptoExecuteResult",
  "reviewedTransaction.review": "reviewedTransactionReviewResult",
  "reviewedTransaction.execute": "reviewedTransactionExecuteResult",
  "broadcast.submit": "broadcastSubmitResult",
  "broadcast.submitBatch": "broadcastSubmitBatchResult",
  "broadcast.reconcile": "broadcastReconcileResult",
  "clock.now": "clockNowResult",
  "entropy.randomBytes": "entropyRandomBytesResult",
});

const METHOD_PARAMS: Readonly<Record<string, TwsValidatorName>> = Object.freeze({
  tbc_getAccount: "getAccountParams",
  tbc_getCapabilities: "getCapabilitiesParams",
  tbc_switchChain: "switchChainParams",
  tbc_signMessage: "messageRequest",
  tbc_signReviewedTransaction: "signReviewedTransactionRequest",
  tbc_encrypt: "encryptRequest",
  tbc_decrypt: "decryptRequest",
  tbc_signTypedData: "typedDataRequest",
  tbc_signTransaction: "transactionRequest",
  tbc_signPreparedTransaction: "preparedTransactionRequest",
  tbc_sendTransaction: "transactionRequest",
  tbc_sendPreparedTransaction: "preparedTransactionRequest",
  tbc_signWorkflow: "workflowRequest",
  tbc_signPreparedWorkflow: "preparedWorkflowRequest",
  tbc_sendWorkflow: "workflowRequest",
  tbc_sendPreparedWorkflow: "preparedWorkflowRequest",
  wallet_requestPermissions: "requestPermissionsParams",
});

function issuesFor(validator: GeneratedValidator): readonly TwsValidationIssue[] {
  return Object.freeze(
    (validator.errors ?? []).map((issue) =>
      Object.freeze({
        instancePath: issue.instancePath ?? "",
        schemaPath: issue.schemaPath ?? "",
        keyword: issue.keyword ?? "unknown",
        ...(issue.message === undefined ? {} : { message: issue.message }),
      }),
    ),
  );
}

export class TwsValidationError extends TypeError {
  readonly code = "TWS_SCHEMA_INVALID" as const;
  readonly validator: TwsValidatorName;
  readonly issues: readonly TwsValidationIssue[];

  constructor(
    validator: TwsValidatorName,
    issues: readonly TwsValidationIssue[],
  ) {
    super(`TWS value failed ${validator} validation`);
    this.name = "TwsValidationError";
    this.validator = validator;
    this.issues = issues;
  }
}

function getValidator(name: TwsValidatorName): GeneratedValidator {
  const validator = VALIDATORS[name];
  if (!validator) throw new TypeError(`unknown TWS validator: ${String(name)}`);
  return validator;
}

export function isValidTws(name: TwsValidatorName, value: unknown): boolean {
  return getValidator(name)(value) && cryptoInputHasValidByteBudget(name, value);
}

export function assertValidTws(
  name: TwsValidatorName,
  value: unknown,
): void {
  const validator = getValidator(name);
  if (!validator(value)) throw new TwsValidationError(name, issuesFor(validator));
  if (!cryptoInputHasValidByteBudget(name, value)) {
    throw new TwsValidationError(name, Object.freeze([Object.freeze({
      instancePath: "", schemaPath: "", keyword: "maxDecodedBytes",
      message: "new encryption plaintext must not exceed 65536 decoded bytes",
    })]));
  }
}

export function assertPortResult(operation: string, value: unknown): void {
  const validator = PORT_RESULTS[operation];
  if (!validator) throw new TypeError(`unknown TWS Port operation: ${operation}`);
  assertValidTws(validator, value);
}

export function assertTwsMethodParams(method: string, value: unknown): void {
  const validator = METHOD_PARAMS[method];
  if (!validator) throw new TypeError(`method has no parameter Schema: ${method}`);
  assertValidTws(validator, value);
}
