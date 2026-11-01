import type { KitWalletAccount } from "./wallet-runtime.js";
import { type TbcNftMintJobMaterial } from "./nft-mint-job-material.js";
import type { TbcNftMintJobScope } from "./nft-mint-job.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import { type TbcNetworkContext } from "./network-context.js";
import type { TestnetClient } from "./testnet-client.js";
import type { PoolMaterial, PoolMaterialConfirmationPolicy, PoolMaterialSource, PoolSnapshotMaterial } from "./pool-material.js";
import { inspectTbcTransaction, type ParsedTbcTransaction } from "./testnet-validation.js";
export interface DefaultTbcChainDataResolver {
    readonly network: TbcNetworkContext;
    /** The account is supplied by Kit after session binding when available. */
    readonly resolve: (params: unknown, account?: KitWalletAccount) => Promise<unknown>;
    /** Private bounded job scope; no cross-request mutable cache or background work. */
    readonly prepareNftMintJob: (scope: TbcNftMintJobScope, account: KitWalletAccount) => Promise<TbcNftMintJobMaterial>;
    /** Private read-plan selection, bound to this exact unexpired snapshot. */
    readonly readUnifiedIntent: (binding: Readonly<{
        snapshotHash: string;
        chainId: string;
        from: string;
        contractId: string;
        intentType: string;
    }>) => string | undefined;
    readonly readPoolPolicy: (binding: Readonly<{
        snapshotHash: string;
        chainId: string;
        sourceIdentity?: string;
        from: string;
        poolContractId: string;
    }>) => PoolMaterial["policy"] | undefined;
    readonly rememberFinalizedTransaction: (transaction: Readonly<{
        txid: string;
        rawTransaction: string;
    }>) => void;
}
export interface CreateDefaultTbcChainDataOptions {
    readonly accounts: Readonly<{
        current: () => Promise<readonly KitWalletAccount[]>;
    }>;
    readonly client: TestnetClient;
    /** Immutable chain and endpoint identity. Omission preserves the legacy Testnet default. */
    readonly network?: TbcNetworkContext;
    readonly now?: () => number;
    readonly snapshotId?: () => string | Promise<string>;
    /** Input budget; FT transfer/merge funding candidates are alternatives, not selected inputs. */
    readonly maxInputs?: number;
    readonly snapshotTtlMs?: number;
    readonly inspectTransaction?: typeof inspectTbcTransaction;
    readonly poolMaterial?: PoolMaterialSource;
    /** Shared keyless codec, also used by the existing Pool material source. */
    readonly materialNative?: PoolMaterialNativeProviderInput;
    /** Wallet-owned read requirement; omission preserves exact reads. */
    readonly confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>;
    readonly rememberPoolSnapshotMaterial?: (value: PoolSnapshotMaterial) => void;
}
/** Exact TypeScript equivalent of Mobile Rust prepareAssetAncestry phase=inspect. */
export declare function inspectFtAncestryReferences(transaction: ParsedTbcTransaction, outputIndex: number): readonly Readonly<{
    txid: string;
    outputIndex: number;
    inputIndex: number;
}>[];
/** Read hints only; the Engine authenticates Code identity, owner and full Tape. */
export declare function inspectTbc20AncestryReferences(transaction: ParsedTbcTransaction, outputIndex: number): readonly Readonly<{
    txid: string;
    outputIndex: number;
    inputIndex: number;
}>[];
/** Read hints only. Coin shares six amount slots but has a four-byte lock suffix. */
export declare function inspectCoinAncestryReferences(transaction: ParsedTbcTransaction, outputIndex: number): readonly Readonly<{
    txid: string;
    outputIndex: number;
    inputIndex: number;
}>[];
export declare function createDefaultTbcChainDataResolver(options: CreateDefaultTbcChainDataOptions): DefaultTbcChainDataResolver;
