import type { OperationCheckpoint } from "../checkpoint.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
export declare function reduceBroadcastClock(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
export declare function reduceWorkflowBatchResponse(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
export declare function reduceWorkflowBatchFailure(checkpoint: OperationCheckpoint, call: PortCall, errorValue: unknown): CoreTransition;
export declare function reduceBroadcastResponse(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
export declare function reduceAmbiguousBroadcast(checkpoint: OperationCheckpoint, call: PortCall, errorValue: unknown): CoreTransition;
export declare function reduceReconciliationResponse(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
//# sourceMappingURL=broadcasting.d.ts.map