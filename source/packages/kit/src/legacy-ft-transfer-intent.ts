import { assertValidTws, hashCanonical } from "@tbc-wallet/core";
import {
  assertHash32,
  assertTbcAddress,
} from "./testnet-validation.js";
import { tbcNetworkProfileForChainId } from "./network-context.js";
import {
  loadTbcLegacyFtCreationIdentity,
  type TbcFtContractMetadata,
  type TbcLegacyMetadataResolver,
} from "./legacy-metadata.js";

const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

export interface LegacyFtContractMetadata {
  readonly contractId: string;
  readonly decimals: number;
  readonly name: string;
  readonly symbol: string;
}

export interface LegacyFtTransferIntentResolver {
  readonly resolve: (
    request: unknown,
    addressFrom: string,
    onMetadata?: (decimals: number) => void,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

function invalidRequest(): never {
  throw new Error("Invalid Legacy FT transfer");
}

export function legacyDisplayAmount(
  value: unknown,
  allowZero: boolean,
): string {
  const normalized =
    typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (
    typeof normalized !== "string" ||
    !DECIMAL.test(normalized) ||
    (!allowZero && /^0(?:\.0+)?$/u.test(normalized))
  ) {
    return invalidRequest();
  }
  return normalized;
}

export function legacyAtomicAmount(value: string, decimals: number): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) {
    return invalidRequest();
  }
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) return invalidRequest();
  const normalized = `${whole}${fraction.padEnd(decimals, "0")}`.replace(
    /^0+(?=[0-9])/u,
    "",
  );
  if (!/^(?:0|[1-9][0-9]*)$/u.test(normalized)) return invalidRequest();
  const amount = BigInt(normalized);
  if (amount > UINT64_MAX) return invalidRequest();
  return amount.toString();
}

export function resolveLegacyFtTransferIntent(input: Readonly<{
  chainId: string;
  request: unknown;
  addressFrom: string;
  decimals: number;
  currentStandard?: boolean;
}>): Readonly<Record<string, unknown>> {
  const request =
    Array.isArray(input.request) &&
    Object.getPrototypeOf(input.request) === Array.prototype &&
    input.request.length === 1
      ? input.request[0]
      : input.request;
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.getPrototypeOf(request) !== Object.prototype ||
    Reflect.get(request, "flag") !== "FT_TRANSFER" ||
    (Reflect.get(request, "broadcastEnabled") !== undefined &&
      typeof Reflect.get(request, "broadcastEnabled") !== "boolean")
  ) {
    return invalidRequest();
  }
  const contractValue = Reflect.get(request, "ft_contract_address");
  const recipientValue = Reflect.get(request, "address");
  if (typeof contractValue !== "string" || typeof recipientValue !== "string") {
    return invalidRequest();
  }
  const profile = tbcNetworkProfileForChainId(input.chainId);
  const source = assertTbcAddress(input.addressFrom, profile.p2pkhVersion).address;
  const recipient = assertTbcAddress(recipientValue, profile.p2pkhVersion).address;
  const contractId = assertHash32(contractValue.toLowerCase());
  const amount = legacyAtomicAmount(
    legacyDisplayAmount(Reflect.get(request, "ft_amount"), false),
    input.decimals,
  );
  if (amount === "0") return invalidRequest();
  const attachedTbcAmount = legacyAtomicAmount(
    legacyDisplayAmount(Reflect.get(request, "tbc_amount") ?? "0", true),
    6,
  );
  const intent = Object.freeze({
    version: "1.0" as const,
    type: input.currentStandard === true ? "tbc20.transfer" as const : "tbc.ft.transfer" as const,
    contractId,
    to: recipient,
    amount,
    ...(attachedTbcAmount === "0" ? {} : input.currentStandard === true
      ? { payment: { to: recipient, amount: attachedTbcAmount } } : { attachedTbcAmount }),
  });
  const base = Object.freeze({
    version: "1.0" as const,
    chainId: input.chainId,
    from: source,
    intent,
  });
  const resolved = Object.freeze({
    ...base,
    clientRequestId: `legacy-ft-transfer:${hashCanonical(base)}`,
  });
  assertValidTws("transactionRequest", resolved);
  return resolved;
}

export function createLegacyFtTransferIntentResolver(options: {
  readonly chainId: string;
  /** Advanced loader override. Prefer `metadata` for the bounded default path. */
  readonly getFtInfo?: (contractId: string) => Promise<LegacyFtContractMetadata>;
  readonly metadata?: Pick<TbcLegacyMetadataResolver, "network" | "getFtInfo">;
  /** Exact local Code-template inspection over the same authenticated metadata read. */
  readonly resolveCurrentStandard?: (metadata: TbcFtContractMetadata) => Promise<boolean>;
  readonly cacheTtlMs?: number;
  readonly maxCacheEntries?: number;
  readonly now?: () => number;
}): LegacyFtTransferIntentResolver {
  const profile = tbcNetworkProfileForChainId(options.chainId);
  if (
    options.metadata !== undefined &&
    options.metadata.network.chainId !== options.chainId
  ) {
    throw new TypeError("FT metadata network does not match the resolver chain");
  }
  if (options.resolveCurrentStandard !== undefined &&
      (options.metadata === undefined || typeof options.resolveCurrentStandard !== "function")) {
    throw new TypeError("FT template inspection requires the configured metadata resolver");
  }
  const getFtInfo =
    options.metadata === undefined
      ? options.getFtInfo
      : options.resolveCurrentStandard === undefined
        ? (contractId: string) =>
          loadTbcLegacyFtCreationIdentity(options.metadata!, contractId)
        : options.metadata.getFtInfo;
  if (typeof getFtInfo !== "function") {
    throw new TypeError("FT metadata loader is required");
  }
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;
  const maxCacheEntries = options.maxCacheEntries ?? 32;
  const now = options.now ?? Date.now;
  if (
    !Number.isSafeInteger(cacheTtlMs) ||
    cacheTtlMs < 0 ||
    cacheTtlMs > 5 * 60_000 ||
    !Number.isSafeInteger(maxCacheEntries) ||
    maxCacheEntries < 1 ||
    maxCacheEntries > 128
  ) {
    throw new TypeError("Invalid FT metadata cache limits");
  }
  const metadataByContract = new Map<
    string,
    Readonly<{ metadata: LegacyFtContractMetadata; currentStandard?: boolean; expiresAt: number }>
  >();
  const useLocalCache = options.resolveCurrentStandard !== undefined ||
    (options.metadata === undefined && cacheTtlMs > 0);
  return Object.freeze({
    async resolve(
      request: unknown,
      addressFrom: string,
      onMetadata?: (decimals: number) => void,
    ) {
      const value =
        Array.isArray(request) &&
        Object.getPrototypeOf(request) === Array.prototype &&
        request.length === 1
          ? request[0]
          : request;
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Reflect.get(value, "flag") !== "FT_TRANSFER" ||
        (Reflect.get(value, "broadcastEnabled") !== undefined &&
          typeof Reflect.get(value, "broadcastEnabled") !== "boolean")
      ) {
        return invalidRequest();
      }
      const contractValue = Reflect.get(value, "ft_contract_address");
      const recipientValue = Reflect.get(value, "address");
      if (
        typeof contractValue !== "string" ||
        typeof recipientValue !== "string"
      ) {
        return invalidRequest();
      }
      assertTbcAddress(addressFrom, profile.p2pkhVersion);
      assertTbcAddress(recipientValue, profile.p2pkhVersion);
      const contractId = assertHash32(contractValue.toLowerCase());
      const timestamp = now();
      if (!Number.isFinite(timestamp)) {
        throw new Error("Invalid FT metadata clock");
      }
      const cached = useLocalCache
        ? metadataByContract.get(contractId)
        : undefined;
      if (cached !== undefined && cached.expiresAt <= timestamp) {
        metadataByContract.delete(contractId);
      }
      const metadata =
        cached !== undefined && cached.expiresAt > timestamp
          ? cached.metadata
          : await getFtInfo(contractId);
      if (
        metadata.contractId !== contractId ||
        !Number.isSafeInteger(metadata.decimals) ||
        metadata.decimals < 0 ||
        metadata.decimals > 18
      ) {
        throw new Error("FT contract metadata identity mismatch");
      }
      const currentStandard = cached !== undefined && cached.expiresAt > timestamp
        ? cached.currentStandard
        : options.resolveCurrentStandard === undefined
          ? undefined
          : await options.resolveCurrentStandard(metadata as TbcFtContractMetadata);
      if (options.resolveCurrentStandard !== undefined && typeof currentStandard !== "boolean") {
        throw new TypeError("Invalid FT template inspection result");
      }
      if (typeof metadata.name !== "string" || metadata.name.length === 0 ||
          metadata.name.length > (currentStandard === true ? 53 : 64) ||
          typeof metadata.symbol !== "string" || metadata.symbol.length === 0 ||
          metadata.symbol.length > (currentStandard === true ? 52 : 16)) {
        throw new Error("FT contract metadata identity mismatch");
      }
      if (
        useLocalCache &&
        (cached === undefined || cached.expiresAt <= timestamp)
      ) {
        if (metadataByContract.size >= maxCacheEntries) {
          metadataByContract.delete(
            metadataByContract.keys().next().value as string,
          );
        }
        metadataByContract.set(
          contractId,
          Object.freeze({
            metadata: Object.freeze({
              contractId,
              decimals: metadata.decimals,
              name: metadata.name,
              symbol: metadata.symbol,
            }),
            ...(currentStandard === undefined ? {} : { currentStandard }),
            expiresAt: options.resolveCurrentStandard === undefined
              ? timestamp + cacheTtlMs
              : Number.POSITIVE_INFINITY,
          }),
        );
      }
      const resolved = resolveLegacyFtTransferIntent({
        chainId: options.chainId,
        request: value,
        addressFrom,
        decimals: metadata.decimals,
        ...(currentStandard === undefined ? {} : { currentStandard }),
      });
      onMetadata?.(metadata.decimals);
      return resolved;
    },
  });
}
