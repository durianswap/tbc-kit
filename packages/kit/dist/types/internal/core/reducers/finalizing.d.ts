import type { OperationCheckpoint } from "../checkpoint.js";
import { type TransactionEngine } from "../engine.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
export declare function reduceFinalizingClock(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
export declare function reduceFinalizing(checkpoint: OperationCheckpoint, engine: TransactionEngine | undefined): Promise<CoreTransition>;
