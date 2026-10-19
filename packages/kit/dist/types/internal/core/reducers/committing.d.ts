import type { OperationCheckpoint } from "../checkpoint.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
interface PermissionRecord {
    readonly id: string;
    readonly parentCapability: string;
    readonly invoker: string;
    readonly date: number;
    readonly caveats: readonly {
        readonly type: string;
        readonly value: unknown;
    }[];
}
interface PermissionLoadArtifact {
    readonly scope: {
        readonly origin: string;
        readonly chainId: string;
    };
    readonly result: {
        readonly revision: string;
        readonly permissions: readonly PermissionRecord[];
    };
}
interface ProviderSessionSnapshot {
    readonly scope: {
        readonly walletProfile: string;
        readonly sessionId: string;
    };
    readonly state: {
        readonly version: "1.0";
        readonly sessionId: string;
        readonly revision: string;
        readonly connected: boolean;
        readonly activeChainId: string;
        readonly activeAccountIds: readonly string[];
    };
}
interface ChainSwitchProposal {
    readonly payload: {
        readonly version: "1.0";
        readonly fromChainId: string;
        readonly toChainId: string;
        readonly expectedSessionRevision: string;
        readonly expiresAt: string;
    };
    readonly chainSwitchProposalHash: string;
}
interface ProviderSessionMutation {
    readonly payload: {
        readonly version: "1.0";
        readonly scope: ProviderSessionSnapshot["scope"];
        readonly expectedRevision: string;
        readonly target: ProviderSessionSnapshot["state"];
        readonly events: readonly {
            readonly name: string;
            readonly payload: unknown;
        }[];
    };
    readonly commitId: string;
}
export declare function assertChainSwitchApprovalArtifacts(checkpoint: OperationCheckpoint): ChainSwitchProposal;
export declare function beginChainSwitch(checkpoint: OperationCheckpoint, toChainId: string, loads: readonly PermissionLoadArtifact[], authorizedAccountIds: readonly string[]): CoreTransition;
export declare function reduceSwitchApproval(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
export declare function assertProviderSessionMutation(checkpoint: OperationCheckpoint): ProviderSessionMutation;
export declare function reduceCommitClock(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
export declare function reducePermissionCommit(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
export {};
