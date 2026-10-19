import {
  LEGACY_CONTRACT_BUNDLE_SHA256,
  LEGACY_CONTRACT_VERSION,
} from "./legacy-webview-contract.js";

export const LEGACY_WEBVIEW_CHANNEL = "legacy-window-turing-webview/1" as const;

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const METHODS = new Set([
  "connect",
  "disconnect",
  "isConnected",
  "getPubKey",
  "getAddress",
  "getNetwork",
  "getInfo",
  "getBalance",
  "sendTransaction",
  "signTransaction",
  "signAssociatedTransaction",
  "signMessage",
  "encrypt",
  "decrypt",
  "sendBatchRequest",
  "mergeUtxos",
  "mergeFtUtxos",
  "mergeStableCoinUtxos",
]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;

export type LegacyMethod =
  | "connect"
  | "disconnect"
  | "isConnected"
  | "getPubKey"
  | "getAddress"
  | "getNetwork"
  | "getInfo"
  | "getBalance"
  | "sendTransaction"
  | "signTransaction"
  | "signAssociatedTransaction"
  | "signMessage"
  | "encrypt"
  | "decrypt"
  | "sendBatchRequest"
  | "mergeUtxos"
  | "mergeFtUtxos"
  | "mergeStableCoinUtxos";

export type LegacyPageMessage =
  | Readonly<{
      channel: typeof LEGACY_WEBVIEW_CHANNEL;
      type: "ready";
      sessionId: string;
      navigationId: string;
    }>
  | Readonly<{
      channel: typeof LEGACY_WEBVIEW_CHANNEL;
      type: "request";
      sessionId: string;
      navigationId: string;
      requestId: string;
      method: LegacyMethod;
      params?: unknown;
    }>
  | Readonly<{
      channel: typeof LEGACY_WEBVIEW_CHANNEL;
      type: "ack";
      sessionId: string;
      navigationId: string;
      requestId: string;
      deliveryId: string;
    }>;

export type LegacyNativeMessage =
  | Readonly<{
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
    }>
  | Readonly<{
      channel: typeof LEGACY_WEBVIEW_CHANNEL;
      type: "response";
      sessionId: string;
      navigationId: string;
      requestId: string;
      method: LegacyMethod;
      deliveryId?: string;
      result: unknown;
    }>
  | Readonly<{
      channel: typeof LEGACY_WEBVIEW_CHANNEL;
      type: "close";
      sessionId: string;
      navigationId: string;
      reason:
        | "TRANSPORT_CLOSED"
        | "NAVIGATION_CHANGED"
        | "ORIGIN_CHANGED"
        | "SESSION_REVOKED";
    }>
  | Readonly<{
      channel: typeof LEGACY_WEBVIEW_CHANNEL;
      type: "event";
      sessionId: string;
      navigationId: string;
      event: "TuringAccountChanged" | "TuringNetworkChanged";
      detail: unknown;
    }>;

function plainJson(value: unknown): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH)
      throw new Error("Invalid Legacy JSON");
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("Invalid Legacy JSON");
      return;
    }
    if (typeof current !== "object") throw new Error("Invalid Legacy JSON");
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (Object.getPrototypeOf(current) !== Object.prototype) {
      throw new Error("Invalid Legacy JSON");
    }
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) {
        throw new Error("Invalid Legacy JSON");
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new Error("Invalid Legacy JSON");
      }
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
}

function exactKeys(value: object, keys: readonly string[]): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new Error("Invalid Legacy message shape");
  }
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error("Invalid Legacy message identity");
  }
  return value;
}

export function isLegacyWebViewMessage(serialized: string): boolean {
  if (typeof serialized !== "string" || serialized.length > MAX_BYTES)
    return false;
  try {
    const value: unknown = JSON.parse(serialized);
    return (
      value !== null &&
      typeof value === "object" &&
      Reflect.get(value, "channel") === LEGACY_WEBVIEW_CHANNEL
    );
  } catch {
    return false;
  }
}

export function decodeLegacyPageMessage(serialized: string): LegacyPageMessage {
  if (
    typeof serialized !== "string" ||
    new TextEncoder().encode(serialized).length > MAX_BYTES
  ) {
    throw new Error("Invalid Legacy message size");
  }
  const value: unknown = JSON.parse(serialized);
  plainJson(value);
  if (value === null || typeof value !== "object") {
    throw new Error("Invalid Legacy message");
  }
  if (Reflect.get(value, "channel") !== LEGACY_WEBVIEW_CHANNEL) {
    throw new Error("Invalid Legacy message channel");
  }
  const type = Reflect.get(value, "type");
  if (type === "ready") {
    exactKeys(value, ["channel", "type", "sessionId", "navigationId"]);
  } else if (type === "request") {
    const hasParams = Object.hasOwn(value, "params");
    exactKeys(value, [
      "channel",
      "type",
      "sessionId",
      "navigationId",
      "requestId",
      "method",
      ...(hasParams ? ["params"] : []),
    ]);
    identifier(Reflect.get(value, "requestId"));
    if (!METHODS.has(String(Reflect.get(value, "method")))) {
      throw new Error("Invalid Legacy method");
    }
  } else if (type === "ack") {
    exactKeys(value, [
      "channel",
      "type",
      "sessionId",
      "navigationId",
      "requestId",
      "deliveryId",
    ]);
    identifier(Reflect.get(value, "requestId"));
    if (!/^[0-9a-f]{64}$/.test(String(Reflect.get(value, "deliveryId")))) {
      throw new Error("Invalid Legacy delivery identity");
    }
  } else {
    throw new Error("Invalid Legacy message type");
  }
  identifier(Reflect.get(value, "sessionId"));
  identifier(Reflect.get(value, "navigationId"));
  return Object.freeze(value) as LegacyPageMessage;
}

export function decodeLegacyNativeMessage(
  serialized: string,
): LegacyNativeMessage {
  if (
    typeof serialized !== "string" ||
    new TextEncoder().encode(serialized).length > MAX_BYTES
  ) {
    throw new Error("Invalid Legacy message size");
  }
  const value: unknown = JSON.parse(serialized);
  plainJson(value);
  if (value === null || typeof value !== "object") {
    throw new Error("Invalid Legacy message");
  }
  if (Reflect.get(value, "channel") !== LEGACY_WEBVIEW_CHANNEL) {
    throw new Error("Invalid Legacy message channel");
  }
  const type = Reflect.get(value, "type");
  if (type === "initialize") {
    exactKeys(value, [
      "channel",
      "type",
      "sessionId",
      "navigationId",
      "origin",
      "chainId",
      "platform",
      "walletVersion",
      "contractVersion",
      "contractBundleSha256",
    ]);
    if (
      Reflect.get(value, "contractVersion") !== LEGACY_CONTRACT_VERSION ||
      Reflect.get(value, "contractBundleSha256") !==
        LEGACY_CONTRACT_BUNDLE_SHA256 ||
      (Reflect.get(value, "platform") !== "ios" &&
        Reflect.get(value, "platform") !== "android") ||
      typeof Reflect.get(value, "origin") !== "string" ||
      typeof Reflect.get(value, "chainId") !== "string" ||
      typeof Reflect.get(value, "walletVersion") !== "string"
    ) {
      throw new Error("Invalid Legacy initialization");
    }
  } else if (type === "response") {
    const hasDelivery = Object.hasOwn(value, "deliveryId");
    exactKeys(value, [
      "channel",
      "type",
      "sessionId",
      "navigationId",
      "requestId",
      "method",
      ...(hasDelivery ? ["deliveryId"] : []),
      "result",
    ]);
    identifier(Reflect.get(value, "requestId"));
    if (!METHODS.has(String(Reflect.get(value, "method")))) {
      throw new Error("Invalid Legacy method");
    }
    if (
      hasDelivery &&
      !/^[0-9a-f]{64}$/.test(String(Reflect.get(value, "deliveryId")))
    ) {
      throw new Error("Invalid Legacy delivery identity");
    }
  } else if (type === "close") {
    exactKeys(value, [
      "channel",
      "type",
      "sessionId",
      "navigationId",
      "reason",
    ]);
    if (
      ![
        "TRANSPORT_CLOSED",
        "NAVIGATION_CHANGED",
        "ORIGIN_CHANGED",
        "SESSION_REVOKED",
      ].includes(String(Reflect.get(value, "reason")))
    ) {
      throw new Error("Invalid Legacy close reason");
    }
  } else if (type === "event") {
    exactKeys(value, [
      "channel",
      "type",
      "sessionId",
      "navigationId",
      "event",
      "detail",
    ]);
    if (
      Reflect.get(value, "event") !== "TuringAccountChanged" &&
      Reflect.get(value, "event") !== "TuringNetworkChanged"
    ) {
      throw new Error("Invalid Legacy event");
    }
  } else {
    throw new Error("Invalid Legacy message type");
  }
  identifier(Reflect.get(value, "sessionId"));
  identifier(Reflect.get(value, "navigationId"));
  return Object.freeze(value) as LegacyNativeMessage;
}

export function encodeLegacyNativeMessage(
  message: LegacyNativeMessage,
): string {
  plainJson(message);
  const serialized = JSON.stringify(message);
  if (new TextEncoder().encode(serialized).length > MAX_BYTES) {
    throw new Error("Invalid Legacy message size");
  }
  return serialized;
}
