import { assertValidTws, hashCanonical } from "@tbc-wallet/core";

import {
  legacyAtomicAmount,
  legacyDisplayAmount,
} from "./legacy-ft-transfer-intent.js";
import type { TbcLegacyMetadataResolver } from "./legacy-metadata.js";
import { tbcNetworkProfileForChainId } from "./network-context.js";
import { assertHash32, assertTbcAddress } from "./testnet-validation.js";

export interface LegacyStablecoinTransferIntentResolver {
  readonly resolve: (
    request: unknown,
    addressFrom: string,
    onMetadata?: (decimals: number) => void,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

export interface CreateLegacyStablecoinTransferIntentResolverOptions {
  readonly chainId: string;
  /**
   * Preferred bounded Kit metadata path. It retains network/source identity and
   * short-lived Stablecoin decimals with the existing FT/Pool metadata cache.
   */
  readonly metadata?: Pick<
    TbcLegacyMetadataResolver,
    "network" | "resolveStablecoinDecimals"
  >;
  /** Advanced wallet-owned authenticated/cache lookup override. */
  readonly resolveDecimals?: (contractId: string) => number | Promise<number>;
}

export class LegacyStablecoinParameterError extends Error {}

function invalidRequest(): never {
  throw new LegacyStablecoinParameterError("Invalid Legacy Stablecoin transfer");
}

function legacyParams(value: unknown): Readonly<Record<string, unknown>> {
  const candidate =
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    value.length === 1
      ? value[0]
      : value;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    return invalidRequest();
  }
  const allowed = new Set([
    "flag",
    "ft_contract_address",
    "address",
    "ft_amount",
    "tbc_amount",
    "broadcastEnabled",
    "domain",
  ]);
  if (
    Reflect.get(candidate, "flag") !== "STABLECOIN_TRANSFER" ||
    Reflect.ownKeys(candidate).some(
      (key) => typeof key !== "string" || !allowed.has(key),
    ) ||
    (Reflect.get(candidate, "broadcastEnabled") !== undefined &&
      typeof Reflect.get(candidate, "broadcastEnabled") !== "boolean") ||
    (Reflect.get(candidate, "domain") !== undefined &&
      typeof Reflect.get(candidate, "domain") !== "string")
  ) {
    return invalidRequest();
  }
  return candidate as Readonly<Record<string, unknown>>;
}

export function isLegacyStablecoinTransferRequest(value: unknown): boolean {
  try {
    legacyParams(value);
    return true;
  } catch {
    return false;
  }
}

export function createLegacyStablecoinTransferIntentResolver(
  options: CreateLegacyStablecoinTransferIntentResolverOptions,
): LegacyStablecoinTransferIntentResolver {
  if (
    options === null ||
    typeof options !== "object" ||
    (options.metadata === undefined && typeof options.resolveDecimals !== "function") ||
    (options.metadata !== undefined && options.metadata.network.chainId !== options.chainId)
  ) {
    throw new TypeError("Legacy Stablecoin decimal resolver is required");
  }
  const profile = tbcNetworkProfileForChainId(options.chainId);
  const resolveDecimals = options.resolveDecimals ??
    options.metadata!.resolveStablecoinDecimals.bind(options.metadata);
  return Object.freeze({
    async resolve(request: unknown, addressFrom: string, onMetadata?: (decimals: number) => void) {
      const params = legacyParams(request);
      const contractValue = Reflect.get(params, "ft_contract_address");
      const recipientValue = Reflect.get(params, "address");
      if (typeof contractValue !== "string" || typeof recipientValue !== "string") {
        return invalidRequest();
      }
      let contractId: string;
      let from: string;
      let to: string;
      try {
        contractId = assertHash32(contractValue.toLowerCase());
        from = assertTbcAddress(addressFrom, profile.p2pkhVersion).address;
        to = assertTbcAddress(recipientValue, profile.p2pkhVersion).address;
      } catch {
        return invalidRequest();
      }
      const decimals = await resolveDecimals(contractId);
      let amount: string;
      let attachedTbcAmount: string;
      try {
        if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) {
          return invalidRequest();
        }
        onMetadata?.(decimals);
        amount = legacyAtomicAmount(
          legacyDisplayAmount(Reflect.get(params, "ft_amount"), false),
          decimals,
        );
        attachedTbcAmount = legacyAtomicAmount(
          legacyDisplayAmount(Reflect.get(params, "tbc_amount") ?? "0", true),
          6,
        );
      } catch (error) {
        if (error instanceof LegacyStablecoinParameterError) throw error;
        return invalidRequest();
      }
      const intent = Object.freeze({
        version: "1.0" as const,
        type: "tbc.stablecoin.transfer" as const,
        contractId,
        to,
        amount,
        ...(attachedTbcAmount === "0" ? {} : { attachedTbcAmount }),
      });
      const base = Object.freeze({
        version: "1.0" as const,
        chainId: options.chainId,
        from,
        intent,
      });
      const resolved = Object.freeze({
        ...base,
        clientRequestId: `legacy-stablecoin-transfer:${hashCanonical(base)}`,
      });
      assertValidTws("transactionRequest", resolved);
      return resolved;
    },
  });
}
