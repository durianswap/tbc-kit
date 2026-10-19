import {
  TBC_MAINNET_PROFILE as INTERNAL_MAINNET_PROFILE,
  TBC_TESTNET_PROFILE as INTERNAL_TESTNET_PROFILE,
} from "@tbc-wallet/tbc-engine";

export interface TbcNetworkProfile {
  readonly chainId: string;
  readonly p2pkhVersion: number;
  readonly transactionVersion: 10;
}

/** Lightweight immutable profiles with no Native/WASM backend dependency. */
export const TBC_MAINNET_PROFILE =
  INTERNAL_MAINNET_PROFILE as TbcNetworkProfile;

export const TBC_TESTNET_PROFILE =
  INTERNAL_TESTNET_PROFILE as TbcNetworkProfile;
