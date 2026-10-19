import {
  TBC_PROVIDER_FEATURE,
  TBC_PROVIDER_FEATURE_VERSION,
  assertTbcWallet,
  assertTbcWalletsListener,
  isTbcProviderFeature,
  type TbcProviderFeature,
  type TbcProviderFeatureValue,
  type TbcProviderFeatureVersion,
  type TbcWallet,
  type TbcWalletAccount,
  type TbcWalletsChange,
  type TbcWalletsListener,
} from "./wallet-standard-common.js";

const NO_WALLETS: readonly TbcWallet[] = Object.freeze([]);

/** Registration occurs inside the browser page bundle, never the RN host realm. */
export function registerTbcWallet(wallet: TbcWallet): void {
  assertTbcWallet(wallet);
}

/** The RN host uses an explicitly injected Provider and has no browser registry. */
export function getTbcWallets(): readonly TbcWallet[] {
  return NO_WALLETS;
}

export function subscribeTbcWallets(listener: TbcWalletsListener): () => void {
  assertTbcWalletsListener(listener);
  return () => undefined;
}

export {
  TBC_PROVIDER_FEATURE,
  TBC_PROVIDER_FEATURE_VERSION,
  isTbcProviderFeature,
  type TbcProviderFeature,
  type TbcProviderFeatureValue,
  type TbcProviderFeatureVersion,
  type TbcWallet,
  type TbcWalletAccount,
  type TbcWalletsChange,
  type TbcWalletsListener,
};
