import { canonicalize, cryptoInputHasValidByteBudget, utf8 } from "@tbc-wallet/core";
import * as generated from "./generated/validators.js";
import type {
  TbcJsonRpcRequest,
  TbcJsonRpcResponse,
} from "./protocol-types.js";
import {
  TBC_PROVIDER_EVENTS,
  TBC_PROVIDER_METHODS,
  type TbcProviderEvent,
  type TbcProviderEventName,
  type TbcProviderMethod,
  type TbcProviderMethodMap,
  type TbcTransportDelivery,
} from "./types.js";

export const TBC_PROVIDER_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export type TbcProviderValidationKind =
  | "json"
  | "size"
  | "request"
  | "params"
  | "result"
  | "response"
  | "event"
  | "delivery";

export class TbcProviderValidationError extends TypeError {
  readonly code = "TBC_PROVIDER_VALIDATION_FAILED" as const;
  readonly kind: TbcProviderValidationKind;

  constructor(kind: TbcProviderValidationKind) {
    super(`The TBC Provider ${kind} value is invalid.`);
    this.name = "TbcProviderValidationError";
    this.kind = kind;
  }
}

interface GeneratedValidator {
  (value: unknown): boolean;
}

const validators = generated as unknown as Readonly<Record<string, unknown>>;
const executionStages = generated.TWS_PROVIDER_EXECUTION_ERROR_STAGES as
  Readonly<Record<string, readonly string[]>>;

function validator(name: string): GeneratedValidator {
  const value = validators[name];
  if (typeof value !== "function") {
    throw new TbcProviderValidationError("json");
  }
  return value as GeneratedValidator;
}

function optionalValidator(name: string): GeneratedValidator | undefined {
  const value = validators[name];
  if (value === undefined) return undefined;
  if (typeof value !== "function") {
    throw new TbcProviderValidationError("json");
  }
  return value as GeneratedValidator;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalSnapshot<T>(value: T): T {
  let encoded: string;
  try {
    encoded = canonicalize(value);
  } catch {
    throw new TbcProviderValidationError("json");
  }
  if (utf8(encoded).length > TBC_PROVIDER_MAX_MESSAGE_BYTES) {
    throw new TbcProviderValidationError("size");
  }
  return deepFreeze(JSON.parse(encoded) as T);
}

function assertSchema<T>(
  name: string,
  value: T,
  kind: TbcProviderValidationKind,
): T {
  const stable = canonicalSnapshot(value);
  if (!validator(name)(stable)) throw new TbcProviderValidationError(kind);
  return stable;
}

function isKnownMethod(method: string): method is TbcProviderMethod {
  return TBC_PROVIDER_METHODS.includes(method as TbcProviderMethod);
}

function isKnownEvent(name: string): name is TbcProviderEventName {
  return TBC_PROVIDER_EVENTS.includes(name as TbcProviderEventName);
}

function assertExecutionErrorPair(response: TbcJsonRpcResponse): void {
  if (!("error" in response) || response.error.code !== -32000) return;
  const data = response.error.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new TbcProviderValidationError("response");
  }
  const name = Reflect.get(data, "name");
  const stage = Reflect.get(data, "stage");
  if (
    typeof name !== "string" ||
    typeof stage !== "string" ||
    !executionStages[name]?.includes(stage)
  ) {
    throw new TbcProviderValidationError("response");
  }
}

export function canonicalTbcMessageBytes(value: unknown): number {
  const stable = canonicalSnapshot(value);
  return utf8(canonicalize(stable)).length;
}

export function assertTbcProviderMethodParams<M extends TbcProviderMethod>(
  method: M,
  value: unknown,
): TbcProviderMethodMap[M]["params"];
export function assertTbcProviderMethodParams(
  method: string,
  value: unknown,
): readonly unknown[] | Readonly<Record<string, unknown>>;
export function assertTbcProviderMethodParams(
  method: string,
  value: unknown,
): readonly unknown[] | Readonly<Record<string, unknown>> {
  const normalized = value === undefined ? [] : value;
  if (!isKnownMethod(method)) {
    const stable = canonicalSnapshot(normalized);
    if (
      (typeof stable !== "object" || stable === null) ||
      (!Array.isArray(stable) && Object.getPrototypeOf(stable) !== Object.prototype)
    ) {
      throw new TbcProviderValidationError("params");
    }
    return stable as readonly unknown[] | Readonly<Record<string, unknown>>;
  }
  const schemaName = `params_${method}`;
  if (optionalValidator(schemaName) === undefined) {
    if (!Array.isArray(normalized) || normalized.length !== 0) {
      throw new TbcProviderValidationError("params");
    }
    return Object.freeze([]);
  }
  const stable = assertSchema(
    schemaName,
    normalized,
    "params",
  );
  if (!cryptoInputHasValidByteBudget(method, stable)) {
    throw new TbcProviderValidationError("params");
  }
  return stable as TbcProviderMethodMap[typeof method]["params"];
}

export function assertTbcProviderMethodResult<M extends TbcProviderMethod>(
  method: M,
  value: unknown,
): TbcProviderMethodMap[M]["result"];
export function assertTbcProviderMethodResult(method: string, value: unknown): unknown;
export function assertTbcProviderMethodResult(method: string, value: unknown): unknown {
  if (!isKnownMethod(method)) return canonicalSnapshot(value);
  return assertSchema(`result_${method}`, value, "result");
}

export function assertTbcProviderRequest(value: unknown): TbcJsonRpcRequest {
  const request = assertSchema("request", value, "request") as TbcJsonRpcRequest;
  assertTbcProviderMethodParams(request.method, request.params);
  return request;
}

export function assertTbcProviderResponse(
  value: unknown,
  method?: string,
): TbcJsonRpcResponse {
  const response = assertSchema("response", value, "response") as TbcJsonRpcResponse;
  assertExecutionErrorPair(response);
  if (method !== undefined && "result" in response) {
    assertTbcProviderMethodResult(method, response.result);
  }
  return response;
}

export function assertTbcProviderEvent(value: unknown): TbcProviderEvent {
  const event = assertSchema("providerEvent", value, "event") as TbcProviderEvent;
  if (!isKnownEvent(event.name)) throw new TbcProviderValidationError("event");
  assertSchema(`event_${event.name}`, event.payload, "event");
  return event;
}

export function assertTbcTransportDelivery(
  value: unknown,
  method?: string,
): TbcTransportDelivery {
  const stable = canonicalSnapshot(value);
  if (
    stable === null ||
    typeof stable !== "object" ||
    Array.isArray(stable)
  ) {
    throw new TbcProviderValidationError("delivery");
  }
  const record = stable as Record<PropertyKey, unknown>;
  if (
    Reflect.ownKeys(record).length !== 3 ||
    !Object.hasOwn(record, "deliveryId") ||
    !Object.hasOwn(record, "response") ||
    !Object.hasOwn(record, "events") ||
    typeof record.deliveryId !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.deliveryId) ||
    !Array.isArray(record.events)
  ) {
    throw new TbcProviderValidationError("delivery");
  }
  assertSchema(
    "providerCompletion",
    { delivery: "respond", response: record.response, events: record.events },
    "delivery",
  );
  const response = assertTbcProviderResponse(record.response, method);
  const events = record.events.map(assertTbcProviderEvent);
  return deepFreeze({ deliveryId: record.deliveryId, response, events });
}
