import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  assertTbcSignInWalletContext,
  base64Decode,
  base64Encode,
  bytesToHex,
  canonicalSigningEnvelope,
  hexToBytes,
  parseTbcSignInMessage,
  serializeTbcSignInMessage,
  signingEnvelopeDigest,
  signingPayload,
} from "@tbc-wallet/core";
import type { KitProvider } from "./public-types.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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

export interface TbcMessageSignatureResult {
  readonly version: "1.0";
  readonly scheme: "tbc-message" | "legacy-bitcoin-message";
  readonly algorithm: "secp256k1-recoverable-ecdsa-sha256d";
  readonly address: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly canonical: string;
  readonly signingPayload?: string;
  readonly digest: string;
  readonly signature: string;
}

export interface TbcSignInInput {
  readonly provider: KitProvider;
  readonly chainId: `tbc:${string}`;
  readonly address: string;
  /** URI authority, for example `app.example`. */
  readonly domain: string;
  readonly uri: string;
  /** Backend-issued, single-use challenge. */
  readonly nonce: string;
  readonly issuedAt?: string;
  readonly expirationTime?: string;
  readonly statement?: string;
  readonly clientRequestId?: string;
}

export interface TbcSignInResult {
  readonly message: string;
  readonly fields: TbcSignInMessageFields;
  readonly signature: TbcMessageSignatureResult;
}

export interface VerifyTbcSignInOptions {
  readonly result: TbcSignInResult;
  readonly expected: Readonly<{
    readonly domain: string;
    readonly uri: string;
    readonly chainId: `tbc:${string}`;
    readonly address: string;
    readonly now?: string;
  }>;
  /**
   * Atomically consume the backend challenge. It must return false when the
   * nonce was already consumed, unknown, expired, or bound to other fields.
   */
  readonly consumeChallenge: (
    challenge: TbcSignInMessageFields,
  ) => boolean | Promise<boolean>;
}

function exactSeconds(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new TypeError("Invalid TBC Sign-In time");
  return value.toISOString();
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function base58Encode(value: Uint8Array): string {
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === 0) leadingZeroes += 1;
  let numeric = 0n;
  for (const byte of value) numeric = (numeric << 8n) | BigInt(byte);
  let encoded = "";
  while (numeric > 0n) {
    encoded = `${BASE58_ALPHABET[Number(numeric % 58n)]}${encoded}`;
    numeric /= 58n;
  }
  return `${"1".repeat(leadingZeroes)}${encoded}`;
}

/** TBC Mainnet and Testnet share the canonical version-0 compressed-key P2PKH format. */
function tbcAddressFromPublicKey(publicKey: Uint8Array): string {
  if (
    publicKey.length !== 33 ||
    (publicKey[0] !== 0x02 && publicKey[0] !== 0x03)
  ) {
    throw new TypeError("TBC Sign-In public key must use compressed secp256k1 encoding");
  }
  const payload = concatBytes(Uint8Array.of(0x00), ripemd160(sha256(publicKey)));
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return base58Encode(concatBytes(payload, checksum));
}

function expectedOrigin(uri: string): string {
  const parsed = new URL(uri);
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("Invalid expected TBC Sign-In URI");
  }
  return parsed.origin;
}

export function createSignInMessage(
  input: Omit<TbcSignInInput, "provider" | "clientRequestId">,
): Readonly<{ message: string; fields: TbcSignInMessageFields }> {
  if (input === null || typeof input !== "object") throw new TypeError("TBC Sign-In input is required");
  const issuedAt = input.issuedAt ?? exactSeconds(new Date());
  const expirationTime = input.expirationTime ?? exactSeconds(new Date(Date.parse(issuedAt) + 5 * 60_000));
  const fields: TbcSignInMessageFields = Object.freeze({
    domain: input.domain,
    uri: input.uri,
    address: input.address,
    chainId: input.chainId,
    nonce: input.nonce,
    issuedAt,
    expirationTime,
    ...(input.statement === undefined ? {} : { statement: input.statement }),
  });
  return Object.freeze({ message: serializeTbcSignInMessage(fields), fields });
}

export async function signIn(input: TbcSignInInput): Promise<TbcSignInResult> {
  const prepared = createSignInMessage(input);
  const signature = await input.provider.request<TbcMessageSignatureResult>({
    method: "tbc_signMessage",
    params: Object.freeze({
      version: "1.0",
      chainId: input.chainId,
      from: input.address,
      message: Object.freeze({ encoding: "utf8", data: prepared.message }),
      ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
    }),
  });
  return Object.freeze({ ...prepared, signature });
}

export async function verifySignIn(
  options: VerifyTbcSignInOptions,
): Promise<TbcSignInMessageFields> {
  if (options === null || typeof options !== "object") throw new TypeError("TBC Sign-In verification options are required");
  const { result, expected } = options;
  const fields = parseTbcSignInMessage(result.message);
  if (fields.domain !== expected.domain || fields.uri !== expected.uri) {
    throw new TypeError("TBC Sign-In relying-party context mismatch");
  }
  assertTbcSignInWalletContext(fields, {
    origin: expectedOrigin(expected.uri),
    chainId: expected.chainId,
    address: expected.address,
    now: expected.now ?? exactSeconds(new Date()),
  });

  const envelope = Object.freeze({
    type: "tbc.message",
    version: "1.0",
    message: Object.freeze({ encoding: "utf8", data: result.message }),
  });
  const canonical = canonicalSigningEnvelope(envelope);
  const digest = signingEnvelopeDigest(envelope);
  const payload = signingPayload(envelope);
  const signature = result.signature;
  if (
    signature.version !== "1.0" ||
    signature.scheme !== "tbc-message" ||
    signature.algorithm !== "secp256k1-recoverable-ecdsa-sha256d" ||
    signature.address !== expected.address ||
    signature.accountId !== `${expected.chainId}:${expected.address}` ||
    canonicalSigningEnvelope(signature.envelope) !== canonical ||
    signature.canonical !== canonical ||
    signature.signingPayload === undefined ||
    !sameBytes(base64Decode(signature.signingPayload), payload) ||
    signature.digest !== digest
  ) {
    throw new TypeError("TBC Sign-In signature artifacts do not match the challenge");
  }

  const recoveredPublicKey = (() => {
    try {
      const framed = base64Decode(signature.signature);
      const header = framed[0];
      if (framed.length !== 65 || header === undefined || header < 31 || header > 34) {
        throw new Error("invalid recoverable signature framing");
      }
      const digestBytes = hexToBytes(digest);
      const publicKey = hexToBytes(signature.publicKey);
      const recovered = secp256k1.Signature
        .fromCompact(framed.subarray(1))
        .addRecoveryBit(header - 31)
        .recoverPublicKey(digestBytes)
        .toBytes(true);
      if (
        !secp256k1.verify(framed.subarray(1), digestBytes, publicKey, { prehash: false, lowS: true }) ||
        bytesToHex(recovered) !== signature.publicKey
      ) {
        throw new Error("signature verification failed");
      }
      return recovered;
    } catch (error) {
      throw new TypeError("Invalid TBC Sign-In signature", { cause: error });
    }
  })();
  if (tbcAddressFromPublicKey(recoveredPublicKey) !== expected.address) {
    throw new TypeError("TBC Sign-In public key does not own the claimed address");
  }

  if (base64Encode(payload) !== signature.signingPayload) {
    throw new TypeError("TBC Sign-In signing payload is not canonical base64");
  }
  if (!(await options.consumeChallenge(fields))) {
    throw new TypeError("TBC Sign-In challenge was already consumed or is invalid");
  }
  return fields;
}
