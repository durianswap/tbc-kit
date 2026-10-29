export interface ApprovalBindingPayload {
    readonly version: "1.0";
    readonly method: string;
    readonly operationKind: string;
    readonly contextHash: string;
    readonly origin: string;
    readonly sessionId: string;
    readonly chainId?: string;
    readonly chainIds?: readonly string[];
    readonly accountId?: string;
    readonly requestHash: string;
    readonly operationHash: string;
    readonly expiresAt: string;
}
export interface ApprovalBinding {
    readonly payload: ApprovalBindingPayload;
    readonly bindingHash: string;
}
export interface ApprovalReceipt {
    readonly status: "approved";
    readonly approvalId: string;
    readonly approvalToken: string;
    readonly bindingHash: string;
    readonly approvedAt: string;
    readonly expiresAt: string;
}
export interface ApprovalRequester {
    readonly transport: "webview" | "extension" | "remote";
    readonly origin: string;
    readonly topOrigin: string;
    readonly frame: "top" | "child";
}
export declare function createApprovalBinding(payloadValue: ApprovalBindingPayload): ApprovalBinding;
export declare function assertApprovalBinding(bindingValue: ApprovalBinding, expectedPayload?: ApprovalBindingPayload): ApprovalBinding;
export declare function projectApprovalRequester(context: {
    readonly transport: ApprovalRequester["transport"];
    readonly origin: string;
    readonly topOrigin: string;
    readonly frame: ApprovalRequester["frame"];
}): ApprovalRequester;
export declare function createApprovalRequest(bindingValue: ApprovalBinding, previewValue: unknown, context: Parameters<typeof projectApprovalRequester>[0]): Readonly<Record<string, unknown>>;
export declare function assertApprovalRequest(requestValue: unknown, expectedValue: unknown): Readonly<Record<string, unknown>>;
export declare function assertApprovalReceipt(bindingValue: ApprovalBinding, receiptValue: ApprovalReceipt, trustedNow: string): ApprovalReceipt;
//# sourceMappingURL=bindings.d.ts.map