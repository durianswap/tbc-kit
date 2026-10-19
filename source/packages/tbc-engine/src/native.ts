import { assertBackend, type TbcEngineBackend, type TbcEngineMethod } from "./backend.js";

export type TbcNativeCall = (method: TbcEngineMethod, canonicalInput: string) => string | Promise<string>;

export function createNativeTbcEngineBackend(call: TbcNativeCall): TbcEngineBackend {
  const backend = Object.freeze({ call });
  assertBackend(backend);
  return backend;
}
