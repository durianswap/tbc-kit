import {
  TBC_PROVIDER_FEATURE,
  TBC_PROVIDER_FEATURE_VERSION,
  getTbcWallets,
  isTbcProviderFeature,
  registerTbcWallet,
  subscribeTbcWallets,
  type TbcProvider,
  type TbcWallet,
} from "../../dist/types/index.js";

declare const provider: TbcProvider;

const wallet = {
  version: "1.0.0",
  name: "Typed Wallet",
  icon: "data:image/svg+xml;base64,PHN2Zy8+",
  chains: ["tbc:testnet"],
  accounts: [],
  features: {
    [TBC_PROVIDER_FEATURE]: {
      version: TBC_PROVIDER_FEATURE_VERSION,
      provider,
    },
  },
} as const satisfies TbcWallet;

registerTbcWallet(wallet);
getTbcWallets()[0] satisfies TbcWallet | undefined;
isTbcProviderFeature(wallet.features[TBC_PROVIDER_FEATURE]) satisfies boolean;
const unsubscribe = subscribeTbcWallets((change) => {
  change.wallets[0] satisfies TbcWallet | undefined;
});
unsubscribe();
