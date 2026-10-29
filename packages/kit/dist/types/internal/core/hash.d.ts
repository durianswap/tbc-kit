/** Optional wallet-owned synchronous platform SHA-256. No keys or network access. */
export type Sha256Backend = (bytes: Uint8Array) => Uint8Array;
/**
 * Configure once at wallet bootstrap, not from a DApp or Port. The optional
 * backend must implement exact SHA-256 and leave its input unchanged. Native,
 * Rust/WASM and JS consumers retain the same protocol bytes and identities.
 * Undefined restores the portable implementation. Runtime errors propagate.
 */
export declare function configureSha256Backend(backend: Sha256Backend | undefined): void;
export declare function sha256Bytes(value: Uint8Array): Uint8Array;
export declare function sha256Hex(value: Uint8Array): string;
export declare function hashCanonical(value: unknown): string;
//# sourceMappingURL=hash.d.ts.map