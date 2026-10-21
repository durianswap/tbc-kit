/// <reference lib="dom" />

import type { LegacyPoolSigningProductionNativeEngine } from "./pool-signing-loader.js";
import { readKeylessWasmAsset, type KeylessWasmAssetOptions } from "./keyless-wasm-asset.js";

export const TBC_KEYLESS_OPERATIONS = Object.freeze([
  "preparePoolNft",
  "prepareAssetAncestry",
  "legacyPoolPreview",
  "inspectTokenReceipt",
  "inspectNftReceipt",
  "prepareReviewedStage",
  "finalizeReviewedStage",
  "inspectAmmMaterial",
  "inspectLopMaterial",
  "inspectTokenMaterial",
  "describeMultisig",
  "decodeMultisigAddress",
  "prepareMultisig",
  "inspectMultisig",
  "reviewMultisig",
  "verifyMultisigSignatures",
  "finalizeMultisig",
] as const);

export type TbcKeylessOperation = (typeof TBC_KEYLESS_OPERATIONS)[number];

type KeylessWasmExports = {
  readonly memory: WebAssembly.Memory;
  readonly tbc_keyless_wasm_alloc: (length: number) => number;
  readonly tbc_keyless_wasm_free_input: (pointer: number, length: number) => void;
  readonly tbc_keyless_wasm_call: (
    operationPointer: number,
    operationLength: number,
    inputPointer: number,
    inputLength: number,
  ) => number;
  readonly tbc_keyless_wasm_result_ptr: (buffer: number) => number;
  readonly tbc_keyless_wasm_result_len: (buffer: number) => number;
  readonly tbc_keyless_wasm_free_result: (buffer: number) => void;
};

function assertKeylessExports(value: unknown): asserts value is KeylessWasmExports {
  const exports = value as Partial<KeylessWasmExports> | null;
  if (
    exports === null ||
    !(exports.memory instanceof WebAssembly.Memory) ||
    [
      exports.tbc_keyless_wasm_alloc,
      exports.tbc_keyless_wasm_free_input,
      exports.tbc_keyless_wasm_call,
      exports.tbc_keyless_wasm_result_ptr,
      exports.tbc_keyless_wasm_result_len,
      exports.tbc_keyless_wasm_free_result,
    ].some((member) => typeof member !== "function")
  ) {
    throw new TypeError("invalid TBC keyless WASM exports");
  }
}

function unwrapKeylessResult(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid TBC keyless response");
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as { readonly error?: unknown }).error === "string"
  ) {
    throw new Error((parsed as { readonly error: string }).error);
  }
  return value;
}

export async function createWasmTbcKeylessEngine(
  source: ArrayBuffer | Uint8Array | WebAssembly.Module,
): Promise<LegacyPoolSigningProductionNativeEngine> {
  const module = source instanceof WebAssembly.Module
    ? source
    : await WebAssembly.compile(
        source instanceof Uint8Array ? Uint8Array.from(source).buffer : source,
      );
  if (WebAssembly.Module.imports(module).length !== 0) {
    throw new TypeError("TBC keyless WASM artifact must not require ambient imports");
  }
  const instance = await WebAssembly.instantiate(module, {});
  assertKeylessExports(instance.exports);
  const wasm = instance.exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  return Object.freeze({
    async protocolInfo() {
      return JSON.stringify({ operations: TBC_KEYLESS_OPERATIONS });
    },
    async execute(operation: string, requestJson: string) {
      if (!(TBC_KEYLESS_OPERATIONS as readonly string[]).includes(operation)) {
        throw new Error("KEYLESS_OPERATION_UNAVAILABLE");
      }
      const operationBytes = encoder.encode(operation);
      const inputBytes = encoder.encode(requestJson);
      const operationPointer = wasm.tbc_keyless_wasm_alloc(operationBytes.length);
      const inputPointer = wasm.tbc_keyless_wasm_alloc(inputBytes.length);
      try {
        new Uint8Array(wasm.memory.buffer, operationPointer, operationBytes.length).set(operationBytes);
        new Uint8Array(wasm.memory.buffer, inputPointer, inputBytes.length).set(inputBytes);
        const result = wasm.tbc_keyless_wasm_call(
          operationPointer,
          operationBytes.length,
          inputPointer,
          inputBytes.length,
        );
        try {
          const pointer = wasm.tbc_keyless_wasm_result_ptr(result);
          const length = wasm.tbc_keyless_wasm_result_len(result);
          return unwrapKeylessResult(
            decoder.decode(new Uint8Array(wasm.memory.buffer, pointer, length)),
          );
        } finally {
          wasm.tbc_keyless_wasm_free_result(result);
        }
      } finally {
        wasm.tbc_keyless_wasm_free_input(operationPointer, operationBytes.length);
        wasm.tbc_keyless_wasm_free_input(inputPointer, inputBytes.length);
      }
    },
  });
}

function packageAssetUrl(relativePath: string): URL {
  return new URL(relativePath, import.meta.url);
}

export function createLazyBundledWasmTbcKeylessEngine(
  input: typeof globalThis.fetch | KeylessWasmAssetOptions = {},
): LegacyPoolSigningProductionNativeEngine {
  const options = typeof input === "function" ? { fetch: input } : input;
  let engine: Promise<LegacyPoolSigningProductionNativeEngine> | undefined;
  // Resolve even the package URL only on use. Policy-only consumers and an
  // injected material source must not initialize the unrelated WASM delivery.
  const read = () => engine ??= readKeylessWasmAsset(
    options.url ?? packageAssetUrl("../../artifacts/wasm/tbc_keyless_wasm.wasm"), options,
  )
    .then(createWasmTbcKeylessEngine);
  return Object.freeze({
    protocolInfo: async () => (await read()).protocolInfo(),
    execute: async (operation: string, requestJson: string) =>
      (await read()).execute(operation, requestJson),
  });
}

/** Thin adapter for a platform-owned Native bridge. No key or signing operation is accepted. */
export function createNativeTbcKeylessEngine(
  execute: LegacyPoolSigningProductionNativeEngine["execute"],
): LegacyPoolSigningProductionNativeEngine {
  return Object.freeze({
    protocolInfo: async () => JSON.stringify({ operations: TBC_KEYLESS_OPERATIONS }),
    execute: async (operation: string, requestJson: string) => {
      if (!(TBC_KEYLESS_OPERATIONS as readonly string[]).includes(operation)) {
        throw new Error("KEYLESS_OPERATION_UNAVAILABLE");
      }
      // Native callEnvelope returns the same success/error JSON ABI as WASM.
      // Normalize failures here so callers never mistake an error for a result.
      return unwrapKeylessResult(await execute(operation, requestJson));
    },
  });
}
