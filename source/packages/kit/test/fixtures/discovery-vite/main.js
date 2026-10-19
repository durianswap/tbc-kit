import {
  TBC_PROVIDER_FEATURE,
  getTbcWallets,
  isTbcProviderFeature,
  subscribeTbcWallets,
} from "../../../dist/esm/index.js";

globalThis.__TBC_DISCOVERY_FIXTURE__ = Object.freeze({
  TBC_PROVIDER_FEATURE,
  getTbcWallets,
  isTbcProviderFeature,
  subscribeTbcWallets,
});
