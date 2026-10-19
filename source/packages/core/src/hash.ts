import { sha256 } from "@noble/hashes/sha256";

import { canonicalize } from "./canonical-json.js";
import { bytesToHex, utf8 } from "./encoding.js";

/** Optional wallet-owned synchronous platform SHA-256. No keys or network access. */
export type Sha256Backend = (bytes: Uint8Array) => Uint8Array;
let platformSha256: Sha256Backend | undefined;

function checkedDigest(backend: Sha256Backend, bytes: Uint8Array): Uint8Array {
  const result = backend(bytes);
  if (!(result instanceof Uint8Array) || result.length !== 32) {
    throw new TypeError("SHA-256 backend must return exactly 32 bytes");
  }
  return result.slice();
}

/**
 * Configure once at wallet bootstrap, not from a DApp or Port. The optional
 * backend must implement exact SHA-256 and leave its input unchanged. Native,
 * Rust/WASM and JS consumers retain the same protocol bytes and identities.
 * Undefined restores the portable implementation. Runtime errors propagate.
 */
export function configureSha256Backend(backend: Sha256Backend | undefined): void {
  if (backend !== undefined) {
    if (typeof backend !== "function") throw new TypeError("SHA-256 backend must be a function");
    const padded = Uint8Array.from({ length: 81 }, (_, index) => index % 251);
    for (const input of [new Uint8Array(), new Uint8Array([97, 98, 99]), padded.subarray(9, 74)]) {
      const before = input.slice();
      const expected = sha256(before);
      const actual = checkedDigest(backend, input);
      if (input.some((value, index) => value !== before[index]) ||
          actual.some((value, index) => value !== expected[index])) {
        throw new TypeError("SHA-256 backend failed the public startup vectors");
      }
    }
  }
  platformSha256 = backend;
}

export function sha256Bytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("SHA-256 input must be bytes");
  }
  return platformSha256 === undefined ? sha256(value) : checkedDigest(platformSha256, value);
}

export function sha256Hex(value: Uint8Array): string {
  return bytesToHex(sha256Bytes(value));
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(utf8(canonicalize(value)));
}
