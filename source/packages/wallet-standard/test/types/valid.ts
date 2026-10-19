import type { TbcProvider } from "@tbc-wallet/provider";
import {
  TBC_PROVIDER_FEATURE,
  getTbcWallets,
  isTbcProviderFeature,
  registerTbcWallet,
  subscribeTbcWallets,
  type TbcProviderFeature,
  type TbcWallet,
} from "../../src/index.js";

declare const provider: TbcProvider;

const feature: TbcProviderFeature = {
  [TBC_PROVIDER_FEATURE]: {
    version: "1.2.3",
    provider,
  },
};
const wallet: TbcWallet = {
  version: "1.0.0",
  name: "TBC Wallet",
  icon: "data:image/svg+xml;base64,PHN2Zy8+",
  chains: ["tbc:mainnet"],
  accounts: [],
  features: feature,
};

registerTbcWallet(wallet);
const wallets: readonly TbcWallet[] = getTbcWallets();
const unsubscribe = subscribeTbcWallets(({ type, wallets: changed }) => {
  const exact: "register" | "unregister" = type;
  const discovered: readonly TbcWallet[] = changed;
  void [exact, discovered];
});
const narrowed = isTbcProviderFeature(wallet.features[TBC_PROVIDER_FEATURE]);

void [wallets, unsubscribe, narrowed];
