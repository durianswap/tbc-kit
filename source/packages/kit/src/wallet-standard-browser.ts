import {
  getTbcWallets as getBundledTbcWallets,
  registerTbcWallet as registerBundledTbcWallet,
  subscribeTbcWallets as subscribeBundledTbcWallets,
} from "@tbc-wallet/wallet-standard";
import {
  TBC_PROVIDER_FEATURE,
  TBC_PROVIDER_FEATURE_VERSION,
  assertTbcWallet,
  assertTbcWalletsListener,
  isTbcProviderFeature,
  isTbcWallet,
  type TbcProviderFeature,
  type TbcProviderFeatureValue,
  type TbcProviderFeatureVersion,
  type TbcWallet,
  type TbcWalletAccount,
  type TbcWalletsChange,
  type TbcWalletsListener,
} from "./wallet-standard-common.js";

export function registerTbcWallet(wallet: TbcWallet): void {
  assertTbcWallet(wallet);
  registerBundledTbcWallet(
    wallet as unknown as Parameters<typeof registerBundledTbcWallet>[0],
  );
}

export function getTbcWallets(): readonly TbcWallet[] {
  return Object.freeze(
    getBundledTbcWallets().filter((wallet) => isTbcWallet(wallet)),
  ) as unknown as readonly TbcWallet[];
}

export function subscribeTbcWallets(listener: TbcWalletsListener): () => void {
  assertTbcWalletsListener(listener);
  return subscribeBundledTbcWallets(
    listener as unknown as Parameters<typeof subscribeBundledTbcWallets>[0],
  );
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
