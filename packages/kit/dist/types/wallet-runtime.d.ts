import { type CancelInput, type TwsCapabilityConfiguration } from "./internal/core/index.js";
import type { CommitAckInput, PortOperation, SchemaCoreTransition, StartInput } from "./internal/core/index.js";
import { type TwsHostOperationResult, type TwsHostOperationInspection } from "./internal/host/index.js";
import { type DefaultTbcNetworkOptions, type DefaultTbcTestnetNetworkOptions } from "./default-network.js";
import { type TbcNetworkContext } from "./network-context.js";
import { type TbcMultiRoundMergeApprovalDecision, type TbcMultiRoundMergeApprovalRequest, type TbcMultiRoundMergeAsset, type TbcMultiRoundMergeLimits, type TbcMultiRoundMergeProgress, type TbcMultiRoundMergeResult } from "./multi-round-merge.js";
import type { TbcKitBroadcastJournalRecord } from "./broadcast-journal.js";
import { type TbcNftMintJobScope, type TbcNftMintJobApproval, type TbcNftMintJobLimits, type TbcNftMintJobResult } from "./nft-mint-job.js";
import type { TbcNftMintJobMaterial } from "./nft-mint-job-material.js";
import type { PoolMergeIndex } from "./pool-material.js";
import { type LegacyKitFacade, type LegacyKitOptions } from "./legacy-mapper.js";
import type { StandardApprovalPreparationApproval, StandardApprovalPreparationHandle, StandardApprovalPreparationPresentation, StandardApprovalPreparationStart } from "./standard-approval-preparation.js";
import type { KitProvider, KitTransactionEngine } from "./public-types.js";
export { TBC_KIT_WALLET_INTENTS, TBC_KIT_UNIFIED_TEMPLATE_SUPPORT } from "./business-capabilities.js";
export type KitWalletCapabilityConfiguration = TwsCapabilityConfiguration;
export interface KitWalletAccount {
    readonly accountId: string;
    readonly address: string;
    readonly chainId: `tbc:${string}`;
    readonly publicKey: string;
}
export interface KitHostPortCall {
    readonly version: "1.0";
    readonly callId: string;
    readonly operation: PortOperation;
    readonly params: unknown;
    /** Wallet-selected lifecycle responsibility. DApp request data cannot set this. */
    readonly execution: Readonly<{
        readonly type: "session-only" | "durable";
    }>;
    /** Non-authorizing UI correlation, present only for the exact ready approval. */
    readonly approvalPreparation?: StandardApprovalPreparationApproval;
}
export type KitWalletAuthoritySnapshot = Readonly<{
    currentContext: StartInput["currentContext"];
    currentSession: StartInput["currentSession"];
}>;
export type KitWalletSessionMutation = Extract<SchemaCoreTransition, {
    readonly kind: "commit";
}>["mutation"];
export interface KitWalletSessionCommitRequest {
    readonly operationId: string;
    readonly commitId: string;
    readonly mutation: KitWalletSessionMutation;
    readonly expected: KitWalletAuthoritySnapshot;
}
export interface KitWalletSessionCommitResult {
    readonly acknowledgment: CommitAckInput["acknowledgment"];
    readonly authority: KitWalletAuthoritySnapshot;
}
/** Wallet-platform authority only. Never construct this from DApp request data. */
export interface KitWalletAuthoritySource {
    readonly read: () => Promise<KitWalletAuthoritySnapshot>;
    readonly compareAndSwapSession: (input: KitWalletSessionCommitRequest) => Promise<KitWalletSessionCommitResult>;
}
export interface KitWalletSignOnlyExecution {
    /**
     * One live-session Host store, normally from createTbcKitMemoryHostStore().
     * Kit routes every Core-declared pure-signing method here; callers do not
     * provide a method list and request params cannot select this store.
     */
    readonly hostStore: unknown;
}
export interface KitWalletSessionExecution {
    /**
     * One session-scoped memory Host store for all new wallet work, including
     * approval and signing evidence. It must not survive an app restart.
     */
    readonly hostStore: unknown;
}
type KitWalletSessionExecutionOptions = Readonly<{
    readonly execution?: KitWalletSessionExecution;
    /** @deprecated Use execution.hostStore. */
    readonly signOnly?: KitWalletSignOnlyExecution;
}>;
export type KitWalletSessionOptions = (Readonly<{
    authority?: undefined;
    origin?: string;
    sessionId?: string;
    requestIdFactory?: () => string | number;
}> | Readonly<{
    authority: KitWalletAuthoritySource;
    origin?: never;
    sessionId?: never;
    requestIdFactory?: () => string | number;
}>) & KitWalletSessionExecutionOptions;
export interface KitWalletOptions {
    /** Stable product metadata for discovery. This is not wallet authority or instance identity. */
    readonly productId?: string;
    readonly name?: string;
    readonly icon?: `data:${string}`;
    readonly profile?: string;
    /** Trusted wallet product declaration, scoped by chain and optionally exact account. */
    readonly capabilities?: KitWalletCapabilityConfiguration;
    readonly accounts: Readonly<{
        current: () => Promise<readonly KitWalletAccount[]>;
        /** Wallet-owned inventory for permission requests on a non-active chain. */
        forChain?: (chainId: `tbc:${string}`) => Promise<readonly KitWalletAccount[]>;
    }>;
    readonly approval: Readonly<{
        /** Declare only after formal and any early-consent UI show and bind these roles. */
        supportedSigningRoles?: readonly ("pool-controller" | "coin-admin")[];
        request: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
    }>;
    /** One native bounded consent for Kit-owned TBC/FT/Stablecoin/Pool multi-round maintenance. */
    readonly multiRoundMerge?: Readonly<{
        approve: (request: TbcMultiRoundMergeApprovalRequest) => Promise<TbcMultiRoundMergeApprovalDecision>;
        /** Issue the exact formal Core credential without presenting another UI. */
        authorizeStep: (input: Readonly<{
            scope: import("./multi-round-merge.js").TbcMultiRoundMergeScope;
            scopeHash: string;
            approval: Extract<TbcMultiRoundMergeApprovalDecision, {
                status: "approved";
            }>;
            params: unknown;
        }>, call: KitHostPortCall) => Promise<unknown>;
        waitForIndex?: (input: Readonly<{
            attempt: number;
            delayMs: number;
            txid: string;
        }>) => Promise<void>;
    }>;
    /** One bounded review for hundreds of NFTs; Kit owns slicing and execution. */
    readonly nftMintJob?: Readonly<{
        approve: (input: Readonly<{
            scope: TbcNftMintJobScope;
            scopeHash: string;
        }>) => Promise<TbcNftMintJobApproval>;
        /** Exact Core credential for a validated sub-batch, without another UI. */
        authorizeBatch: (input: Readonly<{
            scope: TbcNftMintJobScope;
            scopeHash: string;
            approval: Extract<TbcNftMintJobApproval, {
                status: "approved";
            }>;
            params: unknown;
        }>, call: KitHostPortCall) => Promise<unknown>;
    }>;
    /** Shared early-display/decision lifecycle for every current approval method. */
    readonly approvalPreparation?: StandardApprovalPreparationPresentation;
    readonly signer: Readonly<{
        sign: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
    }>;
    /** Optional account-bound BIE1 execution. Key material stays inside the wallet. */
    readonly crypto?: Readonly<{
        execute: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
    }>;
    /** Optional raw/associated review and approved execution boundary. */
    readonly reviewedTransaction?: Readonly<{
        review: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
        execute: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
    }>;
    readonly storage: Readonly<{
        /** @deprecated Audit/cancel access for historical durable Host rows only. */
        hostStore?: unknown;
        loadPermissions: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
        commitPermissions: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
    }>;
    readonly network: KitWalletNetwork | Readonly<{
        /** Wallet-owned network resources for the selected session chain. */
        forChain: (chainId: `tbc:${string}`) => KitWalletNetwork | Promise<KitWalletNetwork>;
    }> | Readonly<{
        defaultNetwork: Omit<DefaultTbcNetworkOptions, "accounts">;
    }> | Readonly<{
        defaultTestnet: Omit<DefaultTbcTestnetNetworkOptions, "accounts">;
    }>;
    readonly engine?: KitTransactionEngine;
    readonly legacy?: boolean | LegacyKitOptions;
    readonly clock?: (call?: KitHostPortCall) => string | Promise<string>;
    readonly randomBytes?: (length: number, call?: KitHostPortCall) => Uint8Array | Promise<Uint8Array>;
    /** Sanitized diagnostics only. Observer failures never alter wallet execution. */
    readonly onPerformance?: (event: KitWalletPerformanceEvent) => void;
}
export type KitWalletPerformanceStage = "port-call-snapshot" | "port-wallet-callback" | "port-result-snapshot";
export interface KitWalletPerformanceEvent {
    readonly component: "host-port";
    readonly stage: KitWalletPerformanceStage;
    readonly operation: PortOperation;
    readonly durationMs: number;
    readonly count: 1;
    /** UTF-8 canonical JSON bytes for snapshot stages; zero for callback timing. */
    readonly bytes: number;
}
export interface KitWalletNetwork {
    readonly network?: TbcNetworkContext;
    /** Wallet-startup warmup for immutable native capability metadata. */
    readonly warmup?: () => Promise<void>;
    /**
     * The optional account is a session-verified binding supplied by Kit. The
     * default network uses it to avoid rereading the account provider while
     * still validating the exact accountId in Chain Data.
     */
    readonly resolveChainData: (params: unknown, call?: KitHostPortCall, account?: KitWalletAccount) => Promise<unknown>;
    readonly resolvePolicy: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
    readonly prepareNftMintJob?: (scope: TbcNftMintJobScope, account: KitWalletAccount) => Promise<TbcNftMintJobMaterial>;
    readonly broadcastSubmit: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
    readonly broadcastSubmitBatch: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
    readonly broadcastReconcile: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
    readonly listBroadcastRecovery?: (limit?: number) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
    readonly recoverBroadcasts?: (txids: readonly string[]) => Promise<unknown>;
    /** Wallet-private authoritative Pool inventory; never exposed to a page. */
    readonly readPoolMergeIndex?: (input: Readonly<{
        address: string;
        poolContractId: string;
        kind: "pool-ft" | "ftlp";
    }>) => Promise<PoolMergeIndex>;
    /** Wallet-local immutable-byte reuse only; it must not retain confirmations. */
    readonly rememberFinalizedTransaction?: (transaction: Readonly<{
        txid: string;
        rawTransaction: string;
    }>) => void;
}
export type KitWalletRequest = Readonly<{
    id: string | number;
    method: string;
    params?: unknown;
}>;
export type KitWalletRequestPreparationDiagnostic = Readonly<{
    readonly status: "ready" | "discarded" | "miss";
    readonly stage: "lifecycle" | "authority" | "normalize" | "account" | "chain-data" | "binding";
    readonly category: "ready" | "cancelled" | "expired" | "superseded" | "request-mismatch" | "authority-changed" | "chain-data-unavailable" | "chain-data-conflict" | "chain-data-unauthorized" | "chain-data-invalid-input" | "unexpected";
}>;
export interface KitWalletRequestPreparation {
    /** Hash of the exact wallet-owned JSON-RPC request, including id and params. */
    readonly requestIdentity: string;
    /** Resolves without throwing; a miss always falls back to normal resolution. */
    readonly ready: Promise<"ready" | "discarded" | "miss">;
    /** Sanitized wallet-only outcome. It never contains URLs, material or raw errors. */
    readonly diagnostic: Promise<KitWalletRequestPreparationDiagnostic>;
    /** Wallet-owned rejection/navigation invalidation. Network I/O may finish but is never consumed. */
    readonly cancel: () => void;
}
export interface KitWalletSession {
    readonly provider: KitProvider;
    readonly legacy: LegacyKitFacade;
    readonly handleRequest: (request: KitWalletRequest) => Promise<Readonly<{
        deliveryId: string;
        response: unknown;
        events: readonly unknown[];
    }>>;
    /**
     * Wallet-trusted, memory-only read preparation. Call only after native review
     * is visible. It never enters Host/Core approval, signing, finalization, or
     * broadcast and is consumed only by an exact later handleRequest call.
     */
    readonly prefetchRequest: (request: KitWalletRequest) => KitWalletRequestPreparation;
    /** Starts the shared non-authorizing approval lifecycle. */
    readonly beginApprovalPreparation: (input: StandardApprovalPreparationStart) => StandardApprovalPreparationHandle;
    /**
     * Production TBC/FT bounded merge. Kit owns index reads, selection/planning,
     * exact formal bindings, execution and reconciliation.
     */
    readonly runMultiRoundMerge: (input: Readonly<{
        asset: TbcMultiRoundMergeAsset;
        limits: TbcMultiRoundMergeLimits;
        signal?: AbortSignal;
        onProgress?: (progress: TbcMultiRoundMergeProgress) => void;
    }>) => Promise<TbcMultiRoundMergeResult>;
    readonly runNftMintJob: (input: Readonly<{
        collectionId: string;
        items: readonly import("./public-types.js").Tbc721StandardMintItem[];
        limits: TbcNftMintJobLimits;
        signal?: AbortSignal;
    }>) => Promise<TbcNftMintJobResult>;
    /** Wallet-owned Legacy bridge only; never expose this method to page code. */
    readonly handleLegacyRequest: (request: Readonly<{
        id: string | number;
        method: "tbc_signMessage";
        params: unknown;
    }>) => Promise<Readonly<{
        deliveryId: string;
        response: unknown;
        events: readonly unknown[];
    }>>;
    /** Wallet-owned Legacy batch bridge into the standard one-approval workflow. Never expose to page code. */
    readonly handleLegacyWorkflowRequest: (request: Readonly<{
        id: string | number;
        method: "tbc_signWorkflow";
        params: unknown;
        approvalPreparation?: StandardApprovalPreparationHandle;
    }>) => Promise<Readonly<{
        deliveryId: string;
        response: unknown;
        events: readonly unknown[];
    }>>;
    /** Wallet-owned Legacy single-operation bridge. Never expose to page code. */
    readonly handleLegacyActionRequest: (request: Readonly<{
        id: string | number;
        method: "tbc_signReviewedTransaction" | "tbc_encrypt" | "tbc_decrypt";
        params: unknown;
        approvalPreparation?: StandardApprovalPreparationHandle;
    }>) => Promise<Readonly<{
        deliveryId: string;
        response: unknown;
        events: readonly unknown[];
    }>>;
    readonly cancelRequest: (requestId: string | number) => Promise<void>;
    /** Wallet-native resumable execution over the same Kit Core/Host composition. */
    readonly startOperation: (request: KitWalletRequest) => Promise<TwsHostOperationResult>;
    readonly resumeOperation: (operationId: string) => Promise<TwsHostOperationResult>;
    readonly inspectOperation: (operationId: string) => Promise<TwsHostOperationInspection>;
    readonly cancelOperation: (operationId: string, reason?: CancelInput["reason"]) => Promise<TwsHostOperationResult>;
    readonly recoverPending: (limit?: number) => Promise<readonly unknown[]>;
    /** @deprecated Durable Host operations are no longer restart-resumed. */
    readonly recoverPostSigner: (operationId: string) => Promise<unknown>;
    /** Lists only persisted submit-boundary identities; no transaction is resumed. */
    readonly listBroadcastRecovery: (limit?: number) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
    /** Explicit status-only recovery; unknown remains pending and is never POSTed. */
    readonly recoverBroadcasts: (txids: readonly string[]) => Promise<unknown>;
    /** Wallet-private historical-chain journal read; never exposed to a page. */
    readonly listBroadcastRecoveryForChain: (chainId: string, limit?: number) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
    /** Wallet-private status-only reconciliation for a configured chain; never POSTs. */
    readonly recoverBroadcastsForChain: (chainId: string, txids: readonly string[]) => Promise<unknown>;
    readonly close: () => void;
}
export interface KitWalletStandardDescriptor {
    readonly productId: string;
    readonly name: string;
    readonly icon: `data:${string}`;
    readonly accounts: readonly KitWalletAccount[];
    readonly provider: KitProvider;
}
export interface KitWalletRuntime {
    readonly openSession: (options?: KitWalletSessionOptions) => Promise<KitWalletSession>;
    /** Reuse an owned, live session opened with platform authority; never creates a hidden session. */
    readonly register: (session: KitWalletSession) => Promise<void>;
    readonly standardWallet: (session: KitWalletSession) => Promise<Readonly<KitWalletStandardDescriptor>>;
}
export declare function createTbcWallet(options: KitWalletOptions): KitWalletRuntime;
//# sourceMappingURL=wallet-runtime.d.ts.map