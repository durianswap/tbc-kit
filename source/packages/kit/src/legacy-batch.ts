import { assertValidTws, canonicalize } from "@tbc-wallet/core";

import {
  legacyAtomicAmount,
  legacyDisplayAmount,
} from "./legacy-ft-transfer-intent.js";
import { assertHash32, assertTestnetAddress } from "./testnet-validation.js";

/** Canonical request-list facts only; this is not approval or signer authority. */
export interface LegacyBatchRequestScope {
  readonly source: string;
  readonly recipient: string;
  readonly kind:
    | "native"
    | "ft"
    | "pool-add"
    | "pool-remove"
    | "ft-create"
    | "pool-mint"
    | "pool-initialize";
  readonly amount: string;
  readonly contractId?: string;
  readonly attachedTbcAtomic: string;
  readonly feeCapAtomic: string;
  readonly poolIntent?: Readonly<Record<string, unknown>>;
  readonly createIntent?: Readonly<Record<string, unknown>>;
  readonly method?: "tbc_sendTransaction";
  readonly transactionCount?: 1 | 2;
}

export function createLegacyBatchRequestScope(
  params: unknown,
  source: string,
): LegacyBatchRequestScope {
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    Object.getPrototypeOf(params) !== Object.prototype
  ) {
    throw new Error("Invalid batch request");
  }
  assertTestnetAddress(source);

  if (Reflect.get(params, "version") === "1.0") {
    assertValidTws("transactionRequest", params);
    const intent = Reflect.get(params, "intent") as Record<string, unknown>;
    if (intent.type === "tbc.ft.create" || intent.type === "tbc.pool.create") {
      if (
        Reflect.get(params, "from") !== source ||
        Reflect.get(params, "constraints") !== undefined
      ) {
        throw new Error("Invalid create request scope");
      }
      const ft = intent.type === "tbc.ft.create";
      const mint = intent.stage === "mint";
      if (!ft && !mint && intent.stage !== "initialize") {
        throw new Error("Unsupported Pool create stage");
      }
      const liquidity = intent.initialLiquidity as
        | Record<string, unknown>
        | undefined;
      return Object.freeze({
        source,
        recipient:
          ft || mint
            ? source
            : assertTestnetAddress(String(liquidity?.receiver)).address,
        kind: ft ? "ft-create" : mint ? "pool-mint" : "pool-initialize",
        amount: String(
          ft ? intent.initialSupply : mint ? "0" : liquidity?.tbcAmount,
        ),
        ...(ft
          ? { method: "tbc_sendTransaction" as const }
          : {
              contractId: assertHash32(
                String(mint ? intent.ftContractId : intent.poolContractId),
              ),
            }),
        attachedTbcAtomic: "0",
        feeCapAtomic: "10000",
        transactionCount: ft || mint ? 2 : 1,
        createIntent: Object.freeze(JSON.parse(canonicalize(intent))),
      });
    }
    const kind =
      intent.type === "tbc.pool.liquidity.add"
        ? "pool-add"
        : intent.type === "tbc.pool.liquidity.remove"
          ? "pool-remove"
          : undefined;
    if (
      !kind ||
      typeof intent.receiver !== "string" ||
      Reflect.get(params, "from") !== source ||
      Reflect.get(params, "constraints") !== undefined
    ) {
      throw new Error("Invalid LP request scope");
    }
    return Object.freeze({
      source,
      recipient: assertTestnetAddress(intent.receiver).address,
      kind,
      amount: String(kind === "pool-add" ? intent.tbcAmount : intent.lpAmount),
      contractId: assertHash32(String(intent.poolContractId)),
      attachedTbcAtomic: "0",
      feeCapAtomic: "10000",
      poolIntent: Object.freeze(JSON.parse(canonicalize(intent))),
    });
  }

  if (Reflect.get(params, "broadcastEnabled") !== false) {
    throw new Error("Invalid batch request");
  }
  const recipient = assertTestnetAddress(
    Reflect.get(params, "address"),
  ).address;
  if (Reflect.get(params, "flag") === "P2PKH") {
    const value = Reflect.get(params, "satoshis");
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error("Invalid amount");
    }
    return Object.freeze({
      source,
      recipient,
      kind: "native" as const,
      amount: legacyAtomicAmount(legacyDisplayAmount(value, false), 0),
      attachedTbcAtomic: "0",
      feeCapAtomic: "1000",
    });
  }
  if (Reflect.get(params, "flag") !== "FT_TRANSFER") {
    throw new Error("Unsupported batch request");
  }
  const contract = Reflect.get(params, "ft_contract_address");
  if (typeof contract !== "string") throw new Error("Invalid FT contract");
  return Object.freeze({
    source,
    recipient,
    kind: "ft" as const,
    contractId: assertHash32(contract.toLowerCase()),
    amount: legacyDisplayAmount(Reflect.get(params, "ft_amount"), false),
    attachedTbcAtomic: legacyAtomicAmount(
      legacyDisplayAmount(Reflect.get(params, "tbc_amount") ?? "0", true),
      6,
    ),
    feeCapAtomic: "10000",
  });
}

/** FT decimals must come from the wallet's verified metadata resolver. */
export function matchesLegacyBatchRequest(
  scope: LegacyBatchRequestScope,
  params: Readonly<Record<string, unknown>>,
  ftDecimals?: number,
): boolean {
  const expected =
    scope.createIntent ??
    (scope.kind === "pool-add" || scope.kind === "pool-remove"
      ? scope.poolIntent
      : scope.kind === "native"
        ? {
            version: "1.0",
            type: "tbc.transfer",
            to: scope.recipient,
            amount: scope.amount,
          }
        : {
            version: "1.0",
            type: "tbc.ft.transfer",
            to: scope.recipient,
            contractId: scope.contractId,
            amount: legacyAtomicAmount(scope.amount, ftDecimals ?? -1),
            ...(scope.attachedTbcAtomic === "0"
              ? {}
              : { attachedTbcAmount: scope.attachedTbcAtomic }),
          });
  return (
    params.version === "1.0" &&
    params.from === scope.source &&
    canonicalize(params.intent) === canonicalize(expected) &&
    params.constraints === undefined
  );
}

export function withLegacyDependentTxids(
  params: unknown,
  txids: readonly string[],
  field = "txids",
): Readonly<{ message: string; encoding: "utf8" }> | undefined {
  if (
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(field) ||
    ["__proto__", "constructor", "prototype"].includes(field)
  ) return undefined;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const message = Reflect.get(params, "message");
  if (typeof message !== "string" || Reflect.get(params, "encoding") !== "utf8") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (Object.hasOwn(parsed, field) &&
      !Array.isArray(Reflect.get(parsed, field))) ||
    Reflect.ownKeys(parsed).some(
      (key) =>
        typeof key !== "string" ||
        ["__proto__", "constructor", "prototype"].includes(key),
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    message: JSON.stringify(
      Object.fromEntries([
        ...Object.entries(parsed).map(([key, value]) =>
          key === field ? [key, [...txids]] : [key, value],
        ),
        ...(Object.hasOwn(parsed, field) ? [] : [[field, [...txids]]]),
      ]),
    ),
    encoding: "utf8" as const,
  });
}
