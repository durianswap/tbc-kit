import type { FinalizeParams, FinalizeResult, NormalizeRequestParams, NormalizeRequestResult, PlanParams, PlanResult, ValidateParams, ValidationResult } from "./protocol-types.js";
import { type TwsValidatorName } from "./validation.js";
export interface TransactionEngine {
    readonly normalizeRequest: (params: NormalizeRequestParams) => NormalizeRequestResult | Promise<NormalizeRequestResult>;
    readonly plan: (params: PlanParams) => PlanResult | Promise<PlanResult>;
    readonly validate: (params: ValidateParams) => ValidationResult | Promise<ValidationResult>;
    readonly finalize: (params: FinalizeParams) => FinalizeResult | Promise<FinalizeResult>;
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
export type LegacyBitcoinMessageDigest = (input: LegacyBitcoinMessageDigestInput) => string | undefined | Promise<string | undefined>;
export type TwsCapabilityIntent = "tbc721.transfer" | "tbc721.batchTransfer" | "amm.swap" | "amm.mergeToken" | "tbc20Lp.transfer" | "tbc20Lp.lock" | "tbc20Lp.unlock" | "tbc20Lp.merge" | "tbc20Lp.burn" | "amm.addLiquidity" | "amm.removeLiquidity" | "tbc20.transfer" | "tbc20.merge" | "tbc20Stablecoin.transfer" | "tbc20Stablecoin.merge" | "tbc.transfer" | "tbc.maintenance.merge" | "tbc.collection.create" | "tbc.nft.mint" | "tbc.nft.transfer" | "tbc.ft.create" | "tbc.ft.transfer" | "tbc.ft.merge" | "tbc20-standard-create" | "tbc20-standard-transfer" | "tbc20-standard-merge" | "tbc20-stablecoin-create" | "tbc20-stablecoin-mint" | "tbc20-stablecoin-freeze" | "tbc20-stablecoin-unfreeze" | "tbc20-stablecoin-transfer" | "tbc20-stablecoin-merge" | "tbc20-lp-transfer" | "tbc20-lp-merge" | "tbc20-lp-lock" | "tbc20-lp-unlock" | "tbc-timelock-lock" | "tbc-timelock-unlock" | "tbc-htlc-lock" | "tbc-htlc-claim" | "tbc-htlc-refund" | "tbc-lop-create" | "tbc-lop-cancel" | "tbc-lop-match" | "tbc-amm-create" | "tbc-amm-add-liquidity" | "tbc-amm-remove-liquidity" | "tbc-amm-swap" | "tbc721-standard-create-collection" | "tbc721-standard-mint" | "tbc721-standard-batch-mint" | "tbc721-standard-transfer" | "tbc.stablecoin.transfer" | "tbc.stablecoin.merge" | "tbc.pool.create" | "tbc.pool.liquidity.add" | "tbc.pool.liquidity.remove" | "tbc.pool.liquidity.close" | "tbc.pool.ft.merge" | "tbc.pool.ftlp.merge" | "tbc.pool.ftlp.burn" | "tbc.pool.swap.exactTbcForToken" | "tbc.pool.swap.exactTokenForTbc";
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
export declare const TWS_CAPABILITY_INTENTS: readonly ["tbc721.transfer", "tbc721.batchTransfer", "amm.swap", "amm.addLiquidity", "amm.removeLiquidity", "amm.mergeToken", "tbc20Lp.transfer", "tbc20Lp.lock", "tbc20Lp.unlock", "tbc20Lp.merge", "tbc20Lp.burn", "tbc20.transfer", "tbc20.merge", "tbc20Stablecoin.transfer", "tbc20Stablecoin.merge", "tbc.transfer", "tbc.maintenance.merge", "tbc.collection.create", "tbc.nft.transfer", "tbc.ft.transfer", "tbc.ft.merge", "tbc20-standard-create", "tbc20-standard-transfer", "tbc20-standard-merge", "tbc20-stablecoin-create", "tbc20-stablecoin-mint", "tbc20-stablecoin-freeze", "tbc20-stablecoin-unfreeze", "tbc20-stablecoin-transfer", "tbc20-stablecoin-merge", "tbc20-lp-transfer", "tbc20-lp-merge", "tbc20-lp-lock", "tbc20-lp-unlock", "tbc-timelock-lock", "tbc-timelock-unlock", "tbc-htlc-lock", "tbc-htlc-claim", "tbc-htlc-refund", "tbc-lop-create", "tbc-lop-cancel", "tbc-lop-match", "tbc-amm-create", "tbc-amm-add-liquidity", "tbc-amm-remove-liquidity", "tbc-amm-swap", "tbc721-standard-create-collection", "tbc721-standard-mint", "tbc721-standard-batch-mint", "tbc721-standard-transfer", "tbc.stablecoin.transfer", "tbc.stablecoin.merge", "tbc.pool.liquidity.add", "tbc.pool.liquidity.remove", "tbc.pool.liquidity.close", "tbc.pool.ft.merge", "tbc.pool.ftlp.merge", "tbc.pool.ftlp.burn", "tbc.pool.swap.exactTbcForToken", "tbc.pool.swap.exactTokenForTbc"];
export declare function normalizeCapabilityConfiguration(value: TwsCapabilityConfiguration | undefined): TwsCapabilityConfiguration | undefined;
export declare function assertTransactionEngine(value: unknown): TransactionEngine;
export declare function invokeTransactionEngine(engine: TransactionEngine | undefined, method: keyof TransactionEngine, paramsValidator: TwsValidatorName, resultValidator: TwsValidatorName, params: unknown): Promise<unknown>;
//# sourceMappingURL=engine.d.ts.map