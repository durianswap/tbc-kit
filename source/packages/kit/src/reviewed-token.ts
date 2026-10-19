import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";

export type ReviewedTokenCode = Readonly<{
  standardId: "tbc20-standard" | "tbc20-stablecoin";
  tapeSize: number;
  controller: string;
  codeIdentity: string;
  verification: "exact-template";
  assetIdentityVerified: false;
  originalOutpoint?: Readonly<{ txid: string; vout: number }>;
  coinNftCodeHash?: string;
  adminPubkeyHash?: string;
}>;
export type ReviewedTokenPairInput = Readonly<{
  codeScript: string; codeSatoshis: number;
  tapeScript: string; tapeSatoshis: number;
  inputLock?: Readonly<{ sequence: number; transactionLockTime: number }>;
}>;
export type ReviewedTokenPair = Readonly<{
  code: ReviewedTokenCode; balanceRaw: string; lockTime?: number;
  inputLockChecked?: true;
}>;
const HEX = /^(?:[0-9a-f]{2})*$/u;
const HASH = /^[0-9a-f]{64}$/u;
function script(value: string): string {
  if (typeof value !== "string" || value.length > 131_072 || !HEX.test(value)) {
    throw new TypeError("Invalid reviewed Token script");
  }
  return value;
}
function count(length: number): void {
  if (length === 0 || length > 256) throw new TypeError("Reviewed Token batch bound exceeded");
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid reviewed Token result");
  }
  return value as Record<string, unknown>;
}
function code(value: unknown): ReviewedTokenCode {
  const result = record(value);
  const standard = result.standardId;
  if ((standard !== "tbc20-standard" && standard !== "tbc20-stablecoin") ||
      result.verification !== "exact-template" || result.assetIdentityVerified !== false ||
      !Number.isInteger(result.tapeSize) || Number(result.tapeSize) < (standard === "tbc20-standard" ? 61 : 66) || Number(result.tapeSize) > 127 ||
      typeof result.controller !== "string" || !/^[0-9a-f]{42}$/u.test(result.controller) ||
      typeof result.codeIdentity !== "string" || !/^[0-9a-f]{66,74}$/u.test(result.codeIdentity) || result.codeIdentity.length % 2 !== 0) {
    throw new TypeError("Invalid reviewed Token Code result");
  }
  if (standard === "tbc20-standard") {
    const origin = record(result.originalOutpoint);
    if (typeof origin.txid !== "string" || !HASH.test(origin.txid) ||
        !Number.isInteger(origin.vout) || Number(origin.vout) < 0 || Number(origin.vout) > 0xffff_ffff ||
        result.coinNftCodeHash !== undefined || result.adminPubkeyHash !== undefined) {
      throw new TypeError("Invalid reviewed Token origin hint");
    }
    Object.freeze(origin);
  } else if (typeof result.coinNftCodeHash !== "string" || !HASH.test(result.coinNftCodeHash) ||
      typeof result.adminPubkeyHash !== "string" || !/^[0-9a-f]{40}$/u.test(result.adminPubkeyHash) || result.originalOutpoint !== undefined) {
    throw new TypeError("Invalid reviewed Coin identity hint");
  }
  return Object.freeze(result) as ReviewedTokenCode;
}
async function batch(native: PoolMaterialNativeProviderInput, request: unknown, field: string, length: number): Promise<unknown[]> {
  const json = JSON.stringify(request);
  if (json.length > 8 * 1_048_576) throw new TypeError("Reviewed Token request exceeds byte bound");
  const response = record(JSON.parse(await native.execute("inspectTokenMaterial", json)));
  const values = response[field];
  if (!Array.isArray(values) || values.length !== length) throw new TypeError("Invalid reviewed Token result mapping");
  return values;
}

/** Pure local hints over exact shared codecs. No HTTP or asset-origin authority.
 * Snapshot/dedup before await; repeated scripts retain original positions. */
export async function inspectReviewedTokenCodes(native: PoolMaterialNativeProviderInput, scripts: readonly string[]): Promise<readonly (ReviewedTokenCode | null)[]> {
  count(scripts.length);
  const snapshot = scripts.map(script), unique = [...new Set(snapshot)];
  const values = await batch(native, { phase: "inspectCodes", scripts: unique }, "codes", unique.length);
  const byScript = new Map(unique.map((s, i) => [s, values[i] === null ? null : code(values[i])]));
  return Object.freeze(snapshot.map(s => byScript.get(s)!));
}

/** Adjacent Code/Tape material must already be authenticated by the caller.
 * This checks exact layout/balance/lock only, not ancestry or spendability. */
export async function inspectReviewedTokenPairs(native: PoolMaterialNativeProviderInput, pairs: readonly ReviewedTokenPairInput[]): Promise<readonly ReviewedTokenPair[]> {
  count(pairs.length);
  const snapshot = pairs.map(p => {
    if (p.codeSatoshis !== 500 || p.tapeSatoshis !== 0) throw new TypeError("Invalid reviewed Token pair values");
    if (p.inputLock !== undefined && (Reflect.ownKeys(p.inputLock).length !== 2 ||
        [p.inputLock.sequence, p.inputLock.transactionLockTime].some(n => !Number.isInteger(n) || n < 0 || n > 0xffff_ffff))) {
      throw new TypeError("Invalid reviewed Coin input lock");
    }
    return { codeScript: script(p.codeScript), codeSatoshis: p.codeSatoshis, tapeScript: script(p.tapeScript), tapeSatoshis: p.tapeSatoshis,
      ...(p.inputLock === undefined ? {} : { inputLock: { sequence: p.inputLock.sequence, transactionLockTime: p.inputLock.transactionLockTime } }) };
  });
  const keys = snapshot.map(p => JSON.stringify(p));
  const unique = [...new Map(snapshot.map((p, i) => [keys[i]!, p])).entries()];
  const values = await batch(native, { phase: "inspectPairs", pairs: unique.map(([, p]) => p) }, "pairs", unique.length);
  const byKey = new Map(unique.map(([key, input], i) => {
    const result = record(values[i]), descriptor = code(result.code);
    if (typeof result.balanceRaw !== "string" || !/^(0|[1-9][0-9]*)$/u.test(result.balanceRaw) ||
        result.balanceRaw.length > 20 || BigInt(result.balanceRaw) > 6n * ((1n << 63n) - 1n) ||
        (descriptor.standardId === "tbc20-standard" ? result.lockTime !== undefined :
          !Number.isInteger(result.lockTime) || Number(result.lockTime) < 0 || Number(result.lockTime) > 0xffff_ffff)) {
      throw new TypeError("Invalid reviewed Token pair result");
    }
    if (input.inputLock === undefined ? result.inputLockChecked !== undefined : descriptor.standardId !== "tbc20-stablecoin" || result.inputLockChecked !== true) {
      throw new TypeError("Invalid reviewed Coin input lock result");
    }
    return [key, Object.freeze({ code: descriptor, balanceRaw: result.balanceRaw, ...(result.lockTime === undefined ? {} : { lockTime: result.lockTime as number }),
      ...(input.inputLock === undefined ? {} : { inputLockChecked: true as const }) })] as const;
  }));
  return Object.freeze(keys.map(key => byKey.get(key)!));
}
