import { createTbcOfficialApi } from "./official-api.js";
import { type LegacyPoolFundingSource, type LegacyPoolMaterialLoadRequest } from "./pool-signing-loader.js";
import { type TestnetClient, type TestnetRawTransaction } from "./testnet-client.js";
import { inspectTbcTransaction } from "./testnet-validation.js";
import { type PoolMaterialNativeProvider, type PoolMaterialNativeProviderInput } from "./pool-material-native.js";
interface PoolMaterialUtxoBase {
    readonly txid: string;
    readonly vout: number;
    readonly satoshis: string;
    readonly scriptPubKey: string;
    /** Omitted means unobserved, never an implicit mempool zero. */
    readonly confirmations?: string;
}
/** Construction-only material. Exact transaction lookup keeps its required count. */
export type PoolMaterialTransaction = Omit<TestnetRawTransaction, "confirmations"> & Readonly<{
    confirmations?: string;
}>;
type PoolMaterialClient = Pick<TestnetClient, "getRawTransactionBytes"> & Readonly<{
    getRawTransaction: (txid: string) => Promise<PoolMaterialTransaction>;
}>;
export type PoolMaterialUtxo = (PoolMaterialUtxoBase & Readonly<{
    classification: "pool-source";
}>) | (PoolMaterialUtxoBase & Readonly<{
    classification: "pool" | "pool-ft" | "ftlp" | "ft";
    contractId: string;
}>);
export interface PoolMaterial {
    readonly utxos: readonly PoolMaterialUtxo[];
    readonly parents: readonly Readonly<{
        txid: string;
        rawTransaction: string;
    }>[];
    readonly contracts: readonly Readonly<{
        contractId: string;
        family: "ft" | "pool";
        protocolVersion: "4.0" | "2.0";
        creationTxid: string;
        currentOutpoint: Readonly<{
            txid: string;
            vout: number;
        }>;
        indexedFungible?: Readonly<{
            codeScript: string;
            tapeScript: string;
            totalSupply: string;
        }>;
        indexedPool?: Readonly<{
            ftCodeScript: string;
            ftTapeScript: string;
        }>;
    }>[];
    readonly policy: Readonly<{
        lpPlan: number;
        serviceProviderTag: string;
        serviceFeeRate: number;
    }>;
    readonly review: Readonly<{
        ftContractId: string;
        ftRequiredRaw: string;
        ftlpDeltaRaw: string;
        lockTime: string;
        feeFundingCapAtomic: string;
        poolBefore: PoolMaterialAmounts;
        poolAfter: PoolMaterialAmounts;
    }>;
}
export interface PoolMaterialAmounts {
    readonly tbcSat: string;
    readonly ftARaw: string;
    readonly ftLpRaw: string;
    readonly poolValueSat: string;
}
/** Wallet-owned construction policy. This is not DApp-controlled input and
 * does not claim that a confirmation count was observed from the node. */
export interface PoolMaterialConfirmationPolicy {
    readonly minConfirmations: string;
}
export declare function normalizePoolMaterialConfirmationPolicy(value: PoolMaterialConfirmationPolicy): Readonly<PoolMaterialConfirmationPolicy>;
export type PoolMergeIndexKind = "pool-ft" | "ftlp";
export interface PoolMergeIndexUtxo {
    readonly txid: string;
    readonly vout: number;
    readonly satoshis: string;
    readonly assetAmount: string;
    readonly lockTime?: number;
}
export interface PoolMergeIndex {
    readonly version: "1.0";
    readonly kind: PoolMergeIndexKind;
    readonly poolContractId: string;
    readonly ftContractId: string;
    /** Current Pool state identity; FTLP merge does not consume this output. */
    readonly currentPoolTxid: string;
    readonly utxos: readonly PoolMergeIndexUtxo[];
}
/** Internal preparation context, not a DApp request or retained index cache. */
export type PoolMaterialReadScope = Readonly<Pick<ReturnType<typeof createTbcOfficialApi>, "poolInfo"> & Partial<Pick<ReturnType<typeof createTbcOfficialApi>, "ftInfo">>>;
export interface PoolMaterialSource {
    /** Internal immutable-byte handoff, never a confirmation/unspentness cache. */
    readonly rememberTransaction?: (txid: string, rawTransaction: string) => void | Promise<void>;
    /** Present only when the wallet deliberately selected a construction floor. */
    readonly confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>;
    /**
     * Wallet-startup capability warmup. It creates the native-backed source and
     * validates its operation surface without reading mutable chain state.
     */
    readonly warmup?: () => Promise<void>;
    readonly resolveLiquidityAdd: (input: PoolMaterialRequest, funding?: LegacyPoolFundingSource, reads?: PoolMaterialReadScope) => Promise<PoolMaterial>;
    readonly resolveLiquidityRemove?: (input: PoolLiquidityRemoveMaterialRequest, funding?: LegacyPoolFundingSource, reads?: PoolMaterialReadScope) => Promise<PoolLiquidityRemoveMaterial>;
    readonly resolveCreateInitialize?: (input: PoolCreateInitializeMaterialRequest) => Promise<PoolCreateInitializeMaterial>;
    readonly resolveSwapTbcForToken?: (input: PoolSwapTbcForTokenMaterialRequest, funding?: LegacyPoolFundingSource, reads?: PoolMaterialReadScope) => Promise<PoolSwapMaterial>;
    readonly resolveSwapTokenForTbc?: (input: PoolSwapTokenForTbcMaterialRequest, funding?: LegacyPoolFundingSource, reads?: PoolMaterialReadScope) => Promise<PoolSwapMaterial>;
    readonly resolvePoolFtMerge?: (input: PoolMergeMaterialRequest, funding?: LegacyPoolFundingSource, reads?: PoolMaterialReadScope) => Promise<PoolMergeMaterial>;
    /** Private authoritative inventory used only by bounded Pool maintenance. */
    readonly readMergeIndex?: (input: PoolMergeMaterialRequest & Readonly<{
        kind: PoolMergeIndexKind;
    }>) => Promise<PoolMergeIndex>;
    readonly resolveFtlpMerge?: (input: PoolMergeMaterialRequest, funding?: LegacyPoolFundingSource, reads?: PoolMaterialReadScope) => Promise<PoolMergeMaterial>;
    readonly resolveFtlpBurn?: (input: PoolMergeMaterialRequest, funding?: LegacyPoolFundingSource, reads?: PoolMaterialReadScope) => Promise<PoolMergeMaterial>;
}
type PoolSnapshotBinding = Readonly<{
    snapshotHash: string;
    chainId: string;
    /** Separates same-chain material loaded from different trusted sources. */
    sourceIdentity?: string;
}>;
export type PoolSnapshotMaterial = Readonly<{
    binding: PoolSnapshotBinding;
    expiresAt: number;
}> & (Readonly<{
    kind: "add";
    input: PoolMaterialRequest;
    material: PoolMaterial;
}> | Readonly<{
    kind: "remove";
    input: PoolLiquidityRemoveMaterialRequest;
    material: PoolLiquidityRemoveMaterial;
}> | Readonly<{
    kind: "initialize";
    input: PoolCreateInitializeMaterialRequest;
    material: PoolCreateInitializeMaterial;
}> | Readonly<{
    kind: "swap-tbc-for-token";
    input: PoolSwapTbcForTokenMaterialRequest;
    material: PoolSwapMaterial;
}> | Readonly<{
    kind: "swap-token-for-tbc";
    input: PoolSwapTokenForTbcMaterialRequest;
    material: PoolSwapMaterial;
}>);
/** One exact snapshot's read-only material, shared by chain preparation and approval.
 * Not spendability, authority or a signing capability; misses keep the normal loader.
 */
export declare function createPoolSnapshotMaterialRetention(now?: () => number): Readonly<{
    remember(value: PoolSnapshotMaterial): void;
    readAdd(binding: PoolSnapshotBinding, input: PoolMaterialRequest): PoolMaterial | undefined;
    readRemove(binding: PoolSnapshotBinding, input: PoolLiquidityRemoveMaterialRequest): Readonly<Pick<PoolMaterial, "policy" | "utxos" | "parents" | "contracts"> & {
        readonly review: Readonly<{
            readonly ftContractId: string;
            readonly lpAmountRaw: string;
            readonly currentLockTime: string;
            readonly feeFundingCapAtomic: string;
            readonly poolBefore: PoolMaterialAmounts;
        }>;
    }> | undefined;
    readInitialize(binding: PoolSnapshotBinding, input: PoolCreateInitializeMaterialRequest): Readonly<Pick<PoolMaterial, "policy" | "utxos" | "parents" | "contracts">> | undefined;
    readSwapTbcForToken(binding: PoolSnapshotBinding, input: PoolSwapTbcForTokenMaterialRequest): Readonly<Pick<PoolMaterial, "policy" | "utxos" | "parents" | "contracts"> & {
        readonly review: Readonly<{
            readonly direction: "tbc-for-token" | "token-for-tbc";
            readonly ftContractId: string;
            readonly inputAmount: string;
            readonly feeFundingCapAtomic: string;
            readonly poolBefore: PoolMaterialAmounts;
        }>;
    }> | undefined;
    readSwapTokenForTbc(binding: PoolSnapshotBinding, input: PoolSwapTokenForTbcMaterialRequest): Readonly<Pick<PoolMaterial, "policy" | "utxos" | "parents" | "contracts"> & {
        readonly review: Readonly<{
            readonly direction: "tbc-for-token" | "token-for-tbc";
            readonly ftContractId: string;
            readonly inputAmount: string;
            readonly feeFundingCapAtomic: string;
            readonly poolBefore: PoolMaterialAmounts;
        }>;
    }> | undefined;
}>;
export type PoolLiquidityRemoveMaterial = Readonly<Pick<PoolMaterial, "utxos" | "parents" | "contracts" | "policy"> & {
    readonly review: Readonly<{
        readonly ftContractId: string;
        readonly lpAmountRaw: string;
        readonly currentLockTime: string;
        readonly feeFundingCapAtomic: string;
        readonly poolBefore: PoolMaterialAmounts;
    }>;
}>;
export interface PoolLiquidityRemoveMaterialRequest {
    readonly address: string;
    readonly poolContractId: string;
    readonly receiver: string;
    readonly lpAmount: string;
}
export type PoolSwapMaterial = Readonly<Pick<PoolMaterial, "utxos" | "parents" | "contracts" | "policy"> & {
    readonly review: Readonly<{
        readonly direction: "tbc-for-token" | "token-for-tbc";
        readonly ftContractId: string;
        readonly inputAmount: string;
        readonly feeFundingCapAtomic: string;
        readonly poolBefore: PoolMaterialAmounts;
    }>;
}>;
export interface PoolSwapTbcForTokenMaterialRequest {
    readonly address: string;
    readonly poolContractId: string;
    readonly receiver: string;
    readonly tbcAmount: string;
}
export interface PoolSwapTokenForTbcMaterialRequest {
    readonly address: string;
    readonly poolContractId: string;
    readonly receiver: string;
    readonly ftAmount: string;
}
export interface PoolMergeMaterialRequest {
    readonly address: string;
    readonly poolContractId: string;
}
export type PoolMergeMaterial = Readonly<Pick<PoolMaterial, "utxos" | "parents" | "contracts" | "policy"> & {
    readonly review: Readonly<{
        readonly kind: "pool-ft" | "ftlp";
        readonly ftContractId: string;
        readonly assetAmountRaw: string;
        readonly feeFundingCapAtomic: string;
        readonly poolBefore: PoolMaterialAmounts;
    }>;
}>;
export type PoolCreateInitializeMaterial = Readonly<Pick<PoolMaterial, "utxos" | "parents" | "contracts" | "policy">>;
export interface PoolCreateInitializeMaterialRequest {
    readonly address: string;
    readonly poolContractId: string;
    readonly receiver: string;
    readonly tbcAmount: string;
    readonly ftAmount: string;
}
export interface PoolMaterialRequest {
    readonly address: string;
    readonly poolContractId: string;
    readonly receiver: string;
    readonly tbcAmount: string;
}
/** Wallet-private exact-byte cache; callers own its scope. No mutable authority. */
export declare function createPoolTransactionInspector(): typeof inspectTbcTransaction;
export declare function createPoolInitializeMaterialResolver(options: {
    readonly client: PoolMaterialClient & Pick<TestnetClient, "getFtUtxos">;
    readonly fetch: typeof globalThis.fetch;
    readonly native: PoolMaterialNativeProvider;
    readonly inspectTransaction?: typeof inspectTbcTransaction;
    readonly baseUrl?: string;
    readonly p2pkhVersion?: number;
}): (input: PoolCreateInitializeMaterialRequest) => Promise<PoolCreateInitializeMaterial>;
export declare function createPoolMaterialSource(options: {
    readonly client: PoolMaterialClient;
    readonly inspectTransaction?: typeof inspectTbcTransaction;
    readonly p2pkhVersion?: number;
    readonly load: (request: LegacyPoolMaterialLoadRequest) => Promise<Readonly<Record<string, unknown>>>;
}): PoolMaterialSource;
/** One LP preparation only: collapse duplicate parent reads across its two loaders.
 * Fresh scopes never reuse mutable confirmations or cache index/UTXO responses.
 */
export declare function createPoolMaterialTransactionReader(client: Pick<TestnetClient, "getRawTransaction" | "getRawTransactionBytes">, readTipHeight?: () => Promise<string | undefined>, readIndexedHeight?: (txid: string) => Promise<string | undefined>, inspectTransaction?: typeof inspectTbcTransaction, readSelectedParentBytes?: (txid: string) => Promise<string | undefined>, confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>): PoolMaterialClient["getRawTransaction"] & {
    readonly readBytes: (txid: string) => Promise<string>;
    readonly observeHeight: (txid: string, height: string) => void;
};
export declare function createProductionPoolMaterialSource(options: {
    readonly native: PoolMaterialNativeProviderInput;
    readonly fetch?: typeof globalThis.fetch;
    readonly baseUrl?: string;
    readonly allowedOrigins?: readonly string[];
    readonly requestTimeoutMs?: number;
    readonly p2pkhVersion?: number;
    /** Wallet-owned only; omitted preserves exact node confirmation reads. */
    readonly confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>;
}): Promise<PoolMaterialSource>;
/** Synchronous wallet composition facade; capability negotiation remains lazy
 * and is shared by every Pool request in this runtime. */
export declare function createLazyProductionPoolMaterialSource(options: {
    readonly native: PoolMaterialNativeProviderInput;
    readonly fetch?: typeof globalThis.fetch;
    readonly baseUrl?: string;
    readonly allowedOrigins?: readonly string[];
    readonly requestTimeoutMs?: number;
    readonly p2pkhVersion?: number;
    /** Wallet-owned only; omitted preserves exact node confirmation reads. */
    readonly confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>;
}): PoolMaterialSource;
export {};
//# sourceMappingURL=pool-material.d.ts.map