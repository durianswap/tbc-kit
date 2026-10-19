import type { TbcJsonRpcId, TbcJsonRpcRequest } from "./protocol-types.js";
import type {
  TbcProviderTransport,
  TbcTransportCloseReason,
  TbcTransportDelivery,
  TbcTransportSignal,
} from "./types.js";
import {
  decodeTbcWebViewNativeMessage,
  encodeTbcWebViewPageMessage,
} from "./webview-codec.js";
import {
  TBC_WEBVIEW_CHANNEL,
  type TbcWebViewNativeMessage,
  type TbcWebViewStringChannel,
} from "./webview-types.js";

export interface TbcWebViewPageOptions {
  readonly channel: TbcWebViewStringChannel;
  readonly isTopFrame: () => boolean;
}

export interface TbcWebViewPageController {
  readonly transport: TbcProviderTransport;
  readonly acceptInitialize: (serialized: string) => void;
  readonly destroy: () => Promise<void>;
}

interface PendingSend {
  readonly request: TbcJsonRpcRequest;
  readonly resolve: (delivery: TbcTransportDelivery) => void;
  readonly reject: (error: Error) => void;
}

const MAX_TRACKED_MESSAGES = 100_000;

function closedError(): Error {
  return new Error("The TBC WebView page Transport is closed.");
}

function requestKey(id: TbcJsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

export function createTbcWebViewPageTransport(
  options: TbcWebViewPageOptions,
): TbcWebViewPageController {
  if (
    options === null ||
    typeof options !== "object" ||
    options.channel === null ||
    typeof options.channel !== "object" ||
    typeof options.channel.post !== "function" ||
    typeof options.channel.subscribe !== "function" ||
    typeof options.isTopFrame !== "function"
  ) {
    throw new TypeError("TBC WebView page Transport options are invalid.");
  }

  const listeners = new Set<(signal: TbcTransportSignal) => void>();
  const pending = new Map<string, PendingSend>();
  const cancelled = new Set<string>();
  const nativeMessages = new Map<string, string>();
  const deliveries = new Map<string, string>();
  let sessionId: string | undefined;
  let navigationId: string | undefined;
  let initialization: string | undefined;
  let nextMessageId = 0;
  let closeReason: TbcTransportCloseReason = "TRANSPORT_CLOSED";
  let closed = false;
  let unsubscribe: (() => void) | undefined;

  function publish(signal: TbcTransportSignal): void {
    for (const listener of [...listeners]) {
      try {
        listener(signal);
      } catch {
        // One Provider listener cannot block another listener or reopen the channel.
      }
    }
  }

  function close(reason: TbcTransportCloseReason): void {
    if (closed) return;
    closed = true;
    closeReason = reason;
    const detach = unsubscribe;
    unsubscribe = undefined;
    try {
      detach?.();
    } catch {
      // Closure is terminal even if the injected subscription cleanup fails.
    }
    for (const entry of pending.values()) entry.reject(closedError());
    pending.clear();
    cancelled.clear();
    publish(Object.freeze({ type: "close", reason }));
    listeners.clear();
  }

  function pageMessageId(): string {
    if (nextMessageId >= Number.MAX_SAFE_INTEGER) {
      close("TRANSPORT_CLOSED");
      throw closedError();
    }
    nextMessageId += 1;
    return `page-${String(nextMessageId)}`;
  }

  function post(fields: Record<string, unknown>, onFailure?: () => void): void {
    if (closed || sessionId === undefined || navigationId === undefined) {
      onFailure?.();
      return;
    }
    let serialized: string;
    try {
      serialized = encodeTbcWebViewPageMessage({
        channel: TBC_WEBVIEW_CHANNEL,
        sessionId,
        navigationId,
        messageId: pageMessageId(),
        ...fields,
      } as never);
      const posted = options.channel.post(serialized);
      if (posted !== undefined) {
        void Promise.resolve(posted).catch(() => {
          onFailure?.();
          close("TRANSPORT_CLOSED");
        });
      }
    } catch {
      onFailure?.();
      close("TRANSPORT_CLOSED");
    }
  }

  function acknowledge(deliveryId: string): void {
    post({ type: "ack", deliveryId });
  }

  function accept(message: TbcWebViewNativeMessage, serialized: string): void {
    if (closed) return;
    const priorMessage = nativeMessages.get(message.messageId);
    if (priorMessage !== undefined) {
      if (priorMessage !== serialized) {
        close("TRANSPORT_CLOSED");
        return;
      }
      if (message.type === "initialize") post({ type: "ready" });
      if (message.type === "delivery") acknowledge(message.deliveryId);
      return;
    }
    if (nativeMessages.size >= MAX_TRACKED_MESSAGES) {
      close("TRANSPORT_CLOSED");
      return;
    }
    nativeMessages.set(message.messageId, serialized);

    if (message.type === "initialize") {
      let isTop = false;
      try {
        isTop = options.isTopFrame();
      } catch {
        isTop = false;
      }
      if (!isTop) {
        close("TRANSPORT_CLOSED");
        return;
      }
      if (initialization !== undefined) {
        if (initialization !== serialized) close("TRANSPORT_CLOSED");
        else post({ type: "ready" });
        return;
      }
      initialization = serialized;
      sessionId = message.sessionId;
      navigationId = message.navigationId;
      post({ type: "ready" });
      return;
    }

    if (
      sessionId === undefined ||
      navigationId === undefined ||
      message.sessionId !== sessionId ||
      message.navigationId !== navigationId
    ) {
      close("TRANSPORT_CLOSED");
      return;
    }

    if (message.type === "close") {
      close(message.reason);
      return;
    }
    if (message.type === "event") {
      publish(Object.freeze({ type: "event", event: message.event }));
      return;
    }

    const priorDelivery = deliveries.get(message.deliveryId);
    if (priorDelivery !== undefined) {
      if (priorDelivery !== serialized) {
        close("TRANSPORT_CLOSED");
        return;
      }
      acknowledge(message.deliveryId);
      return;
    }
    deliveries.set(message.deliveryId, serialized);
    const responseId = message.response.id;
    if (responseId === null) {
      close("TRANSPORT_CLOSED");
      return;
    }
    const key = requestKey(responseId);
    if (cancelled.delete(key)) {
      acknowledge(message.deliveryId);
      return;
    }
    const entry = pending.get(key);
    if (entry === undefined || entry.request.id !== responseId) {
      close("TRANSPORT_CLOSED");
      return;
    }
    pending.delete(key);
    acknowledge(message.deliveryId);
    entry.resolve(Object.freeze({
      deliveryId: message.deliveryId,
      response: message.response,
      events: message.events,
    }));
  }

  function receive(serialized: string): void {
    if (closed) return;
    try {
      accept(decodeTbcWebViewNativeMessage(serialized), serialized);
    } catch {
      close("TRANSPORT_CLOSED");
    }
  }

  try {
    unsubscribe = options.channel.subscribe(receive);
    if (typeof unsubscribe !== "function") {
      throw new TypeError("TBC WebView channel subscribe must return an unsubscribe function.");
    }
  } catch {
    closed = true;
    throw new TypeError("TBC WebView page Transport could not subscribe to the channel.");
  }

  const transport: TbcProviderTransport = Object.freeze({
    send(request: TbcJsonRpcRequest): Promise<TbcTransportDelivery> {
      if (closed || sessionId === undefined || navigationId === undefined) {
        return Promise.reject(closedError());
      }
      const key = requestKey(request.id);
      if (pending.has(key) || cancelled.has(key)) {
        return Promise.reject(new Error("The TBC WebView request ID was already used."));
      }
      let resolveSend!: (delivery: TbcTransportDelivery) => void;
      let rejectSend!: (error: Error) => void;
      const result = new Promise<TbcTransportDelivery>((resolve, reject) => {
        resolveSend = resolve;
        rejectSend = reject;
      });
      const entry = { request, resolve: resolveSend, reject: rejectSend };
      pending.set(key, entry);
      post(
        { type: "request", request },
        () => {
          if (pending.get(key) !== entry) return;
          pending.delete(key);
          rejectSend(closedError());
        },
      );
      return result;
    },

    subscribe(listener: (signal: TbcTransportSignal) => void): () => void {
      if (typeof listener !== "function") {
        throw new TypeError("TBC WebView Transport listener is invalid.");
      }
      if (closed) {
        listener(Object.freeze({ type: "close", reason: closeReason }));
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    cancel(requestId: TbcJsonRpcId, reason: "REQUEST_ABORTED"): void {
      if (reason !== "REQUEST_ABORTED") {
        throw new TypeError("TBC WebView cancellation reason is invalid.");
      }
      const key = requestKey(requestId);
      const entry = pending.get(key);
      if (entry === undefined) return;
      pending.delete(key);
      cancelled.add(key);
      entry.reject(new Error("The TBC WebView request was aborted."));
      post({ type: "cancel", requestId, reason });
    },

    close(): void {
      close("TRANSPORT_CLOSED");
    },
  });

  return Object.freeze({
    transport,
    acceptInitialize(serialized: string): void {
      if (closed) return;
      try {
        const message = decodeTbcWebViewNativeMessage(serialized);
        if (message.type !== "initialize") throw new TypeError("not initialize");
        accept(message, serialized);
      } catch {
        close("TRANSPORT_CLOSED");
      }
    },
    async destroy(): Promise<void> {
      close("TRANSPORT_CLOSED");
    },
  });
}
