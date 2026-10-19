import { canonicalize } from "@tbc-wallet/core";
import type { TbcReviewedPolicyMaterial } from "./reviewed-transaction-types.js";

const MAX_NATIVE_RESPONSE_BYTES = 8 * 1024 * 1024;
const HASH32 = /^[0-9a-f]{64}$/u;
const HEX = /^(?:[0-9a-fA-F]{2})*$/u;

export type TbcWalletPrivateNativeMethod =
  | "signP2pkh"
  | "signAssociated"
  | "encryptMessage"
  | "decryptMessage";

/** Platform bridge that closes over the wallet's scoped key accessor. */
export interface TbcWalletPrivateNativeBridge {
  readonly call: (
    method: TbcWalletPrivateNativeMethod,
    canonicalRequestJson: string,
  ) => Promise<string>;
}

type Approved = Readonly<{
  status: "approved";
  bindingHash: string;
  approvalId: string;
}>;

type BoundRequest<T> = Readonly<{
  bindingHash: string;
  request: T;
}>;

export type TbcWalletPrivateNativeAdapters = Readonly<{
  rawSigner: Readonly<{
    sign(input: Readonly<{
      binding: BoundRequest<Readonly<{
        txraws: readonly string[];
        utxos_satoshis: readonly (readonly number[])[];
        script_pubkeys: readonly (readonly string[])[];
      }>>;
      approval: Approved;
      policyMaterial?: TbcReviewedPolicyMaterial;
    }>): Promise<unknown>;
  }>;
  cryptoAdapter: Readonly<{
    encrypt(input: Readonly<{
      binding: BoundRequest<Readonly<{ message: string }>>;
      approval: Approved;
    }>): Promise<unknown>;
    decrypt(input: Readonly<{
      binding: BoundRequest<Readonly<{ message: string }>>;
      approval: Approved;
    }>): Promise<unknown>;
  }>;
  associatedExecutor: Readonly<{
    execute(input: Readonly<{
      operationDigest: string;
      request: Readonly<Record<string, unknown>>;
      policyMaterial?: TbcReviewedPolicyMaterial;
    }>): Promise<unknown>;
  }>;
}>;

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key));
}

function approvedBinding(binding: BoundRequest<unknown>, approval: Approved): void {
  if (
    !HASH32.test(binding.bindingHash) ||
    approval.bindingHash !== binding.bindingHash ||
    typeof approval.approvalId !== "string" ||
    approval.approvalId.length === 0
  ) {
    throw new Error("Wallet-private approval binding mismatch");
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function hexToUtf8(value: unknown): string {
  if (typeof value !== "string" || !HEX.test(value)) {
    throw new Error("Invalid wallet-private Native UTF-8 result");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Invalid wallet-private Native UTF-8 result");
  }
}

function parseEnvelope(serialized: string): unknown {
  if (
    typeof serialized !== "string" ||
    new TextEncoder().encode(serialized).length > MAX_NATIVE_RESPONSE_BYTES
  ) {
    throw new Error("Invalid wallet-private Native response");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(serialized);
  } catch {
    throw new Error("Invalid wallet-private Native response");
  }
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    Reflect.get(envelope, "version") !== "1.0" ||
    typeof Reflect.get(envelope, "ok") !== "boolean"
  ) {
    throw new Error("Invalid wallet-private Native response");
  }
  if (Reflect.get(envelope, "ok") === true) {
    if (!exactKeys(envelope, ["ok", "value", "version"])) {
      throw new Error("Invalid wallet-private Native response");
    }
    return Reflect.get(envelope, "value");
  }
  if (!exactKeys(envelope, ["error", "ok", "version"])) {
    throw new Error("Invalid wallet-private Native response");
  }
  // Native/parser errors can contain a request fragment (including plaintext
  // or an unlocking witness). Do not propagate arbitrary message/code/path or
  // retain them as `cause`; Standard and Legacy share this boundary.
  throw new Error("Wallet-private Native operation failed");
}

/** Creates one-shot Standard/Legacy adapters over the shared restricted ABI. */
export function createTbcWalletPrivateNativeAdapters(
  bridge: TbcWalletPrivateNativeBridge,
): TbcWalletPrivateNativeAdapters {
  if (bridge === null || typeof bridge !== "object" || typeof bridge.call !== "function") {
    throw new TypeError("Wallet-private Native bridge is required");
  }
  const invoke = async (
    method: TbcWalletPrivateNativeMethod,
    request: unknown,
  ): Promise<unknown> => {
    let serialized: string;
    try {
      serialized = await bridge.call(method, canonicalize(request));
    } catch {
      throw new Error("Wallet-private Native bridge failed");
    }
    return parseEnvelope(serialized);
  };

  const rawSigner = Object.freeze({
    async sign({ binding, approval }: Parameters<TbcWalletPrivateNativeAdapters["rawSigner"]["sign"]>[0]) {
      approvedBinding(binding, approval);
      return invoke("signP2pkh", binding.request);
    },
  });
  const cryptoAdapter = Object.freeze({
    async encrypt({ binding, approval }: Parameters<TbcWalletPrivateNativeAdapters["cryptoAdapter"]["encrypt"]>[0]) {
      approvedBinding(binding, approval);
      const result = await invoke("encryptMessage", {
        messageHex: bytesToHex(new TextEncoder().encode(binding.request.message)),
      });
      const encryptedMessage = result !== null && typeof result === "object"
        ? Reflect.get(result, "encryptedMessage")
        : undefined;
      return { encryptedMessage };
    },
    async decrypt({ binding, approval }: Parameters<TbcWalletPrivateNativeAdapters["cryptoAdapter"]["decrypt"]>[0]) {
      approvedBinding(binding, approval);
      const result = await invoke("decryptMessage", {
        encryptedMessage: binding.request.message,
      });
      const messageHex = result !== null && typeof result === "object"
        ? Reflect.get(result, "messageHex")
        : undefined;
      return { decryptedMessage: hexToUtf8(messageHex) };
    },
  });
  const associatedExecutor = Object.freeze({
    async execute(
      { operationDigest, request }: Parameters<TbcWalletPrivateNativeAdapters["associatedExecutor"]["execute"]>[0],
    ) {
      if (!HASH32.test(operationDigest)) {
        throw new TypeError("Invalid associated transaction digest");
      }
      return invoke("signAssociated", request);
    },
  });
  return Object.freeze({ rawSigner, cryptoAdapter, associatedExecutor });
}
