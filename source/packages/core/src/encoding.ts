const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Optional standard platform primitive; no DOM/Node dependency is required.
const PlatformTextEncoder = (globalThis as {
  TextEncoder?: new () => { encode(value: string): Uint8Array };
}).TextEncoder;
const platformEncoder = typeof PlatformTextEncoder === "function"
  ? new PlatformTextEncoder()
  : undefined;

function pushCodePoint(bytes: number[], codePoint: number): void {
  if (codePoint <= 0x7f) {
    bytes.push(codePoint);
  } else if (codePoint <= 0x7ff) {
    bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
  } else if (codePoint <= 0xffff) {
    bytes.push(
      0xe0 | (codePoint >>> 12),
      0x80 | ((codePoint >>> 6) & 0x3f),
      0x80 | (codePoint & 0x3f),
    );
  } else {
    bytes.push(
      0xf0 | (codePoint >>> 18),
      0x80 | ((codePoint >>> 12) & 0x3f),
      0x80 | ((codePoint >>> 6) & 0x3f),
      0x80 | (codePoint & 0x3f),
    );
  }
}

export function utf8(value: string): Uint8Array {
  if (typeof value !== "string") throw new TypeError("UTF-8 input must be a string");
  // Transaction hex and canonical journal data are predominantly ASCII. The VM
  // scan excludes surrogates, so TextEncoder cannot silently replace one here.
  // Non-ASCII and runtimes without an encoder retain the exact strict fallback.
  if (platformEncoder !== undefined && !/[^\x00-\x7f]/.test(value)) {
    return platformEncoder.encode(value);
  }
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) {
        throw new TypeError("UTF-8 rejects strings with a lone surrogate");
      }
      const codePoint =
        0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
      pushCodePoint(bytes, codePoint);
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new TypeError("UTF-8 rejects strings with a lone surrogate");
    } else {
      pushCodePoint(bytes, first);
    }
  }
  return Uint8Array.from(bytes);
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

export function bytesToHex(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
  return encoded;
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) {
    throw new TypeError("hex input must be lowercase and have an even length");
  }
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

export function base64urlEncode(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const block = (first << 16) | (second << 8) | third;
    encoded += BASE64URL_ALPHABET[(block >>> 18) & 0x3f];
    encoded += BASE64URL_ALPHABET[(block >>> 12) & 0x3f];
    if (index + 1 < bytes.length) {
      encoded += BASE64URL_ALPHABET[(block >>> 6) & 0x3f];
    }
    if (index + 2 < bytes.length) encoded += BASE64URL_ALPHABET[block & 0x3f];
  }
  return encoded;
}

export function base64urlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new TypeError("base64url input must be canonical and unpadded");
  }
  const bytes: number[] = [];
  let bits = 0;
  let bitCount = 0;
  for (const character of value) {
    const index = BASE64URL_ALPHABET.indexOf(character);
    if (index < 0) throw new TypeError("base64url input is invalid");
    bits = (bits << 6) | index;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
    }
  }
  if (bitCount > 0 && (bits & ((1 << bitCount) - 1)) !== 0) {
    throw new TypeError("base64url input has non-zero trailing bits");
  }
  const decoded = Uint8Array.from(bytes);
  if (base64urlEncode(decoded) !== value) {
    throw new TypeError("base64url input is not canonical");
  }
  return decoded;
}

export function base64Encode(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const block = (first << 16) | (second << 8) | third;
    encoded += BASE64_ALPHABET[(block >>> 18) & 0x3f];
    encoded += BASE64_ALPHABET[(block >>> 12) & 0x3f];
    encoded += index + 1 < bytes.length
      ? BASE64_ALPHABET[(block >>> 6) & 0x3f]
      : "=";
    encoded += index + 2 < bytes.length
      ? BASE64_ALPHABET[block & 0x3f]
      : "=";
  }
  return encoded;
}

export function base64Decode(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError("base64 input must be canonical");
  }
  const bytes: number[] = [];
  const unpadded = value.replace(/=+$/u, "");
  let bits = 0;
  let bitCount = 0;
  for (const character of unpadded) {
    const index = BASE64_ALPHABET.indexOf(character);
    if (index < 0) throw new TypeError("base64 input is invalid");
    bits = (bits << 6) | index;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
    }
  }
  if (bitCount > 0 && (bits & ((1 << bitCount) - 1)) !== 0) {
    throw new TypeError("base64 input has non-zero trailing bits");
  }
  const decoded = Uint8Array.from(bytes);
  if (base64Encode(decoded) !== value) {
    throw new TypeError("base64 input is not canonical");
  }
  return decoded;
}

export function utf8Decode(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index]!;
    let codePoint: number;
    let length: number;
    if (first <= 0x7f) {
      codePoint = first;
      length = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f;
      length = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f;
      length = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07;
      length = 4;
    } else {
      throw new TypeError("UTF-8 input is invalid");
    }
    if (index + length > bytes.length) throw new TypeError("UTF-8 input is truncated");
    for (let offset = 1; offset < length; offset += 1) {
      const next = bytes[index + offset]!;
      if ((next & 0xc0) !== 0x80) throw new TypeError("UTF-8 continuation byte is invalid");
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (
      (length === 3 && codePoint < 0x800) ||
      (length === 4 && codePoint < 0x10000) ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      throw new TypeError("UTF-8 input is not canonical");
    }
    output += String.fromCodePoint(codePoint);
    index += length;
  }
  return output;
}
