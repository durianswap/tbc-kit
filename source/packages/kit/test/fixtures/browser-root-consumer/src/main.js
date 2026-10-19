import {
  createTbcClient,
  getTbcWallets,
  isTbcProviderFeature,
} from "../../../../dist/esm/index.js";

globalThis.__tbcBrowserRootConsumer = {
  createTbcClient,
  getTbcWallets,
  isTbcProviderFeature,
};
