import type { TbcProvider } from "@tbc-wallet/provider";
import type {
  WalletAccount,
  WalletWithFeatures,
} from "@wallet-standard/core";

export const TBC_PROVIDER_FEATURE = "tbc:provider" as const;
export const TBC_PROVIDER_FEATURE_VERSION = "1.0.0" as const;

export type TbcProviderFeatureVersion = `1.${number}.${number}`;

export interface TbcProviderFeatureValue {
  readonly version: TbcProviderFeatureVersion;
  /** Self-reported product metadata. Never use this value as instance identity or authority. */
  readonly productId?: string;
  readonly provider: TbcProvider;
}

export type TbcProviderFeature = Readonly<{
  [TBC_PROVIDER_FEATURE]: TbcProviderFeatureValue;
}>;

export type TbcWallet = WalletWithFeatures<TbcProviderFeature>;

export type TbcWalletAccount = WalletAccount & Readonly<{
  chains: readonly `tbc:${string}`[];
  features: readonly (typeof TBC_PROVIDER_FEATURE | string)[];
}>;

export type TbcWalletsChange =
  | Readonly<{ type: "register"; wallets: readonly TbcWallet[] }>
  | Readonly<{ type: "unregister"; wallets: readonly TbcWallet[] }>;

export type TbcWalletsListener = (change: TbcWalletsChange) => void;
