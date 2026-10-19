import { canonicalize } from "./canonical-json.js";
import {
  base64Decode,
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8,
} from "./encoding.js";
import { sha256Bytes } from "./hash.js";

function compactSize(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("CompactSize input is outside uint32");
  }
  if (value < 0xfd) return Uint8Array.of(value);
  if (value <= 0xffff) {
    return Uint8Array.of(0xfd, value & 0xff, (value >>> 8) & 0xff);
  }
  return Uint8Array.of(
    0xfe,
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

export function canonicalSigningEnvelope(envelope: unknown): string {
  return canonicalize(envelope);
}

export interface EncodedSigningMessage {
  readonly encoding: "utf8" | "hex" | "base64";
  readonly data: string;
}

export function decodeSigningMessage(message: EncodedSigningMessage): Uint8Array {
  if (message.encoding === "utf8") return utf8(message.data);
  if (message.encoding === "hex") return hexToBytes(message.data);
  if (message.encoding === "base64") return base64Decode(message.data);
  throw new TypeError("unsupported message encoding");
}

export function signingPayload(envelope: unknown): Uint8Array {
  const type = (envelope as { readonly type?: unknown })?.type;
  const magic = type === "tbc.message"
    ? "TBC Signed Message:\n"
    : type === "tbc.typedData"
      ? "TBC Signed Typed Data:\n"
      : undefined;
  if (magic === undefined) {
    throw new TypeError("unsupported signing envelope type");
  }
  const magicBytes = utf8(magic);
  const body = type === "tbc.message"
    ? decodeSigningMessage(
        (envelope as { readonly message: EncodedSigningMessage }).message,
      )
    : utf8(canonicalSigningEnvelope(envelope));
  return concatBytes(
    compactSize(magicBytes.length),
    magicBytes,
    compactSize(body.length),
    body,
  );
}

export function signingEnvelopeDigest(envelope: unknown): string {
  const payload = signingPayload(envelope);
  return bytesToHex(sha256Bytes(sha256Bytes(payload)));
}
