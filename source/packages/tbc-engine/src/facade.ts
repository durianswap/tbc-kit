import {
  assertValidTws,
  canonicalize,
  type FinalizeParams,
  type FinalizeResult,
  type NormalizeRequestParams,
  type NormalizeRequestResult,
  type PlanParams,
  type PlanResult,
  type TransactionEngine,
  type ValidateParams,
  type ValidationResult,
} from "@tbc-wallet/core";
import { assertBackend, type TbcEngineBackend, type TbcEngineMethod } from "./backend.js";
import { TbcEngineError } from "./errors.js";

export interface TbcEngineOptions {
  readonly backend: TbcEngineBackend;
}

const validators = Object.freeze({
  normalizeRequest: ["normalizeRequestParams", "normalizeRequestResult"],
  plan: ["planParams", "planResult"],
  validate: ["validateParams", "validationResult"],
  finalize: ["finalizeParams", "finalizeResult"],
} as const);

function decodeEnvelope<T>(method: TbcEngineMethod, raw: string): T {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new TbcEngineError("SERIALIZATION_ERROR", "Rust backend returned invalid JSON");
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new TbcEngineError("SERIALIZATION_ERROR", "Rust backend returned an invalid envelope");
  }
  const record = envelope as {
    readonly ok?: unknown;
    readonly result?: unknown;
    readonly error?: { readonly code?: unknown; readonly message?: unknown; readonly path?: unknown };
  };
  if (record.ok === false && record.error !== undefined) {
    throw TbcEngineError.fromRust(record.error);
  }
  if (record.ok !== true || !("result" in record)) {
    throw new TbcEngineError("SERIALIZATION_ERROR", "Rust backend omitted its result envelope");
  }
  try {
    assertValidTws(validators[method][1], record.result);
  } catch {
    throw new TbcEngineError("SERIALIZATION_ERROR", `Rust backend returned invalid ${method} output`);
  }
  return record.result as T;
}

function invoke<T>(backend: TbcEngineBackend, method: TbcEngineMethod, params: unknown): T | Promise<T> {
  try {
    assertValidTws(validators[method][0], params);
  } catch {
    throw new TbcEngineError("INVALID_REQUEST", `invalid ${validators[method][0]}`);
  }
  const response = backend.call(method, canonicalize(params));
  return typeof response === "string"
    ? decodeEnvelope<T>(method, response)
    : response.then((raw) => decodeEnvelope<T>(method, raw));
}

export function createTbcEngine(options: TbcEngineOptions): TransactionEngine {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TbcEngineError("INVALID_REQUEST", "invalid TBC Engine options");
  }
  assertBackend(options.backend);
  const backend = options.backend;
  return Object.freeze({
    normalizeRequest: (params: NormalizeRequestParams): NormalizeRequestResult | Promise<NormalizeRequestResult> =>
      invoke(backend, "normalizeRequest", params),
    plan: (params: PlanParams): PlanResult | Promise<PlanResult> => invoke(backend, "plan", params),
    validate: (params: ValidateParams): ValidationResult | Promise<ValidationResult> =>
      invoke(backend, "validate", params),
    finalize: (params: FinalizeParams): FinalizeResult | Promise<FinalizeResult> =>
      invoke(backend, "finalize", params),
  });
}
