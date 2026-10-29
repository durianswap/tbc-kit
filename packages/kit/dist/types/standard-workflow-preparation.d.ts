export interface StandardWorkflowPreparationContext {
    readonly sessionId: string;
    readonly transport: "webview" | "extension" | "remote";
    readonly origin: string;
    readonly topOrigin: string;
    readonly frame: "top" | "child";
    readonly navigationId?: string;
    readonly createdAt: string;
}
export type StandardWorkflowPreparationOutcome = "complete" | "rejected" | "cancelled" | "failed" | "expired";
export type StandardWorkflowPreparationDecision = Readonly<{
    readonly status: "approved";
}> | Readonly<{
    readonly status: "rejected";
}>;
export interface StandardWorkflowPreparationStart {
    readonly requestId: string | number;
    readonly requestCount: number;
    /** Hash of the immutable input currently available to the caller. */
    readonly inputHash: string;
}
/**
 * Opaque, wallet-owned preparation identity. It cannot approve anything and is
 * accepted only by the session that created it.
 */
export interface StandardWorkflowPreparationHandle {
    readonly preparationId: string;
    readonly cancel: (outcome?: Extract<StandardWorkflowPreparationOutcome, "cancelled" | "failed">) => void;
}
export interface StandardWorkflowPreparationPresentation {
    readonly begin: (input: Readonly<{
        preparationId: string;
        requestCount: number;
        inputHash: string;
        startedAt: number;
        expiresAt: number;
        context: StandardWorkflowPreparationContext;
    }>) => void;
    /**
     * Optional one-click consent for a narrowly eligible canonical workflow.
     * The decision is not a Core approval receipt. Kit rechecks the exact later
     * approval binding and fee before exposing it to the wallet approval Port.
     */
    readonly review?: (input: Readonly<{
        preparationId: string;
        requestHash: string;
        chainId: string;
        accountId: string;
        feeCapAtomic: string;
        expiresAt: number;
        context: StandardWorkflowPreparationContext;
        workflow: unknown;
    }>) => Promise<StandardWorkflowPreparationDecision>;
    readonly finish?: (input: Readonly<{
        preparationId: string;
        outcome: StandardWorkflowPreparationOutcome;
    }>) => void;
}
/** Present only on the exact later approval Port call. */
export interface StandardWorkflowPreparationApproval {
    readonly preparationId: string;
    readonly requestHash: string;
    readonly startedAt: number;
    readonly state: "ready";
    readonly earlyConsent?: Readonly<{
        readonly status: "approved" | "rejected";
        readonly feeCapAtomic: string;
    }>;
}
//# sourceMappingURL=standard-workflow-preparation.d.ts.map