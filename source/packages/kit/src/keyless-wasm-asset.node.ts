import { readFile } from "node:fs/promises";
import {
  readKeylessWasmAsset as fetchAsset,
  type KeylessWasmAssetOptions,
} from "./keyless-wasm-asset.js";

/** Selected only in Node builds; explicit transports never silently fall back. */
export async function readKeylessWasmAsset(
  url: string | URL,
  options: KeylessWasmAssetOptions,
): Promise<ArrayBuffer | Uint8Array> {
  if (options.fetch === undefined) {
    const local = url instanceof URL ? url : url.startsWith("file:") ? new URL(url) : undefined;
    if (local?.protocol === "file:") return Uint8Array.from(await readFile(local));
  }
  return fetchAsset(url, options);
}
