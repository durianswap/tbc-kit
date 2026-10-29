import type { CollectionCreateIntent, NftMintIntent, NftTransferIntent, Tbc721StandardCollectionIntent, Tbc721StandardMintIntent, Tbc721StandardBatchMintIntent, Tbc721TransferIntent, Tbc721BatchTransferIntent, FtCreateIntent, FtMergeIntent, FtTransferIntent, Tbc20StandardCreateIntent, Tbc20StandardTransferIntent, Tbc20StandardMergeIntent, Tbc20TransferIntent, Tbc20MergeIntent, Tbc20StablecoinTransferIntent, Tbc20StablecoinMergeIntent, AmmCreateIntent, UnifiedAmmAddLiquidityIntent, UnifiedAmmRemoveLiquidityIntent, UnifiedAmmSwapIntent, UnifiedLpTransferIntent, UnifiedLpLockIntent, UnifiedPoolMaintenanceIntent, LpTransferIntent, LpLockIntent, LpMaintenanceIntent, TimelockLockIntent, LopCreateIntent, LopCancelIntent, LopMatchIntent, HtlcLockIntent, HtlcTokenTarget, CoinTransferIntent, CoinMergeIntent, CoinCreateIntent, CoinMintIntent, CoinFreezeIntent, CoinUnfreezeIntent, StablecoinMergeIntent, StablecoinTransferIntent, KitRequestOptions, KitExpiringTransactionConstraints, KitProvider, KitSupportedIntent, KitTransactionConstraints, KitTransactionRequest, KitWalletCatalogEntry, KitWalletDescriptor, KitWalletOption, PoolCreateIntent, PoolFtlpBurnIntent, PoolLiquidityIntent, PoolMergeIntent, PoolSwapIntent, TbcTransferIntent } from "./public-types.js";
import type { TbcPreparedProposal, TbcPreparedWorkflowRequest, TbcReviewedTransactionInput, TbcWorkflowComposition, TbcWorkflowStep } from "./prepared.js";
import { type TimelockReader } from "./timelock-query.js";
import { type Tbc721Reader, type CreateTbc721ReaderOptions } from "./nft-query.js";
import type { TbcNftMintJobLimits, TbcNftMintJobResult } from "./nft-mint-job.js";
import type { TbcMultiRoundMergeAsset, TbcMultiRoundMergeLimits, TbcMultiRoundMergeProgress, TbcMultiRoundMergeResult } from "./multi-round-merge.js";
import { type TbcMessageSignatureResult, type TbcSignInInput, type TbcSignInResult } from "./sign-in.js";
import { type CreateTransferVerifierOptions, type TransferVerificationResult, type VerifyTransferInput } from "./receipt-verification.js";
import type { WorkflowSendResult } from "./core-runtime.js";
export type TbcWorkflowSendResult = WorkflowSendResult;
export type Tbc721MintJobInput = Omit<Tbc721StandardBatchMintIntent, "type" | "version"> & Readonly<{
    limits: TbcNftMintJobLimits;
    constraints?: never;
}>;
export type Tbc721SingleBatchMintInput = Omit<Tbc721StandardBatchMintIntent, "type" | "version"> & Readonly<{
    constraints?: KitTransactionConstraints;
    limits?: never;
}>;
export type TbcEncodedMessage = Readonly<{
    encoding: "utf8" | "hex" | "base64";
    data: string;
}>;
export interface TbcTypedDataInput {
    readonly domain: Readonly<{
        name: string;
        version?: string;
        chainId: `tbc:${string}`;
        origin?: string;
        verifyingContract?: string;
        salt?: string;
    }>;
    readonly types: Readonly<Record<string, readonly Readonly<{
        name: string;
        type: string;
    }>[]>>;
    readonly primaryType: string;
    readonly message: Readonly<Record<string, unknown>>;
}
export interface TbcWalletBuildInput<TIntent extends KitSupportedIntent = KitSupportedIntent> {
    readonly intent: TIntent;
    readonly signingRoles?: KitTransactionRequest["signingRoles"];
    readonly constraints?: KitTransactionConstraints;
    readonly clientRequestId?: string;
}
export interface TbcWalletProposalInput<TIntent extends KitSupportedIntent = KitSupportedIntent> extends TbcWalletBuildInput<TIntent> {
    readonly proposal: TbcPreparedProposal;
}
export type TbcWorkflowOrderedStepResult<TStep extends TbcWorkflowStep> = Readonly<{
    readonly id: TStep["id"];
    readonly kind: TStep["kind"];
    readonly result: unknown;
}> | Readonly<{
    readonly id: TStep["id"];
    readonly kind: TStep["kind"];
    readonly status: "failed" | "skipped";
    readonly error: Readonly<{
        readonly code: string;
        readonly message: string;
    }>;
}>;
export type TbcWorkflowOrderedResult<TSteps extends readonly TbcWorkflowStep[]> = Readonly<{
    readonly version: "1.0";
    readonly chainId: `tbc:${string}`;
    readonly from: string;
    readonly requestHash: string;
    readonly workflowPlanHash: string;
    readonly approvalId: string;
    readonly failureMode: "atomic" | "continue-independent";
    readonly steps: Readonly<{
        readonly [K in keyof TSteps]: TSteps[K] extends TbcWorkflowStep ? TbcWorkflowOrderedStepResult<TSteps[K]> : never;
    }>;
    readonly totalFee: string;
}>;
export interface TbcDappMultiRoundMergeInput {
    readonly asset: TbcMultiRoundMergeAsset;
    readonly limits: TbcMultiRoundMergeLimits;
    readonly clientRequestId?: string;
}
/** A terminal immutable trace. Multi-transaction submission is never atomic. */
export type TbcDappMultiRoundMergeResult = TbcMultiRoundMergeResult & Readonly<{
    readonly atomic: false;
    readonly progress: readonly TbcMultiRoundMergeProgress[];
}>;
export interface CreateTbcClientOptions {
    readonly network: `tbc:${string}` | "mainnet" | "testnet";
    readonly provider?: KitProvider;
    readonly walletCatalog?: readonly KitWalletCatalogEntry[];
    readonly requestIdFactory?: () => string;
    /** HTTP chain API only. RPC configuration remains separate and is never guessed. */
    readonly api?: Omit<CreateTransferVerifierOptions, "network">;
    /** Optional existing Native/WASM instance for local read-only material decoding. */
    readonly materialEngine?: CreateTbc721ReaderOptions["engine"];
}
export interface TbcConnectOptions {
    /** Bind the exact discovered wallet/provider instance selected by the user. */
    readonly wallet?: KitWalletDescriptor;
    /** Legacy convenience only. It fails when more than one discovered wallet has this name. */
    readonly walletName?: string;
    readonly account?: string;
}
type IntentInput<T> = T extends unknown ? Omit<T, "type" | "version"> : never;
type HtlcSpendInput = Readonly<{
    inputOutpoints: NonNullable<KitTransactionConstraints["inputOutpoints"]>;
    assetStandard?: never;
    contractId?: never;
    targetOutpoints?: never;
    constraints?: Omit<KitTransactionConstraints, "inputOutpoints">;
}> | (HtlcTokenTarget & Readonly<{
    inputOutpoints?: never;
    constraints?: KitTransactionConstraints;
}>);
type Tbc20TransferInput = IntentInput<Tbc20StandardTransferIntent>;
export interface TbcConnectedWallet {
    readonly provider: KitProvider;
    readonly account: string;
    readonly chainId: `tbc:${string}`;
    readonly request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
    readonly signMessage: (input: Readonly<{
        message: TbcEncodedMessage;
        clientRequestId?: string;
    }>) => Promise<TbcMessageSignatureResult>;
    readonly signTypedData: (input: Readonly<{
        data: TbcTypedDataInput;
        clientRequestId?: string;
    }>) => Promise<unknown>;
    readonly signIn: (input: Omit<TbcSignInInput, "provider" | "chainId" | "address">) => Promise<TbcSignInResult>;
    readonly send: <TIntent extends KitSupportedIntent>(intent: TIntent, options?: Readonly<{
        constraints?: KitTransactionConstraints;
        clientRequestId?: string;
        broadcast?: boolean;
        signingRoles?: KitTransactionRequest["signingRoles"];
    }>) => Promise<unknown>;
    /** Canonical native-asset business entry. Uses the existing generic Provider channel. */
    readonly tbc: Readonly<{
        transfer: (input: Omit<TbcTransferIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        merge: (input?: Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
    /** @deprecated Use tbc.transfer. This is the same function, not a fallback path. */
    readonly sendTbc: (input: Omit<TbcTransferIntent, "type" | "version"> & Readonly<{
        constraints?: KitTransactionConstraints;
    }>) => Promise<unknown>;
    /** Latest issuance; holder operations resolve supported templates from bound material. */
    readonly tbc20: Readonly<{
        create: (input: Omit<Tbc20StandardCreateIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        transfer: (input: IntentInput<Tbc20TransferIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        merge: (input: IntentInput<Tbc20MergeIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
    /** Latest administration, shared current/historical holder operations; no mint fallback. */
    readonly tbc20Stablecoin: Readonly<Pick<TbcConnectedWallet["coin"], "create" | "mint" | "freeze" | "unfreeze"> & {
        transfer: (input: IntentInput<Tbc20StablecoinTransferIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        merge: (input: IntentInput<Tbc20StablecoinMergeIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
    /** @deprecated Use tbc20.create. Both names reference the same implementation. */
    readonly createTbc20: (input: Omit<Tbc20StandardCreateIntent, "type" | "version"> & Readonly<{
        constraints?: KitTransactionConstraints;
    }>) => Promise<unknown>;
    readonly transferTbc20: (input: Tbc20TransferInput & Readonly<{
        constraints?: KitTransactionConstraints;
    }>) => Promise<unknown>;
    readonly mergeTbc20: (input: Omit<Tbc20StandardMergeIntent, "type" | "version"> & Readonly<{
        constraints?: KitTransactionConstraints;
    }>) => Promise<unknown>;
    readonly coin: Readonly<{
        mint: (input: Omit<CoinMintIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
            signingRoles?: KitTransactionRequest["signingRoles"];
        }>) => Promise<unknown>;
        freeze: (input: Omit<CoinFreezeIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
            signingRoles?: KitTransactionRequest["signingRoles"];
        }>) => Promise<unknown>;
        unfreeze: (input: Omit<CoinUnfreezeIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
            signingRoles?: KitTransactionRequest["signingRoles"];
        }>) => Promise<unknown>;
        create: (input: Omit<CoinCreateIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
            signingRoles?: KitTransactionRequest["signingRoles"];
        }>) => Promise<unknown>;
        transfer: (input: IntentInput<CoinTransferIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        merge: (input: Omit<CoinMergeIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
    /** Latest creation and shared current/historical business routing. */
    readonly amm: Readonly<{
        create: (input: IntentInput<AmmCreateIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        addLiquidity: (input: IntentInput<UnifiedAmmAddLiquidityIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
            signingRoles?: KitTransactionRequest["signingRoles"];
        }>) => Promise<unknown>;
        removeLiquidity: (input: IntentInput<UnifiedAmmRemoveLiquidityIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
            signingRoles?: KitTransactionRequest["signingRoles"];
        }>) => Promise<unknown>;
        swap: (input: IntentInput<UnifiedAmmSwapIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
            signingRoles?: KitTransactionRequest["signingRoles"];
        }>) => Promise<unknown>;
        mergeToken: (input: IntentInput<UnifiedPoolMaintenanceIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
    readonly timelock: Readonly<{
        lock: (input: IntentInput<TimelockLockIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        unlock: (input: Readonly<{
            inputOutpoints: NonNullable<KitTransactionConstraints["inputOutpoints"]>;
            constraints?: Omit<KitTransactionConstraints, "inputOutpoints">;
        }>) => Promise<unknown>;
    }>;
    readonly lop: Readonly<{
        create: (input: IntentInput<LopCreateIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        cancel: (input: IntentInput<LopCancelIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        match: (input: IntentInput<LopMatchIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
    /** Native TBC or an explicitly identified TBC20/Coin HTLC. */
    readonly htlc: Readonly<{
        lock: (input: IntentInput<HtlcLockIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        /** The signed transaction discloses this preimage, even before broadcast. */
        claim: (input: HtlcSpendInput & Readonly<{
            preimage: string;
        }>) => Promise<unknown>;
        refund: (input: HtlcSpendInput) => Promise<unknown>;
    }>;
    readonly tbc20Lp: Readonly<{
        transfer: (input: IntentInput<UnifiedLpTransferIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        lock: (input: IntentInput<UnifiedLpLockIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        merge: (input: IntentInput<UnifiedPoolMaintenanceIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        unlock: (input: IntentInput<UnifiedPoolMaintenanceIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        burn: (input: IntentInput<UnifiedPoolMaintenanceIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
    /** @deprecated Explicit current-template helpers; use tbc20Lp for shared routing. */
    readonly lp: Readonly<{
        transfer: (input: IntentInput<LpTransferIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        lock: (input: IntentInput<LpLockIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        merge: (input: IntentInput<LpMaintenanceIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        unlock: (input: IntentInput<LpMaintenanceIntent> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
    /** Latest issuance; transfer resolves supported current/historical NFT material. */
    readonly tbc721: Readonly<{
        createCollection: (input: Omit<Tbc721StandardCollectionIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        mint: (input: Omit<Tbc721StandardMintIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        /** Add job limits for automatic resource-bounded sub-batches and one whole-job approval. */
        batchMint: {
            (input: Tbc721MintJobInput, options?: KitRequestOptions): Promise<TbcNftMintJobResult>;
            (input: Tbc721SingleBatchMintInput, options?: KitRequestOptions): Promise<unknown>;
        };
        transfer: (input: Omit<Tbc721TransferIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        batchTransfer: (input: Omit<Tbc721BatchTransferIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
    readonly maintenance: Readonly<{
        /** @deprecated Use tbc.merge. This is the same function, not a fallback path. */
        mergeTbc: (input?: Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        mergeFt: (input: Omit<FtMergeIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        mergeStablecoin: (input: Omit<StablecoinMergeIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        mergePoolFt: (input: Omit<Extract<PoolMergeIntent, {
            type: "tbc.pool.ft.merge";
        }>, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        mergeFtlp: (input: Omit<Extract<PoolMergeIntent, {
            type: "tbc.pool.ftlp.merge";
        }>, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        burnFtlp: (input: Omit<PoolFtlpBurnIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        multiRoundMerge: (input: TbcDappMultiRoundMergeInput, options?: KitRequestOptions) => Promise<TbcDappMultiRoundMergeResult>;
    }>;
    readonly walletBuild: Readonly<{
        sign: <TIntent extends KitSupportedIntent>(input: TbcWalletBuildInput<TIntent>) => Promise<unknown>;
        send: <TIntent extends KitSupportedIntent>(input: TbcWalletBuildInput<TIntent>) => Promise<unknown>;
        signWorkflow: <const TSteps extends readonly TbcWorkflowStep[]>(input: TbcWorkflowComposition<TSteps>) => Promise<TbcWorkflowOrderedResult<TSteps>>;
        sendWorkflow: <const TSteps extends readonly TbcWorkflowStep[]>(input: TbcWorkflowComposition<TSteps>) => Promise<TbcWorkflowSendResult>;
    }>;
    readonly wallet: Readonly<{
        signProposal: <TIntent extends KitSupportedIntent>(input: TbcWalletProposalInput<TIntent>) => Promise<unknown>;
        sendProposal: <TIntent extends KitSupportedIntent>(input: TbcWalletProposalInput<TIntent>) => Promise<unknown>;
        signPreparedWorkflow: (input: Omit<TbcPreparedWorkflowRequest, "version" | "chainId" | "from">) => Promise<unknown>;
        sendPreparedWorkflow: (input: Omit<TbcPreparedWorkflowRequest, "version" | "chainId" | "from">) => Promise<TbcWorkflowSendResult>;
        signReviewedTransaction: (input: Readonly<{
            request: TbcReviewedTransactionInput;
            clientRequestId?: string;
        }>) => Promise<unknown>;
    }>;
    readonly crypto: Readonly<{
        encrypt: (input: Readonly<{
            message: TbcEncodedMessage;
            clientRequestId?: string;
        }>) => Promise<unknown>;
        decrypt: (input: Readonly<{
            ciphertext: string;
            clientRequestId?: string;
        }>) => Promise<unknown>;
    }>;
    readonly ft: Readonly<{
        create: (input: Omit<FtCreateIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        transfer: (input: Omit<FtTransferIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
    readonly stablecoin: Readonly<{
        transfer: (input: Omit<StablecoinTransferIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
    readonly collection: Readonly<{
        create: (input: Omit<CollectionCreateIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
    readonly nft: Readonly<{
        mint: (input: Omit<NftMintIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        transfer: (input: Omit<NftTransferIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
    readonly pool: Readonly<{
        create: (input: Omit<PoolCreateIntent, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        buy: (input: Omit<Extract<PoolSwapIntent, {
            type: "tbc.pool.swap.exactTbcForToken";
        }>, "type" | "version"> & Readonly<{
            constraints: KitExpiringTransactionConstraints;
        }>) => Promise<unknown>;
        sell: (input: Omit<Extract<PoolSwapIntent, {
            type: "tbc.pool.swap.exactTokenForTbc";
        }>, "type" | "version"> & Readonly<{
            constraints: KitExpiringTransactionConstraints;
        }>) => Promise<unknown>;
        addLiquidity: (input: Omit<Extract<PoolLiquidityIntent, {
            type: "tbc.pool.liquidity.add";
        }>, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
        removeLiquidity: (input: Omit<Extract<PoolLiquidityIntent, {
            type: "tbc.pool.liquidity.remove";
        }>, "type" | "version"> & Readonly<{
            constraints?: KitTransactionConstraints;
        }>) => Promise<unknown>;
    }>;
}
export interface TbcClient {
    readonly verifyTransfer: (input: VerifyTransferInput) => Promise<TransferVerificationResult>;
    /** Public chain query, no wallet connection or permission required. */
    readonly timelock: TimelockReader;
    readonly tbc721: Tbc721Reader;
    readonly wallets: () => readonly KitWalletDescriptor[];
    readonly subscribeWallets: (listener: (wallets: readonly KitWalletDescriptor[]) => void) => () => void;
    readonly walletOptions: () => readonly KitWalletOption[];
    readonly subscribeWalletOptions: (listener: (wallets: readonly KitWalletOption[]) => void) => () => void;
    readonly connect: (options?: TbcConnectOptions) => Promise<TbcConnectedWallet>;
}
interface TbcDiscoveredWallet {
    readonly name: string;
    readonly icon: `data:${string}`;
    readonly accounts: readonly Readonly<{
        address: string;
        publicKey: ArrayLike<number>;
        chains: readonly string[];
    }>[];
    readonly features: Readonly<{
        "tbc:provider": Readonly<{
            productId?: string;
            provider: unknown;
        }>;
    }>;
}
interface TbcWalletDiscoveryAdapter {
    readonly get: () => readonly TbcDiscoveredWallet[];
    readonly subscribe: (listener: () => void) => () => void;
}
export declare function createTbcClientWithWalletDiscovery(options: CreateTbcClientOptions, discovery: TbcWalletDiscoveryAdapter): TbcClient;
/** React Native-safe client. Browser discovery is supplied by the browser root. */
export declare function createTbcClient(options: CreateTbcClientOptions): TbcClient;
export {};
//# sourceMappingURL=client.d.ts.map