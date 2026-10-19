import {
  assertPortResult,
  assertValidTws,
  canonicalize,
  type PortCall,
  type PortError,
  type PortOperation,
  type PortResponse,
} from "@tbc-wallet/core";
import type {
  TwsHostPortOutcome,
  TwsHostPorts,
} from "./types.js";

export const TWS_HOST_OPERATION_PORTS = Object.freeze({
  "accounts.resolve": "accounts",
  "chainData.resolve": "chainData",
  "policy.resolve": "policy",
  "permissionStore.load": "permissionStore",
  "permissionStore.commit": "permissionStore",
  "approval.request": "approval",
  "signer.sign": "signer",
  "crypto.execute": "crypto",
  "reviewedTransaction.review": "reviewedTransaction",
  "reviewedTransaction.execute": "reviewedTransaction",
  "broadcast.submit": "broadcast",
  "broadcast.submitBatch": "broadcast",
  "broadcast.reconcile": "broadcast",
  "clock.now": "clock",
  "entropy.randomBytes": "entropy",
} as const satisfies Readonly<Record<PortOperation, keyof TwsHostPorts>>);

const PORT_NAMES = Object.freeze([
  "accounts",
  "chainData",
  "policy",
  "permissionStore",
  "approval",
  "signer",
  "crypto",
  "reviewedTransaction",
  "broadcast",
  "clock",
  "entropy",
] as const satisfies readonly (keyof TwsHostPorts)[]);

const ALLOWED_FUNCTION_PROTOTYPES = new Set<object>([
  Function.prototype,
  Object.getPrototypeOf(async () => undefined) as object,
  Object.prototype,
]);

function clone<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot<T>(value: T): T {
  return freeze(clone(value));
}

function internalFailure(callId: string): PortResponse {
  return Object.freeze({
    version: "1.0",
    callId,
    error: Object.freeze({
      name: "INTERNAL_ERROR",
      message: "The Host Port failed.",
      retryable: false,
    }),
  });
}

function unknownOperation(callId: string): PortResponse {
  return Object.freeze({
    version: "1.0",
    callId,
    error: Object.freeze({
      name: "INVALID_INPUT",
      message: "The Host Port operation is not registered.",
      retryable: false,
    }),
  });
}

function hasNonstandardFunctionPrototype(
  value: (...args: never[]) => unknown,
): boolean {
  let current = Object.getPrototypeOf(value) as object | null;
  while (current !== null) {
    if (!ALLOWED_FUNCTION_PROTOTYPES.has(current)) return true;
    current = Object.getPrototypeOf(current) as object | null;
  }

  const declaredPrototype = value.prototype as unknown;
  if (declaredPrototype === undefined) return false;
  if (declaredPrototype === null || typeof declaredPrototype !== "object") return true;
  const keys = Reflect.ownKeys(declaredPrototype);
  const constructorDescriptor = Reflect.getOwnPropertyDescriptor(
    declaredPrototype,
    "constructor",
  );
  return (
    keys.length !== 1 ||
    keys[0] !== "constructor" ||
    constructorDescriptor === undefined ||
    !("value" in constructorDescriptor) ||
    constructorDescriptor.value !== value ||
    Object.getPrototypeOf(declaredPrototype) !== Object.prototype
  );
}

function isAllowedFunctionOwnKey(
  value: object,
  key: PropertyKey,
): boolean {
  if (
    typeof key === "string" &&
    ["length", "name", "prototype"].includes(key)
  ) {
    return true;
  }
  if (key !== "caller" && key !== "arguments") return false;
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    descriptor.enumerable !== false ||
    descriptor.configurable !== false
  ) {
    return false;
  }
  if ("value" in descriptor) {
    return descriptor.value === null && descriptor.writable === false;
  }
  function restrictedIntrinsicProbe(): void {}
  const intrinsicDescriptor = Reflect.getOwnPropertyDescriptor(
    restrictedIntrinsicProbe,
    key,
  );
  return (
    intrinsicDescriptor !== undefined &&
    !("value" in intrinsicDescriptor) &&
    descriptor.get === intrinsicDescriptor.get &&
    descriptor.set === intrinsicDescriptor.set
  );
}

function isPortFailure(value: object): value is Readonly<{ portError: PortError }> {
  return "portError" in value;
}

async function invokeRegisteredPort(
  ports: TwsHostPorts,
  call: PortCall,
): Promise<object> {
  switch (call.operation) {
    case "accounts.resolve":
      return ports.accounts(call);
    case "chainData.resolve":
      return ports.chainData(call);
    case "policy.resolve":
      return ports.policy(call);
    case "permissionStore.load":
    case "permissionStore.commit":
      return ports.permissionStore(call);
    case "approval.request":
      return ports.approval(call);
    case "signer.sign":
      return ports.signer(call);
    case "crypto.execute":
      return ports.crypto === undefined
        ? { portError: { name: "UNAVAILABLE", message: "Crypto Port is unavailable.", retryable: false } }
        : ports.crypto(call);
    case "reviewedTransaction.review":
    case "reviewedTransaction.execute":
      return ports.reviewedTransaction === undefined
        ? { portError: { name: "UNAVAILABLE", message: "Reviewed Transaction Port is unavailable.", retryable: false } }
        : ports.reviewedTransaction(call);
    case "broadcast.submit":
    case "broadcast.submitBatch":
    case "broadcast.reconcile":
      return ports.broadcast(call);
    case "clock.now":
      return ports.clock(call);
    case "entropy.randomBytes":
      return ports.entropy(call);
  }
}

export function assertHostPorts(value: TwsHostPorts): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Host ports must provide the required capabilities and optional crypto/reviewed-transaction capabilities");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length < PORT_NAMES.length - 2 ||
    keys.length > PORT_NAMES.length ||
    keys.some((key) => typeof key !== "string" || !PORT_NAMES.includes(key as never))
  ) {
    throw new TypeError("Host ports must provide the required capabilities and optional crypto/reviewed-transaction capabilities");
  }
  for (const name of PORT_NAMES) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, name);
    if ((name === "crypto" || name === "reviewedTransaction") && descriptor === undefined) continue;
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      throw new TypeError(`Host Port ${name} is missing its function capability`);
    }
    const port = descriptor.value;
    const hidden = Reflect.ownKeys(port).filter(
      (key) => !isAllowedFunctionOwnKey(port, key),
    );
    if (hidden.length > 0) {
      throw new TypeError(`Host Port ${name} exposes a hidden capability`);
    }
    if (hasNonstandardFunctionPrototype(port)) {
      throw new TypeError(`Host Port ${name} exposes a hidden prototype capability`);
    }
  }
}

export async function dispatchHostPort<K extends PortOperation>(
  ports: TwsHostPorts,
  call: PortCall<K>,
): Promise<PortResponse<K>> {
  if (!(call.operation in TWS_HOST_OPERATION_PORTS)) {
    return unknownOperation(call.callId) as PortResponse<K>;
  }
  try {
    const stableCall = snapshot(call) as PortCall;
    const outcome = await invokeRegisteredPort(ports, stableCall);
    if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) {
      return internalFailure(call.callId) as PortResponse<K>;
    }
    const response = isPortFailure(outcome)
      ? {
          version: "1.0" as const,
          callId: call.callId,
          error: snapshot(outcome.portError),
        }
      : {
          version: "1.0" as const,
          callId: call.callId,
          result: snapshot(outcome),
        };
    if ("result" in response) assertPortResult(call.operation, response.result);
    assertValidTws("portResponse", response);
    return snapshot(response) as PortResponse<K>;
  } catch {
    return internalFailure(call.callId) as PortResponse<K>;
  }
}

export type { TwsHostPortOutcome };
