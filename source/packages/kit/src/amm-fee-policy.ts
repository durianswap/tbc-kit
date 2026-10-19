import type { AmmFeePolicy } from "./public-types.js";
import { assertTbcAddress } from "./testnet-validation.js";

const RATES = ["lpFeeRate", "taxFeeRate", "serviceProviderFeeRate", "protocolFeeRate"] as const;

/** Pure configuration validation, shared by creation helpers and presentation.
 * Does not quote, read an index, or override an existing pool's chain config. */
export function normalizeAmmFeePolicy(value: unknown): AmmFeePolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid AMM fee policy");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(fields).length !== 5 || Object.values(fields).some(field => !("value" in field)) ||
      Object.keys(fields).some(key => key !== "feeAddress" && !(RATES as readonly string[]).includes(key))) {
    throw new TypeError("AMM fee policy requires exactly four rates and feeAddress");
  }
  const rates = RATES.map(key => fields[key]?.value as unknown);
  if (rates.some(rate => typeof rate !== "number" || !Number.isSafeInteger(rate) || rate < 0 || rate >= 10000)) {
    throw new TypeError("AMM rates must be nonnegative integer basis points");
  }
  if ((rates as number[]).reduce((total, rate) => total + rate, 0) >= 10000) throw new TypeError("AMM total fee must be below 10000 bps");
  const address = fields.feeAddress?.value as unknown;
  if (typeof address !== "string") throw new TypeError("AMM fee address required");
  assertTbcAddress(address, 0); // Both supported TBC networks use P2PKH version 0.
  return Object.freeze({ lpFeeRate: rates[0] as number, taxFeeRate: rates[1] as number,
    serviceProviderFeeRate: rates[2] as number, protocolFeeRate: rates[3] as number, feeAddress: address });
}

/** Display data only. Values remain part of the bound request; approval and
 * Engine still validate the complete plan, including continuation stages. */
export function describeAmmFeePolicy(value: unknown) {
  const feePolicy = normalizeAmmFeePolicy(value);
  const nonLpFeeBps = feePolicy.taxFeeRate + feePolicy.serviceProviderFeeRate + feePolicy.protocolFeeRate;
  return Object.freeze({ feePolicy, totalFeeBps: feePolicy.lpFeeRate + nonLpFeeBps,
    lpFeeBps: feePolicy.lpFeeRate, nonLpFeeBps, feeAddress: feePolicy.feeAddress });
}
