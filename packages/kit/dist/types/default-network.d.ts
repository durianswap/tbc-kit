import { type DefaultTbcChainDataResolver } from "./default-chain-data.js";
import { type KitRequestLedger } from "./request-ledger.js";
import { type PoolMaterialConfirmationPolicy, type PoolMergeIndex, type PoolMergeIndexKind, type PoolMaterialSource, type PoolSnapshotMaterial } from "./pool-material.js";
import type { TbcKitBroadcastJournal } from "./broadcast-journal.js";
import type { TbcKitBroadcastJournalRecord } from "./broadcast-journal.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import { type TestnetClient, type TestnetFetch } from "./testnet-client.js";
import type { inspectTbcTransaction } from "./testnet-validation.js";
import type { KitHostPortCall, KitWalletAccount } from "./wallet-runtime.js";
import { type TbcNetworkContext } from "./network-context.js";
export declare const DEFAULT_TBC_TESTNET_POLICY: Readonly<{
    policyId: "tbc-testnet-kit-r1";
    revision: "1";
    feeRateSatPerKb: "80";
    dustThreshold: "24";
    minConfirmations: "0";
    maxBundleTransactions: 32;
    maximumNativeAmount: "2100000000000000";
    ttlMs: 300000;
}>;
export declare const DEFAULT_TBC_MAINNET_POLICY: Readonly<{
    policyId: "tbc-mainnet-kit-r1";
    revision: "1";
    feeRateSatPerKb: "80";
    dustThreshold: "24";
    minConfirmations: "0";
    maxBundleTransactions: 32;
    maximumNativeAmount: "2100000000000000";
    ttlMs: 300000;
}>;
export interface DefaultTbcNetworkOptions {
    readonly network: TbcNetworkContext;
    readonly accounts: Readonly<{
        current: () => Promise<readonly KitWalletAccount[]>;
    }>;
    readonly fetch: TestnetFetch;
    readonly ledger?: KitRequestLedger;
    readonly requestTimeoutMs?: number;
    readonly now?: () => number;
    readonly snapshotId?: () => string | Promise<string>;
    /** Shared exact-byte parser/cache for client proof and Chain Data material. */
    readonly inspectTransaction?: typeof inspectTbcTransaction;
    /** Keyless Native bridge for canonical Pool descriptors and previews. */
    readonly poolNative?: PoolMaterialNativeProviderInput;
    /** Wallet-owned source shared with approval evidence when already composed. */
    readonly poolMaterial?: PoolMaterialSource;
    /** Wallet-owned construction floor; never accepted from a DApp request. */
    readonly confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>;
    /** Retains only the exact short-lived snapshot material for approval review. */
    readonly rememberPoolSnapshotMaterial?: (value: PoolSnapshotMaterial) => void;
    /** Internal/session composition hook; returns a trusted active-account digest without network I/O. */
    readonly broadcastAccountScopeHash?: () => Promise<string>;
    readonly broadcast?: Readonly<{
        journal: TbcKitBroadcastJournal;
        submit?: never;
        reconcile?: never;
    }> | Readonly<{
        journal?: never;
        submit: (params: unknown, client: TestnetClient, call: KitHostPortCall | undefined) => Promise<unknown>;
        submitBatch?: (params: unknown, client: TestnetClient, call: KitHostPortCall | undefined) => Promise<unknown>;
        reconcile: (params: unknown, client: TestnetClient, call: KitHostPortCall | undefined) => Promise<unknown>;
    }>;
}
export interface DefaultTbcTestnetNetworkOptions {
    readonly accounts: Readonly<{
        current: () => Promise<readonly KitWalletAccount[]>;
    }>;
    readonly baseUrl?: string;
    readonly allowedOrigins?: readonly string[];
    readonly fetch: TestnetFetch;
    readonly ledger?: KitRequestLedger;
    readonly requestTimeoutMs?: number;
    readonly now?: () => number;
    readonly snapshotId?: () => string | Promise<string>;
    /** Shared exact-byte parser/cache for client proof and Chain Data material. */
    readonly inspectTransaction?: typeof inspectTbcTransaction;
    /** Keyless Native bridge for canonical Pool descriptors and previews. */
    readonly poolNative?: PoolMaterialNativeProviderInput;
    /** Wallet-owned source shared with approval evidence when already composed. */
    readonly poolMaterial?: PoolMaterialSource;
    /** Wallet-owned construction floor; never accepted from a DApp request. */
    readonly confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>;
    /** Retains only the exact short-lived snapshot material for approval review. */
    readonly rememberPoolSnapshotMaterial?: (value: PoolSnapshotMaterial) => void;
    /** Internal/session composition hook; returns a trusted active-account digest without network I/O. */
    readonly broadcastAccountScopeHash?: () => Promise<string>;
    readonly broadcast?: Readonly<{
        /** Kit-owned durable state machine; ordinary wallets use this path. */
        journal: TbcKitBroadcastJournal;
        submit?: never;
        reconcile?: never;
    }> | Readonly<{
        /** Advanced wallet override. It must preserve Host identity and durable recovery. */
        journal?: never;
        submit: (params: unknown, client: TestnetClient, call: KitHostPortCall | undefined) => Promise<unknown>;
        submitBatch?: (params: unknown, client: TestnetClient, call: KitHostPortCall | undefined) => Promise<unknown>;
        reconcile: (params: unknown, client: TestnetClient, call: KitHostPortCall | undefined) => Promise<unknown>;
    }>;
}
export interface DefaultTbcTestnetNetwork {
    readonly network: TbcNetworkContext;
    readonly client: TestnetClient;
    readonly chainData: DefaultTbcChainDataResolver;
    readonly prepareNftMintJob: DefaultTbcChainDataResolver["prepareNftMintJob"];
    /** Initializes wallet-owned Pool native capability without chain reads. */
    readonly warmup: () => Promise<void>;
    /** Wallet-private authoritative Pool asset inventory for bounded maintenance. */
    readonly readPoolMergeIndex: (input: Readonly<{
        address: string;
        poolContractId: string;
        kind: PoolMergeIndexKind;
    }>) => Promise<PoolMergeIndex>;
    readonly resolveChainData: (params: unknown, accountOrCall?: KitWalletAccount | KitHostPortCall, account?: KitWalletAccount) => Promise<unknown>;
    readonly resolvePolicy: (params: unknown) => Promise<unknown>;
    readonly broadcastSubmit: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
    readonly broadcastSubmitBatch: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
    readonly broadcastReconcile: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
    /** Durable submit-boundary records only; no Core/Signer operation is resumed. */
    readonly listBroadcastRecovery: (limit?: number) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
    /** Explicit status-only reconciliation; never POSTs transaction bytes. */
    readonly recoverBroadcasts: (txids: readonly string[]) => Promise<unknown>;
}
export type DefaultTbcNetwork = DefaultTbcTestnetNetwork;
export declare function createDefaultTbcNetwork(options: DefaultTbcNetworkOptions): DefaultTbcNetwork;
export declare function createDefaultTbcTestnetNetwork(options: DefaultTbcTestnetNetworkOptions): DefaultTbcTestnetNetwork;
