import type { OperationCheckpoint } from "../checkpoint.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
interface PermissionScope {
    readonly origin: string;
    readonly chainId: string;
}
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
    readonly scope: PermissionScope;
    readonly result: {
        readonly revision: string;
        readonly permissions: readonly PermissionRecord[];
    };
}
interface RequestedCapability {
    readonly chains: readonly string[];
    readonly maxAccounts?: number;
}
type RequestedPermissions = readonly [
    Readonly<Record<string, RequestedCapability>>
];
export declare function beginPermissionRequest(checkpoint: OperationCheckpoint, loads: readonly PermissionLoadArtifact[]): CoreTransition;
export declare function reducePermissionResolution(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
export declare function planPermissionRequest(checkpoint: OperationCheckpoint, memory?: Readonly<Record<string, unknown>>): CoreTransition;
interface PermissionProposal {
    readonly payload: {
        readonly origin: string;
        readonly requested: RequestedPermissions;
        readonly changes: readonly unknown[];
        readonly createdAt: string;
        readonly expiresAt: string;
    };
    readonly permissionProposalHash: string;
}
export declare function assertPermissionApprovalArtifacts(checkpoint: OperationCheckpoint): PermissionProposal;
export declare function permissionCommitFromProposal(proposal: PermissionProposal): Readonly<{
    readonly params: Readonly<Record<string, unknown>>;
}>;
export declare function reducePermissionApproval(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
export declare function disconnectCommitFromLoads(checkpoint: OperationCheckpoint, loads: readonly PermissionLoadArtifact[]): Readonly<{
    readonly params: Readonly<Record<string, unknown>>;
}>;
export declare function beginDisconnect(checkpoint: OperationCheckpoint, loads: readonly PermissionLoadArtifact[]): CoreTransition;
export {};
