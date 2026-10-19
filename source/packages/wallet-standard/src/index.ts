import { getWallets, registerWallet, type Wallet } from "@wallet-standard/core";

import {
  TBC_PROVIDER_FEATURE,
  TBC_PROVIDER_FEATURE_VERSION,
  type TbcProviderFeatureValue,
  type TbcWallet,
  type TbcWalletsChange,
  type TbcWalletsListener,
} from "./types.js";

const COMPATIBLE_FEATURE_VERSION = /^1\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const PRODUCT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasProviderSurface(value: unknown): boolean {
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
      (typeof feature.productId === "string" && PRODUCT_ID.test(feature.productId))) &&
    hasProviderSurface(feature.provider)
  );
}

function isTbcWallet(wallet: unknown): wallet is TbcWallet {
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

export function registerTbcWallet(wallet: TbcWallet): void {
  if (!isTbcWallet(wallet)) {
    throw new TypeError("Wallet must expose a compatible tbc:provider feature.");
  }
  if (typeof window === "undefined") return;
  registerWallet(wallet);
}

export function getTbcWallets(): readonly TbcWallet[] {
  return Object.freeze(getWallets().get().filter(isTbcWallet));
}

export function subscribeTbcWallets(listener: TbcWalletsListener): () => void {
  if (typeof listener !== "function") {
    throw new TypeError("TBC wallet discovery listener must be a function.");
  }
  const wallets = getWallets();
  function emit(type: TbcWalletsChange["type"], registered: readonly Wallet[]) {
    const compatible = registered.filter(isTbcWallet);
    if (compatible.length === 0) return;
    listener(Object.freeze({
      type,
      wallets: Object.freeze(compatible),
    }) as TbcWalletsChange);
  }
  const offRegister = wallets.on("register", (...registered) => {
    emit("register", registered);
  });
  const offUnregister = wallets.on("unregister", (...registered) => {
    emit("unregister", registered);
  });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    offRegister();
    offUnregister();
  };
}

export {
  TBC_PROVIDER_FEATURE,
  TBC_PROVIDER_FEATURE_VERSION,
  type TbcProviderFeature,
  type TbcProviderFeatureValue,
  type TbcProviderFeatureVersion,
  type TbcWallet,
  type TbcWalletAccount,
  type TbcWalletsChange,
  type TbcWalletsListener,
} from "./types.js";
