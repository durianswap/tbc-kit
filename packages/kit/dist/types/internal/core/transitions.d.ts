import { type OperationCheckpoint } from "./checkpoint.js";
import type { AnyPortCall } from "./ports.js";
export declare const TWS_TRANSITION_KINDS: readonly ["continue", "waiting", "commit", "complete"];
export type TwsTransitionKind = (typeof TWS_TRANSITION_KINDS)[number];
export type CoreTransition = Readonly<{
    kind: "continue";
    checkpoint: OperationCheckpoint;
}> | Readonly<{
    kind: "waiting";
    checkpoint: OperationCheckpoint;
    calls: readonly AnyPortCall[];
}> | Readonly<{
    kind: "commit";
    checkpoint: OperationCheckpoint;
    mutation: Readonly<Record<string, unknown>>;
}> | Readonly<{
    kind: "complete";
    checkpoint: OperationCheckpoint;
    completion: Readonly<Record<string, unknown>>;
}>;
export declare function continueTransition(checkpoint: OperationCheckpoint): CoreTransition;
export declare function waitingTransition(checkpoint: OperationCheckpoint): CoreTransition;
export declare function commitTransition(checkpoint: OperationCheckpoint, mutation: Readonly<Record<string, unknown>>): CoreTransition;
export declare function completeTransition(checkpoint: OperationCheckpoint, completion: Readonly<Record<string, unknown>>): CoreTransition;
