import type { TbcJsonRpcId, TbcJsonRpcRequest, TbcJsonRpcResponse, TbcProviderEvent, TbcTransportCloseReason, TbcTransportDelivery } from "./provider-transport.js";
export declare const TBC_WEBVIEW_CHANNEL: "tws-webview/1";
export type TbcKitWebViewCloseReason = TbcTransportCloseReason;
export interface TbcKitWebViewVerifiedNavigation {
    readonly webViewInstanceId: string;
    readonly sessionId: string;
    readonly navigationId: string;
    readonly committedUrl: string;
    readonly origin: string;
    readonly topOrigin: string;
    readonly frame: "top";
    readonly createdAt: string;
}
export interface TbcKitWebViewStringChannel {
    readonly post: (serialized: string) => void | Promise<void>;
    readonly subscribe: (listener: (serialized: string) => void) => () => void;
}
export type TbcKitWebViewStoreDecision = "accepted" | "replay" | "collision";
export type TbcKitWebViewOutboxState = "pending" | "sent" | "acknowledged";
export interface TbcKitWebViewStoredDelivery {
    readonly sessionId: string;
    readonly navigationId: string;
    readonly deliveryId: string;
    readonly canonicalEnvelope: string;
    readonly envelopeDigest: string;
    readonly state: TbcKitWebViewOutboxState;
}
export type TbcKitWebViewDeliveryInput = Omit<TbcKitWebViewStoredDelivery, "state">;
export interface TbcKitWebViewSessionStore {
    readonly openSession: (navigation: TbcKitWebViewVerifiedNavigation) => Promise<void>;
    readonly closeSession: (input: Readonly<{
        sessionId: string;
        navigationId: string;
        reason: TbcKitWebViewCloseReason;
    }>) => Promise<void>;
    readonly acceptInbound: (input: Readonly<{
        sessionId: string;
        navigationId: string;
        messageId: string;
        canonicalEnvelope: string;
        envelopeDigest: string;
    }>) => Promise<TbcKitWebViewStoreDecision>;
    readonly enqueueDelivery: (delivery: TbcKitWebViewDeliveryInput) => Promise<TbcKitWebViewStoreDecision>;
    readonly markDeliverySent: (input: Readonly<{
        sessionId: string;
        deliveryId: string;
        envelopeDigest: string;
    }>) => Promise<TbcKitWebViewStoreDecision>;
    readonly acknowledgeDelivery: (input: Readonly<{
        sessionId: string;
        deliveryId: string;
        envelopeDigest: string;
    }>) => Promise<TbcKitWebViewStoreDecision>;
    readonly listOutstanding: (sessionId: string) => Promise<readonly TbcKitWebViewStoredDelivery[]>;
}
export type TbcKitWebViewJsonRpcParams = readonly unknown[] | Readonly<Record<string, unknown>>;
export interface TbcKitWebViewJsonRpcRequest {
    readonly jsonrpc: "2.0";
    readonly id: string | number;
    readonly method: string;
    /** Exact JSON-RPC structured params accepted by the bundled strict codec. */
    readonly params?: TbcKitWebViewJsonRpcParams;
}
export type TbcKitWebViewDelivery = TbcTransportDelivery;
export type TbcKitWebViewNativeDispatch = TbcKitWebViewDelivery | Readonly<{
    status: "suppressed";
    deliveryId: string;
}>;
export interface TbcKitWebViewNativeHandlers {
    readonly send: (request: TbcKitWebViewJsonRpcRequest, navigation: TbcKitWebViewVerifiedNavigation) => Promise<TbcKitWebViewNativeDispatch>;
    readonly acknowledgeDelivery?: (deliveryId: string, navigation: TbcKitWebViewVerifiedNavigation) => Promise<void>;
    readonly cancel: (requestId: string | number, reason: "REQUEST_ABORTED", navigation: TbcKitWebViewVerifiedNavigation) => Promise<void>;
    readonly close: (reason: TbcKitWebViewCloseReason, navigation: TbcKitWebViewVerifiedNavigation) => Promise<void>;
}
export interface TbcKitWebViewNativeOptions {
    readonly channel: TbcKitWebViewStringChannel;
    readonly store: TbcKitWebViewSessionStore;
    readonly chainId: string;
    readonly handlers: TbcKitWebViewNativeHandlers;
    readonly allowInsecureLoopback?: boolean;
    readonly messageIdFactory?: () => string;
}
export interface TbcKitWebViewPageInput {
    readonly webViewInstanceId: string;
    readonly serialized: string;
}
export interface TbcKitWebViewNativeController {
    readonly openNavigation: (navigation: TbcKitWebViewVerifiedNavigation) => Promise<void>;
    readonly acceptPageMessage: (input: TbcKitWebViewPageInput) => Promise<void>;
    readonly deliver: (delivery: TbcKitWebViewDelivery) => Promise<void>;
    readonly emitEvent: (event: TbcProviderEvent) => Promise<void>;
    readonly close: (reason?: TbcKitWebViewCloseReason) => Promise<void>;
    readonly destroy: () => Promise<void>;
}
interface TbcWebViewMessageBase {
    readonly channel: "tws-webview/1";
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
export type TbcWebViewVerifiedNavigation = TbcKitWebViewVerifiedNavigation;
export type TbcWebViewStringChannel = TbcKitWebViewStringChannel;
export type TbcWebViewStoreDecision = TbcKitWebViewStoreDecision;
export type TbcWebViewOutboxState = TbcKitWebViewOutboxState;
export type TbcWebViewStoredDelivery = TbcKitWebViewStoredDelivery;
export type TbcWebViewDeliveryInput = TbcKitWebViewDeliveryInput;
export type TbcWebViewSessionStore = TbcKitWebViewSessionStore;
export type TbcWebViewNativeDispatch = TbcKitWebViewNativeDispatch;
export type TbcWebViewNativeHandlers = TbcKitWebViewNativeHandlers;
export type TbcWebViewNativeOptions = TbcKitWebViewNativeOptions;
export type TbcWebViewPageInput = TbcKitWebViewPageInput;
export type TbcWebViewNativeController = TbcKitWebViewNativeController;
/** Decode with the exact WebView codec bundled into this Kit release. */
export declare function decodeTbcWebViewPageMessage(serialized: string): TbcWebViewPageMessage;
/** Decode with the exact WebView codec bundled into this Kit release. */
export declare function decodeTbcWebViewNativeMessage(serialized: string): TbcWebViewNativeMessage;
/** Encode with the exact WebView codec bundled into this Kit release. */
export declare function encodeTbcWebViewPageMessage(value: TbcWebViewPageMessage): string;
/** Encode with the exact WebView codec bundled into this Kit release. */
export declare function encodeTbcWebViewNativeMessage(value: TbcWebViewNativeMessage): string;
export declare function digestTbcWebViewEnvelope(serialized: string): string;
/**
 * Creates the wallet-native half of the bundled WebView transport. The wrapper
 * deliberately keeps Provider implementation types private while preserving
 * the exact native controller, durable outbox and termination behavior.
 */
export declare function createTbcKitWebViewNativeController(options: TbcKitWebViewNativeOptions): TbcKitWebViewNativeController;
export {};
