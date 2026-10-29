import { type OperationCheckpoint } from "../checkpoint.js";
import { type PortCall } from "../ports.js";
import { type CoreTransition } from "../transitions.js";
export declare const TWS_CHAIN_IDS: readonly ["tbc:mainnet", "tbc:testnet"];
export interface ProviderSessionView {
    readonly state: {
        readonly connected: boolean;
        readonly activeChainId: string;
        readonly activeAccountIds: readonly string[];
    };
}
export interface TrustedContextView {
    readonly origin: string;
    readonly transport: "webview" | "extension" | "remote";
}
export declare function nextRevision(checkpoint: OperationCheckpoint): string;
export declare function earliestExpiry(...timestamps: readonly (string | undefined)[]): string;
export declare function makeCalls(checkpoint: OperationCheckpoint, revision: string, effects: readonly {
    readonly operation: string;
    readonly params: unknown;
}[]): readonly PortCall[];
export declare function advance(checkpoint: OperationCheckpoint, changes: Readonly<Record<string, unknown>>): OperationCheckpoint;
export declare function completeSuccess(checkpoint: OperationCheckpoint, result: unknown, memory?: Readonly<Record<string, unknown>>, events?: readonly Readonly<{
    readonly name: string;
    readonly payload: unknown;
}>[]): CoreTransition;
export declare function completeError(checkpoint: OperationCheckpoint, code: number, message: string, memory?: Readonly<Record<string, unknown>>, errorData?: Readonly<Record<string, unknown>>): CoreTransition;
export declare function operationOf(checkpoint: OperationCheckpoint): {
    readonly method: string;
    readonly params: unknown;
};
//# sourceMappingURL=shared.d.ts.map