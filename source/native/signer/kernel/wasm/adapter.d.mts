export declare function createWasmDigestSigner(source: BufferSource | WebAssembly.Module): Promise<Readonly<{
  signDigest(digest: string, scalar: Uint8Array, encoding: "compact64" | "compact65-recoverable" | "schnorr64"): Promise<string>;
}>>;
