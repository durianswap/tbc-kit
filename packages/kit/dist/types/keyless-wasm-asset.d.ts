/** Browser/RN-neutral resource transport. Never used for chain-data queries. */
export interface KeylessWasmAssetOptions {
    readonly fetch?: typeof globalThis.fetch;
    readonly url?: string | URL;
}
export declare function readKeylessWasmAsset(url: string | URL, options: KeylessWasmAssetOptions): Promise<ArrayBuffer | Uint8Array>;
