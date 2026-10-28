import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  sha256Bytes,
} from "./network-bytes.js";

export type TestnetNodeErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_INPUT"
  | "NODE_REQUEST_FAILED"
  | "NODE_RESPONSE_INVALID";

export class TestnetNodeError extends Error {
  override readonly name = "TestnetNodeError";
  readonly code: TestnetNodeErrorCode;

  constructor(code: TestnetNodeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const TESTNET_NODE_ERROR_CODES = new Set<TestnetNodeErrorCode>([
  "INVALID_CONFIG",
  "INVALID_INPUT",
  "NODE_REQUEST_FAILED",
  "NODE_RESPONSE_INVALID",
]);

/** Recognizes node errors across independently bundled package entry points. */
export function isTestnetNodeError(value: unknown): value is TestnetNodeError {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Readonly<{ name?: unknown; message?: unknown; code?: unknown }>;
  return candidate.name === "TestnetNodeError" &&
    typeof candidate.message === "string" &&
    typeof candidate.code === "string" &&
    TESTNET_NODE_ERROR_CODES.has(candidate.code as TestnetNodeErrorCode);
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(
  Array.from(BASE58, (character, index) => [character, index]),
);
const MAX_TRANSACTION_BYTES = 2 * 1024 * 1024;
const MAX_TRANSACTION_ITEMS = 10_000;
// Script lengths are bounded by Reader.bytes and the complete transaction
// budget. A Bitcoin-era 10KB per-script limit rejects valid NFT Tape/proofs;
// this structural decoder is not a script VM or a contract-policy validator.

function fail(code: TestnetNodeErrorCode, message: string): never {
  throw new TestnetNodeError(code, message);
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

function reverse(value: Uint8Array): Uint8Array {
  return new Uint8Array(value).reverse();
}

function uint32Le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    return fail("NODE_RESPONSE_INVALID", "Invalid transaction uint32");
  }
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, true);
  return result;
}

function uint64Le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    return fail("NODE_RESPONSE_INVALID", "Invalid transaction uint64");
  }
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, value, true);
  return result;
}

function base58Encode(value: Uint8Array): string {
  let leading = 0;
  while (leading < value.length && value[leading] === 0) leading += 1;
  let numeric = 0n;
  for (const byte of value) numeric = (numeric << 8n) | BigInt(byte);
  let encoded = "";
  while (numeric > 0n) {
    encoded = `${BASE58[Number(numeric % 58n)]}${encoded}`;
    numeric /= 58n;
  }
  return `${"1".repeat(leading)}${encoded}`;
}

function base58Decode(value: string): Uint8Array {
  if (value.length === 0 || value.length > 64) {
    return fail("INVALID_INPUT", "Invalid TBC Testnet address");
  }
  let numeric = 0n;
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) {
      return fail("INVALID_INPUT", "Invalid TBC Testnet address");
    }
    numeric = numeric * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (numeric > 0n) {
    body.push(Number(numeric & 0xffn));
    numeric >>= 8n;
  }
  body.reverse();
  let leading = 0;
  while (value[leading] === "1") leading += 1;
  const decoded = new Uint8Array(leading + body.length);
  decoded.set(body, leading);
  if (base58Encode(decoded) !== value) {
    return fail("INVALID_INPUT", "Non-canonical TBC Testnet address");
  }
  return decoded;
}

export interface TbcAddress {
  readonly address: string;
  readonly p2pkhVersion: number;
  readonly publicKeyHash: string;
  readonly scriptPubKey: string;
}

export type TestnetAddress = TbcAddress & Readonly<{ p2pkhVersion: 0 }>;

/** Pure inverse of address validation, for trusted script-derived recipients. */
export function tbcAddressFromPublicKeyHash(hash: string, p2pkhVersion: number): string {
  if (!/^[0-9a-f]{40}$/u.test(hash) || !Number.isInteger(p2pkhVersion) || p2pkhVersion < 0 || p2pkhVersion > 255) {
    throw new TypeError("Invalid TBC public key hash or address version");
  }
  const body = concatBytes(Uint8Array.of(p2pkhVersion), hexToBytes(hash));
  return base58Encode(concatBytes(body, sha256Bytes(sha256Bytes(body)).slice(0, 4)));
}

export function assertTbcAddress(
  address: string,
  p2pkhVersion: number,
): TbcAddress {
  if (!Number.isInteger(p2pkhVersion) || p2pkhVersion < 0 || p2pkhVersion > 0xff) {
    return fail("INVALID_CONFIG", "Invalid TBC P2PKH version");
  }
  const decoded = base58Decode(address);
  if (decoded.length !== 25 || decoded[0] !== p2pkhVersion) {
    return fail("INVALID_INPUT", "Address is not valid for the selected TBC network");
  }
  const body = decoded.slice(0, 21);
  const expected = sha256Bytes(sha256Bytes(body)).slice(0, 4);
  if (!equal(decoded.slice(21), expected)) {
    return fail("INVALID_INPUT", "TBC Testnet address checksum mismatch");
  }
  const publicKeyHash = bytesToHex(body.slice(1));
  return Object.freeze({
    address,
    p2pkhVersion,
    publicKeyHash,
    scriptPubKey: `76a914${publicKeyHash}88ac`,
  });
}

/** Backwards-compatible Testnet validator. Mainnet currently has the same
 * P2PKH version, but callers must still bind transactions by chainId. */
export function assertTestnetAddress(address: string): TestnetAddress {
  return assertTbcAddress(address, 0) as TestnetAddress;
}

export function assertHash32(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    return fail("NODE_RESPONSE_INVALID", "Invalid hash32 response");
  }
  return value;
}

export function assertRawTransaction(value: string): string {
  if (
    value.length / 2 > MAX_TRANSACTION_BYTES ||
    !/^(?:[0-9a-f]{2})+$/.test(value)
  ) {
    return fail("NODE_RESPONSE_INVALID", "Invalid raw TBC transaction");
  }
  return value;
}

class Reader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(raw: string) {
    this.#bytes = hexToBytes(assertRawTransaction(raw));
  }

  bytes(length: number): Uint8Array {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.#offset + length > this.#bytes.length
    ) {
      return fail("NODE_RESPONSE_INVALID", "Truncated TBC transaction");
    }
    const value = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  uint32(): number {
    const value = this.bytes(4);
    return new DataView(value.buffer, value.byteOffset, 4).getUint32(0, true);
  }

  uint64(): bigint {
    const value = this.bytes(8);
    return new DataView(value.buffer, value.byteOffset, 8).getBigUint64(
      0,
      true,
    );
  }

  compactSize(): number {
    const first = this.bytes(1)[0];
    if (first === undefined) {
      return fail("NODE_RESPONSE_INVALID", "Truncated compact size");
    }
    if (first < 0xfd) return first;
    let value: bigint;
    if (first === 0xfd) {
      const bytes = this.bytes(2);
      value = BigInt(
        new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(0, true),
      );
      if (value < 0xfdn)
        return fail("NODE_RESPONSE_INVALID", "Non-canonical compact size");
    } else if (first === 0xfe) {
      value = BigInt(this.uint32());
      if (value <= 0xffffn)
        return fail("NODE_RESPONSE_INVALID", "Non-canonical compact size");
    } else {
      value = this.uint64();
      if (value <= 0xffff_ffffn) {
        return fail("NODE_RESPONSE_INVALID", "Non-canonical compact size");
      }
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return fail("NODE_RESPONSE_INVALID", "Compact size is too large");
    }
    return Number(value);
  }

  finish(): void {
    if (this.#offset !== this.#bytes.length) {
      fail("NODE_RESPONSE_INVALID", "Trailing TBC transaction bytes");
    }
  }
}

export interface ParsedTbcTransaction {
  readonly version: 10;
  readonly inputs: readonly Readonly<{
    txid: string;
    vout: number;
    scriptSig: Uint8Array;
    sequence: number;
  }>[];
  readonly outputs: readonly Readonly<{
    satoshis: bigint;
    scriptPubKey: Uint8Array;
  }>[];
  readonly locktime: number;
}

export function parseTbcTransaction(raw: string): ParsedTbcTransaction {
  return parseTransactionBytes(raw, false);
}

/** Internal unsigned-plan parser, NOT a valid transaction/receipt verifier.
 * Different planned parents may both use the all-zero txid placeholder and
 * output zero. Callers must bind those positions with the shared exact-edge
 * resolver. Real outpoint duplicates and any unlocking script still fail. */
export function parseTbcUnsignedTemplate(raw: string): ParsedTbcTransaction {
  return parseTransactionBytes(raw, true);
}

function parseTransactionBytes(raw: string, unsignedTemplate: boolean): ParsedTbcTransaction {
  const reader = new Reader(raw);
  const version = reader.uint32();
  if (version !== 10) {
    return fail("NODE_RESPONSE_INVALID", "TBC transaction version must be 10");
  }
  const inputCount = reader.compactSize();
  if (inputCount < 1 || inputCount > MAX_TRANSACTION_ITEMS) {
    return fail("NODE_RESPONSE_INVALID", "Invalid TBC transaction input count");
  }
  const outpoints = new Set<string>();
  const inputs = Array.from({ length: inputCount }, () => {
    const txid = bytesToHex(reverse(reader.bytes(32)));
    const vout = reader.uint32();
    const scriptLength = reader.compactSize();
    const scriptSig = reader.bytes(scriptLength);
    if (unsignedTemplate && scriptLength !== 0) {
      return fail("NODE_RESPONSE_INVALID", "Unsigned TBC template contains an unlocking script");
    }
    const sequence = reader.uint32();
    const key = `${txid}:${vout}`;
    if (outpoints.has(key) && !(unsignedTemplate && txid === "0".repeat(64))) {
      return fail("NODE_RESPONSE_INVALID", "Duplicate TBC transaction input");
    }
    outpoints.add(key);
    return Object.freeze({ txid, vout, scriptSig, sequence });
  });
  const outputCount = reader.compactSize();
  if (outputCount < 1 || outputCount > MAX_TRANSACTION_ITEMS) {
    return fail(
      "NODE_RESPONSE_INVALID",
      "Invalid TBC transaction output count",
    );
  }
  const outputs = Array.from({ length: outputCount }, () => {
    const satoshis = reader.uint64();
    const scriptLength = reader.compactSize();
    return Object.freeze({
      satoshis,
      scriptPubKey: reader.bytes(scriptLength),
    });
  });
  const locktime = reader.uint32();
  reader.finish();
  return Object.freeze({
    version: 10,
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
    locktime,
  });
}

export function turingTransactionId(raw: string): string {
  return parsedTransactionId(parseTbcTransaction(raw));
}

/** Wallet-private read-only inspection. No authority, UTXO or confirmation state. */
export function inspectTbcTransaction(raw: string) {
  const transaction = parseTbcTransaction(raw);
  return Object.freeze({ transaction, txid: parsedTransactionId(transaction) });
}

function parsedTransactionId(transaction: ParsedTbcTransaction): string {
  const inputHeader = concatBytes(
    ...transaction.inputs.map((input) =>
      concatBytes(
        reverse(hexToBytes(input.txid)),
        uint32Le(input.vout),
        uint32Le(input.sequence),
      ),
    ),
  );
  const unlockHashes = concatBytes(
    ...transaction.inputs.map((input) => sha256Bytes(input.scriptSig)),
  );
  const outputHeader = concatBytes(
    ...transaction.outputs.map((output) =>
      concatBytes(uint64Le(output.satoshis), sha256Bytes(output.scriptPubKey)),
    ),
  );
  const header = concatBytes(
    uint32Le(10),
    uint32Le(transaction.locktime),
    uint32Le(transaction.inputs.length),
    uint32Le(transaction.outputs.length),
    sha256Bytes(inputHeader),
    sha256Bytes(unlockHashes),
    sha256Bytes(outputHeader),
  );
  return bytesToHex(reverse(sha256Bytes(sha256Bytes(header))));
}
