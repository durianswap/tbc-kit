import { TbcEngineError } from "./errors.js";

export interface TbcNetworkProfile {
  readonly chainId: string;
  readonly p2pkhVersion: number;
  readonly transactionVersion: 10;
}

export const TBC_MAINNET_PROFILE: TbcNetworkProfile = Object.freeze({
  chainId: "tbc:mainnet",
  p2pkhVersion: 0x00,
  transactionVersion: 10,
});

export const TBC_TESTNET_PROFILE: TbcNetworkProfile = Object.freeze({
  chainId: "tbc:testnet",
  p2pkhVersion: 0x00,
  transactionVersion: 10,
});

function validatedProfile(value: TbcNetworkProfile): TbcNetworkProfile {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).some(
      (key) => !["chainId", "p2pkhVersion", "transactionVersion"].includes(String(key)),
    ) ||
    typeof value.chainId !== "string" ||
    value.chainId.length === 0 ||
    !Number.isInteger(value.p2pkhVersion) ||
    value.p2pkhVersion < 0 ||
    value.p2pkhVersion > 0xff ||
    value.transactionVersion !== 10
  ) {
    throw new TbcEngineError("INVALID_REQUEST", "invalid TBC network profile");
  }
  return Object.freeze({
    chainId: value.chainId,
    p2pkhVersion: value.p2pkhVersion,
    transactionVersion: 10,
  });
}

export function validatedProfiles(
  values: readonly TbcNetworkProfile[],
): ReadonlyMap<string, TbcNetworkProfile> {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TbcEngineError("INVALID_REQUEST", "at least one network profile is required");
  }
  const profiles = new Map<string, TbcNetworkProfile>();
  for (const value of values) {
    const profile = validatedProfile(value);
    if (profiles.has(profile.chainId)) {
      throw new TbcEngineError("INVALID_REQUEST", "duplicate TBC network profile");
    }
    profiles.set(profile.chainId, profile);
  }
  return profiles;
}
