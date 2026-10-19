import type { OperationCheckpoint } from "../checkpoint.js";
import { type TransactionEngine } from "../engine.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
export declare function reduceTransactionApproval(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown, engine: TransactionEngine | undefined): Promise<CoreTransition>;
export declare function reduceSigningClock(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
export declare function reduceSigningResponse(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
