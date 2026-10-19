import type { EncodedSigningMessage } from "./signing-artifacts.js";
import { decodeSigningMessage } from "./signing-artifacts.js";
import { utf8, utf8Decode } from "./encoding.js";
import { parseProtocolTimestamp } from "./protocol-time.js";

const HEADER = "TBC Sign-In";
const PREFIX = `${HEADER}\n`;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/u;
const CHAIN_ID = /^tbc:[0-9a-z][0-9a-z._:-]{0,127}$/u;
const ADDRESS = /^[!-~]{1,128}$/u;
const ORIGIN = /^(https?):\/\/([^/?#@]+)$/u;
const URI = /^(https?):\/\/([^/?#@]+)([^\u0000-\u001f\u007f ]*)$/u;

export interface TbcSignInMessageFields {
  readonly domain: string;
  readonly uri: string;
  readonly address: string;
  readonly chainId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expirationTime: string;
  readonly statement?: string;
}

function exactTimestamp(value: string, field: string): number {
  try {
    return parseProtocolTimestamp(value);
  } catch {
    throw new TypeError(`Invalid TBC Sign-In ${field}`);
  }
}

function uriOrigin(uri: string): Readonly<{ origin: string; domain: string }> {
  const match = URI.exec(uri);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new TypeError("Invalid TBC Sign-In URI");
  }
  const scheme = match[1];
  const domain = match[2];
  if (scheme !== scheme.toLowerCase() || domain !== domain.toLowerCase()) {
    throw new TypeError("TBC Sign-In URI must use a canonical lowercase origin");
  }
  return Object.freeze({ origin: `${scheme}://${domain}`, domain });
}

export function serializeTbcSignInMessage(input: TbcSignInMessageFields): string {
  const target = uriOrigin(input.uri);
  if (input.domain !== target.domain || !ORIGIN.test(target.origin)) {
    throw new TypeError("TBC Sign-In domain differs from URI");
  }
  if (!ADDRESS.test(input.address) || !CHAIN_ID.test(input.chainId) || !NONCE.test(input.nonce)) {
    throw new TypeError("Invalid TBC Sign-In identity or nonce");
  }
  const issuedAt = exactTimestamp(input.issuedAt, "issuedAt");
  const expirationTime = exactTimestamp(input.expirationTime, "expirationTime");
  if (expirationTime <= issuedAt) throw new TypeError("TBC Sign-In expiration must follow issuance");
  if (
    input.statement !== undefined &&
    (input.statement.length < 1 || input.statement.length > 256 || /[\r\n\u0000-\u001f\u007f]/u.test(input.statement))
  ) {
    throw new TypeError("Invalid TBC Sign-In statement");
  }
  return [
    HEADER,
    `Domain: ${input.domain}`,
    `URI: ${input.uri}`,
    `Address: ${input.address}`,
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expirationTime}`,
    ...(input.statement === undefined ? [] : [`Statement: ${input.statement}`]),
  ].join("\n");
}

export function parseTbcSignInMessage(value: string): TbcSignInMessageFields {
  if (typeof value !== "string" || value.includes("\r")) {
    throw new TypeError("Invalid TBC Sign-In message encoding");
  }
  const lines = value.split("\n");
  if (lines.length !== 8 && lines.length !== 9) {
    throw new TypeError("Invalid TBC Sign-In field count");
  }
  const take = (index: number, label: string): string => {
    const line = lines[index];
    const prefix = `${label}: `;
    if (line === undefined || !line.startsWith(prefix)) {
      throw new TypeError(`Missing TBC Sign-In ${label}`);
    }
    return line.slice(prefix.length);
  };
  if (lines[0] !== HEADER) throw new TypeError("Invalid TBC Sign-In header");
  const parsed: TbcSignInMessageFields = Object.freeze({
    domain: take(1, "Domain"),
    uri: take(2, "URI"),
    address: take(3, "Address"),
    chainId: take(4, "Chain ID"),
    nonce: take(5, "Nonce"),
    issuedAt: take(6, "Issued At"),
    expirationTime: take(7, "Expiration Time"),
    ...(lines.length === 9 ? { statement: take(8, "Statement") } : {}),
  });
  if (serializeTbcSignInMessage(parsed) !== value) {
    throw new TypeError("TBC Sign-In message is not canonical");
  }
  return parsed;
}

export function inspectTbcSignInMessage(
  message: EncodedSigningMessage,
): TbcSignInMessageFields | undefined {
  const bytes = decodeSigningMessage(message);
  const prefix = utf8(PREFIX);
  const marked = prefix.every((byte, index) => bytes[index] === byte);
  let text: string;
  try {
    text = utf8Decode(bytes);
  } catch (error) {
    if (marked) throw new TypeError("TBC Sign-In message is not valid UTF-8", { cause: error });
    return undefined;
  }
  if (!text.startsWith(PREFIX)) return undefined;
  return parseTbcSignInMessage(text);
}

export function assertTbcSignInWalletContext(
  fields: TbcSignInMessageFields,
  expected: Readonly<{
    origin: string;
    chainId: string;
    address: string;
    now: string;
  }>,
): void {
  const target = uriOrigin(fields.uri);
  const origin = ORIGIN.exec(expected.origin);
  if (
    origin?.[1] === undefined ||
    origin[2] === undefined ||
    expected.origin !== `${origin[1]}://${origin[2]}` ||
    fields.domain !== target.domain ||
    target.origin !== expected.origin ||
    fields.chainId !== expected.chainId ||
    fields.address !== expected.address
  ) {
    throw new TypeError("TBC Sign-In trusted context mismatch");
  }
  const now = exactTimestamp(expected.now, "walletTime");
  const issuedAt = exactTimestamp(fields.issuedAt, "issuedAt");
  const expirationTime = exactTimestamp(fields.expirationTime, "expirationTime");
  if (issuedAt > now || expirationTime <= now) {
    throw new TypeError("TBC Sign-In request is not currently valid");
  }
}
