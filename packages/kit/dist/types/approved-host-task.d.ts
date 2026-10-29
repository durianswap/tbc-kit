import { type LegacyBitcoinMessageDigest } from "./internal/core/index.js";
import type { ApprovalHostEvidenceStoreReader } from "./approval-host-evidence.js";
/**
 * Reads the current private Host call, never a page-supplied task or checkpoint.
 * Core remains the transaction/workflow verifier. Platform adapters use this
 * projection to bind a Vault one-shot token to the active workflow step as well
 * as the task ID (task IDs may repeat across different transaction steps).
 * It adds no chain read, signing, storage write or broadcast.
 */
export declare function createApprovedHostTaskReader(options: Readonly<{
    store: ApprovalHostEvidenceStoreReader;
    releaseFingerprint: string;
    /** Same host-owned digest authority used by Core, never supplied by the page. */
    legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest;
}>): Readonly<{
    read: (callId: string, params: unknown) => Promise<Readonly<{
        version: "1.0";
        operationId: string;
        callId: string;
        bindingHash: string;
        task: Readonly<Record<string, unknown>>;
    }> | Readonly<{
        version: string;
        operationId: string;
        callId: string;
        workflowPlanHash: string;
        bindingHash: string;
        stepId: unknown;
        task: Readonly<Record<string, unknown>>;
    }> | undefined>;
    readReviewed(callId: string, params: unknown): Promise<Readonly<{
        version: "1.0";
        operationId: string;
        callId: string;
        bindingHash: string;
        task: Readonly<Record<string, unknown>>;
    }> | Readonly<{
        version: string;
        operationId: string;
        callId: string;
        workflowPlanHash: string;
        bindingHash: string;
        stepId: unknown;
        task: Readonly<Record<string, unknown>>;
    }>>;
}>;
//# sourceMappingURL=approved-host-task.d.ts.map