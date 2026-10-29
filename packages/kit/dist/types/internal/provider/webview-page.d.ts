import type { TbcProviderTransport } from "./types.js";
import { type TbcWebViewStringChannel } from "./webview-types.js";
export interface TbcWebViewPageOptions {
    readonly channel: TbcWebViewStringChannel;
    readonly isTopFrame: () => boolean;
}
export interface TbcWebViewPageController {
    readonly transport: TbcProviderTransport;
    readonly acceptInitialize: (serialized: string) => void;
    readonly destroy: () => Promise<void>;
}
export declare function createTbcWebViewPageTransport(options: TbcWebViewPageOptions): TbcWebViewPageController;
//# sourceMappingURL=webview-page.d.ts.map