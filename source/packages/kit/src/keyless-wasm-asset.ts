/** Browser/RN-neutral resource transport. Never used for chain-data queries. */
export interface KeylessWasmAssetOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly url?: string | URL;
}

export async function readKeylessWasmAsset(
  url: string | URL,
  options: KeylessWasmAssetOptions,
): Promise<ArrayBuffer | Uint8Array> {
  const response = await (options.fetch ?? globalThis.fetch)(url);
  if (!response.ok) throw new Error(`could not load TBC keyless WASM: ${response.status}`);
  return response.arrayBuffer();
}
