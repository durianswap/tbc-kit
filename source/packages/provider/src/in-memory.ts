import type { TbcJsonRpcId, TbcJsonRpcRequest } from "./protocol-types.js";
import type {
  TbcProviderEvent,
  TbcProviderTransport,
  TbcTransportCloseReason,
  TbcTransportDelivery,
  TbcTransportSignal,
} from "./types.js";

export type TbcInMemoryTransportHandler = (
  request: TbcJsonRpcRequest,
) => TbcTransportDelivery | Promise<TbcTransportDelivery>;

export interface TbcInMemoryTransportOptions {
  readonly handler: TbcInMemoryTransportHandler;
  readonly onCancel?: (
    requestId: TbcJsonRpcId,
    reason: "REQUEST_ABORTED",
  ) => void | Promise<void>;
}

export interface TbcInMemoryTransportController {
  readonly transport: TbcProviderTransport;
  readonly emitEvent: (event: TbcProviderEvent) => void;
  readonly close: (reason?: TbcTransportCloseReason) => void;
}

interface PendingSend {
  readonly resolve: (delivery: TbcTransportDelivery) => void;
  readonly reject: (error: Error) => void;
}

const CLOSE_REASONS: readonly TbcTransportCloseReason[] = Object.freeze([
  "TRANSPORT_CLOSED",
  "NAVIGATION_CHANGED",
  "ORIGIN_CHANGED",
  "SESSION_REVOKED",
]);

function transportClosedError(): Error {
  return new Error("The in-memory Transport is closed.");
}

export function createInMemoryTransport(
  options: TbcInMemoryTransportOptions,
): TbcInMemoryTransportController {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.handler !== "function" ||
    (options.onCancel !== undefined && typeof options.onCancel !== "function")
  ) {
    throw new TypeError("In-memory Transport options are invalid.");
  }

  const listeners = new Set<(signal: TbcTransportSignal) => void>();
  const pending = new Map<TbcJsonRpcId, PendingSend>();
  let closed = false;
  let closeReason: TbcTransportCloseReason = "TRANSPORT_CLOSED";

  function publish(signal: TbcTransportSignal): void {
    for (const listener of [...listeners]) {
      try {
        listener(signal);
      } catch {
        // One consumer cannot prevent another from observing the same signal.
      }
    }
  }

  function close(reason: TbcTransportCloseReason = "TRANSPORT_CLOSED"): void {
    if (!CLOSE_REASONS.includes(reason)) {
      throw new TypeError("In-memory Transport close reason is invalid.");
    }
    if (closed) return;
    closed = true;
    closeReason = reason;
    for (const entry of pending.values()) entry.reject(transportClosedError());
    pending.clear();
    publish(Object.freeze({ type: "close", reason }));
    listeners.clear();
  }

  const transport: TbcProviderTransport = Object.freeze({
    send(request: TbcJsonRpcRequest): Promise<TbcTransportDelivery> {
      if (closed) return Promise.reject(transportClosedError());
      if (pending.has(request.id)) {
        return Promise.reject(new Error("The in-memory request ID is already pending."));
      }

      let resolveSend!: (delivery: TbcTransportDelivery) => void;
      let rejectSend!: (error: Error) => void;
      const result = new Promise<TbcTransportDelivery>((resolve, reject) => {
        resolveSend = resolve;
        rejectSend = reject;
      });
      const entry = { resolve: resolveSend, reject: rejectSend };
      pending.set(request.id, entry);

      let handled: TbcTransportDelivery | Promise<TbcTransportDelivery>;
      try {
        handled = options.handler(request);
      } catch (error) {
        pending.delete(request.id);
        rejectSend(
          error instanceof Error ? error : new Error("In-memory handler failed."),
        );
        return result;
      }
      void Promise.resolve(handled).then(
        (delivery) => {
          if (pending.get(request.id) !== entry) return;
          pending.delete(request.id);
          resolveSend(delivery);
        },
        (error: unknown) => {
          if (pending.get(request.id) !== entry) return;
          pending.delete(request.id);
          rejectSend(
            error instanceof Error ? error : new Error("In-memory handler failed."),
          );
        },
      );
      return result;
    },

    subscribe(listener: (signal: TbcTransportSignal) => void): () => void {
      if (typeof listener !== "function") {
        throw new TypeError("In-memory Transport listener is invalid.");
      }
      if (closed) {
        listener(Object.freeze({ type: "close", reason: closeReason }));
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    cancel(
      requestId: TbcJsonRpcId,
      reason: "REQUEST_ABORTED",
    ): void | Promise<void> {
      if (reason !== "REQUEST_ABORTED") {
        throw new TypeError("In-memory Transport cancellation reason is invalid.");
      }
      const entry = pending.get(requestId);
      if (entry !== undefined) {
        pending.delete(requestId);
        entry.reject(new Error("The in-memory request was aborted."));
      }
      return options.onCancel?.(requestId, reason);
    },

    close(): void {
      close("TRANSPORT_CLOSED");
    },
  });

  return Object.freeze({
    transport,
    emitEvent(event: TbcProviderEvent): void {
      if (closed) return;
      publish(Object.freeze({ type: "event", event }));
    },
    close,
  });
}
