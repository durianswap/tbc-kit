import type { KitHostEvidenceReader } from "./sqlite.js";
import { type LegacyBatchRequestScope } from "./legacy-batch.js";
import type { TbcKitWebViewJsonRpcRequest, TbcKitWebViewVerifiedNavigation } from "./wallet-webview.js";
export declare class LegacyBatchConsentConflictError extends Error {
    readonly name = "LegacyBatchConsentConflictError";
}
export interface LegacyBatchReview {
    readonly batchId: string;
    readonly scopeHash: string;
    readonly messageTemplate: string;
    readonly singleRequest?: true;
}
export interface LegacyRequestBatchReview extends LegacyBatchRequestScope {
    readonly operationKind: "request-batch";
    readonly intentId: string;
    readonly verifiedOrigin: string;
    readonly chainId: string;
    readonly expiresAt: string;
    readonly batch: LegacyBatchReview;
}
export interface LegacyBatchConsentIntent {
    readonly intentId: string;
    readonly callId: string;
    readonly params: Readonly<{
        readonly binding: Readonly<{
            readonly bindingHash: string;
            readonly payload: Readonly<{
                readonly method: string;
                readonly requestHash: string;
                readonly contextHash: string;
                readonly origin: string;
                readonly sessionId: string;
                /** Optional on non-batch records returned by a general approval journal. */
                readonly chainId?: string;
                readonly accountId?: string;
            }>;
        }>;
        readonly preview: Readonly<{
            readonly operationKind: string;
            readonly transactionCount?: number;
            readonly totalFee?: string;
        }>;
    }>;
    readonly facts: Readonly<{
        readonly operationKind: string;
        readonly accountId?: string;
        readonly chainId?: string;
        readonly requestHash: string;
        readonly contextHash: string;
        readonly expiresAt: string;
    }>;
    readonly decision?: Readonly<{
        readonly status: "approved" | "rejected";
        readonly approvalId?: string;
    }>;
}
export interface LegacyBatchConsentJournal {
    readonly readIntent: (intentId: string) => Promise<LegacyBatchConsentIntent | null>;
}
export interface LegacyBatchConsentMachine {
    readonly requestApproval?: (navigation: TbcKitWebViewVerifiedNavigation, requestId: string, chainId: string, template: unknown, source: string | undefined, transaction: unknown, onVisible?: () => void) => Promise<boolean>;
    loadRequestReview(intentId: string): Promise<LegacyRequestBatchReview | undefined>;
    decideRequest(intentId: string, decision: "approved" | "rejected"): Promise<boolean>;
    authorizeRequest(intent: LegacyBatchConsentIntent): Promise<boolean>;
    prepare(navigation: TbcKitWebViewVerifiedNavigation, requestId: string, chainId: string, template: unknown): Promise<void>;
    register(navigation: TbcKitWebViewVerifiedNavigation, requestId: string, request: TbcKitWebViewJsonRpcRequest, ftDecimals?: number): Promise<void>;
    review(intent: LegacyBatchConsentIntent): Promise<LegacyBatchReview | undefined>;
    bindRoot(intent: LegacyBatchConsentIntent): Promise<void>;
    authorizeDependent(intent: LegacyBatchConsentIntent): Promise<boolean>;
    verifyDependency(intent: LegacyBatchConsentIntent): Promise<void>;
}
export interface LegacyBatchConsentMachineOptions {
    readonly store: Pick<KitHostEvidenceReader, "readCall" | "readOperation" | "readDelivery">;
    readonly journal: LegacyBatchConsentJournal;
    /** Must match the Host that owns `store`. */
    readonly releaseFingerprint?: string;
    readonly now?: () => number;
    readonly readAccount?: (navigation: TbcKitWebViewVerifiedNavigation) => Promise<string | null>;
    readonly presentRequest?: (intentId: string, onVisible?: () => void) => Promise<void>;
    /** Wallet-specific error identity; it cannot change conflict semantics. */
    readonly createConflictError?: (message: string) => Error;
}
/**
 * Session-only request-list consent state and dependency verification.
 * Authority, evidence, journal, clock, account and presentation stay injected.
 */
export declare function createLegacyBatchConsentMachine(options: LegacyBatchConsentMachineOptions): LegacyBatchConsentMachine;
//# sourceMappingURL=legacy-batch-consent.d.ts.map