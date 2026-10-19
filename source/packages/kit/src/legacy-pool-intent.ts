import { assertValidTws, hashCanonical } from "@tbc-wallet/core";
import {
  assertHash32,
  assertTbcAddress,
} from "./testnet-validation.js";
import { tbcNetworkProfileForChainId } from "./network-context.js";
import { poolServiceFeeRate } from "./pool-policy.js";
import type { TbcLegacyMetadataResolver } from "./legacy-metadata.js";

const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const PUBLIC_KEY = /^(?:02|03)[0-9a-f]{64}$/u;
const LEGACY_POOL_SWAP_TTL_MS = 5 * 60 * 1000;

export const LEGACY_POOL_REMOVE_MINIMUM_TBC_ATOMIC = "1" as const;
export const LEGACY_POOL_REMOVE_MINIMUM_FT_RAW = "1" as const;
export const LEGACY_POOL_SWAP_MINIMUM_TBC_ATOMIC = "1" as const;
export const LEGACY_POOL_SWAP_MINIMUM_FT_RAW = "1" as const;

export interface LegacyPoolIntentResolver {
  readonly resolve: (
    request: unknown,
    addressFrom: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

export class LegacyPoolParameterError extends Error {}

function invalidRequest(operation = "LP increase"): never {
  throw new LegacyPoolParameterError(`Invalid Legacy Pool ${operation}`);
}

function atomicDisplayAmount(
  value: unknown,
  decimals: number,
  operation = "LP increase",
  truncate = false,
): string {
  const display =
    typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    typeof display !== "string" ||
    !DECIMAL.test(display) ||
    /^0(?:\.0+)?$/u.test(display)
  ) {
    return invalidRequest(operation);
  }
  const [whole = "0", suppliedFraction = ""] = display.split(".");
  if (!truncate && suppliedFraction.length > decimals) {
    return invalidRequest(operation);
  }
  const fraction = suppliedFraction.slice(0, decimals);
  const normalized = `${whole}${fraction.padEnd(decimals, "0")}`.replace(
    /^0+(?=[0-9])/u,
    "",
  );
  if (!/^[1-9][0-9]*$/u.test(normalized)) return invalidRequest(operation);
  const amount = BigInt(normalized);
  if (amount > UINT64_MAX) return invalidRequest(operation);
  return amount.toString();
}

function atomicTbcAmount(value: unknown, operation?: string): string {
  return atomicDisplayAmount(value, 6, operation);
}

function exactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function allowedOwnKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        (required.includes(key) || optional.includes(key)),
    )
  );
}

function canonicalRequest(
  chainId: string,
  from: string,
  prefix: string,
  intent: Readonly<Record<string, unknown>>,
  constraints?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const base = Object.freeze({
    version: "1.0" as const,
    chainId,
    from,
    intent,
    ...(constraints === undefined ? {} : { constraints }),
  });
  const resolved = Object.freeze({
    ...base,
    clientRequestId: `${prefix}:${hashCanonical(base)}`,
  });
  assertValidTws("transactionRequest", resolved);
  return resolved;
}

export function createLegacyPoolIntentResolver(options: {
  readonly chainId: string;
  readonly now?: () => Date;
  /** Advanced loader override. Prefer `metadata` for the bounded default path. */
  readonly resolvePoolFtDecimals?: (poolContractId: string) => Promise<number>;
  readonly metadata?: Pick<
    TbcLegacyMetadataResolver,
    "network" | "resolvePoolFtDecimals"
  >;
}): LegacyPoolIntentResolver {
  const profile = tbcNetworkProfileForChainId(options.chainId);
  if (
    options.metadata !== undefined &&
    options.metadata.network.chainId !== options.chainId
  ) {
    throw new TypeError("Pool metadata network does not match the resolver chain");
  }
  const resolvePoolFtDecimals =
    options.metadata?.resolvePoolFtDecimals ?? options.resolvePoolFtDecimals;
  const assertAddress = (value: string) =>
    assertTbcAddress(value, profile.p2pkhVersion);
  return Object.freeze({
    async resolve(request: unknown, addressFrom: string) {
      if (
        request === null ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.getPrototypeOf(request) !== Object.prototype
      ) {
        return invalidRequest();
      }
      const source = assertAddress(addressFrom).address;
      const flag = Reflect.get(request, "flag");
      if (flag === "POOLNFT_LP_BURN") {
        if (
          !allowedOwnKeys(request, ["flag", "nft_contract_address"], ["domain"])
        ) {
          return invalidRequest("FTLP burn");
        }
        const contractValue = Reflect.get(request, "nft_contract_address");
        if (typeof contractValue !== "string") return invalidRequest("FTLP burn");
        return canonicalRequest(
          options.chainId,
          source,
          "legacy-ftlp-burn",
          Object.freeze({
            version: "1.0" as const,
            type: "tbc.pool.ftlp.burn" as const,
            poolContractId: assertHash32(contractValue.toLowerCase()),
          }),
        );
      }
      if (flag === "POOLNFT_MERGE" || flag === "FTLP_MERGE") {
        if (
          !allowedOwnKeys(request, ["flag", "nft_contract_address"], ["domain"])
        ) {
          return invalidRequest(flag === "POOLNFT_MERGE" ? "FT merge" : "FTLP merge");
        }
        const contractValue = Reflect.get(request, "nft_contract_address");
        if (typeof contractValue !== "string") {
          return invalidRequest(flag === "POOLNFT_MERGE" ? "FT merge" : "FTLP merge");
        }
        const poolContractId = assertHash32(contractValue.toLowerCase());
        return canonicalRequest(
          options.chainId,
          source,
          flag === "POOLNFT_MERGE" ? "legacy-pool-ft-merge" : "legacy-ftlp-merge",
          Object.freeze({
            version: "1.0" as const,
            type: flag === "POOLNFT_MERGE"
              ? "tbc.pool.ft.merge" as const
              : "tbc.pool.ftlp.merge" as const,
            poolContractId,
          }),
        );
      }
      if (flag === "POOLNFT_MINT") {
        if (
          !exactOwnKeys(request, [
            "flag",
            "ft_contract_address",
            "poolNFT_version",
            "serverProvider_tag",
            "serviceFeeRate",
            "with_lock",
            "pubKeyLock",
            "lpCostAddress",
            "lpCostAmount",
            "lpPlan",
            "broadcastEnabled",
          ]) ||
          Reflect.get(request, "poolNFT_version") !== 2 ||
          Reflect.get(request, "with_lock") !== true ||
          Reflect.get(request, "broadcastEnabled") !== false
        ) {
          return invalidRequest("mint");
        }
        const ftContractValue = Reflect.get(request, "ft_contract_address");
        const serviceProviderTag = Reflect.get(request, "serverProvider_tag");
        const lpPlan = Reflect.get(request, "lpPlan");
        const serviceFeeRate = Reflect.get(request, "serviceFeeRate");
        const publicKeyValues = Reflect.get(request, "pubKeyLock");
        if (
          typeof ftContractValue !== "string" ||
          typeof serviceProviderTag !== "string" ||
          !/^[ -~]{1,64}$/u.test(serviceProviderTag) ||
          !Number.isInteger(lpPlan) ||
          typeof lpPlan !== "number" ||
          poolServiceFeeRate(lpPlan) === undefined ||
          serviceFeeRate !== poolServiceFeeRate(lpPlan) ||
          !Array.isArray(publicKeyValues) ||
          Object.getPrototypeOf(publicKeyValues) !== Array.prototype ||
          publicKeyValues.length < 1 ||
          publicKeyValues.length > 16
        ) {
          return invalidRequest("mint");
        }
        const publicKeys = publicKeyValues.map((value) =>
          typeof value === "string" ? value.toLowerCase() : "",
        );
        if (
          publicKeys.some((value) => !PUBLIC_KEY.test(value)) ||
          new Set(publicKeys).size !== publicKeys.length
        ) {
          return invalidRequest("mint");
        }
        const ftContractId = assertHash32(ftContractValue.toLowerCase());
        const costRecipientValue = Reflect.get(request, "lpCostAddress");
        if (typeof costRecipientValue !== "string") {
          return invalidRequest("mint");
        }
        const costRecipient = assertAddress(costRecipientValue).address;
        const costAmount = atomicTbcAmount(
          Reflect.get(request, "lpCostAmount"),
          "mint",
        );
        return canonicalRequest(
          options.chainId,
          source,
          "legacy-pool-create-mint",
          Object.freeze({
            version: "1.0" as const,
            type: "tbc.pool.create" as const,
            stage: "mint" as const,
            ftContractId,
            lpPlan,
            serviceProviderTag,
            lock: Object.freeze({
              publicKeys: Object.freeze(publicKeys),
              costRecipient,
              costAmount,
            }),
          }),
        );
      }
      if (flag === "POOLNFT_INIT") {
        if (
          !exactOwnKeys(request, [
            "flag",
            "nft_contract_address",
            "address",
            "tbc_amount",
            "ft_amount",
            "poolNFT_version",
            "lockTime",
            "broadcastEnabled",
          ]) ||
          Reflect.get(request, "poolNFT_version") !== 2 ||
          Reflect.get(request, "lockTime") !== 0 ||
          Reflect.get(request, "broadcastEnabled") !== false ||
          resolvePoolFtDecimals === undefined
        ) {
          return invalidRequest("initialize");
        }
        const poolValue = Reflect.get(request, "nft_contract_address");
        const receiverValue = Reflect.get(request, "address");
        if (typeof poolValue !== "string" || typeof receiverValue !== "string") {
          return invalidRequest("initialize");
        }
        const poolContractId = assertHash32(poolValue.toLowerCase());
        const receiver = assertAddress(receiverValue).address;
        const decimals = await resolvePoolFtDecimals(poolContractId);
        const tbcAmount = atomicTbcAmount(
          Reflect.get(request, "tbc_amount"),
          "initialize",
        );
        const ftAmount = atomicDisplayAmount(
          Reflect.get(request, "ft_amount"),
          decimals,
          "initialize",
        );
        return canonicalRequest(
          options.chainId,
          source,
          "legacy-pool-create-initialize",
          Object.freeze({
            version: "1.0" as const,
            type: "tbc.pool.create" as const,
            stage: "initialize" as const,
            poolContractId,
            initialLiquidity: Object.freeze({
              receiver,
              tbcAmount,
              ftAmount,
            }),
          }),
        );
      }
      if (flag === "POOLNFT_LP_CONSUME") {
        if (
          Reflect.get(request, "broadcastEnabled") !== false ||
          Reflect.get(request, "poolNFT_version") !== 2 ||
          !exactOwnKeys(request, [
            "flag",
            "nft_contract_address",
            "address",
            "ft_amount",
            "poolNFT_version",
            "broadcastEnabled",
          ])
        ) {
          return invalidRequest("LP consume");
        }
        const contractValue = Reflect.get(request, "nft_contract_address");
        const receiverValue = Reflect.get(request, "address");
        if (
          typeof contractValue !== "string" ||
          typeof receiverValue !== "string"
        ) {
          return invalidRequest("LP consume");
        }
        const receiver = assertAddress(receiverValue).address;
        const poolContractId = assertHash32(contractValue.toLowerCase());
        const lpAmount = atomicDisplayAmount(
          Reflect.get(request, "ft_amount"),
          6,
          "LP consume",
          true,
        );
        return canonicalRequest(
          options.chainId,
          source,
          "legacy-pool-remove",
          Object.freeze({
            version: "1.0" as const,
            type: "tbc.pool.liquidity.remove" as const,
            poolContractId,
            receiver,
            lpAmount,
            minimumTbcAmount: LEGACY_POOL_REMOVE_MINIMUM_TBC_ATOMIC,
            minimumFtAmount: LEGACY_POOL_REMOVE_MINIMUM_FT_RAW,
          }),
        );
      }
      if (flag === "POOLNFT_SWAP_TO_TOKEN" || flag === "POOLNFT_SWAP_TO_TBC") {
        const amountField =
          flag === "POOLNFT_SWAP_TO_TOKEN" ? "tbc_amount" : "ft_amount";
        if (
          Reflect.get(request, "broadcastEnabled") !== false ||
          !allowedOwnKeys(
            request,
            [
              "flag",
              "nft_contract_address",
              "address",
              amountField,
              "broadcastEnabled",
            ],
            ["poolNFT_version", "lpPlan"],
          ) ||
          (Object.hasOwn(request, "poolNFT_version") &&
            Reflect.get(request, "poolNFT_version") !== 2)
        ) {
          return invalidRequest("swap");
        }
        const lpPlan = Reflect.get(request, "lpPlan");
        if (
          lpPlan !== undefined &&
          (!Number.isInteger(lpPlan) ||
            typeof lpPlan !== "number" ||
            poolServiceFeeRate(lpPlan) === undefined)
        ) {
          return invalidRequest("swap");
        }
        const contractValue = Reflect.get(request, "nft_contract_address");
        const receiverValue = Reflect.get(request, "address");
        if (
          typeof contractValue !== "string" ||
          typeof receiverValue !== "string"
        ) {
          return invalidRequest("swap");
        }
        const poolContractId = assertHash32(contractValue.toLowerCase());
        const receiver = assertAddress(receiverValue).address;
        const now = (options.now ?? (() => new Date()))();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
          return invalidRequest("swap");
        }
        const constraints = Object.freeze({
          expiresAt: new Date(now.getTime() + LEGACY_POOL_SWAP_TTL_MS)
            .toISOString(),
        });
        if (flag === "POOLNFT_SWAP_TO_TOKEN") {
          const tbcAmount = atomicTbcAmount(
            Reflect.get(request, "tbc_amount"),
            "swap",
          );
          return canonicalRequest(
            options.chainId,
            source,
            "legacy-pool-swap-tbc-for-token",
            Object.freeze({
              version: "1.0" as const,
              type: "tbc.pool.swap.exactTbcForToken" as const,
              poolContractId,
              receiver,
              tbcAmount,
              minimumFtAmount: LEGACY_POOL_SWAP_MINIMUM_FT_RAW,
            }),
            constraints,
          );
        }
        if (resolvePoolFtDecimals === undefined) {
          return invalidRequest("swap");
        }
        const decimals = await resolvePoolFtDecimals(poolContractId);
        const ftAmount = atomicDisplayAmount(
          Reflect.get(request, "ft_amount"),
          decimals,
          "swap",
        );
        return canonicalRequest(
          options.chainId,
          source,
          "legacy-pool-swap-token-for-tbc",
          Object.freeze({
            version: "1.0" as const,
            type: "tbc.pool.swap.exactTokenForTbc" as const,
            poolContractId,
            receiver,
            ftAmount,
            minimumTbcAmount: LEGACY_POOL_SWAP_MINIMUM_TBC_ATOMIC,
          }),
          constraints,
        );
      }
      if (
        flag !== "POOLNFT_LP_INCREASE" ||
        Reflect.get(request, "broadcastEnabled") !== false ||
        !allowedOwnKeys(
          request,
          [
            "flag",
            "nft_contract_address",
            "address",
            "tbc_amount",
            "broadcastEnabled",
          ],
          ["poolNFT_version"],
        ) ||
        (Object.hasOwn(request, "poolNFT_version") &&
          Reflect.get(request, "poolNFT_version") !== 2)
      ) {
        return invalidRequest();
      }
      const contractValue = Reflect.get(request, "nft_contract_address");
      const receiverValue = Reflect.get(request, "address");
      if (
        typeof contractValue !== "string" ||
        typeof receiverValue !== "string"
      ) {
        return invalidRequest();
      }
      const receiver = assertAddress(receiverValue).address;
      const poolContractId = assertHash32(contractValue.toLowerCase());
      const tbcAmount = atomicTbcAmount(Reflect.get(request, "tbc_amount"));
      return canonicalRequest(
        options.chainId,
        source,
        "legacy-pool-add",
        Object.freeze({
          version: "1.0" as const,
          type: "tbc.pool.liquidity.add" as const,
          poolContractId,
          receiver,
          tbcAmount,
          minimumLpAmount: "1",
        }),
      );
    },
  });
}
