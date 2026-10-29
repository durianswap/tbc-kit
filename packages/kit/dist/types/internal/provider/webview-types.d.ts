import type { TbcJsonRpcId, TbcJsonRpcRequest, TbcJsonRpcResponse } from "./protocol-types.js";
import type { TbcProviderEvent, TbcTransportCloseReason } from "./types.js";
export declare const TBC_WEBVIEW_CHANNEL: "tws-webview/1";
export declare const TBC_WEBVIEW_MAX_MESSAGE_BYTES: number;
export interface TbcWebViewStringChannel {
    readonly post: (serialized: string) => void | Promise<void>;
    readonly subscribe: (listener: (serialized: string) => void) => () => void;
}
export interface TbcWebViewVerifiedNavigation {
    readonly webViewInstanceId: string;
    readonly sessionId: string;
    readonly navigationId: string;
    readonly committedUrl: string;
    readonly origin: string;
    readonly topOrigin: string;
    readonly frame: "top";
    readonly createdAt: string;
}
interface TbcWebViewMessageBase {
    readonly channel: typeof TBC_WEBVIEW_CHANNEL;
    readonly sessionId: string;
    readonly navigationId: string;
    readonly messageId: string;
}
export type TbcWebViewPageMessage = Readonly<TbcWebViewMessageBase & {
    readonly type: "ready";
}> | Readonly<TbcWebViewMessageBase & {
    readonly type: "request";
    readonly request: TbcJsonRpcRequest;
}> | Readonly<TbcWebViewMessageBase & {
    readonly type: "cancel";
    readonly requestId: TbcJsonRpcId;
    readonly reason: "REQUEST_ABORTED";
}> | Readonly<TbcWebViewMessageBase & {
    readonly type: "ack";
    readonly deliveryId: string;
}>;
export type TbcWebViewNativeMessage = Readonly<TbcWebViewMessageBase & {
    readonly type: "initialize";
    readonly origin: string;
    readonly chainId: string;
}> | Readonly<TbcWebViewMessageBase & {
    readonly type: "delivery";
    readonly deliveryId: string;
    readonly response: TbcJsonRpcResponse;
    readonly events: readonly TbcProviderEvent[];
}> | Readonly<TbcWebViewMessageBase & {
    readonly type: "event";
    readonly event: TbcProviderEvent;
}> | Readonly<TbcWebViewMessageBase & {
    readonly type: "close";
    readonly reason: TbcTransportCloseReason;
}>;
export type TbcWebViewStoreDecision = "accepted" | "replay" | "collision";
export type TbcWebViewOutboxState = "pending" | "sent" | "acknowledged";
export interface TbcWebViewStoredDelivery {
    readonly sessionId: string;
    readonly navigationId: string;
    readonly deliveryId: string;
    readonly canonicalEnvelope: string;
    readonly envelopeDigest: string;
    readonly state: TbcWebViewOutboxState;
}
export type TbcWebViewDeliveryInput = Omit<TbcWebViewStoredDelivery, "state">;
export interface TbcWebViewSessionStore {
    readonly openSession: (navigation: TbcWebViewVerifiedNavigation) => Promise<void>;
    readonly closeSession: (input: Readonly<{
        sessionId: string;
        navigationId: string;
        reason: TbcTransportCloseReason;
    }>) => Promise<void>;
    readonly acceptInbound: (input: Readonly<{
        sessionId: string;
        navigationId: string;
        messageId: string;
        canonicalEnvelope: string;
        envelopeDigest: string;
    }>) => Promise<TbcWebViewStoreDecision>;
    readonly enqueueDelivery: (delivery: TbcWebViewDeliveryInput) => Promise<TbcWebViewStoreDecision>;
    readonly markDeliverySent: (input: Readonly<{
        sessionId: string;
        deliveryId: string;
        envelopeDigest: string;
    }>) => Promise<TbcWebViewStoreDecision>;
    readonly acknowledgeDelivery: (input: Readonly<{
        sessionId: string;
        deliveryId: string;
        envelopeDigest: string;
    }>) => Promise<TbcWebViewStoreDecision>;
    readonly listOutstanding: (sessionId: string) => Promise<readonly TbcWebViewStoredDelivery[]>;
}
export {};
//# sourceMappingURL=webview-types.d.ts.map