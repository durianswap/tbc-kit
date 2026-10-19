/// <reference lib="dom" />

import type { TbcEngineBackend, TbcEngineMethod } from "./backend.js";

type WasmExports = {
  readonly memory: WebAssembly.Memory;
  readonly tbc_engine_wasm_alloc: (length: number) => number;
  readonly tbc_engine_wasm_free_input: (pointer: number, length: number) => void;
  readonly tbc_engine_wasm_call: (
    methodPointer: number,
    methodLength: number,
    inputPointer: number,
    inputLength: number,
  ) => number;
  readonly tbc_engine_wasm_result_ptr: (buffer: number) => number;
  readonly tbc_engine_wasm_result_len: (buffer: number) => number;
  readonly tbc_engine_wasm_free_result: (buffer: number) => void;
};

function assertExports(value: unknown): asserts value is WasmExports {
  const exports = value as Partial<WasmExports> | null;
  if (
    exports === null ||
    !(exports.memory instanceof WebAssembly.Memory) ||
    [
      exports.tbc_engine_wasm_alloc,
      exports.tbc_engine_wasm_free_input,
      exports.tbc_engine_wasm_call,
      exports.tbc_engine_wasm_result_ptr,
      exports.tbc_engine_wasm_result_len,
      exports.tbc_engine_wasm_free_result,
    ].some((member) => typeof member !== "function")
  ) {
    throw new TypeError("invalid TBC Engine WASM exports");
  }
}

export async function createWasmTbcEngineBackend(
  source: ArrayBuffer | Uint8Array | WebAssembly.Module,
): Promise<TbcEngineBackend> {
  const module = source instanceof WebAssembly.Module
    ? source
    : await WebAssembly.compile(
        source instanceof Uint8Array ? Uint8Array.from(source).buffer : source,
      );
  if (WebAssembly.Module.imports(module).length !== 0) {
    throw new TypeError("TBC Engine WASM artifact must not require ambient imports");
  }
  const instance = await WebAssembly.instantiate(module, {});
  assertExports(instance.exports);
  const wasm = instance.exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  return Object.freeze({
    call(method: TbcEngineMethod, input: string) {
      const methodBytes = encoder.encode(method);
      const inputBytes = encoder.encode(input);
      const methodPointer = wasm.tbc_engine_wasm_alloc(methodBytes.length);
      const inputPointer = wasm.tbc_engine_wasm_alloc(inputBytes.length);
      try {
        new Uint8Array(wasm.memory.buffer, methodPointer, methodBytes.length).set(methodBytes);
        new Uint8Array(wasm.memory.buffer, inputPointer, inputBytes.length).set(inputBytes);
        const result = wasm.tbc_engine_wasm_call(
          methodPointer,
          methodBytes.length,
          inputPointer,
          inputBytes.length,
        );
        try {
          const pointer = wasm.tbc_engine_wasm_result_ptr(result);
          const length = wasm.tbc_engine_wasm_result_len(result);
          return decoder.decode(new Uint8Array(wasm.memory.buffer, pointer, length));
        } finally {
          wasm.tbc_engine_wasm_free_result(result);
        }
      } finally {
        wasm.tbc_engine_wasm_free_input(methodPointer, methodBytes.length);
        wasm.tbc_engine_wasm_free_input(inputPointer, inputBytes.length);
      }
    },
  });
}

export interface LazyWasmTbcEngineOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly url?: string | URL;
}

function packageAssetUrl(relativePath: string): URL {
  return new URL(relativePath, import.meta.url);
}

export function createLazyBundledWasmTbcEngineBackend(
  options: LazyWasmTbcEngineOptions = {},
): TbcEngineBackend {
  let backend: Promise<TbcEngineBackend> | undefined;
  return Object.freeze({
    call(method: TbcEngineMethod, input: string) {
      const fetchImpl = options.fetch ?? globalThis.fetch;
      if (typeof fetchImpl !== "function") throw new Error("TBC Engine WASM requires fetch");
      const url = options.url ?? packageAssetUrl("../../artifacts/wasm/tbc_engine_wasm.wasm");
      const loading = backend ??= fetchImpl(url)
        .then((response) => {
          if (!response.ok) throw new Error(`could not load TBC Engine WASM: ${response.status}`);
          return response.arrayBuffer();
        })
        .then(createWasmTbcEngineBackend);
      return loading.then((resolved) => resolved.call(method, input));
    },
  });
}
