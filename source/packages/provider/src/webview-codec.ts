import {
  canonicalize,
  sha256Hex,
  utf8,
} from "@tbc-wallet/core";
import {
  assertTbcProviderEvent,
  assertTbcProviderMethodResult,
  assertTbcProviderRequest,
  assertTbcTransportDelivery,
} from "./validation.js";
import {
  TBC_WEBVIEW_CHANNEL,
  TBC_WEBVIEW_MAX_MESSAGE_BYTES,
  type TbcWebViewNativeMessage,
  type TbcWebViewPageMessage,
} from "./webview-types.js";

export type TbcWebViewValidationKind =
  | "json"
  | "size"
  | "page-message"
  | "native-message";

export class TbcWebViewValidationError extends TypeError {
  readonly code = "TBC_WEBVIEW_VALIDATION_FAILED" as const;
  readonly kind: TbcWebViewValidationKind;

  constructor(kind: TbcWebViewValidationKind) {
    super(`The TBC WebView ${kind} value is invalid.`);
    this.name = "TbcWebViewValidationError";
    this.kind = kind;
  }
}

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u;
const DELIVERY_ID = /^[0-9a-f]{64}$/u;
const CLOSE_REASONS = new Set([
  "TRANSPORT_CLOSED",
  "NAVIGATION_CHANGED",
  "ORIGIN_CHANGED",
  "SESSION_REVOKED",
]);
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 128;
const MAX_NODES = 100_000;

function fail(kind: TbcWebViewValidationKind): never {
  throw new TbcWebViewValidationError(kind);
}

function assertUnicode(value: string, kind: TbcWebViewValidationKind): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail(kind);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(kind);
    }
  }
}

function assertPlainJson(value: unknown, kind: TbcWebViewValidationKind): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) fail(kind);
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "string") {
      assertUnicode(current, kind);
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail(kind);
      return;
    }
    if (typeof current !== "object") fail(kind);

    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype) fail(kind);
      const keys = Reflect.ownKeys(current);
      if (keys.length !== current.length + 1 || keys.at(-1) !== "length") fail(kind);
      for (let index = 0; index < current.length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          fail(kind);
        }
        visit(descriptor.value, depth + 1);
      }
      return;
    }

    if (Object.getPrototypeOf(current) !== Object.prototype) fail(kind);
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string" || PROTOTYPE_KEYS.has(key)) fail(kind);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        fail(kind);
      }
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
}

class JsonDuplicateScanner {
  readonly #source: string;
  #index = 0;

  constructor(source: string) {
    this.#source = source;
  }

  scan(): void {
    this.#space();
    this.#value(0);
    this.#space();
    if (this.#index !== this.#source.length) fail("json");
  }

  #space(): void {
    while (/\s/u.test(this.#source[this.#index] ?? "")) this.#index += 1;
  }

  #value(depth: number): void {
    if (depth > MAX_DEPTH) fail("json");
    const token = this.#source[this.#index];
    if (token === "{") return this.#object(depth + 1);
    if (token === "[") return this.#array(depth + 1);
    if (token === '"') {
      this.#string();
      return;
    }
    if (token === "t") return this.#literal("true");
    if (token === "f") return this.#literal("false");
    if (token === "n") return this.#literal("null");
    const number = this.#source.slice(this.#index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0];
    if (number === undefined) fail("json");
    this.#index += number.length;
  }

  #literal(expected: string): void {
    if (this.#source.slice(this.#index, this.#index + expected.length) !== expected) {
      fail("json");
    }
    this.#index += expected.length;
  }

  #string(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#source.length) {
      const code = this.#source.charCodeAt(this.#index);
      if (code === 0x22) {
        this.#index += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.#source.slice(start, this.#index));
        } catch {
          return fail("json");
        }
        if (typeof value !== "string") return fail("json");
        assertUnicode(value, "json");
        return value;
      }
      if (code < 0x20) fail("json");
      if (code === 0x5c) {
        this.#index += 1;
        const escaped = this.#source[this.#index];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(this.#source.slice(this.#index + 1, this.#index + 5))) {
            fail("json");
          }
          this.#index += 5;
          continue;
        }
        if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) fail("json");
      }
      this.#index += 1;
    }
    return fail("json");
  }

  #object(depth: number): void {
    this.#index += 1;
    this.#space();
    const keys = new Set<string>();
    if (this.#source[this.#index] === "}") {
      this.#index += 1;
      return;
    }
    while (true) {
      if (this.#source[this.#index] !== '"') fail("json");
      const key = this.#string();
      if (keys.has(key)) fail("json");
      keys.add(key);
      this.#space();
      if (this.#source[this.#index] !== ":") fail("json");
      this.#index += 1;
      this.#space();
      this.#value(depth);
      this.#space();
      const separator = this.#source[this.#index];
      if (separator === "}") {
        this.#index += 1;
        return;
      }
      if (separator !== ",") fail("json");
      this.#index += 1;
      this.#space();
    }
  }

  #array(depth: number): void {
    this.#index += 1;
    this.#space();
    if (this.#source[this.#index] === "]") {
      this.#index += 1;
      return;
    }
    while (true) {
      this.#value(depth);
      this.#space();
      const separator = this.#source[this.#index];
      if (separator === "]") {
        this.#index += 1;
        return;
      }
      if (separator !== ",") fail("json");
      this.#index += 1;
      this.#space();
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertExact(
  value: Record<string, unknown>,
  keys: readonly string[],
  kind: TbcWebViewValidationKind,
): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail(kind);
  }
}

function assertIdentifier(value: unknown, kind: TbcWebViewValidationKind): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(kind);
  return value;
}

function assertDeliveryId(value: unknown, kind: TbcWebViewValidationKind): string {
  if (typeof value !== "string" || !DELIVERY_ID.test(value)) fail(kind);
  return value;
}

function assertRequestId(value: unknown, kind: TbcWebViewValidationKind): void {
  if (
    !(
      (typeof value === "string" && value.length >= 1 && value.length <= 128) ||
      (Number.isSafeInteger(value) && (value as number) >= 0)
    )
  ) {
    fail(kind);
  }
}

function common(
  value: Record<string, unknown>,
  kind: TbcWebViewValidationKind,
): void {
  if (value.channel !== TBC_WEBVIEW_CHANNEL) fail(kind);
  assertIdentifier(value.sessionId, kind);
  assertIdentifier(value.navigationId, kind);
  assertIdentifier(value.messageId, kind);
}

function validatePageMessage(value: unknown): TbcWebViewPageMessage {
  const kind = "page-message" as const;
  assertPlainJson(value, kind);
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") fail(kind);
  if (record.type === "ready") {
    assertExact(record, ["channel", "type", "sessionId", "navigationId", "messageId"], kind);
  } else if (record.type === "request") {
    assertExact(record, ["channel", "type", "sessionId", "navigationId", "messageId", "request"], kind);
    assertTbcProviderRequest(record.request);
  } else if (record.type === "cancel") {
    assertExact(record, ["channel", "type", "sessionId", "navigationId", "messageId", "requestId", "reason"], kind);
    assertRequestId(record.requestId, kind);
    if (record.reason !== "REQUEST_ABORTED") fail(kind);
  } else if (record.type === "ack") {
    assertExact(record, ["channel", "type", "sessionId", "navigationId", "messageId", "deliveryId"], kind);
    assertDeliveryId(record.deliveryId, kind);
  } else {
    fail(kind);
  }
  common(record, kind);
  return record as unknown as TbcWebViewPageMessage;
}

function validateNativeMessage(value: unknown): TbcWebViewNativeMessage {
  const kind = "native-message" as const;
  assertPlainJson(value, kind);
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") fail(kind);
  if (record.type === "initialize") {
    assertExact(record, ["channel", "type", "sessionId", "navigationId", "messageId", "origin", "chainId"], kind);
    if (
      typeof record.origin !== "string" ||
      record.origin.length === 0 ||
      record.origin.length > 2048 ||
      /[\u0000-\u001f\u007f]/u.test(record.origin)
    ) {
      fail(kind);
    }
    assertTbcProviderMethodResult("tbc_chainId", record.chainId);
  } else if (record.type === "delivery") {
    assertExact(record, ["channel", "type", "sessionId", "navigationId", "messageId", "deliveryId", "response", "events"], kind);
    assertTbcTransportDelivery({
      deliveryId: record.deliveryId,
      response: record.response,
      events: record.events,
    });
  } else if (record.type === "event") {
    assertExact(record, ["channel", "type", "sessionId", "navigationId", "messageId", "event"], kind);
    assertTbcProviderEvent(record.event);
  } else if (record.type === "close") {
    assertExact(record, ["channel", "type", "sessionId", "navigationId", "messageId", "reason"], kind);
    if (typeof record.reason !== "string" || !CLOSE_REASONS.has(record.reason)) fail(kind);
  } else {
    fail(kind);
  }
  common(record, kind);
  return record as unknown as TbcWebViewNativeMessage;
}

function encode<T>(
  value: unknown,
  validate: (candidate: unknown) => T,
  kind: TbcWebViewValidationKind,
): string {
  const valid = validate(value);
  let encoded: string;
  try {
    encoded = canonicalize(valid);
  } catch {
    return fail(kind);
  }
  if (utf8(encoded).length > TBC_WEBVIEW_MAX_MESSAGE_BYTES) fail("size");
  return encoded;
}

function decode<T>(
  serialized: string,
  validate: (candidate: unknown) => T,
): T {
  if (typeof serialized !== "string") fail("json");
  assertUnicode(serialized, "json");
  if (utf8(serialized).length > TBC_WEBVIEW_MAX_MESSAGE_BYTES) fail("size");
  new JsonDuplicateScanner(serialized).scan();
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
    if (canonicalize(parsed) !== serialized) fail("json");
  } catch (error) {
    if (error instanceof TbcWebViewValidationError) throw error;
    return fail("json");
  }
  return deepFreeze(validate(parsed));
}

export function encodeTbcWebViewPageMessage(value: TbcWebViewPageMessage): string {
  return encode(value, validatePageMessage, "page-message");
}

export function decodeTbcWebViewPageMessage(serialized: string): TbcWebViewPageMessage {
  return decode(serialized, validatePageMessage);
}

export function encodeTbcWebViewNativeMessage(value: TbcWebViewNativeMessage): string {
  return encode(value, validateNativeMessage, "native-message");
}

export function decodeTbcWebViewNativeMessage(serialized: string): TbcWebViewNativeMessage {
  return decode(serialized, validateNativeMessage);
}

export function digestTbcWebViewEnvelope(serialized: string): string {
  if (typeof serialized !== "string") fail("json");
  assertUnicode(serialized, "json");
  if (utf8(serialized).length > TBC_WEBVIEW_MAX_MESSAGE_BYTES) fail("size");
  return sha256Hex(utf8(serialized));
}
