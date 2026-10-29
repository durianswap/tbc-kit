import type { TbcProviderEvent } from "./provider-transport.js";
import type { TbcReviewedTransactionInput, TbcWorkflowRequest } from "./prepared.js";
import type { KitSupportedIntent, KitTransactionRequest } from "./public-types.js";
import type { StandardApprovalPreparationHandle, StandardApprovalPreparationStart } from "./standard-approval-preparation.js";
type LegacyWorkflowDelivery = Readonly<{
    deliveryId: string;
    response: unknown;
    events: readonly unknown[];
}>;
export type LegacyStandardWorkflowContext = Readonly<{
    origin: string;
    chainId: string;
    sessionId: string;
    navigationId: string;
}>;
export interface LegacyStandardWorkflowBatchAdapter {
    /** Optional capability probe; omission means the adapter accepts all secure methods. */
    readonly supports?: (method: "signTransaction" | "signAssociatedTransaction" | "encrypt" | "decrypt" | "sendBatchRequest") => boolean;
    readonly execute: (input: Readonly<{
        requestId: string;
        requests: unknown;
        context: LegacyStandardWorkflowContext;
    }>) => Promise<Readonly<{
        deliveryId: string;
        results: readonly unknown[];
        events: readonly TbcProviderEvent[];
    }>>;
}
export interface LegacyStandardWorkflowBatchOptions {
    readonly chainId: string;
    /** Immutable trusted WebView/session binding for this adapter instance. */
    readonly context: LegacyStandardWorkflowContext;
    readonly readAccount: () => Promise<Readonly<{
        address: string;
        accountId: string;
    }>>;
    /** Shared Legacy transaction mapper only; execution remains inside the standard workflow. */
    readonly resolveSendTransaction: (input: Readonly<{
        params: unknown;
        chainId: string;
        from: string;
    }>) => Promise<KitTransactionRequest<KitSupportedIntent>>;
    /** Canonical shared lifecycle; Legacy only maps and forwards the opaque handle. */
    readonly beginApprovalPreparation?: (input: StandardApprovalPreparationStart) => StandardApprovalPreparationHandle;
    readonly executeWorkflow: (request: Readonly<{
        id: string | number;
        method: "tbc_signWorkflow";
        params: TbcWorkflowRequest;
        approvalPreparation?: StandardApprovalPreparationHandle;
    }>) => Promise<LegacyWorkflowDelivery>;
    /** Independent single-operation route; it must not synthesize a workflow. */
    readonly executeAction: (request: Readonly<{
        id: string | number;
        method: "tbc_signReviewedTransaction" | "tbc_encrypt" | "tbc_decrypt";
        params: unknown;
        approvalPreparation?: StandardApprovalPreparationHandle;
    }>) => Promise<LegacyWorkflowDelivery>;
}
export declare function mapLegacyRawTransactionToReviewed(input: unknown): TbcReviewedTransactionInput;
export declare function mapLegacyAssociatedTransactionToReviewed(input: unknown): TbcReviewedTransactionInput;
export declare function mapLegacyGenericBatchToWorkflow(input: unknown, options: LegacyStandardWorkflowBatchOptions): Promise<TbcWorkflowRequest>;
export declare function createLegacyStandardWorkflowBatchAdapter(options: LegacyStandardWorkflowBatchOptions): LegacyStandardWorkflowBatchAdapter;
export {};
//# sourceMappingURL=legacy-standard-workflow.d.ts.map