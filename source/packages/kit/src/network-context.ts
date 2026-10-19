import { hashCanonical } from "@tbc-wallet/core";
import {
  TBC_MAINNET_PROFILE,
  TBC_TESTNET_PROFILE,
  type TbcNetworkProfile,
} from "./network-profiles.js";

export type TbcNetworkName = "mainnet" | "testnet";

export const OFFICIAL_TBC_MAINNET_API_ORIGIN =
  "https://api.turingbitchain.io" as const;
export const OFFICIAL_TBC_TESTNET_API_ORIGIN =
  "https://api.tbcdev.org" as const;

export interface TbcNetworkContext {
  readonly version: "1.0";
  readonly network: TbcNetworkName;
  readonly chainId: string;
  readonly profile: TbcNetworkProfile;
  readonly endpoint: Readonly<{
    readonly kind: "official" | "trusted-custom";
    readonly apiOrigin: string;
    readonly rpcOrigin?: string;
    readonly trustId: string;
  }>;
  /** Immutable partition key for cache, approval preparation and recovery. */
  readonly sourceIdentity: string;
}

export type CreateTbcNetworkContextOptions = Readonly<{
  network: TbcNetworkName;
  endpoint?:
    | Readonly<{ kind: "official" }>
    | Readonly<{
        kind: "trusted-custom";
        apiOrigin: string;
        rpcOrigin?: string;
        /** Wallet-owned stable identifier for the audited endpoint source. */
        trustId: string;
      }>;
}>;

const OFFICIAL = Object.freeze({
  mainnet: Object.freeze({
    profile: TBC_MAINNET_PROFILE,
    apiOrigin: OFFICIAL_TBC_MAINNET_API_ORIGIN,
  }),
  testnet: Object.freeze({
    profile: TBC_TESTNET_PROFILE,
    apiOrigin: OFFICIAL_TBC_TESTNET_API_ORIGIN,
  }),
});

function exactOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`Invalid TBC ${label} origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== value
  ) {
    throw new TypeError(`Invalid TBC ${label} origin`);
  }
  return url.origin;
}

export function tbcNetworkProfileForChainId(chainId: string): TbcNetworkProfile {
  if (chainId === TBC_MAINNET_PROFILE.chainId) return TBC_MAINNET_PROFILE;
  if (chainId === TBC_TESTNET_PROFILE.chainId) return TBC_TESTNET_PROFILE;
  // Legacy/custom Engine profiles historically used the same version-0 P2PKH
  // and v10 transaction rules. Unified default networking remains limited to
  // the two explicit contexts above; this preserves injected custom adapters.
  if (/^tbc:[A-Za-z0-9._:-]+$/u.test(chainId)) {
    return Object.freeze({ chainId, p2pkhVersion: 0, transactionVersion: 10 });
  }
  throw new TypeError("Unsupported TBC network chainId");
}

export function tbcNetworkNameForChainId(chainId: string): TbcNetworkName {
  if (chainId === TBC_MAINNET_PROFILE.chainId) return "mainnet";
  if (chainId === TBC_TESTNET_PROFILE.chainId) return "testnet";
  throw new TypeError("Unsupported TBC network chainId");
}

export function createTbcNetworkContext(
  options: CreateTbcNetworkContextOptions,
): TbcNetworkContext {
  if (
    options === null ||
    typeof options !== "object" ||
    (options.network !== "mainnet" && options.network !== "testnet")
  ) {
    throw new TypeError("Invalid TBC network context");
  }
  const official = OFFICIAL[options.network];
  const configured = options.endpoint ?? { kind: "official" as const };
  let endpoint: TbcNetworkContext["endpoint"];
  if (configured.kind === "official") {
    endpoint = Object.freeze({
      kind: "official" as const,
      apiOrigin: official.apiOrigin,
      trustId: `official:${options.network}`,
    });
  } else if (configured.kind === "trusted-custom") {
    const apiOrigin = exactOrigin(configured.apiOrigin, "API");
    const rpcOrigin = configured.rpcOrigin === undefined
      ? undefined
      : exactOrigin(configured.rpcOrigin, "RPC");
    if (
      typeof configured.trustId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(configured.trustId)
    ) {
      throw new TypeError("Invalid trusted TBC endpoint identity");
    }
    const other = options.network === "mainnet" ? OFFICIAL.testnet : OFFICIAL.mainnet;
    if (apiOrigin === other.apiOrigin || rpcOrigin === other.apiOrigin) {
      throw new TypeError("Official TBC endpoint does not match the selected network");
    }
    endpoint = Object.freeze({
      kind: "trusted-custom" as const,
      apiOrigin,
      ...(rpcOrigin === undefined ? {} : { rpcOrigin }),
      trustId: configured.trustId,
    });
  } else {
    throw new TypeError("Invalid TBC endpoint configuration");
  }
  const sourceIdentity = hashCanonical({
    version: "1.0",
    network: options.network,
    chainId: official.profile.chainId,
    endpoint,
  });
  return Object.freeze({
    version: "1.0" as const,
    network: options.network,
    chainId: official.profile.chainId,
    profile: official.profile,
    endpoint,
    sourceIdentity,
  });
}

export function assertTbcNetworkContext(value: TbcNetworkContext): TbcNetworkContext {
  const rebuilt = createTbcNetworkContext({
    network: value.network,
    endpoint: value.endpoint.kind === "official"
      ? { kind: "official" }
      : {
          kind: "trusted-custom",
          apiOrigin: value.endpoint.apiOrigin,
          ...(value.endpoint.rpcOrigin === undefined ? {} : { rpcOrigin: value.endpoint.rpcOrigin }),
          trustId: value.endpoint.trustId,
        },
  });
  if (
    value.version !== rebuilt.version ||
    value.chainId !== rebuilt.chainId ||
    value.sourceIdentity !== rebuilt.sourceIdentity
  ) {
    throw new TypeError("TBC network context identity mismatch");
  }
  return rebuilt;
}
