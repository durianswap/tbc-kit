import type { TbcJsonRpcId, TbcJsonRpcRequest } from "./protocol-types.js";
import type { TbcProviderEvent, TbcTransportCloseReason, TbcTransportDelivery } from "./types.js";
import { type TbcWebViewSessionStore, type TbcWebViewStringChannel, type TbcWebViewVerifiedNavigation } from "./webview-types.js";
export interface TbcWebViewNativeHandlers {
    readonly send: (request: TbcJsonRpcRequest, navigation: TbcWebViewVerifiedNavigation) => Promise<TbcWebViewNativeDispatch>;
    readonly acknowledgeDelivery?: (deliveryId: string, navigation: TbcWebViewVerifiedNavigation) => Promise<void>;
    readonly cancel: (requestId: TbcJsonRpcId, reason: "REQUEST_ABORTED", navigation: TbcWebViewVerifiedNavigation) => Promise<void>;
    readonly close: (reason: TbcTransportCloseReason, navigation: TbcWebViewVerifiedNavigation) => Promise<void>;
}
export type TbcWebViewNativeDispatch = TbcTransportDelivery | Readonly<{
    status: "suppressed";
    deliveryId: string;
}>;
export interface TbcWebViewNativeOptions {
    readonly channel: TbcWebViewStringChannel;
    readonly store: TbcWebViewSessionStore;
    readonly chainId: string;
    readonly handlers: TbcWebViewNativeHandlers;
    readonly allowInsecureLoopback?: boolean;
    readonly messageIdFactory?: () => string;
}
export interface TbcWebViewPageInput {
    readonly webViewInstanceId: string;
    readonly serialized: string;
}
export interface TbcWebViewNativeController {
    readonly openNavigation: (navigation: TbcWebViewVerifiedNavigation) => Promise<void>;
    readonly acceptPageMessage: (input: TbcWebViewPageInput) => Promise<void>;
    readonly deliver: (delivery: TbcTransportDelivery) => Promise<void>;
    readonly emitEvent: (event: TbcProviderEvent) => Promise<void>;
    readonly close: (reason?: TbcTransportCloseReason) => Promise<void>;
    readonly destroy: () => Promise<void>;
}
export declare function createTbcWebViewNativeController(options: TbcWebViewNativeOptions): TbcWebViewNativeController;
