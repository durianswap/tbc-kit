import { canonicalize, type ResolvedTransactionSigningRole } from "@tbc-wallet/core";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { bytesToHex, hexToBytes, sha256Bytes } from "./network-bytes.js";
import { parseTbcTransaction, tbcAddressFromPublicKeyHash } from "./testnet-validation.js";
import { inspectReviewedTokenCodes, type ReviewedTokenCode } from "./reviewed-token.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TbcReviewedTransactionRequest } from "./reviewed-transaction-types.js";

export function reviewedCoinAdministrator(roles: readonly ResolvedTransactionSigningRole[], chainId: string, addressVersion: number): string {
  const role = roles[0], account = role?.account;
  if (roles.length !== 1 || role?.role !== "coin-admin" || account?.chainId !== chainId ||
      !/^0[23][0-9a-f]{64}$/u.test(account.publicKey) || account.accountId !== `${chainId}:${account.address}` ||
      tbcAddressFromPublicKeyHash(bytesToHex(ripemd160(sha256Bytes(hexToBytes(account.publicKey)))), addressVersion) !== account.address) {
    throw new Error("Reviewed Coin administrator account binding mismatch");
  }
  return account.publicKey;
}

/** Code identity is already decoded by the shared exact-template inspector.
 * No role flag or indexer label substitutes for this committed key hash. */
export function reviewedCoinAdminKey(code: ReviewedTokenCode | null | undefined, publicKey: string): string {
  if (code?.standardId !== "tbc20-stablecoin" || !/^0[23][0-9a-f]{64}$/u.test(publicKey)) {
    throw new Error("Reviewed Coin administrator requires current Coin Code");
  }
  for (const key of [publicKey, publicKey.slice(2)]) {
    if (bytesToHex(ripemd160(sha256Bytes(hexToBytes(key)))) === code.adminPubkeyHash) return key;
  }
  throw new Error("Reviewed Coin administrator does not match Code");
}

/** Bind raw input role markers to actual Code using the same trusted role key.
 * No script assembly, chain read or custody. Null cells retain the fee/holder. */
export async function bindReviewedRawCoinAdminMaterial(input: Readonly<{
  request: TbcReviewedTransactionRequest; inputRoles: readonly (readonly unknown[])[];
  publicKey: string; native: PoolMaterialNativeProviderInput;
}>): Promise<TbcReviewedTransactionRequest> {
  const json = canonicalize(input.request);
  if (json.length > 4 * 1_048_576) throw new Error("Reviewed raw role material exceeds bound");
  const request = JSON.parse(json) as TbcReviewedTransactionRequest;
  if (request.signingPublicKeys !== undefined || input.inputRoles.length !== request.txraws.length ||
      request.txraws.length < 1 || request.txraws.length > 32) throw new Error("Invalid raw role matrix");
  const keys: (string | null)[][] = [], marked: {row: number; column: number; script: string}[] = [];
  input.inputRoles.forEach((roles,row) => {
    if (roles.length !== request.script_pubkeys[row]?.length || roles.length !== request.utxos_satoshis[row]?.length) throw new Error("Invalid raw role input count");
    keys.push(roles.map((role,column) => {
      if (role === undefined || role === null) return null;
      if (role !== "coin-admin") throw new Error("Invalid raw signing role");
      marked.push({row,column,script:request.script_pubkeys[row]![column]!});return null;
    }));
  });
  if (marked.length < 1 || marked.length > 256) throw new Error("Raw Coin role must select bounded inputs");
  const codes = await inspectReviewedTokenCodes(input.native, marked.map(item => item.script));
  marked.forEach((item,index) => {
    keys[item.row]![item.column] = reviewedCoinAdminKey(codes[index], input.publicKey);
  });
  return Object.freeze({...request, signingPublicKeys:Object.freeze(keys.map(row => Object.freeze(row)))});
}

/** Internal normalized associated material, not a public signing endpoint.
 * Role selections came from Core's trusted account resolution. This snapshots
 * public material, authenticates the Code, and derives the exact key encoding
 * used by the existing keyless proof. No HTTP, private key or state store.
 */
export async function bindReviewedCoinAdminMaterial(input: Readonly<{
  request: Readonly<Record<string, unknown>>; publicKey: string; native: PoolMaterialNativeProviderInput;
}>): Promise<Readonly<Record<string, unknown>>> {
  const json = canonicalize(input.request);
  if (json.length > 4 * 1_048_576) throw new Error("Reviewed Coin role material exceeds bound");
  const request = JSON.parse(json) as { sourceTxraw: string; sourceUtxos: Record<string, unknown>[];
    inputs: Record<string, unknown>[][]; outputs: { script: string }[][] };
  const source = parseTbcTransaction(request.sourceTxraw);
  const rows = [request.sourceUtxos, ...(request.inputs ?? [])];
  if (rows.length > 33 || rows.reduce((n, row) => n + row.length, 0) > 1000) throw new Error("Reviewed Coin role input bound exceeded");
  const marked: { input: Record<string, unknown>; script: string }[] = [];
  rows.forEach((row, rowIndex) => row.forEach(item => {
    if (Object.hasOwn(item, "signingPublicKey")) throw new Error("Reviewed role material cannot supply a public key override");
    if (!Object.hasOwn(item, "signingRole")) return;
    if (item.signingRole !== "coin-admin" || item.scriptSigType !== "tbc20-stablecoin" ||
        !Number.isInteger(item.outputIndex) || Number(item.outputIndex) < 0) throw new Error("Invalid Reviewed Coin role input");
    const vout = Number(item.outputIndex);
    const script = rowIndex === 0 || item.txId !== undefined ? item.script : rowIndex === 1
      ? source.outputs[vout] && bytesToHex(source.outputs[vout]!.scriptPubKey) : request.outputs[rowIndex - 2]?.[vout]?.script;
    if (typeof script !== "string") throw new Error("Reviewed Coin role Code missing");
    marked.push({ input: item, script });
  }));
  if (marked.length === 0 || marked.length > 256) throw new Error("Reviewed Coin role must select bounded inputs");
  const codes = await inspectReviewedTokenCodes(input.native, marked.map(item => item.script));
  marked.forEach((item, i) => {
    item.input.signingPublicKey = reviewedCoinAdminKey(codes[i], input.publicKey);
    delete item.input.signingRole;
  });
  return Object.freeze(request);
}
