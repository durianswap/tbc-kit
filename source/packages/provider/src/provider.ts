import { TbcEventEmitter } from "./emitter.js";
import {
  ProviderRpcError,
  abortedProviderError,
  disconnectedProviderError,
  internalProviderError,
} from "./errors.js";
import type { TbcJsonRpcId, TbcJsonRpcRequest } from "./protocol-types.js";
import type {
  TbcAbortSignal,
  TbcProvider,
  TbcProviderEvent,
  TbcProviderEventMap,
  TbcProviderEventName,
  TbcProviderMethod,
  TbcProviderOptions,
  TbcProviderRequestArguments,
  TbcProviderRequestOptions,
  TbcProviderRequestResult,
  TbcTransportCloseReason,
  TbcTransportDelivery,
  TbcTransportSignal,
} from "./types.js";
import {
  TbcProviderValidationError,
  assertTbcProviderEvent,
  assertTbcProviderRequest,
  assertTbcTransportDelivery,
  canonicalTbcMessageBytes,
} from "./validation.js";

type Listener = (...args: readonly unknown[]) => void;

interface PendingRequest {
  readonly id: TbcJsonRpcId;
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: ProviderRpcError) => void;
  readonly signal?: TbcAbortSignal;
  readonly abortListener?: () => void;
}

const CLOSE_REASONS: readonly TbcTransportCloseReason[] = Object.freeze([
  "TRANSPORT_CLOSED",
  "NAVIGATION_CHANGED",
  "ORIGIN_CHANGED",
  "SESSION_REVOKED",
]);

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every(
      (key) => typeof key === "string" && expected.includes(key),
    )
  );
}

function requestInputError(error: unknown): ProviderRpcError {
  if (
    error instanceof TbcProviderValidationError &&
    error.kind === "request"
  ) {
    return new ProviderRpcError(-32600, "The Provider request is invalid.");
  }
  return new ProviderRpcError(-32602, "The Provider request params are invalid.");
}

function defaultRequestIdFactory(): () => TbcJsonRpcId {
  let next = 0;
  return () => {
    if (next === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("The Provider request ID space is exhausted.");
    }
    next += 1;
    return `tws-${next.toString(10)}`;
  };
}

function validTransportOptions(value: unknown): value is TbcProviderOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const transport = Reflect.get(value, "transport");
  if (transport === null || typeof transport !== "object") return false;
  return (
    typeof Reflect.get(transport, "send") === "function" &&
    typeof Reflect.get(transport, "subscribe") === "function" &&
    (Reflect.get(value, "requestIdFactory") === undefined ||
      typeof Reflect.get(value, "requestIdFactory") === "function")
  );
}

class TbcProviderImplementation implements TbcProvider {
  readonly #transport: TbcProviderOptions["transport"];
  readonly #requestIdFactory: () => TbcJsonRpcId;
  readonly #pending = new Map<TbcJsonRpcId, PendingRequest>();
  readonly #usedIds = new Set<TbcJsonRpcId>();
  readonly #deliveryIds = new Set<string>();
  readonly #emitter = new TbcEventEmitter();
  #unsubscribe: (() => void) | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: TbcProviderOptions) {
    this.#transport = options.transport;
    this.#requestIdFactory =
      options.requestIdFactory ?? defaultRequestIdFactory();
    let unsubscribe: unknown;
    try {
      unsubscribe = this.#transport.subscribe((signal) => {
        this.#receiveSignal(signal);
      });
    } catch {
      this.#closed = true;
      throw internalProviderError("The Provider transport could not be initialized.");
    }
    if (typeof unsubscribe !== "function") {
      this.#closed = true;
      throw internalProviderError("The Provider transport could not be initialized.");
    }
    this.#unsubscribe = unsubscribe as () => void;
    if (this.#closed) this.#unsubscribeTransport();
  }

  request<const M extends string>(
    args: Readonly<{ method: M }> &
      Omit<TbcProviderRequestArguments<NoInfer<M>>, "method">,
    options?: TbcProviderRequestOptions,
  ): Promise<TbcProviderRequestResult<M>> {
    if (this.#closed) {
      return Promise.reject(disconnectedProviderError());
    }

    let preflight: TbcJsonRpcRequest;
    try {
      const record = args as Readonly<Record<string, unknown>>;
      const request = {
        jsonrpc: "2.0" as const,
        id: "tws-preflight",
        method: record.method,
        ...(Object.hasOwn(record, "params") ? { params: record.params } : {}),
      };
      preflight = assertTbcProviderRequest(request);
    } catch (error) {
      return Promise.reject(requestInputError(error));
    }

    const signal = options?.signal;
    if (signal?.aborted === true) {
      return Promise.reject(abortedProviderError());
    }

    let request: TbcJsonRpcRequest;
    try {
      request = assertTbcProviderRequest({
        ...preflight,
        id: this.#requestIdFactory(),
      });
    } catch {
      return Promise.reject(
        internalProviderError("The Provider request ID is invalid."),
      );
    }
    if (this.#usedIds.has(request.id)) {
      return Promise.reject(
        internalProviderError("The Provider request ID was already used."),
      );
    }
    this.#usedIds.add(request.id);

    let resolveRequest!: (result: unknown) => void;
    let rejectRequest!: (error: ProviderRpcError) => void;
    const result = new Promise<unknown>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const abortListener = signal === undefined
      ? undefined
      : () => this.#abort(request.id);
    const pending: PendingRequest = {
      id: request.id,
      method: request.method,
      resolve: resolveRequest,
      reject: rejectRequest,
      ...(signal === undefined ? {} : { signal }),
      ...(abortListener === undefined ? {} : { abortListener }),
    };
    this.#pending.set(request.id, pending);

    if (signal !== undefined && abortListener !== undefined) {
      try {
        signal.addEventListener("abort", abortListener);
      } catch {
        this.#pending.delete(request.id);
        rejectRequest(internalProviderError());
        return result as Promise<TbcProviderRequestResult<M>>;
      }
      if (signal.aborted) {
        this.#abort(request.id);
        return result as Promise<TbcProviderRequestResult<M>>;
      }
    }

    let sent: Promise<TbcTransportDelivery>;
    try {
      sent = Promise.resolve(this.#transport.send(request));
    } catch {
      this.#rejectSend(request.id);
      return result as Promise<TbcProviderRequestResult<M>>;
    }
    void sent.then(
      (delivery) => this.#receiveDelivery(request.id, delivery),
      () => this.#rejectSend(request.id),
    );
    return result as Promise<TbcProviderRequestResult<M>>;
  }

  on<const E extends string>(
    event: E,
    listener: E extends TbcProviderEventName
      ? (payload: TbcProviderEventMap[NoInfer<E>]) => void
      : (...args: unknown[]) => void,
  ): this {
    if (typeof event !== "string" || typeof listener !== "function") {
      throw new TypeError("Provider event and listener are invalid.");
    }
    if (!this.#closed) this.#emitter.on(event, listener as Listener);
    return this;
  }

  removeListener<const E extends string>(
    event: E,
    listener: E extends TbcProviderEventName
      ? (payload: TbcProviderEventMap[NoInfer<E>]) => void
      : (...args: unknown[]) => void,
  ): this {
    if (typeof event !== "string" || typeof listener !== "function") {
      throw new TypeError("Provider event and listener are invalid.");
    }
    this.#emitter.removeListener(event, listener as Listener);
    return this;
  }

  async destroy(): Promise<void> {
    await this.#close(disconnectedProviderError());
  }

  #cleanupPending(pending: PendingRequest): void {
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      try {
        pending.signal.removeEventListener("abort", pending.abortListener);
      } catch {
        // The request is already terminal; a hostile signal cannot reopen it.
      }
    }
  }

  #abort(id: TbcJsonRpcId): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    this.#cleanupPending(pending);
    pending.reject(abortedProviderError());
    try {
      const cancelled = this.#transport.cancel?.(id, "REQUEST_ABORTED");
      if (cancelled !== undefined) {
        void Promise.resolve(cancelled).catch(() => undefined);
      }
    } catch {
      // Local abortion is already terminal and cannot be reversed by Transport failure.
    }
  }

  #rejectSend(id: TbcJsonRpcId): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    this.#cleanupPending(pending);
    pending.reject(internalProviderError());
  }

  #receiveDelivery(id: TbcJsonRpcId, input: unknown): void {
    const pending = this.#pending.get(id);
    if (pending === undefined || this.#closed) return;

    let delivery: TbcTransportDelivery;
    try {
      delivery = assertTbcTransportDelivery(input, pending.method);
      if (
        this.#deliveryIds.has(delivery.deliveryId) ||
        delivery.response.id !== pending.id
      ) {
        throw new TbcProviderValidationError("delivery");
      }
    } catch {
      void this.#close(disconnectedProviderError());
      return;
    }
    this.#deliveryIds.add(delivery.deliveryId);
    this.#pending.delete(id);
    this.#cleanupPending(pending);

    if ("error" in delivery.response) {
      const error = delivery.response.error;
      pending.reject(
        new ProviderRpcError(error.code, error.message, error.data),
      );
    } else {
      pending.resolve(delivery.response.result);
    }
    void Promise.resolve().then(() => {
      if (this.#closed) return;
      for (const event of delivery.events) this.#emitEvent(event);
    });
  }

  #receiveSignal(input: TbcTransportSignal): void {
    if (this.#closed) return;
    try {
      canonicalTbcMessageBytes(input);
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TbcProviderValidationError("delivery");
      }
      if (input.type === "event" && exactKeys(input, ["type", "event"])) {
        this.#emitEvent(assertTbcProviderEvent(input.event));
        return;
      }
      if (
        input.type === "close" &&
        exactKeys(input, ["type", "reason"]) &&
        CLOSE_REASONS.includes(input.reason)
      ) {
        void this.#close(disconnectedProviderError());
        return;
      }
      throw new TbcProviderValidationError("delivery");
    } catch {
      void this.#close(disconnectedProviderError());
    }
  }

  #emitEvent(event: TbcProviderEvent): void {
    if (this.#closed) return;
    const payload = event.name === "disconnect"
      ? new ProviderRpcError(
          event.payload.code,
          event.payload.message,
          event.payload.data,
        )
      : event.payload;
    this.#emitter.emit(event.name, payload);
  }

  #unsubscribeTransport(): void {
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    if (unsubscribe === undefined) return;
    try {
      unsubscribe();
    } catch {
      // Closing is terminal; subscription cleanup cannot restore the channel.
    }
  }

  #close(error: ProviderRpcError): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#unsubscribeTransport();
    for (const pending of this.#pending.values()) {
      this.#cleanupPending(pending);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#emitter.clear();

    let closing: void | Promise<void>;
    try {
      closing = this.#transport.close?.();
    } catch {
      closing = undefined;
    }
    this.#closePromise = Promise.resolve(closing).then(
      () => undefined,
      () => undefined,
    );
    return this.#closePromise;
  }
}

export function createTbcProvider(options: TbcProviderOptions): TbcProvider {
  if (!validTransportOptions(options)) {
    throw new TypeError("TbcProviderOptions must contain a valid Transport.");
  }
  return new TbcProviderImplementation(options);
}
