import type { OperationCheckpoint } from "../checkpoint.js";
import { type TransactionEngine } from "../engine.js";
import { TwsEngineError } from "../errors.js";
import { type PreparedInputDependency } from "../prepared-dependencies.js";
import type { CoreTransition } from "../transitions.js";
interface TransactionArtifacts {
    readonly request: unknown;
    readonly requestHash: string;
    readonly snapshot: unknown;
    readonly policy: unknown;
}
interface ExecutionPlan {
    readonly payload: {
        readonly requestHash: string;
        readonly snapshotHash: string;
        readonly policyHash: string;
        readonly chainId: string;
        readonly accountId: string;
        readonly expiresAt: string;
        readonly preview: unknown;
        readonly transactions?: readonly Readonly<{
            readonly id: string;
            readonly role: string;
            readonly dependsOn: readonly string[];
            readonly unsignedTransaction: string;
            readonly deferredInputs?: readonly PreparedInputDependency[];
            readonly fee: string;
        }>[];
    };
    readonly planHash: string;
}
interface PreparedRequestLike {
    readonly intent: unknown;
    readonly proposal: {
        readonly payload: {
            readonly engineProfile: string;
            readonly createdAt: string;
            readonly expiresAt: string;
            readonly intentHash: string;
            readonly transactions: readonly Readonly<Record<string, unknown>>[];
            readonly evidence: unknown;
            readonly estimatedTotalFee: string;
        };
        readonly proposalHash: string;
    };
}
export declare class PreparedProposalTimeError extends TwsEngineError {
    constructor();
}
export declare function preparedProposalTransactions(planned: NonNullable<ExecutionPlan["payload"]["transactions"]>): readonly Readonly<Record<string, unknown>>[];
export declare function assertPreparedProposalForPlan(prepared: PreparedRequestLike, snapshot: unknown, plan: ExecutionPlan): void;
declare function artifacts(checkpoint: OperationCheckpoint): TransactionArtifacts;
declare function validationParams(checkpoint: OperationCheckpoint, phase: "plan" | "pre-sign" | "finalized" | "pre-broadcast", additional?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
export declare function reducePlanning(checkpoint: OperationCheckpoint, engine: TransactionEngine | undefined): Promise<CoreTransition>;
export { artifacts as transactionArtifacts, validationParams as transactionValidationParams };
