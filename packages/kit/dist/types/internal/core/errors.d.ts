export type TwsCheckpointErrorCode = "RELEASE_MISMATCH" | "RELEASE_FINGERPRINT_MISMATCH" | "CONTEXT_HASH_MISMATCH" | "OPERATION_ID_MISMATCH" | "CALL_ID_MISMATCH" | "CHECKPOINT_HASH_MISMATCH" | "REVISION_NOT_MONOTONIC" | "PREDECESSOR_MISMATCH" | "CHECKPOINT_BASE_CHANGED" | "EXPIRY_EXTENDED" | "MEMORY_NOT_MONOTONIC";
export declare class TwsCheckpointError extends Error {
    readonly code: TwsCheckpointErrorCode;
    constructor(code: TwsCheckpointErrorCode, message: string);
}
export type TwsStateErrorCode = "PROTOCOL_RELEASE_MISMATCH" | "TERMINAL_STATE" | "STATE_MISMATCH" | "PORT_RESPONSE_NOT_PENDING" | "PORT_RESULT_INVALID" | "STATE_HANDLER_NOT_IMPLEMENTED" | "CANCEL_REASON_NOT_PROVEN";
export declare class TwsStateError extends Error {
    readonly code: TwsStateErrorCode;
    constructor(code: TwsStateErrorCode, message: string);
}
export type TwsMethodErrorCode = "UNSUPPORTED_METHOD" | "INVALID_METHOD_PARAMS";
export declare class TwsMethodError extends Error {
    readonly code: TwsMethodErrorCode;
    constructor(code: TwsMethodErrorCode, message: string);
}
export type TwsApprovalErrorCode = "APPROVAL_BINDING_INVALID" | "BINDING_HASH_MISMATCH" | "BINDING_EXPECTATION_MISMATCH" | "ACCOUNT_CHAIN_MISMATCH" | "CHAIN_IDS_NOT_SORTED" | "PREVIEW_MISMATCH" | "REQUESTER_CONTEXT_MISMATCH" | "APPROVAL_REQUEST_INVALID" | "RECEIPT_INVALID" | "RECEIPT_BINDING_MISMATCH" | "RECEIPT_EXPIRY_EXTENDED" | "RECEIPT_EXPIRED" | "RECEIPT_TIME_INVALID";
export declare class TwsApprovalError extends Error {
    readonly code: TwsApprovalErrorCode;
    constructor(code: TwsApprovalErrorCode, message: string);
}
export type TwsEngineErrorCode = "ENGINE_INTERFACE_INVALID" | "ENGINE_REQUIRED" | "ENGINE_INPUT_INVALID" | "ENGINE_RESULT_INVALID" | "ENGINE_ARTIFACT_MISMATCH";
export declare class TwsEngineError extends Error {
    readonly code: TwsEngineErrorCode;
    constructor(code: TwsEngineErrorCode, message: string);
}
