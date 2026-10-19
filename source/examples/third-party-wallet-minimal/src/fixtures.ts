import {
  hashCanonical,
  type AccountsResolveResult,
  type ChainDataResolveResult,
  type PolicyResolveResult,
  type TransactionRequest,
} from "@tbc-wallet/core";
import {
  TBC_MAINNET_PROFILE,
  TBC_TESTNET_PROFILE,
  type TbcNetworkProfile,
} from "@tbc-wallet/tbc-engine";

export const MAINNET_CHAIN_ID =
  "tbc:mainnet" as const;
export const TESTNET_CHAIN_ID =
  "tbc:testnet" as const;

export const TESTNET_PROFILE: TbcNetworkProfile = TBC_TESTNET_PROFILE;

const PUBLIC_KEY =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const SCRIPT_PUBLIC_KEY =
  "76a914751e76e8199196d454941c45d1b3a323f1433bd688ac";
interface PublicFixtureUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: string;
  readonly scriptPubKey: string;
  readonly confirmations: string;
  readonly classification: "native";
  readonly rawTransaction: string;
}

const UTXOS: readonly PublicFixtureUtxo[] = Object.freeze([
  Object.freeze({
    txid: "4d7ddb28eaa2e2e46269eac6168edb4003ea116921e389f4f6091f4a42c565c7",
    vout: 0,
    satoshis: "700",
    scriptPubKey: SCRIPT_PUBLIC_KEY,
    confirmations: "100",
    classification: "native" as const,
    rawTransaction:
      "0a00000001010000000000000000000000000000000000000000000000000000000000000000000000025100ffffffff01bc020000000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac00000000",
  }),
  Object.freeze({
    txid: "ddb917e8cad41edda4a38fd8cb8cb51a8511c8bc51ab7f62b97a039af3d9125c",
    vout: 0,
    satoshis: "1200",
    scriptPubKey: SCRIPT_PUBLIC_KEY,
    confirmations: "100",
    classification: "native" as const,
    rawTransaction:
      "0a00000001020000000000000000000000000000000000000000000000000000000000000001000000025101ffffffff01b0040000000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac01000000",
  }),
]);

export interface MinimalTransferFixture {
  readonly profile: TbcNetworkProfile;
  readonly request: TransactionRequest;
  readonly account: AccountsResolveResult["accounts"][number];
  readonly snapshot: ChainDataResolveResult;
  readonly policy: PolicyResolveResult;
}

export interface TransferFixtureOptions {
  readonly chainId: typeof MAINNET_CHAIN_ID | typeof TESTNET_CHAIN_ID;
  readonly amount: string;
  readonly clientRequestId: string;
  readonly utxos: "single" | "multi";
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createTransferFixture(
  options: TransferFixtureOptions,
): MinimalTransferFixture {
  const profile = options.chainId === MAINNET_CHAIN_ID
    ? TBC_MAINNET_PROFILE
    : TESTNET_PROFILE;
  const from = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
  const to = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
  const account = {
    address: from,
    accountId: `${options.chainId}:${from}`,
    chainId: options.chainId,
    publicKey: PUBLIC_KEY,
  } as const;
  const selected: readonly PublicFixtureUtxo[] = options.utxos === "single"
    ? [UTXOS[1]!]
    : UTXOS;
  const snapshotPayload = {
    version: "1.0",
    snapshotId: `snapshot-${options.clientRequestId}`,
    chainId: options.chainId,
    block: {
      height: "1000",
      hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    capturedAt: "2026-09-02T00:00:00Z",
    expiresAt: "2026-09-02T00:05:00Z",
    account,
    utxos: selected.map(({ rawTransaction: _rawTransaction, ...utxo }) => utxo),
    parents: selected.map(({ txid, rawTransaction }) => ({
      txid,
      rawTransaction,
    })),
    contracts: [],
  } as const;
  const policyPayload = {
    version: "1.0",
    policyId: `policy-${options.clientRequestId}`,
    revision: "1",
    chainId: options.chainId,
    feeRateSatPerKb: "80",
    dustThreshold: "24",
    minConfirmations: "1",
    maxBundleTransactions: 32,
    sighashType: 65,
    contractPolicies: [],
    amountLimits: [
      { scope: "native", maximum: "2100000000000000" },
    ],
    expiresAt: "2026-09-02T00:05:00Z",
  } as const;
  const request = {
    version: "1.0",
    chainId: options.chainId,
    from,
    clientRequestId: options.clientRequestId,
    intent: {
      type: "tbc.transfer",
      version: "1.0",
      to,
      amount: options.amount,
    },
    constraints: {
      expiresAt: "2026-09-02T00:05:00Z",
      maxFee: "200",
      feePreference: "standard",
    },
  } as const;
  return deepFreeze({
    profile,
    request: request as TransactionRequest,
    account,
    snapshot: {
      payload: snapshotPayload,
      snapshotHash: hashCanonical(snapshotPayload),
    } as ChainDataResolveResult,
    policy: {
      payload: policyPayload,
      policyHash: hashCanonical(policyPayload),
    } as PolicyResolveResult,
  });
}
