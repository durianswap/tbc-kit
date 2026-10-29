export declare const TWS_HOST_ERROR_CODES: readonly ["HOST_NOT_IMPLEMENTED", "HOST_BUSY", "HOST_NOT_FOUND", "HOST_RELEASE_MISMATCH", "HOST_STORE_CONFLICT", "HOST_STORE_CORRUPT", "HOST_PORT_FAILURE", "HOST_AUTHORITY_FAILURE", "HOST_STEP_LIMIT", "HOST_INTERNAL"];
export type TwsHostErrorCode = (typeof TWS_HOST_ERROR_CODES)[number];
export interface TwsHostErrorMetadata {
    readonly operationId?: string;
    readonly callId?: string;
    readonly commitId?: string;
}
export declare class TwsHostError extends Error {
    readonly code: TwsHostErrorCode;
    readonly retryable: boolean;
    readonly metadata?: TwsHostErrorMetadata;
    constructor(code: TwsHostErrorCode, message: string, options?: {
        readonly retryable?: boolean;
        readonly metadata?: TwsHostErrorMetadata;
    });
}
//# sourceMappingURL=errors.d.ts.map