import { LEGACY_CONTRACT_BUNDLE_SHA256, LEGACY_CONTRACT_VERSION } from "./legacy-webview-contract.js";
export declare const LEGACY_WEBVIEW_CHANNEL: "legacy-window-turing-webview/1";
export type LegacyMethod = "connect" | "disconnect" | "isConnected" | "getPubKey" | "getAddress" | "getNetwork" | "getInfo" | "getBalance" | "sendTransaction" | "signTransaction" | "signAssociatedTransaction" | "signMessage" | "encrypt" | "decrypt" | "sendBatchRequest" | "mergeUtxos" | "mergeFtUtxos" | "mergeStableCoinUtxos";
export type LegacyPageMessage = Readonly<{
    channel: typeof LEGACY_WEBVIEW_CHANNEL;
    type: "ready";
    sessionId: string;
    navigationId: string;
}> | Readonly<{
    channel: typeof LEGACY_WEBVIEW_CHANNEL;
    type: "request";
    sessionId: string;
    navigationId: string;
    requestId: string;
    method: LegacyMethod;
    params?: unknown;
}> | Readonly<{
    channel: typeof LEGACY_WEBVIEW_CHANNEL;
    type: "ack";
    sessionId: string;
    navigationId: string;
    requestId: string;
    deliveryId: string;
}>;
export type LegacyNativeMessage = Readonly<{
    channel: typeof LEGACY_WEBVIEW_CHANNEL;
    type: "initialize";
    sessionId: string;
    navigationId: string;
    origin: string;
    chainId: string;
    platform: "ios" | "android";
    walletVersion: string;
    contractVersion: typeof LEGACY_CONTRACT_VERSION;
    contractBundleSha256: typeof LEGACY_CONTRACT_BUNDLE_SHA256;
}> | Readonly<{
    channel: typeof LEGACY_WEBVIEW_CHANNEL;
    type: "response";
    sessionId: string;
    navigationId: string;
    requestId: string;
    method: LegacyMethod;
    deliveryId?: string;
    result: unknown;
}> | Readonly<{
    channel: typeof LEGACY_WEBVIEW_CHANNEL;
    type: "close";
    sessionId: string;
    navigationId: string;
    reason: "TRANSPORT_CLOSED" | "NAVIGATION_CHANGED" | "ORIGIN_CHANGED" | "SESSION_REVOKED";
}> | Readonly<{
    channel: typeof LEGACY_WEBVIEW_CHANNEL;
    type: "event";
    sessionId: string;
    navigationId: string;
    event: "TuringAccountChanged" | "TuringNetworkChanged";
    detail: unknown;
}>;
export declare function isLegacyWebViewMessage(serialized: string): boolean;
export declare function decodeLegacyPageMessage(serialized: string): LegacyPageMessage;
export declare function decodeLegacyNativeMessage(serialized: string): LegacyNativeMessage;
export declare function encodeLegacyNativeMessage(message: LegacyNativeMessage): string;
