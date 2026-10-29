import type { TbcProvider } from "./provider-transport.js";
export declare const TBC_PROVIDER_FEATURE: "tbc:provider";
export declare const TBC_PROVIDER_FEATURE_VERSION: "1.0.0";
export type TbcProviderFeatureVersion = `1.${number}.${number}`;
export interface TbcProviderFeatureValue {
    readonly version: TbcProviderFeatureVersion;
    /** Display metadata only; never use it as wallet-instance identity or authority. */
    readonly productId?: string;
    readonly provider: TbcProvider;
}
export type TbcProviderFeature = Readonly<{
    [TBC_PROVIDER_FEATURE]: TbcProviderFeatureValue;
}>;
export interface TbcWalletAccount {
    readonly address: string;
    readonly publicKey: ArrayLike<number>;
    readonly chains: readonly `tbc:${string}`[];
    readonly features: readonly string[];
    readonly label?: string;
    readonly icon?: `data:${string}`;
}
export interface TbcWallet {
    readonly version: "1.0.0";
    readonly name: string;
    readonly icon: `data:${string}`;
    readonly chains: readonly string[];
    readonly features: TbcProviderFeature & Readonly<Record<string, unknown>>;
    readonly accounts: readonly TbcWalletAccount[];
}
export type TbcWalletsChange = Readonly<{
    type: "register";
    wallets: readonly TbcWallet[];
}> | Readonly<{
    type: "unregister";
    wallets: readonly TbcWallet[];
}>;
export type TbcWalletsListener = (change: TbcWalletsChange) => void;
export declare function isTbcProviderFeature(feature: unknown): feature is TbcProviderFeatureValue;
export declare function isTbcWallet(wallet: unknown): wallet is TbcWallet;
export declare function assertTbcWallet(wallet: unknown): asserts wallet is TbcWallet;
export declare function assertTbcWalletsListener(listener: unknown): asserts listener is TbcWalletsListener;
//# sourceMappingURL=wallet-standard-common.d.ts.map