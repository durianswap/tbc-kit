import {
  assertStablecoinApprovalEvidence,
  assertWalletActionApprovalEvidence,
  createApprovalHostEvidenceReader,
  type ApprovalHostEvidenceStoreReader,
  type ApprovalHostRequestShape,
  type StablecoinApprovalEvidence,
  type WalletActionApprovalEvidence,
} from "../../dist/types/wallet.js";

interface MobileApprovalRequestParams extends ApprovalHostRequestShape {
  readonly version: "1.0";
  readonly binding: Readonly<{
    readonly bindingHash: string;
    readonly payload: Readonly<{
      readonly method: string;
      readonly chainId?: string;
    }>;
  }>;
  readonly preview: Readonly<{
    readonly operationKind: "message" | "permission" | "transaction" | "typedData";
  }>;
}

interface DifferentMobileHostCallRecord {
  readonly operation: "approval.request";
  readonly callId: string;
  readonly operationId: string;
  readonly permission: "tbc_signTypedData_v1" | "tbc_signTypedData";
  readonly call: Readonly<Record<string, unknown>>;
}

interface DifferentMobileHostOperationRecord {
  readonly operationId: string;
  readonly releaseFingerprint: string;
  readonly permission: "tbc_signTypedData_v1" | "tbc_signTypedData";
  readonly transition: Readonly<Record<string, unknown>>;
}

interface DifferentMobileHostEvidenceReader {
  readonly readCall: (
    callId: string,
  ) => Promise<DifferentMobileHostCallRecord | null>;
  readonly readOperation: (
    operationId: string,
  ) => Promise<DifferentMobileHostOperationRecord | null>;
}

declare const store: DifferentMobileHostEvidenceReader;
declare function assertMobileApprovalRequest(
  value: unknown,
): MobileApprovalRequestParams;

store satisfies ApprovalHostEvidenceStoreReader;

const reader = createApprovalHostEvidenceReader({
  store,
  releaseFingerprint: "dd".repeat(32),
  parseApprovalRequest: assertMobileApprovalRequest,
  createConflictError: (message) => new TypeError(message),
});

const evidence = reader.read("call", "aa".repeat(32));
evidence satisfies Promise<
  Readonly<{
    callId: string;
    operationId: string;
    releaseFingerprint: string;
    call: Readonly<Record<string, unknown>>;
    params: MobileApprovalRequestParams;
    operation: Readonly<Record<string, unknown>>;
    payload: Readonly<Record<string, unknown>>;
    memory: Readonly<Record<string, unknown>>;
  }>
>;
void evidence;

const walletActionEvidence = evidence.then(assertWalletActionApprovalEvidence);
walletActionEvidence satisfies Promise<WalletActionApprovalEvidence>;
void walletActionEvidence;

const stablecoinEvidence = evidence.then(assertStablecoinApprovalEvidence);
stablecoinEvidence satisfies Promise<StablecoinApprovalEvidence>;
void stablecoinEvidence;
