import { sha256 } from "@noble/hashes/sha256";

export function bytesToHex(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
  return encoded;
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/u.test(value)) {
    throw new TypeError("hex input must be lowercase and have an even length");
  }
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function sha256Bytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("SHA-256 input must be bytes");
  }
  return sha256(value);
}

