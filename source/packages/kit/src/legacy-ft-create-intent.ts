import { assertValidTws, hashCanonical, utf8 } from "@tbc-wallet/core";

import { tbcNetworkProfileForChainId } from "./network-context.js";
import { assertTbcAddress } from "./testnet-validation.js";

const LEGACY_FT_DECIMALS = 6;
const LEGACY_FT_MAX_DISPLAY_AMOUNT = 1_000_000_000_000;

export interface LegacyFtCreateIntentResolver {
  readonly resolve: (
    request: unknown,
    addressFrom: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

export class LegacyFtCreateParameterError extends Error {}

function invalidRequest(): never {
  throw new LegacyFtCreateParameterError("Invalid Legacy FT mint");
}

function exactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalidRequest();
  }
  return value as Readonly<Record<string, unknown>>;
}

function initialSupply(value: unknown): string {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > LEGACY_FT_MAX_DISPLAY_AMOUNT
  ) {
    return invalidRequest();
  }
  const fixed = value.toFixed(LEGACY_FT_DECIMALS);
  if (Number(fixed) !== value) return invalidRequest();
  const [whole = "0", fraction = ""] = fixed.split(".");
  const atomic = `${whole}${fraction}`.replace(/^0+(?=[0-9])/u, "");
  return /^[1-9][0-9]*$/u.test(atomic) ? atomic : invalidRequest();
}

export function createLegacyFtCreateIntentResolver(options: {
  readonly chainId: string;
}): LegacyFtCreateIntentResolver {
  const profile = tbcNetworkProfileForChainId(options.chainId);
  return Object.freeze({
    async resolve(request: unknown, addressFrom: string) {
      if (
        !Array.isArray(request) ||
        Object.getPrototypeOf(request) !== Array.prototype ||
        request.length !== 1
      ) {
        return invalidRequest();
      }
      const outer = plainRecord(request[0]);
      if (
        !exactOwnKeys(outer, ["flag", "ft_data"]) ||
        outer.flag !== "FT_MINT" ||
        typeof outer.ft_data !== "string" ||
        outer.ft_data.length > 4_096
      ) {
        return invalidRequest();
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(outer.ft_data);
      } catch {
        return invalidRequest();
      }
      const metadata = plainRecord(decoded);
      if (!exactOwnKeys(metadata, ["name", "symbol", "amount", "decimal"])) {
        return invalidRequest();
      }
      const name = metadata.name;
      const symbol = metadata.symbol;
      if (
        typeof name !== "string" ||
        name.length === 0 ||
        utf8(name).length > 256 ||
        typeof symbol !== "string" ||
        symbol.length === 0 ||
        utf8(symbol).length > 256 ||
        metadata.decimal !== LEGACY_FT_DECIMALS
      ) {
        return invalidRequest();
      }
      const source = assertTbcAddress(addressFrom, profile.p2pkhVersion).address;
      const intent = Object.freeze({
        version: "1.0" as const,
        type: "tbc.ft.create" as const,
        name,
        symbol,
        decimals: LEGACY_FT_DECIMALS,
        initialSupply: initialSupply(metadata.amount),
      });
      const base = Object.freeze({
        version: "1.0" as const,
        chainId: options.chainId,
        from: source,
        intent,
      });
      const resolved = Object.freeze({
        ...base,
        clientRequestId: `legacy-ft-create:${hashCanonical(base)}`,
      });
      assertValidTws("transactionRequest", resolved);
      return resolved;
    },
  });
}
