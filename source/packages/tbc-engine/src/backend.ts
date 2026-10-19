export const TBC_ENGINE_METHODS = Object.freeze([
  "normalizeRequest",
  "plan",
  "validate",
  "finalize",
] as const);

export type TbcEngineMethod = (typeof TBC_ENGINE_METHODS)[number];

export interface TbcEngineBackend {
  readonly call: (method: TbcEngineMethod, input: string) => string | Promise<string>;
}

export function assertBackend(value: unknown): asserts value is TbcEngineBackend {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { readonly call?: unknown }).call !== "function"
  ) {
    throw new TypeError("TBC Engine backend must expose call(method, canonicalJson)");
  }
}
