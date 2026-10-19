import {
  bytesToHex,
  concatBytes,
  decodeSigningMessage,
  sha256Bytes,
  utf8,
  type EncodedSigningMessage,
} from "@tbc-wallet/core";

const MAGIC = utf8("Bitcoin Signed Message:\n");
const MAX_MESSAGE_BYTES = 64 * 1024;

function compactSize(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MESSAGE_BYTES) {
    throw new TypeError("Invalid Legacy Bitcoin message size");
  }
  if (value < 0xfd) return Uint8Array.of(value);
  if (value <= 0xffff) return Uint8Array.of(0xfd, value & 0xff, value >>> 8);
  return Uint8Array.of(0xfe, value & 0xff, (value >>> 8) & 0xff,
    (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/** Wallet-owned Bitcoin Signed Message digest; no page-supplied digest is read. */
export function digestTbcLegacyBitcoinMessage(input: Readonly<{
  version: "1.0";
  message: EncodedSigningMessage;
}>): string {
  if (input === null || typeof input !== "object" || input.version !== "1.0" ||
      input.message === null || typeof input.message !== "object" ||
      typeof input.message.data !== "string" ||
      input.message.data.length > MAX_MESSAGE_BYTES * 2 ||
      !["utf8", "hex", "base64"].includes(input.message.encoding)) {
    throw new TypeError("Invalid Legacy Bitcoin message");
  }
  const body = decodeSigningMessage(input.message);
  if (body.length > MAX_MESSAGE_BYTES) {
    throw new TypeError("Invalid Legacy Bitcoin message size");
  }
  const payload = concatBytes(compactSize(MAGIC.length), MAGIC,
    compactSize(body.length), body);
  return bytesToHex(sha256Bytes(sha256Bytes(payload)));
}

/** Private WebView adapter helper. Flutter's SHA backend is native and verified at startup. */
export async function prepareTbcLegacyBitcoinMessage(input: Readonly<{
  message: string;
  encoding: "utf8" | "hex" | "base64";
}>): Promise<Readonly<{
  message: string;
  encoding: "utf8" | "hex" | "base64";
  digest: string;
}>> {
  if (input === null || typeof input !== "object" ||
      typeof input.message !== "string" ||
      !["utf8", "hex", "base64"].includes(input.encoding)) {
    throw new TypeError("Invalid Legacy Bitcoin message");
  }
  return Object.freeze({
    message: input.message,
    encoding: input.encoding,
    digest: digestTbcLegacyBitcoinMessage({version: "1.0",
      message: {encoding: input.encoding, data: input.message}}),
  });
}
