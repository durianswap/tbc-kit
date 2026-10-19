/** Wallet-private. Authenticate approval/task binding outside this primitive. */
export interface MuSigGroup {
  /** Sorted unique compressed public keys (33-byte lowercase hex). */
  publicKeys: readonly string[];
  aggregateKey: string;
  digest: string;
}
export interface MuSigBegin extends MuSigGroup {
  binding: string;
  scalar: Uint8Array;
  /** Trusted monotonic milliseconds; no later than the approval deadline. */
  expiresAt: number;
}
export interface MuSigHandle { readonly handle: string; readonly publicNonce: string; }
export interface MuSigSign {
  handle: string; binding: string; digest: string; scalar: Uint8Array;
  publicNonces: readonly string[];
}
export interface MuSigCombine extends MuSigGroup {
  publicNonces: readonly string[]; partialSignatures: readonly string[];
}
export interface WasmMuSigSigner {
  /** Pure public group derivation. Sorted unique keys; does not grant authority. */
  aggregateKey(publicKeys: readonly string[]): string;
  begin(input: MuSigBegin): MuSigHandle;
  sign(input: MuSigSign): string;
  combine(input: MuSigCombine): string;
  cancel(handle: string): void;
  cancelAll(): void;
}
export declare function createWasmMuSigSigner(
  source: Uint8Array | ArrayBuffer | WebAssembly.Module,
  options?: {
    /** Trusted platform service only. Defaults to Web Crypto, never Math.random. */
    crypto?: { getRandomValues<T extends Uint8Array>(bytes: T): T };
    clock?: () => number;
  },
): Promise<Readonly<WasmMuSigSigner>>;
