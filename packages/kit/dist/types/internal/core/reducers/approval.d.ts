import { type ApprovalBinding, type ApprovalReceipt } from "../bindings.js";
import type { OperationCheckpoint } from "../checkpoint.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
export type ApprovalDecision = Readonly<{
    readonly status: "approved";
    readonly receipt: ApprovalReceipt;
}> | Readonly<{
    readonly status: "rejected";
    readonly bindingHash: string;
    readonly rejectedAt: string;
}>;
export declare function prepareApproval(checkpoint: OperationCheckpoint, bindingValue: ApprovalBinding, preview: unknown): CoreTransition;
export declare function prepareApprovalWithMemory(checkpoint: OperationCheckpoint, bindingValue: ApprovalBinding, preview: unknown, additionalMemory: Readonly<Record<string, unknown>>, operationHashOverride?: string): CoreTransition;
export declare function reduceApprovalClock(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
export declare function readApprovalDecision(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): ApprovalDecision;
//# sourceMappingURL=approval.d.ts.map