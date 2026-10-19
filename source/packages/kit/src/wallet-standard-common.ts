import type { TbcProvider } from "./provider-transport.js";

export const TBC_PROVIDER_FEATURE = "tbc:provider" as const;
export const TBC_PROVIDER_FEATURE_VERSION = "1.0.0" as const;

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

export type TbcWalletsChange =
  | Readonly<{ type: "register"; wallets: readonly TbcWallet[] }>
  | Readonly<{ type: "unregister"; wallets: readonly TbcWallet[] }>;

export type TbcWalletsListener = (change: TbcWalletsChange) => void;

const COMPATIBLE_FEATURE_VERSION = /^1\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const PRODUCT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasProviderSurface(value: unknown): value is TbcProvider {
  return (
    isRecord(value) &&
    typeof value.request === "function" &&
    typeof value.on === "function" &&
    typeof value.removeListener === "function" &&
    typeof value.destroy === "function"
  );
}

export function isTbcProviderFeature(
  feature: unknown,
): feature is TbcProviderFeatureValue {
  return (
    isRecord(feature) &&
    typeof feature.version === "string" &&
    COMPATIBLE_FEATURE_VERSION.test(feature.version) &&
    (!Object.hasOwn(feature, "productId") ||
      (typeof feature.productId === "string" &&
        PRODUCT_ID.test(feature.productId))) &&
    hasProviderSurface(feature.provider)
  );
}

export function isTbcWallet(wallet: unknown): wallet is TbcWallet {
  if (
    !isRecord(wallet) ||
    wallet.version !== "1.0.0" ||
    typeof wallet.name !== "string" ||
    wallet.name.length === 0 ||
    typeof wallet.icon !== "string" ||
    !Array.isArray(wallet.chains) ||
    !Array.isArray(wallet.accounts)
  ) {
    return false;
  }
  const features = wallet.features;
  return (
    isRecord(features) &&
    Object.hasOwn(features, TBC_PROVIDER_FEATURE) &&
    isTbcProviderFeature(features[TBC_PROVIDER_FEATURE])
  );
}

export function assertTbcWallet(wallet: unknown): asserts wallet is TbcWallet {
  if (!isTbcWallet(wallet)) {
    throw new TypeError("Wallet must expose a compatible tbc:provider feature.");
  }
}

export function assertTbcWalletsListener(
  listener: unknown,
): asserts listener is TbcWalletsListener {
  if (typeof listener !== "function") {
    throw new TypeError("TBC wallet discovery listener must be a function.");
  }
}
