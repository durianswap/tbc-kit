import {
  canonicalize,
  sha256Hex,
  utf8,
} from "@tbc-wallet/core";
import type { TbcJsonRpcId, TbcJsonRpcRequest } from "./protocol-types.js";
import type {
  TbcProviderEvent,
  TbcTransportCloseReason,
  TbcTransportDelivery,
} from "./types.js";
import {
  decodeTbcWebViewNativeMessage,
  decodeTbcWebViewPageMessage,
  digestTbcWebViewEnvelope,
  encodeTbcWebViewNativeMessage,
} from "./webview-codec.js";
import {
  TBC_WEBVIEW_CHANNEL,
  type TbcWebViewSessionStore,
  type TbcWebViewStringChannel,
  type TbcWebViewVerifiedNavigation,
} from "./webview-types.js";

export interface TbcWebViewNativeHandlers {
  readonly send: (
    request: TbcJsonRpcRequest,
    navigation: TbcWebViewVerifiedNavigation,
  ) => Promise<TbcWebViewNativeDispatch>;
  readonly acknowledgeDelivery?: (
    deliveryId: string,
    navigation: TbcWebViewVerifiedNavigation,
  ) => Promise<void>;
  readonly cancel: (
    requestId: TbcJsonRpcId,
    reason: "REQUEST_ABORTED",
    navigation: TbcWebViewVerifiedNavigation,
  ) => Promise<void>;
  readonly close: (
    reason: TbcTransportCloseReason,
    navigation: TbcWebViewVerifiedNavigation,
  ) => Promise<void>;
}

export type TbcWebViewNativeDispatch =
  | TbcTransportDelivery
  | Readonly<{
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
  readonly openNavigation: (
    navigation: TbcWebViewVerifiedNavigation,
  ) => Promise<void>;
  readonly acceptPageMessage: (input: TbcWebViewPageInput) => Promise<void>;
  readonly deliver: (delivery: TbcTransportDelivery) => Promise<void>;
  readonly emitEvent: (event: TbcProviderEvent) => Promise<void>;
  readonly close: (reason?: TbcTransportCloseReason) => Promise<void>;
  readonly destroy: () => Promise<void>;
}

interface LiveSession {
  readonly navigation: TbcWebViewVerifiedNavigation;
  readonly requests: Map<string, string>;
  readonly activeInbound: Set<string>;
  readonly usedNativeMessageIds: Set<string>;
  ready: boolean;
  closed: boolean;
  nextMessageId: number;
}

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u;
const CLOSE_REASONS: readonly TbcTransportCloseReason[] = Object.freeze([
  "TRANSPORT_CLOSED",
  "NAVIGATION_CHANGED",
  "ORIGIN_CHANGED",
  "SESSION_REVOKED",
]);
const NAVIGATION_KEYS = Object.freeze([
  "webViewInstanceId",
  "sessionId",
  "navigationId",
  "committedUrl",
  "origin",
  "topOrigin",
  "frame",
  "createdAt",
]);

function fail(message: string): never {
  throw new TypeError(message);
}

function exactScalarRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return fail("TBC WebView verified navigation is invalid.");
  }
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    return fail("TBC WebView verified navigation is invalid.");
  }
  for (const key of actual) {
    if (typeof key !== "string") return fail("TBC WebView verified navigation is invalid.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return fail("TBC WebView verified navigation is invalid.");
    }
  }
  return value as Record<string, unknown>;
}

function parseAuthority(url: string): {
  readonly scheme: "http" | "https";
  readonly authority: string;
  readonly host: string;
} {
  if (/[\\\u0000-\u0020\u007f]/u.test(url)) {
    return fail("TBC WebView committed URL is invalid.");
  }
  const matched = /^(https?):\/\/([^/?#]+)(?:[/?#]|$)/u.exec(url);
  const scheme = matched?.[1];
  const authority = matched?.[2];
  if (
    (scheme !== "http" && scheme !== "https") ||
    authority === undefined
  ) {
    return fail("TBC WebView committed URL is invalid.");
  }
  if (authority.includes("@")) return fail("TBC WebView URL credentials are forbidden.");
  let host: string;
  let port: string | undefined;
  if (authority.startsWith("[")) {
    const ipv6 = /^(\[[0-9a-fA-F:]+\])(?::([0-9]+))?$/u.exec(authority);
    const ipv6Host = ipv6?.[1];
    if (ipv6Host === undefined) return fail("TBC WebView URL authority is invalid.");
    host = ipv6Host.toLowerCase();
    port = ipv6?.[2];
  } else {
    const hostPort = /^([A-Za-z0-9.-]+)(?::([0-9]+))?$/u.exec(authority);
    const parsedHost = hostPort?.[1];
    if (parsedHost === undefined || parsedHost.length === 0) {
      return fail("TBC WebView URL authority is invalid.");
    }
    host = parsedHost.toLowerCase();
    port = hostPort?.[2];
    if (
      host !== parsedHost ||
      host.startsWith(".") ||
      host.endsWith(".") ||
      host.includes("..")
    ) {
      return fail("TBC WebView URL authority is not canonical.");
    }
  }
  if (port !== undefined) {
    const numeric = Number(port);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65_535) {
      return fail("TBC WebView URL port is invalid.");
    }
    if (
      (scheme === "https" && port === "443") ||
      (scheme === "http" && port === "80")
    ) {
      return fail("TBC WebView URL default port must be normalized.");
    }
  }
  return { scheme, authority, host };
}

function checkedNavigation(
  value: TbcWebViewVerifiedNavigation,
  allowInsecureLoopback: boolean,
): TbcWebViewVerifiedNavigation {
  const record = exactScalarRecord(value, NAVIGATION_KEYS);
  for (const key of NAVIGATION_KEYS) {
    if (typeof record[key] !== "string") fail("TBC WebView verified navigation is invalid.");
  }
  if (
    !IDENTIFIER.test(record.webViewInstanceId as string) ||
    !IDENTIFIER.test(record.sessionId as string) ||
    !IDENTIFIER.test(record.navigationId as string) ||
    record.frame !== "top" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(record.createdAt as string) ||
    !Number.isFinite(Date.parse(record.createdAt as string))
  ) {
    fail("TBC WebView verified navigation is invalid.");
  }
  const committedUrl = record.committedUrl as string;
  const parsed = parseAuthority(committedUrl);
  const origin = `${parsed.scheme}://${parsed.authority}`;
  if (record.origin !== origin || record.topOrigin !== origin) {
    fail("TBC WebView Origin binding is invalid.");
  }
  if (parsed.scheme !== "https") {
    const loopback = parsed.host === "localhost" ||
      parsed.host === "127.0.0.1" || parsed.host === "[::1]";
    if (!allowInsecureLoopback || !loopback) {
      fail("TBC WebView navigation requires HTTPS.");
    }
  }
  return Object.freeze({
    webViewInstanceId: record.webViewInstanceId,
    sessionId: record.sessionId,
    navigationId: record.navigationId,
    committedUrl,
    origin,
    topOrigin: origin,
    frame: "top",
    createdAt: record.createdAt,
  }) as TbcWebViewVerifiedNavigation;
}

function requestKey(id: TbcJsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function stableMessageId(prefix: string, value: unknown): string {
  return `${prefix}-${sha256Hex(utf8(canonicalize(value)))}`;
}

export function createTbcWebViewNativeController(
  options: TbcWebViewNativeOptions,
): TbcWebViewNativeController {
  if (
    options === null ||
    typeof options !== "object" ||
    options.channel === null ||
    typeof options.channel !== "object" ||
    typeof options.channel.post !== "function" ||
    options.store === null ||
    typeof options.store !== "object" ||
    typeof options.store.openSession !== "function" ||
    typeof options.store.closeSession !== "function" ||
    typeof options.store.acceptInbound !== "function" ||
    typeof options.store.enqueueDelivery !== "function" ||
    typeof options.store.markDeliverySent !== "function" ||
    typeof options.store.acknowledgeDelivery !== "function" ||
    typeof options.store.listOutstanding !== "function" ||
    options.handlers === null ||
    typeof options.handlers !== "object" ||
    typeof options.handlers.send !== "function" ||
    (options.handlers.acknowledgeDelivery !== undefined &&
      typeof options.handlers.acknowledgeDelivery !== "function") ||
    typeof options.handlers.cancel !== "function" ||
    typeof options.handlers.close !== "function" ||
    (options.messageIdFactory !== undefined && typeof options.messageIdFactory !== "function")
  ) {
    throw new TypeError("TBC WebView native controller options are invalid.");
  }

  let current: LiveSession | undefined;
  const allowInsecureLoopback = options.allowInsecureLoopback === true;

  function nextMessageId(session: LiveSession): string {
    let value: string;
    if (options.messageIdFactory !== undefined) {
      value = options.messageIdFactory();
      if (!IDENTIFIER.test(value)) fail("TBC WebView native message ID is invalid.");
    } else {
      if (session.nextMessageId >= Number.MAX_SAFE_INTEGER) {
        fail("TBC WebView native message ID space is exhausted.");
      }
      session.nextMessageId += 1;
      value = `native-${String(session.nextMessageId)}`;
    }
    if (session.usedNativeMessageIds.has(value)) {
      fail("TBC WebView native message ID was already used.");
    }
    session.usedNativeMessageIds.add(value);
    return value;
  }

  async function post(serialized: string): Promise<void> {
    await options.channel.post(serialized);
  }

  async function acknowledgeHostDelivery(
    session: LiveSession,
    deliveryId: string,
  ): Promise<void> {
    await options.handlers.acknowledgeDelivery?.(
      deliveryId,
      session.navigation,
    );
  }

  function isSuppressed(
    value: TbcWebViewNativeDispatch,
  ): value is Extract<TbcWebViewNativeDispatch, { status: "suppressed" }> {
    return (
      value !== null &&
      typeof value === "object" &&
      Reflect.ownKeys(value).length === 2 &&
      Reflect.get(value, "status") === "suppressed" &&
      typeof Reflect.get(value, "deliveryId") === "string" &&
      /^[0-9a-f]{64}$/u.test(Reflect.get(value, "deliveryId") as string)
    );
  }

  function envelope(
    session: LiveSession,
    messageId: string,
    fields: Record<string, unknown>,
  ): string {
    session.usedNativeMessageIds.add(messageId);
    return encodeTbcWebViewNativeMessage({
      channel: TBC_WEBVIEW_CHANNEL,
      sessionId: session.navigation.sessionId,
      navigationId: session.navigation.navigationId,
      messageId,
      ...fields,
    } as never);
  }

  async function closeSession(
    session: LiveSession,
    reason: TbcTransportCloseReason,
    notify: boolean,
  ): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    if (current === session) current = undefined;
    await options.store.closeSession({
      sessionId: session.navigation.sessionId,
      navigationId: session.navigation.navigationId,
      reason,
    });
    await options.handlers.close(reason, session.navigation).catch(() => undefined);
    if (notify) {
      const serialized = envelope(
        session,
        stableMessageId("native-close", {
          sessionId: session.navigation.sessionId,
          navigationId: session.navigation.navigationId,
          reason,
        }),
        { type: "close", reason },
      );
      await post(serialized).catch(() => undefined);
    }
  }

  async function integrityClose(session: LiveSession): Promise<void> {
    await closeSession(session, "TRANSPORT_CLOSED", true);
  }

  async function sendStored(session: LiveSession, record: Awaited<
    ReturnType<TbcWebViewSessionStore["listOutstanding"]>
  >[number]): Promise<void> {
    if (
      session.closed ||
      current !== session ||
      record.sessionId !== session.navigation.sessionId ||
      record.navigationId !== session.navigation.navigationId ||
      digestTbcWebViewEnvelope(record.canonicalEnvelope) !== record.envelopeDigest
    ) {
      await integrityClose(session);
      return;
    }
    let decoded;
    try {
      decoded = decodeTbcWebViewNativeMessage(record.canonicalEnvelope);
    } catch {
      await integrityClose(session);
      return;
    }
    if (
      decoded.type !== "delivery" ||
      decoded.deliveryId !== record.deliveryId ||
      decoded.sessionId !== record.sessionId ||
      decoded.navigationId !== record.navigationId
    ) {
      await integrityClose(session);
      return;
    }
    const decision = await options.store.markDeliverySent({
      sessionId: record.sessionId,
      deliveryId: record.deliveryId,
      envelopeDigest: record.envelopeDigest,
    });
    if (decision === "collision") {
      await integrityClose(session);
      return;
    }
    await acknowledgeHostDelivery(session, record.deliveryId);
    await post(record.canonicalEnvelope);
  }

  async function replayOutstanding(session: LiveSession): Promise<void> {
    const outstanding = await options.store.listOutstanding(session.navigation.sessionId);
    for (const record of outstanding) {
      if (session.closed || current !== session) return;
      await sendStored(session, record);
    }
  }

  async function deliverTo(
    session: LiveSession,
    delivery: TbcTransportDelivery,
  ): Promise<void> {
    if (session.closed || current !== session || !session.ready) return;
    const messageId = stableMessageId("native-delivery", {
      sessionId: session.navigation.sessionId,
      navigationId: session.navigation.navigationId,
      deliveryId: delivery.deliveryId,
    });
    const canonicalEnvelope = envelope(session, messageId, {
      type: "delivery",
      deliveryId: delivery.deliveryId,
      response: delivery.response,
      events: delivery.events,
    });
    const envelopeDigest = digestTbcWebViewEnvelope(canonicalEnvelope);
    const decision = await options.store.enqueueDelivery({
      sessionId: session.navigation.sessionId,
      navigationId: session.navigation.navigationId,
      deliveryId: delivery.deliveryId,
      canonicalEnvelope,
      envelopeDigest,
    });
    if (decision === "collision") {
      await integrityClose(session);
      return;
    }
    await sendStored(session, {
      sessionId: session.navigation.sessionId,
      navigationId: session.navigation.navigationId,
      deliveryId: delivery.deliveryId,
      canonicalEnvelope,
      envelopeDigest,
      state: "pending",
    });
  }

  async function acceptPageMessageIn(input: TbcWebViewPageInput): Promise<void> {
    const session = current;
    if (session === undefined || session.closed) return;
    if (
      input === null ||
      typeof input !== "object" ||
      input.webViewInstanceId !== session.navigation.webViewInstanceId ||
      typeof input.serialized !== "string"
    ) {
      await integrityClose(session);
      return;
    }
    let message;
    try {
      message = decodeTbcWebViewPageMessage(input.serialized);
    } catch {
      await integrityClose(session);
      return;
    }
    if (
      message.sessionId !== session.navigation.sessionId ||
      message.navigationId !== session.navigation.navigationId
    ) {
      await integrityClose(session);
      return;
    }
    const envelopeDigest = digestTbcWebViewEnvelope(input.serialized);
    const decision = await options.store.acceptInbound({
      sessionId: message.sessionId,
      navigationId: message.navigationId,
      messageId: message.messageId,
      canonicalEnvelope: input.serialized,
      envelopeDigest,
    });
    if (decision === "collision") {
      await integrityClose(session);
      return;
    }

    if (message.type === "ready") {
      session.ready = true;
      await replayOutstanding(session);
      return;
    }
    if (!session.ready) {
      await integrityClose(session);
      return;
    }
    if (message.type === "ack") {
      const outstanding = await options.store.listOutstanding(message.sessionId);
      const record = outstanding.find(({ deliveryId }) => deliveryId === message.deliveryId);
      if (record === undefined) {
        if (decision === "replay") return;
        await integrityClose(session);
        return;
      }
      const acknowledged = await options.store.acknowledgeDelivery({
        sessionId: message.sessionId,
        deliveryId: message.deliveryId,
        envelopeDigest: record.envelopeDigest,
      });
      if (acknowledged === "collision") await integrityClose(session);
      return;
    }

    if (session.activeInbound.has(message.messageId)) return;
    session.activeInbound.add(message.messageId);
    try {
      if (message.type === "cancel") {
        await options.handlers.cancel(
          message.requestId,
          message.reason,
          session.navigation,
        );
        return;
      }
      const key = requestKey(message.request.id);
      const canonicalRequest = canonicalize(message.request);
      const prior = session.requests.get(key);
      if (prior !== undefined && prior !== canonicalRequest) {
        await integrityClose(session);
        return;
      }
      session.requests.set(key, canonicalRequest);
      let dispatched: TbcWebViewNativeDispatch;
      try {
        dispatched = await options.handlers.send(
          message.request,
          session.navigation,
        );
      } catch {
        if (current === session && !session.closed) await integrityClose(session);
        return;
      }
      if (current !== session || session.closed) return;
      if (isSuppressed(dispatched)) {
        await acknowledgeHostDelivery(session, dispatched.deliveryId);
        return;
      }
      const delivery = dispatched;
      if (delivery.response.id !== message.request.id) {
        await integrityClose(session);
        return;
      }
      await deliverTo(session, delivery);
    } finally {
      session.activeInbound.delete(message.messageId);
    }
  }

  async function acceptPageMessage(input: TbcWebViewPageInput): Promise<void> {
    const session = current;
    try {
      await acceptPageMessageIn(input);
    } catch {
      if (session !== undefined && !session.closed) {
        await integrityClose(session).catch(() => undefined);
      }
    }
  }

  async function openNavigation(input: TbcWebViewVerifiedNavigation): Promise<void> {
    const navigation = checkedNavigation(input, allowInsecureLoopback);
    const previous = current;
    if (previous !== undefined) {
      if (canonicalize(previous.navigation) === canonicalize(navigation)) return;
      await closeSession(previous, "NAVIGATION_CHANGED", true);
    }
    await options.store.openSession(navigation);
    const session: LiveSession = {
      navigation,
      requests: new Map(),
      activeInbound: new Set(),
      usedNativeMessageIds: new Set(),
      ready: false,
      closed: false,
      nextMessageId: 0,
    };
    current = session;
    const messageId = stableMessageId("native-initialize", {
      sessionId: navigation.sessionId,
      navigationId: navigation.navigationId,
    });
    const serialized = envelope(session, messageId, {
      type: "initialize",
      origin: navigation.origin,
      chainId: options.chainId,
    });
    try {
      await post(serialized);
    } catch {
      await closeSession(session, "TRANSPORT_CLOSED", false);
      throw new Error("The TBC WebView initialization could not be posted.");
    }
  }

  return Object.freeze({
    openNavigation,
    acceptPageMessage,
    async deliver(delivery: TbcTransportDelivery): Promise<void> {
      const session = current;
      if (session === undefined || session.closed) return;
      await deliverTo(session, delivery);
    },
    async emitEvent(event: TbcProviderEvent): Promise<void> {
      const session = current;
      if (session === undefined || session.closed || !session.ready) return;
      const messageId = nextMessageId(session);
      const serialized = envelope(session, messageId, { type: "event", event });
      try {
        await post(serialized);
      } catch {
        await closeSession(session, "TRANSPORT_CLOSED", false);
      }
    },
    async close(reason: TbcTransportCloseReason = "TRANSPORT_CLOSED"): Promise<void> {
      if (!CLOSE_REASONS.includes(reason)) {
        throw new TypeError("TBC WebView close reason is invalid.");
      }
      const session = current;
      if (session !== undefined) await closeSession(session, reason, true);
    },
    async destroy(): Promise<void> {
      const session = current;
      if (session !== undefined) {
        await closeSession(session, "TRANSPORT_CLOSED", false);
      }
    },
  });
}
