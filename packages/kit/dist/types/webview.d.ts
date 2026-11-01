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
export declare const TBC_KIT_WEBVIEW_CHANNEL: "tws-webview/1";
/**
 * Creates the page-side Provider and WebView transport from the exact schema
 * bundled into this Kit release. Consumers must not pair it with a separately
 * installed @tbc-wallet/provider artifact.
 */
export declare function createTbcKitWebViewPageProvider(options: TbcKitWebViewPageProviderOptions): TbcKitWebViewPageProvider;
