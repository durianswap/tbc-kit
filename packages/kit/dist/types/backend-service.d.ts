import { type TbcPreparedTransactionRequest, type TbcPreparedWorkflowRequest, type TbcWorkflowRequest } from "./prepared.js";
import type { KitSupportedIntent, KitTransactionEngine, KitTransactionRequest } from "./public-types.js";
import type { TbcSecureOperationContext } from "./reviewed-transaction-types.js";
import { type KitHostPortCall, type KitWalletAccount, type KitWalletNetwork, type KitWalletOptions } from "./wallet-runtime.js";
export type TbcBackendAuthorizationDecision = Readonly<{
    status: "approved";
    decisionId: string;
    approvedAt: string;
}> | Readonly<{
    status: "rejected";
    rejectedAt: string;
}>;
export interface TbcBackendAuthorizationRequest {
    /** Existing Core approval input with exact preview, binding, fee and expiry. */
    readonly approvalRequest: unknown;
    readonly call: KitHostPortCall;
}
export interface TbcBackendNetwork extends Pick<KitWalletNetwork, "resolveChainData" | "resolvePolicy">, Partial<Pick<KitWalletNetwork, "network" | "warmup" | "broadcastSubmit" | "broadcastSubmitBatch" | "broadcastReconcile" | "listBroadcastRecovery" | "recoverBroadcasts" | "readPoolMergeIndex" | "rememberFinalizedTransaction">> {
}
export interface CreateTbcBackendServiceOptions {
    /** Stable service identity; this is not an origin supplied by a remote caller. */
    readonly serviceId: string;
    readonly account: KitWalletAccount;
    readonly network: TbcBackendNetwork;
    readonly engine: KitTransactionEngine;
    /** Required only for sign/send execution. Preparation remains keyless. */
    readonly authorize?: (request: TbcBackendAuthorizationRequest) => Promise<TbcBackendAuthorizationDecision>;
    /** Opaque service-owned Signer. Private keys never enter Kit inputs. */
    readonly signer?: KitWalletOptions["signer"];
    /** Shared reviewed raw/associated capability, not a second transaction builder.
     * A factory receives the service-owned context; never use caller/page identity. */
    readonly reviewedTransaction?: NonNullable<KitWalletOptions["reviewedTransaction"]> | ((context: TbcBackendReviewContext) => NonNullable<KitWalletOptions["reviewedTransaction"]> | Promise<NonNullable<KitWalletOptions["reviewedTransaction"]>>);
    readonly clock?: KitWalletOptions["clock"];
    readonly randomBytes?: KitWalletOptions["randomBytes"];
}
export interface TbcBackendReviewContext extends TbcSecureOperationContext {
    readonly account: KitWalletAccount;
    /** False after close; authority-aware shared adapters should check this. */
    readonly isActive: () => boolean;
}
export type TbcBackendPreparedExecution = Readonly<{
    kind: "transaction";
    action: "sign" | "send";
    prepared: TbcPreparedTransactionRequest;
}> | Readonly<{
    kind: "workflow";
    action: "sign" | "send";
    prepared: TbcPreparedWorkflowRequest;
}>;
export interface TbcBackendService {
    readonly prepareTransaction: <TIntent extends KitSupportedIntent>(request: KitTransactionRequest<TIntent>) => Promise<TbcPreparedTransactionRequest<TIntent>>;
    readonly prepareWorkflow: (request: TbcWorkflowRequest) => Promise<TbcPreparedWorkflowRequest>;
    readonly executePrepared: (input: TbcBackendPreparedExecution) => Promise<unknown>;
    readonly listBroadcastRecovery: (limit?: number) => Promise<readonly unknown[]>;
    readonly recoverBroadcasts: (txids: readonly string[]) => Promise<unknown>;
    readonly close: () => void;
}
export declare class TbcBackendServiceError extends Error {
    readonly name = "TbcBackendServiceError";
    readonly code: number;
    readonly data?: unknown;
    constructor(code: number, message: string, data?: unknown);
}
/**
 * Thin service facade over the existing Prepared and Wallet/Core/Host paths.
 * Construction is keyless. Execution is unavailable until both an explicit
 * service authorization callback and an external Signer are injected.
 */
export declare function createTbcBackendService(options: CreateTbcBackendServiceOptions): TbcBackendService;
//# sourceMappingURL=backend-service.d.ts.map