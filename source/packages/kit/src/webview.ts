import { createTbcProvider } from "@tbc-wallet/provider";
import {
  TBC_WEBVIEW_CHANNEL,
  createTbcWebViewPageTransport,
} from "@tbc-wallet/provider/webview";

import type { KitProvider } from "./public-types.js";

export interface TbcKitWebViewStringChannel {
  readonly post: (serialized: string) => void | Promise<void>;
  readonly subscribe: (listener: (serialized: string) => void) => () => void;
}

export interface TbcKitWebViewPageProviderOptions {
  readonly channel: TbcKitWebViewStringChannel;
  readonly isTopFrame: () => boolean;
  readonly requestIdFactory?: () => string | number;
}

export interface TbcKitWebViewPageProvider {
  readonly provider: KitProvider;
  readonly acceptInitialize: (serialized: string) => void;
  readonly destroy: () => Promise<void>;
}

export const TBC_KIT_WEBVIEW_CHANNEL = TBC_WEBVIEW_CHANNEL;

/**
 * Creates the page-side Provider and WebView transport from the exact schema
 * bundled into this Kit release. Consumers must not pair it with a separately
 * installed @tbc-wallet/provider artifact.
 */
export function createTbcKitWebViewPageProvider(
  options: TbcKitWebViewPageProviderOptions,
): TbcKitWebViewPageProvider {
  const page = createTbcWebViewPageTransport({
    channel: options.channel,
    isTopFrame: options.isTopFrame,
  });
  const provider = createTbcProvider({
    transport: page.transport,
    ...(options.requestIdFactory === undefined
      ? {}
      : { requestIdFactory: options.requestIdFactory }),
  });
  let destroyPromise: Promise<void> | undefined;

  return Object.freeze({
    provider: provider as unknown as KitProvider,
    acceptInitialize: page.acceptInitialize,
    destroy(): Promise<void> {
      destroyPromise ??= (async () => {
        await provider.destroy();
        await page.destroy();
      })();
      return destroyPromise;
    },
  });
}
