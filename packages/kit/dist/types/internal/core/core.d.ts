import { type TwsCoreDependencies } from "./engine.js";
import type { CancelInput, CommitAckInput, ResumeInput, StartInput } from "./protocol-types.js";
import { type CoreTransition } from "./transitions.js";
export interface TwsCore {
    readonly start: (input: StartInput) => Promise<CoreTransition>;
    readonly resume: (input: ResumeInput) => Promise<CoreTransition>;
    readonly acknowledgeCommit: (input: CommitAckInput) => Promise<CoreTransition>;
    readonly cancel: (input: CancelInput) => Promise<CoreTransition>;
}
export declare function createTwsCore(dependencies?: TwsCoreDependencies): TwsCore;
//# sourceMappingURL=core.d.ts.map