import { type AccountIdentity, type CryptoTask, type ReviewedTransactionTask } from "./private-action-kernel.js";
import type { OperationCheckpoint } from "../checkpoint.js";
import { type LegacyBitcoinMessageDigest, type TransactionEngine } from "../engine.js";
import { type TransactionRoleRequest } from "../transaction-signing-roles.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
interface WorkflowRequest {
    readonly version: "1.0";
    readonly chainId: string;
    readonly from: string;
    readonly expiresAt?: string;
    readonly maxTotalFee?: string;
    readonly failureMode?: "atomic" | "continue-independent";
    readonly steps: readonly WorkflowStep[];
}
type WorkflowStep = TransactionStep | PreparedTransactionStep | ReviewedTransactionStep | MessageStep | CryptoStep | TypedDataStep;
interface TransactionStep {
    readonly id: string;
    readonly kind: "transaction";
    readonly dependsOn: readonly string[];
    readonly intent: Readonly<Record<string, unknown>>;
    readonly signingRoles?: TransactionRoleRequest["signingRoles"];
    readonly constraints?: Readonly<Record<string, unknown>>;
}
interface PreparedTransactionStep {
    readonly id: string;
    readonly kind: "preparedTransaction";
    readonly dependsOn: readonly string[];
    readonly intent: Readonly<Record<string, unknown>>;
    readonly signingRoles?: TransactionRoleRequest["signingRoles"];
    readonly proposal: Readonly<Record<string, unknown>>;
    readonly constraints?: Readonly<Record<string, unknown>>;
}
interface ReviewedTransactionStep {
    readonly signingRoles?: TransactionRoleRequest["signingRoles"];
    readonly id: string;
    readonly kind: "reviewedTransaction";
    readonly dependsOn: readonly string[];
    readonly request: Readonly<Record<string, unknown>>;
}
interface MessageStep {
    readonly id: string;
    readonly kind: "message";
    readonly dependsOn: readonly string[];
    readonly message: Readonly<{
        readonly encoding: "utf8" | "hex" | "base64";
        readonly data: string;
    }>;
    readonly bindings?: readonly {
        readonly target: string;
        readonly source: {
            readonly stepId: string;
            readonly output: string;
        };
    }[];
}
type CryptoStep = EncryptStep | DecryptStep;
interface EncryptStep {
    readonly id: string;
    readonly kind: "encrypt";
    readonly dependsOn: readonly string[];
    readonly algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
    readonly message: MessageStep["message"];
}
interface DecryptStep {
    readonly id: string;
    readonly kind: "decrypt";
    readonly dependsOn: readonly string[];
    readonly algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
    readonly ciphertext: string;
}
interface TypedDataStep {
    readonly id: string;
    readonly kind: "typedData";
    readonly dependsOn: readonly string[];
    readonly data: {
        readonly domain: Readonly<Record<string, unknown>>;
        readonly types: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
        readonly primaryType: string;
        readonly message: Readonly<Record<string, unknown>>;
    };
    readonly bindings: readonly {
        readonly target: string;
        readonly source: {
            readonly stepId: string;
            readonly output: string;
        };
    }[];
}
interface SigningTask {
    readonly taskId: string;
    readonly purpose: "transaction" | "message" | "typedData";
    readonly signatureEncoding: string;
    readonly digest: string;
    readonly accountId: string;
    readonly publicKey: string;
    readonly [key: string]: unknown;
}
interface ExecutionPlan {
    readonly payload: {
        readonly requestHash: string;
        readonly snapshotHash: string;
        readonly policyHash: string;
        readonly chainId: string;
        readonly accountId: string;
        readonly expiresAt: string;
        readonly transactions: readonly {
            readonly id: string;
            readonly role: string;
            readonly dependsOn: readonly string[];
            readonly unsignedTransaction: string;
            readonly fee: string;
            readonly [key: string]: unknown;
        }[];
        readonly signingTasks: readonly SigningTask[];
        readonly preview: {
            readonly assetFlows: readonly unknown[];
            readonly warnings: readonly string[];
            readonly [key: string]: unknown;
        };
    };
    readonly planHash: string;
}
interface WorkflowPlan {
    readonly payload: {
        readonly version: "1.0";
        readonly requestHash: string;
        readonly chainId: string;
        readonly accountId: string;
        readonly expiresAt: string;
        readonly failureMode: "atomic" | "continue-independent";
        readonly stepOrder: readonly string[];
        readonly transactionPlans: readonly {
            readonly stepId: string;
            readonly plan: ExecutionPlan;
        }[];
        readonly immediateSigningTasks: readonly {
            readonly stepId: string;
            readonly envelope?: Readonly<Record<string, unknown>>;
            readonly task: SigningTask;
        }[];
        readonly deferredSigningTasks: readonly DeferredSigningTask[];
        readonly legacyBitcoinMessageStepIds: readonly string[];
        readonly cryptoTasks: readonly CryptoTask[];
        readonly reviewedTransactionTasks: readonly ReviewedTransactionTask[];
        readonly maxTotalFee: string;
        readonly totalFee: string;
        readonly preview: Readonly<Record<string, unknown>>;
    };
    readonly workflowPlanHash: string;
}
interface DeferredSigningTask {
    readonly taskId: string;
    readonly source: {
        readonly stepId: string;
        readonly output: string;
    };
    readonly targetStepId: string;
    readonly target: string;
    readonly targetType: "bytes32" | "bytes32[]" | "json-string-array";
    readonly purpose: "message" | "typedData";
    readonly publicKey: string;
    readonly envelopeTemplate: Readonly<Record<string, unknown>>;
}
export declare function beginWorkflowResolution(checkpoint: OperationCheckpoint, account: AccountIdentity, memory: Readonly<Record<string, unknown>>, legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest): Promise<CoreTransition>;
export declare function reduceWorkflowResolvingResponse(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown, engine: TransactionEngine | undefined, legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest): Promise<CoreTransition>;
export declare function assertWorkflowApprovalArtifacts(checkpoint: OperationCheckpoint): {
    plan: WorkflowPlan;
    request: WorkflowRequest;
    account: AccountIdentity;
    binding: import("../bindings.js").ApprovalBinding;
};
export declare function reduceWorkflowPlanning(checkpoint: OperationCheckpoint): CoreTransition;
/** Reuses Core's approved dependency resolution at a private native boundary. */
export declare function assertWorkflowDeferredSigningTask(checkpoint: OperationCheckpoint, stepId: string, task: unknown, legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest): Promise<void>;
export declare function reduceWorkflowPortFailure(checkpoint: OperationCheckpoint, call: PortCall, portError: Readonly<{
    readonly name: string;
}>, legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest): Promise<CoreTransition>;
export declare function reduceWorkflowApproval(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown, engine: TransactionEngine | undefined, legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest): Promise<CoreTransition>;
export declare function reduceWorkflowCryptoResponse(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown, legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest): Promise<CoreTransition>;
export declare function reduceWorkflowReviewedTransactionResponse(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown, legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest): Promise<CoreTransition>;
export declare function reduceWorkflowSigningResponse(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown, legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest): Promise<CoreTransition>;
export declare function reduceWorkflowFinalizing(checkpoint: OperationCheckpoint, engine: TransactionEngine | undefined, legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest): Promise<CoreTransition>;
export {};
//# sourceMappingURL=workflows.d.ts.map