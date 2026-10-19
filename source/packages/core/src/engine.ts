import { TwsEngineError } from "./errors.js";
import type {
  FinalizeParams,
  FinalizeResult,
  NormalizeRequestParams,
  NormalizeRequestResult,
  PlanParams,
  PlanResult,
  ValidateParams,
  ValidationResult,
} from "./protocol-types.js";
import { assertValidTws, type TwsValidatorName } from "./validation.js";

export interface TransactionEngine {
  readonly normalizeRequest: (
    params: NormalizeRequestParams,
  ) => NormalizeRequestResult | Promise<NormalizeRequestResult>;
  readonly plan: (params: PlanParams) => PlanResult | Promise<PlanResult>;
  readonly validate: (
    params: ValidateParams,
  ) => ValidationResult | Promise<ValidationResult>;
  readonly finalize: (
    params: FinalizeParams,
  ) => FinalizeResult | Promise<FinalizeResult>;
}

export interface LegacyBitcoinMessageDigestInput {
  readonly version: "1.0";
  /** Trusted Host request identity; never sourced from message params. */
  readonly requestId: string | number;
  readonly message: Readonly<{
    readonly encoding: "utf8" | "hex" | "base64";
    readonly data: string;
  }>;
}

/** Wallet-trusted deterministic computation; it never receives a claimed digest. */
export type LegacyBitcoinMessageDigest = (
  input: LegacyBitcoinMessageDigestInput,
) => string | undefined | Promise<string | undefined>;

export type TwsCapabilityIntent =
  | "tbc721.transfer"
  | "amm.swap"
  | "amm.mergeToken"
  | "tbc20Lp.transfer"
  | "tbc20Lp.lock"
  | "tbc20Lp.unlock"
  | "tbc20Lp.merge"
  | "tbc20Lp.burn"
  | "amm.addLiquidity"
  | "amm.removeLiquidity"
  | "tbc20.transfer"
  | "tbc20.merge"
  | "tbc20Stablecoin.transfer"
  | "tbc20Stablecoin.merge"
  | "tbc.transfer"
  | "tbc.maintenance.merge"
  | "tbc.collection.create"
  | "tbc.nft.mint"
  | "tbc.nft.transfer"
  | "tbc.ft.create"
  | "tbc.ft.transfer"
  | "tbc.ft.merge"
  | "tbc20-standard-create"
  | "tbc20-standard-transfer"
  | "tbc20-standard-merge"
  | "tbc20-stablecoin-create"
  | "tbc20-stablecoin-mint"
  | "tbc20-stablecoin-freeze"
  | "tbc20-stablecoin-unfreeze"
  | "tbc20-stablecoin-transfer"
  | "tbc20-stablecoin-merge"
  | "tbc20-lp-transfer"
  | "tbc20-lp-merge"
  | "tbc20-lp-lock"
  | "tbc20-lp-unlock"
  | "tbc-timelock-lock"
  | "tbc-timelock-unlock"
  | "tbc-htlc-lock"
  | "tbc-htlc-claim"
  | "tbc-htlc-refund"
  | "tbc-lop-create"
  | "tbc-lop-cancel"
  | "tbc-lop-match"
  | "tbc-amm-create"
  | "tbc-amm-add-liquidity"
  | "tbc-amm-remove-liquidity"
  | "tbc-amm-swap"
  | "tbc721-standard-create-collection"
  | "tbc721-standard-mint"
  | "tbc721-standard-batch-mint"
  | "tbc721-standard-transfer"
  | "tbc.stablecoin.transfer"
  | "tbc.stablecoin.merge"
  | "tbc.pool.create"
  | "tbc.pool.liquidity.add"
  | "tbc.pool.liquidity.remove"
  | "tbc.pool.liquidity.close"
  | "tbc.pool.ft.merge"
  | "tbc.pool.ftlp.merge"
  | "tbc.pool.ftlp.burn"
  | "tbc.pool.swap.exactTbcForToken"
  | "tbc.pool.swap.exactTokenForTbc";

export type TwsCapabilityProfile = "core" | "assets" | "defi";

export interface TwsCapabilityScope {
  readonly chainId: string;
  /** Omit for the chain-wide default; set for an exact trusted wallet account. */
  readonly accountId?: string;
  readonly intents: readonly TwsCapabilityIntent[];
  readonly profiles: readonly TwsCapabilityProfile[];
  readonly limits?: Readonly<{
    readonly workflowSteps: number;
    readonly transactionBundleSize: number;
  }>;
}

export interface TwsCapabilityConfiguration {
  readonly version: "1.0";
  readonly scopes: readonly TwsCapabilityScope[];
}

export interface TwsCoreDependencies {
  readonly transactionEngine?: TransactionEngine;
  readonly legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest;
  /** Trusted wallet-composition declaration; never sourced from a page request. */
  readonly capabilities?: TwsCapabilityConfiguration;
}

export const TWS_CAPABILITY_INTENTS = Object.freeze([
  "tbc721.transfer",
  "amm.swap", "amm.addLiquidity", "amm.removeLiquidity",
  "amm.mergeToken", "tbc20Lp.transfer", "tbc20Lp.lock", "tbc20Lp.unlock", "tbc20Lp.merge", "tbc20Lp.burn",
  "tbc20.transfer",
  "tbc20.merge",
  "tbc20Stablecoin.transfer",
  "tbc20Stablecoin.merge",
  "tbc.transfer",
  "tbc.maintenance.merge",
  "tbc.collection.create",
  "tbc.nft.transfer",
  "tbc.ft.transfer",
  "tbc.ft.merge",
  "tbc20-standard-create",
  "tbc20-standard-transfer",
  "tbc20-standard-merge",
  "tbc20-stablecoin-create",
  "tbc20-stablecoin-mint",
  "tbc20-stablecoin-freeze",
  "tbc20-stablecoin-unfreeze",
  "tbc20-stablecoin-transfer",
  "tbc20-stablecoin-merge",
  "tbc20-lp-transfer",
  "tbc20-lp-merge",
  "tbc20-lp-lock",
  "tbc20-lp-unlock",
  "tbc-timelock-lock",
  "tbc-timelock-unlock",
  "tbc-htlc-lock",
  "tbc-htlc-claim",
  "tbc-htlc-refund",
  "tbc-lop-create",
  "tbc-lop-cancel",
  "tbc-lop-match",
  "tbc-amm-create",
  "tbc-amm-add-liquidity",
  "tbc-amm-remove-liquidity",
  "tbc-amm-swap",
  "tbc721-standard-create-collection",
  "tbc721-standard-mint",
  "tbc721-standard-batch-mint",
  "tbc721-standard-transfer",
  "tbc.stablecoin.transfer",
  "tbc.stablecoin.merge",
  "tbc.pool.liquidity.add",
  "tbc.pool.liquidity.remove",
  "tbc.pool.liquidity.close",
  "tbc.pool.ft.merge",
  "tbc.pool.ftlp.merge",
  "tbc.pool.ftlp.burn",
  "tbc.pool.swap.exactTbcForToken",
  "tbc.pool.swap.exactTokenForTbc",
] as const satisfies readonly TwsCapabilityIntent[]);

const ASSET_PROFILE_INTENTS = Object.freeze([
  "tbc721-standard-create-collection",
  "tbc721-standard-mint",
  "tbc721.transfer",
  "tbc20-standard-create",
  "tbc20.transfer",
  "tbc20Stablecoin.transfer",
] as const satisfies readonly TwsCapabilityIntent[]);

const DEFI_PROFILE_INTENTS = Object.freeze([
  "tbc-amm-create",
  "amm.addLiquidity",
  "amm.removeLiquidity",
  "amm.swap",
] as const satisfies readonly TwsCapabilityIntent[]);

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && allowed.includes(key),
  );
}

export function normalizeCapabilityConfiguration(
  value: TwsCapabilityConfiguration | undefined,
): TwsCapabilityConfiguration | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value as unknown as Readonly<Record<string, unknown>>, ["version", "scopes"]) ||
    value.version !== "1.0" ||
    !Array.isArray(value.scopes) ||
    value.scopes.length === 0
  ) {
    throw new TypeError("Invalid wallet capability configuration");
  }
  const knownIntents = new Set<string>(TWS_CAPABILITY_INTENTS);
  const profileOrder = ["core", "assets", "defi"] as const;
  const seenScopes = new Set<string>();
  const scopes = value.scopes.map((scope) => {
    if (
      scope === null ||
      typeof scope !== "object" ||
      Array.isArray(scope) ||
      !exactKeys(scope as unknown as Readonly<Record<string, unknown>>, [
        "chainId",
        "accountId",
        "intents",
        "profiles",
        "limits",
      ]) ||
      typeof scope.chainId !== "string" ||
      !/^tbc:[a-z0-9_-]{1,32}$/u.test(scope.chainId) ||
      (scope.accountId !== undefined &&
        (typeof scope.accountId !== "string" ||
          !scope.accountId.startsWith(`${scope.chainId}:`) ||
          scope.accountId.length === scope.chainId.length + 1)) ||
      !Array.isArray(scope.intents) ||
      scope.intents.length === 0 ||
      new Set(scope.intents).size !== scope.intents.length ||
      scope.intents.some((intent: unknown) => typeof intent !== "string" || !knownIntents.has(intent)) ||
      !Array.isArray(scope.profiles) ||
      scope.profiles.length === 0 ||
      new Set(scope.profiles).size !== scope.profiles.length ||
      scope.profiles.some(
        (profile: unknown) =>
          typeof profile !== "string" ||
          !profileOrder.includes(profile as TwsCapabilityProfile),
      ) ||
      !scope.profiles.includes("core") ||
      (scope.profiles.includes("defi") && !scope.profiles.includes("assets"))
    ) {
      throw new TypeError("Invalid wallet capability scope");
    }
    const intentSet = new Set<string>(scope.intents);
    if (
      !intentSet.has("tbc.transfer") ||
      (scope.profiles.includes("assets") &&
        ASSET_PROFILE_INTENTS.some((intent) => !intentSet.has(intent))) ||
      (scope.profiles.includes("defi") &&
        DEFI_PROFILE_INTENTS.some((intent) => !intentSet.has(intent)))
    ) {
      throw new TypeError("Wallet capability profiles exceed their declared intents");
    }
    const limits = scope.limits ?? {
      workflowSteps: 5,
      transactionBundleSize: 32,
    };
    if (
      limits === null ||
      typeof limits !== "object" ||
      Array.isArray(limits) ||
      !exactKeys(limits as unknown as Readonly<Record<string, unknown>>, [
        "workflowSteps",
        "transactionBundleSize",
      ]) ||
      !Number.isInteger(limits.workflowSteps) ||
      limits.workflowSteps < 0 ||
      limits.workflowSteps > 5 ||
      !Number.isInteger(limits.transactionBundleSize) ||
      limits.transactionBundleSize < 1 ||
      limits.transactionBundleSize > 32
    ) {
      throw new TypeError("Invalid wallet capability limits");
    }
    const scopeKey = `${scope.chainId}\u0000${scope.accountId ?? ""}`;
    if (seenScopes.has(scopeKey)) {
      throw new TypeError("Duplicate wallet capability scope");
    }
    seenScopes.add(scopeKey);
    return Object.freeze({
      chainId: scope.chainId,
      ...(scope.accountId === undefined ? {} : { accountId: scope.accountId }),
      intents: Object.freeze(
        TWS_CAPABILITY_INTENTS.filter((intent) => intentSet.has(intent)),
      ),
      profiles: Object.freeze(
        profileOrder.filter((profile) => scope.profiles.includes(profile)),
      ),
      limits: Object.freeze({
        workflowSteps: limits.workflowSteps,
        transactionBundleSize: limits.transactionBundleSize,
      }),
    });
  });
  return Object.freeze({ version: "1.0", scopes: Object.freeze(scopes) });
}

const ENGINE_METHODS = Object.freeze([
  "finalize",
  "normalizeRequest",
  "plan",
  "validate",
] as const);

export function assertTransactionEngine(value: unknown): TransactionEngine {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TwsEngineError(
      "ENGINE_INTERFACE_INVALID",
      "transaction engine must implement the frozen four-method facade",
    );
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== ENGINE_METHODS.length ||
    [...(keys as string[])].sort().some((key, index) => key !== ENGINE_METHODS[index])
  ) {
    throw new TwsEngineError(
      "ENGINE_INTERFACE_INVALID",
      "transaction engine must expose only the frozen four-method facade; execute is forbidden",
    );
  }
  const descriptors = Object.fromEntries(
    ENGINE_METHODS.map((method) => [method, Reflect.getOwnPropertyDescriptor(value, method)]),
  ) as Record<(typeof ENGINE_METHODS)[number], PropertyDescriptor | undefined>;
  if (
    ENGINE_METHODS.some((method) => {
      const descriptor = descriptors[method];
      return (
        descriptor === undefined ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "function"
      );
    })
  ) {
    throw new TwsEngineError(
      "ENGINE_INTERFACE_INVALID",
      "transaction engine facade members must be own data-property functions",
    );
  }
  const target = value as TransactionEngine;
  const normalizeRequest = descriptors.normalizeRequest?.value as TransactionEngine["normalizeRequest"];
  const plan = descriptors.plan?.value as TransactionEngine["plan"];
  const validate = descriptors.validate?.value as TransactionEngine["validate"];
  const finalize = descriptors.finalize?.value as TransactionEngine["finalize"];
  return Object.freeze({
    normalizeRequest: (params: NormalizeRequestParams) =>
      Reflect.apply(normalizeRequest, target, [params]),
    plan: (params: PlanParams) => Reflect.apply(plan, target, [params]),
    validate: (params: ValidateParams) => Reflect.apply(validate, target, [params]),
    finalize: (params: FinalizeParams) => Reflect.apply(finalize, target, [params]),
  });
}

export async function invokeTransactionEngine(
  engine: TransactionEngine | undefined,
  method: keyof TransactionEngine,
  paramsValidator: TwsValidatorName,
  resultValidator: TwsValidatorName,
  params: unknown,
): Promise<unknown> {
  if (engine === undefined) {
    throw new TwsEngineError(
      "ENGINE_REQUIRED",
      "transaction method requires a Transaction Engine",
    );
  }
  try {
    assertValidTws(paramsValidator, params);
  } catch {
    throw new TwsEngineError(
      "ENGINE_INPUT_INVALID",
      `transaction engine ${method} input is invalid`,
    );
  }
  const result = await Reflect.apply(engine[method], engine, [params]);
  try {
    assertValidTws(resultValidator, result);
  } catch {
    throw new TwsEngineError(
      "ENGINE_RESULT_INVALID",
      `transaction engine ${method} result is invalid`,
    );
  }
  return result;
}
