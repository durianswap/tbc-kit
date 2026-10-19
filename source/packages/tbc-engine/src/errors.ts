export const TBC_ENGINE_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "UNSUPPORTED_CHAIN",
  "INVALID_ADDRESS",
  "INVALID_SNAPSHOT",
  "INVALID_POLICY",
  "INSUFFICIENT_FUNDS",
  "MINIMUM_OUTPUT_NOT_MET",
  "AMOUNT_OUT_OF_RANGE",
  "SIGNATURE_INVALID",
  "SERIALIZATION_ERROR",
] as const);

export type TbcEngineErrorCode = (typeof TBC_ENGINE_ERROR_CODES)[number];

export class TbcEngineError extends Error {
  readonly code: TbcEngineErrorCode;
  readonly path?: string;
  readonly rustCode?: string;

  constructor(code: TbcEngineErrorCode, message: string, path?: string, rustCode?: string) {
    super(message);
    this.name = "TbcEngineError";
    this.code = code;
    if (path !== undefined) this.path = path;
    if (rustCode !== undefined) this.rustCode = rustCode;
  }

  static fromRust(error: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly path?: unknown;
  }): TbcEngineError {
    const rustCode = typeof error.code === "string" ? error.code : "INTERNAL_INVARIANT";
    const message = typeof error.message === "string" ? error.message : "Rust engine rejected the request";
    const path = typeof error.path === "string" ? error.path : undefined;
    const mapped: TbcEngineErrorCode = rustCode === "INSUFFICIENT_FUNDS"
      ? "INSUFFICIENT_FUNDS"
      : rustCode === "MINIMUM_OUTPUT_NOT_MET"
        ? "MINIMUM_OUTPUT_NOT_MET"
        : rustCode === "INVALID_SIGNATURE" || rustCode === "MISSING_SIGNATURE"
          ? "SIGNATURE_INVALID"
          : rustCode === "SERIALIZATION_ERROR"
            ? "SERIALIZATION_ERROR"
            : "INVALID_REQUEST";
    return new TbcEngineError(mapped, message, path, rustCode);
  }
}
