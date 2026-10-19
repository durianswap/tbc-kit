import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TbcReviewedPolicyMaterial, TbcReviewedTransactionRequest } from "./reviewed-transaction-types.js";
import { parseTbcTransaction, turingTransactionId } from "./testnet-validation.js";

/** Strict snapshot for a review/approval hash. Empty is sufficient only where
 * all required outputs are already present in the bound transaction request. */
export function normalizeReviewedPolicyMaterial(value: unknown): TbcReviewedPolicyMaterial {
  function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
    if (input === null || typeof input !== "object" || Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== keys.length ||
        keys.some(key => !Object.hasOwn(input, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, "value"))) {
      throw new TypeError("Invalid reviewed policy material");
    }
    return input as Record<string, unknown>;
  }
  const root = fields(value, ["resolvedOutputs"]);
  const rows = root.resolvedOutputs;
  if (!Array.isArray(rows) || rows.length > 10_000) throw new TypeError("Invalid reviewed policy material");
  for (let i = 0; i < rows.length; i += 1) {
    const property = Object.getOwnPropertyDescriptor(rows, String(i));
    if (!property || !Object.hasOwn(property, "value")) throw new TypeError("Invalid reviewed policy material");
  }
  const seen = new Set<string>();
  let bytes = 0;
  const resolvedOutputs = rows.map(row => {
    const output = fields(row, ["txid", "vout", "satoshis", "scriptPubKey"]);
    const { txid, vout, satoshis, scriptPubKey } = output;
    if (typeof txid !== "string" || !/^[0-9a-f]{64}$/u.test(txid) ||
        typeof vout !== "number" || !Number.isInteger(vout) || vout < 0 || vout > 0xffff_ffff ||
        typeof satoshis !== "string" || !/^(0|[1-9][0-9]{0,19})$/u.test(satoshis) || BigInt(satoshis) > 18_446_744_073_709_551_615n ||
        typeof scriptPubKey !== "string" || scriptPubKey.length > 131_072 || scriptPubKey.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(scriptPubKey)) {
      throw new TypeError("Invalid reviewed policy material");
    }
    const key = `${txid}:${vout}`;
    bytes += scriptPubKey.length + 160;
    if (seen.has(key) || bytes > 4_194_304) throw new TypeError("Reviewed policy material bound or duplicate");
    seen.add(key);
    return Object.freeze({ txid, vout, satoshis, scriptPubKey });
  });
  resolvedOutputs.sort((a, b) => a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout);
  return Object.freeze({ resolvedOutputs: Object.freeze(resolvedOutputs) });
}

/** Recheck a concrete normalized request at the Standard execution boundary.
 * Supplemental material cannot replace an input committed by that request. */
export async function requireBoundReviewedPolicy(native: PoolMaterialNativeProviderInput,
  request: TbcReviewedTransactionRequest, material: TbcReviewedPolicyMaterial): Promise<void> {
  const outputs = new Map<string, PolicyOutput>();
  const put = (output: PolicyOutput) => {
    const key = `${output.txid}:${output.vout}`, previous = outputs.get(key);
    if (previous && (previous.satoshis !== output.satoshis || previous.scriptPubKey !== output.scriptPubKey)) {
      throw new Error("Reviewed policy input material conflict");
    }
    outputs.set(key, output);
  };
  const transactions = request.txraws.map((raw, index) => {
    const tx = parseTbcTransaction(raw);
    if (tx.inputs.length !== request.utxos_satoshis[index]?.length || tx.inputs.length !== request.script_pubkeys[index]?.length) {
      throw new Error("Invalid reviewed policy input matrix");
    }
    tx.inputs.forEach((input, i) => put({ txid: input.txid, vout: input.vout,
      satoshis: request.utxos_satoshis[index]![i]!, scriptPubKey: request.script_pubkeys[index]![i]!.toLowerCase() }));
    return { rawTransaction: raw.toLowerCase(), txid: turingTransactionId(raw) };
  });
  for (const output of material.resolvedOutputs) {
    const satoshis = Number(output.satoshis);
    if (!Number.isSafeInteger(satoshis)) throw new Error("Reviewed policy amount exceeds adapter bound");
    put({ ...output, satoshis });
  }
  await requireReviewedIssuancePolicy(native, transactions, [...outputs.values()]);
}

type PolicyOutput = Readonly<{
  txid: string;
  vout: number;
  satoshis: number;
  scriptPubKey: string;
}>;

/** Wallet-side policy only. Reuses authenticated review material; performs no
 * HTTP, signing or persistence and does not grant asset/approval authority.
 * The Rust checker resolves earlier batch outputs itself, so external material
 * must never shadow a transaction in the batch. Caller must separately bind
 * these exact transactions/material to execution and recheck rebound children. */
export async function requireReviewedIssuancePolicy(
  native: PoolMaterialNativeProviderInput,
  transactions: readonly Readonly<{ rawTransaction: string; txid: string }>[],
  outputs: readonly PolicyOutput[],
): Promise<void> {
  const txids = transactions.map(tx => tx.txid);
  if (transactions.length === 0 || transactions.length > 33 ||
      new Set(txids).size !== txids.length ||
      txids.some(txid => !/^[0-9a-f]{64}$/u.test(txid)) || outputs.length > 10_000) {
    throw new Error("Invalid reviewed issuance policy material");
  }
  let rawBytes = 0;
  const rows = transactions.map(tx => {
    if (typeof tx.rawTransaction !== "string" || tx.rawTransaction.length === 0 ||
        tx.rawTransaction.length > 2_097_152 || tx.rawTransaction.length % 2 !== 0 ||
        !/^[0-9a-f]+$/u.test(tx.rawTransaction)) throw new Error("Invalid reviewed issuance policy material");
    rawBytes += tx.rawTransaction.length;
    if (rawBytes > 8_388_608) throw new Error("Reviewed issuance policy material exceeds bound");
    return { rawTransaction: tx.rawTransaction };
  });
  const batchIds = new Set(txids);
  const local = new Map<string, PolicyOutput>();
  transactions.forEach(tx => parseTbcTransaction(tx.rawTransaction).outputs.forEach((output, vout) =>
    local.set(`${tx.txid}:${vout}`, { txid: tx.txid, vout, satoshis: Number(output.satoshis),
      scriptPubKey: Array.from(output.scriptPubKey, byte => byte.toString(16).padStart(2, "0")).join("") })));
  for (const output of outputs) {
    if (!batchIds.has(output.txid)) continue;
    const actual = local.get(`${output.txid}:${output.vout}`);
    if (!actual || actual.satoshis !== output.satoshis || actual.scriptPubKey !== output.scriptPubKey) {
      throw new Error("Reviewed local policy material mismatch");
    }
  }
  const seen = new Set<string>();
  const resolvedOutputs = outputs.filter(output => !batchIds.has(output.txid)).map(output => {
    const key = `${output.txid}:${output.vout}`;
    if (!/^[0-9a-f]{64}$/u.test(output.txid) || !Number.isInteger(output.vout) ||
        output.vout < 0 || output.vout > 0xffff_ffff ||
        !Number.isSafeInteger(output.satoshis) || output.satoshis < 0 ||
        typeof output.scriptPubKey !== "string" || output.scriptPubKey.length > 131_072 ||
        output.scriptPubKey.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(output.scriptPubKey) || seen.has(key)) {
      throw new Error("Invalid reviewed issuance policy material");
    }
    seen.add(key);
    return { txid: output.txid, vout: output.vout, satoshis: String(output.satoshis), scriptPubKey: output.scriptPubKey };
  });
  const request = JSON.stringify({ phase: "checkHistoricalIssuance", transactions: rows, resolvedOutputs });
  if (request.length > 8_388_608) throw new Error("Reviewed issuance policy material exceeds bound");
  let result: unknown;
  try {
    result = JSON.parse(await native.execute("inspectTokenMaterial", request));
  } catch {
    // Never relay bridge exceptions which could include raw unlock witnesses.
    throw new Error("Reviewed transaction issuance policy rejected or unavailable");
  }
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Invalid reviewed issuance policy result");
  }
  const record = result as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || record.verification !== "historical-issuance-policy" ||
      record.assetIdentityVerified !== false || !Array.isArray(record.transactionIds) ||
      record.transactionIds.length !== txids.length ||
      record.transactionIds.some((txid, index) => txid !== txids[index])) {
    throw new Error("Invalid reviewed issuance policy result");
  }
}
