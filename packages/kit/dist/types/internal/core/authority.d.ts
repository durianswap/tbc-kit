export type AuthorityChangeReason = "SESSION_REVOKED" | "ORIGIN_CHANGED" | "NAVIGATION_CHANGED" | "CHAIN_CHANGED" | "ACCOUNT_CHANGED";
export type TwsAuthorityErrorCode = "AUTHORITY_INVALID" | "AUTHORITY_CHANGED" | "COMMIT_ACK_MISMATCH" | "COMMIT_AUTHORITY_MISMATCH";
export declare class TwsAuthorityError extends Error {
    readonly code: TwsAuthorityErrorCode;
    readonly reason?: AuthorityChangeReason;
    constructor(code: TwsAuthorityErrorCode, message: string, reason?: AuthorityChangeReason);
}
interface TrustedContextRecord {
    readonly sessionId: string;
    readonly transport: string;
    readonly origin: string;
    readonly topOrigin: string;
    readonly frame: string;
    readonly navigationId?: string;
    readonly createdAt: string;
}
export declare function validateAuthoritySnapshot(context: unknown, session: unknown): asserts context is TrustedContextRecord;
export declare function classifyAuthorityChange(expectedContextValue: unknown, expectedSessionValue: unknown, currentContextValue: unknown, currentSessionValue: unknown): AuthorityChangeReason | null;
export declare function assertAuthorityUnchanged(expectedContext: unknown, expectedSession: unknown, currentContext: unknown, currentSession: unknown): void;
export declare function assertProviderCommitAcknowledgment(mutationValue: unknown, acknowledgmentValue: unknown, currentSessionValue: unknown): void;
export {};
