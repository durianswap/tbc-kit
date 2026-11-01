import { TBC_PROVIDER_FEATURE, TBC_PROVIDER_FEATURE_VERSION, isTbcProviderFeature, type TbcProviderFeature, type TbcProviderFeatureValue, type TbcProviderFeatureVersion, type TbcWallet, type TbcWalletAccount, type TbcWalletsChange, type TbcWalletsListener } from "./wallet-standard-common.js";
/** Registration occurs inside the browser page bundle, never the RN host realm. */
export declare function registerTbcWallet(wallet: TbcWallet): void;
/** The RN host uses an explicitly injected Provider and has no browser registry. */
export declare function getTbcWallets(): readonly TbcWallet[];
export declare function subscribeTbcWallets(listener: TbcWalletsListener): () => void;
export { TBC_PROVIDER_FEATURE, TBC_PROVIDER_FEATURE_VERSION, isTbcProviderFeature, type TbcProviderFeature, type TbcProviderFeatureValue, type TbcProviderFeatureVersion, type TbcWallet, type TbcWalletAccount, type TbcWalletsChange, type TbcWalletsListener, };
