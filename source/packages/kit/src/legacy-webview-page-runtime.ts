import {
  LEGACY_CONTRACT_BUNDLE_SHA256,
  LEGACY_CONTRACT_VERSION,
} from "./legacy-webview-contract.js";
import {
  decodeLegacyNativeMessage,
  LEGACY_WEBVIEW_CHANNEL,
  type LegacyMethod,
} from "./legacy-webview-protocol.js";

interface LegacyBridgeWindow extends Window {
  readonly ReactNativeWebView?: Readonly<{
    postMessage: (serialized: string) => void;
  }>;
}

interface PendingRequest {
  readonly method: LegacyMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

const BOOTSTRAP_MARKER = Symbol.for("org.tbc.tws.webview.legacy-bootstrap.v1");
const MAX_PENDING = 128;

function install(): void {
  const page = window as unknown as LegacyBridgeWindow &
    Record<PropertyKey, unknown>;
  if (window.top !== window || page[BOOTSTRAP_MARKER] === true) return;
  Object.defineProperty(page, BOOTSTRAP_MARKER, {
    value: true,
    writable: false,
    configurable: false,
    enumerable: false,
  });

  const pending = new Map<string, PendingRequest>();
  const used = new Set<string>();
  const eventWrappers = new Map<
    string,
    Map<(value: unknown) => void, EventListener>
  >();
  let sessionId: string | undefined;
  let navigationId: string | undefined;
  let initialization: string | undefined;
  let sequence = 0;
  let closed = false;
  let rebindAllowed = false;

  function bridgePost(message: object): void {
    const bridge = page.ReactNativeWebView;
    if (bridge === undefined || typeof bridge.postMessage !== "function") {
      throw new Error("Legacy wallet session closed");
    }
    bridge.postMessage(JSON.stringify(message));
  }

  function close(): void {
    if (closed) return;
    closed = true;
    const error = new Error("Legacy wallet session closed");
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  }

  function requestId(): string {
    if (sequence === Number.MAX_SAFE_INTEGER) {
      close();
      throw new Error("Legacy wallet session closed");
    }
    sequence += 1;
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    const suffix = Array.from(bytes, (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    bytes.fill(0);
    const id = `legacy-${sequence.toString(10)}-${suffix}`;
    if (used.has(id)) {
      close();
      throw new Error("Legacy wallet session closed");
    }
    used.add(id);
    return id;
  }

  function request(method: LegacyMethod, params?: unknown): Promise<unknown> {
    if (closed || sessionId === undefined || navigationId === undefined) {
      return Promise.reject(new Error("Legacy wallet session closed"));
    }
    if (pending.size >= MAX_PENDING) {
      return Promise.resolve({
        error: "Another wallet request is already pending",
      });
    }
    let id: string;
    try {
      id = requestId();
    } catch {
      return Promise.reject(new Error("Legacy wallet session closed"));
    }
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      try {
        bridgePost({
          channel: LEGACY_WEBVIEW_CHANNEL,
          type: "request",
          sessionId,
          navigationId,
          requestId: id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch {
        pending.delete(id);
        reject(new Error("Legacy wallet session closed"));
      }
    });
  }

  function subscribe(
    facade: object,
    event: string,
    listener: (value: unknown) => void,
  ): object {
    if (typeof event !== "string" || typeof listener !== "function") {
      throw new TypeError("Invalid Legacy event listener");
    }
    let listeners = eventWrappers.get(event);
    if (listeners === undefined) {
      listeners = new Map();
      eventWrappers.set(event, listeners);
    }
    if (!listeners.has(listener)) {
      const wrapper: EventListener = (value) =>
        listener((value as CustomEvent<unknown>).detail);
      listeners.set(listener, wrapper);
      window.addEventListener(event, wrapper);
    }
    return facade;
  }

  function unsubscribe(
    facade: object,
    event: string,
    listener: (value: unknown) => void,
  ): object {
    const listeners = eventWrappers.get(event);
    const wrapper = listeners?.get(listener);
    if (wrapper !== undefined) {
      window.removeEventListener(event, wrapper);
      listeners?.delete(listener);
    }
    return facade;
  }

  function createFacade(): object {
    let facade: object;
    const method = (name: LegacyMethod) => (params?: unknown) =>
      request(name, params);
    facade = Object.freeze({
      isReady: true,
      connect: method("connect"),
      disconnect: method("disconnect"),
      isConnected: method("isConnected"),
      getPubKey: method("getPubKey"),
      getAddress: method("getAddress"),
      getNetwork: method("getNetwork"),
      getInfo: method("getInfo"),
      getBalance: method("getBalance"),
      sendTransaction: method("sendTransaction"),
      signTransaction: method("signTransaction"),
      signAssociatedTransaction: method("signAssociatedTransaction"),
      signMessage: method("signMessage"),
      encrypt: method("encrypt"),
      decrypt: method("decrypt"),
      sendBatchRequest: method("sendBatchRequest"),
      mergeUtxos: method("mergeUtxos"),
      mergeFtUtxos: method("mergeFtUtxos"),
      mergeStableCoinUtxos: method("mergeStableCoinUtxos"),
      on: (event: string, listener: (value: unknown) => void) =>
        subscribe(facade, event, listener),
      removeListener: (event: string, listener: (value: unknown) => void) =>
        unsubscribe(facade, event, listener),
    });
    return facade;
  }

  function receive(event: Event): void {
    const data = (event as MessageEvent<unknown>).data;
    if (typeof data !== "string") return;
    let message: ReturnType<typeof decodeLegacyNativeMessage>;
    try {
      message = decodeLegacyNativeMessage(data);
    } catch {
      return;
    }
    if (message.type === "initialize") {
      if (
        message.contractVersion !== LEGACY_CONTRACT_VERSION ||
        message.contractBundleSha256 !== LEGACY_CONTRACT_BUNDLE_SHA256
      ) {
        close();
        return;
      }
      if (initialization !== undefined) {
        if (initialization === data || !closed || !rebindAllowed) {
          if (initialization !== data) close();
          return;
        }
        initialization = data;
        sessionId = message.sessionId;
        navigationId = message.navigationId;
        closed = false;
        rebindAllowed = false;
        try {
          bridgePost({
            channel: LEGACY_WEBVIEW_CHANNEL,
            type: "ready",
            sessionId,
            navigationId,
          });
        } catch {
          close();
        }
        return;
      }
      initialization = data;
      sessionId = message.sessionId;
      navigationId = message.navigationId;
      try {
        Object.defineProperty(page, "Turing", {
          value: createFacade(),
          writable: false,
          configurable: false,
          enumerable: true,
        });
        bridgePost({
          channel: LEGACY_WEBVIEW_CHANNEL,
          type: "ready",
          sessionId,
          navigationId,
        });
        window.dispatchEvent(new CustomEvent("TuringReady"));
      } catch {
        close();
      }
      return;
    }
    if (
      sessionId === undefined ||
      navigationId === undefined ||
      message.sessionId !== sessionId ||
      message.navigationId !== navigationId
    ) {
      return;
    }
    if (message.type === "close") {
      rebindAllowed =
        message.reason === "NAVIGATION_CHANGED" ||
        message.reason === "TRANSPORT_CLOSED";
      close();
      return;
    }
    if (message.type === "event") {
      window.dispatchEvent(
        new CustomEvent(message.event, { detail: message.detail }),
      );
      return;
    }
    const current = pending.get(message.requestId);
    if (current === undefined || current.method !== message.method) {
      close();
      return;
    }
    pending.delete(message.requestId);
    window.dispatchEvent(
      new CustomEvent("TuringResponse", {
        detail: Object.freeze({
          id: message.requestId,
          method: message.method,
          result: message.result,
        }),
      }),
    );
    current.resolve(message.result);
    if (message.deliveryId !== undefined) {
      try {
        bridgePost({
          channel: LEGACY_WEBVIEW_CHANNEL,
          type: "ack",
          sessionId,
          navigationId,
          requestId: message.requestId,
          deliveryId: message.deliveryId,
        });
      } catch {
        close();
      }
    }
  }

  window.addEventListener("message", receive);
  document.addEventListener("message", receive);
}

install();
