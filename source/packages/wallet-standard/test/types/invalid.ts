import type { TbcProvider } from "@tbc-wallet/provider";
import {
  TBC_PROVIDER_FEATURE,
  registerTbcWallet,
  type TbcProviderFeature,
} from "../../src/index.js";

declare const provider: TbcProvider;

const incompatible: TbcProviderFeature = {
  [TBC_PROVIDER_FEATURE]: {
    // @ts-expect-error Feature major 2 is incompatible with this adapter.
    version: "2.0.0",
    provider,
  },
};

registerTbcWallet({
  version: "1.0.0",
  name: "Not TBC",
  icon: "data:image/svg+xml;base64,PHN2Zy8+",
  chains: ["example:1"],
  accounts: [],
  // @ts-expect-error A wallet without tbc:provider is not a TBC wallet.
  features: {},
});

void incompatible;
