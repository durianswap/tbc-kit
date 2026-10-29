import type { TbcTransportCloseReason } from "./provider-transport.js";
import type { TbcKitWebViewNativeHandlers, TbcKitWebViewVerifiedNavigation } from "./wallet-webview.js";
import { type LegacyStandardWorkflowBatchAdapter, type LegacyStandardWorkflowBatchOptions } from "./legacy-standard-workflow.js";
import { type LegacyTbcBalanceReader } from "./legacy-generic-capabilities.js";
import { type LegacyFtCreateIntentResolver } from "./legacy-ft-create-intent.js";
import type { LegacyFtTransferIntentResolver } from "./legacy-ft-transfer-intent.js";
import { type LegacyStablecoinTransferIntentResolver } from "./legacy-stablecoin-intent.js";
import { type LegacyPoolIntentResolver } from "./legacy-pool-intent.js";
import { type TbcNetworkContext } from "./network-context.js";
import { type LegacyMethod } from "./legacy-webview-protocol.js";
import type { TbcMultiRoundMergeAsset, TbcMultiRoundMergeLimits } from "./multi-round-merge.js";
export interface TbcKitLegacyBitcoinMessageInput {
    readonly message: string;
    readonly encoding: "utf8" | "hex" | "base64";
}
export interface TbcKitPreparedLegacyBitcoinMessage extends TbcKitLegacyBitcoinMessageInput {
    readonly digest: string;
}
export interface TbcKitLegacyBitcoinMessagePreparer {
    /** Wallet-trusted digest preparation backed by the installed native module. */
    readonly prepare: (input: TbcKitLegacyBitcoinMessageInput) => Promise<TbcKitPreparedLegacyBitcoinMessage>;
}
export interface TbcKitLegacyTransactionContext {
    readonly address: string;
    readonly permissions: readonly unknown[];
    /** Required when the controller is bound to a unified network context. */
    readonly networkSourceIdentity?: string;
}
export type TbcKitLegacyTransactionContextReader = (navigation: TbcKitWebViewVerifiedNavigation) => Promise<TbcKitLegacyTransactionContext | null>;
export interface TbcKitLegacyTransactionOptions {
    /** Canonical FT-create mapping; Host/Engine still construct and submit. */
    readonly ftCreateIntents?: LegacyFtCreateIntentResolver;
    /** Canonical FT-transfer mapping used by the Standard preparation path. */
    readonly ftTransferIntents?: LegacyFtTransferIntentResolver;
    /** Canonical Stablecoin transfer mapping; no network or persistence authority. */
    readonly stablecoinTransferIntents?: LegacyStablecoinTransferIntentResolver;
    /** Canonical Pool create/swap/liquidity mapping; no signing authority. */
    readonly poolIntents?: LegacyPoolIntentResolver;
    /** Optional wallet-private fast path for the current account and grants. */
    readonly readTransactionContext?: TbcKitLegacyTransactionContextReader;
    readonly onBatchProgress?: (progress: Readonly<{
        completed: 0 | 1 | 2;
        total: 2;
        stage: "signing" | "finalizing";
    }>) => void;
}
export type TbcKitLegacyMergeMethod = "mergeUtxos" | "mergeFtUtxos" | "mergeStableCoinUtxos";
export type TbcKitLegacyMergeAsset = Extract<TbcMultiRoundMergeAsset, Readonly<{
    kind: "tbc" | "ft" | "stablecoin";
}>>;
export interface TbcKitLegacyMultiRoundMergeOptions {
    /**
     * Wallet-owned bounded policy for a historical all-to-one alias. Kit fixes
     * the target to one UTXO and delegates execution to tbc_runMultiRoundMerge.
     */
    readonly createLimits: (input: Readonly<{
        method: TbcKitLegacyMergeMethod;
        asset: TbcKitLegacyMergeAsset;
        navigation: TbcKitWebViewVerifiedNavigation;
    }>) => Omit<TbcMultiRoundMergeLimits, "targetUtxoCount"> | Promise<Omit<TbcMultiRoundMergeLimits, "targetUtxoCount">>;
}
export interface TbcKitLegacyWebViewNativeOptions {
    /** Native-verified, top-frame navigation. Never derive this from page JSON. */
    readonly navigation: TbcKitWebViewVerifiedNavigation;
    readonly chainId: string;
    /** Immutable endpoint/source binding. Network switches create a new controller. */
    readonly network?: TbcNetworkContext;
    readonly platform: "ios" | "android";
    readonly walletVersion: string;
    /** Partner policy: reject historical asset creation before Host dispatch. */
    readonly allowHistoricalAssetCreation?: boolean;
    /** Wallet-owned Host/session dispatch and delivery acknowledgment. */
    readonly handlers: TbcKitWebViewNativeHandlers;
    readonly bitcoinMessages?: TbcKitLegacyBitcoinMessagePreparer;
    /** Maps historical 1-5 batches and standalone secure methods into fully reviewed Standard workflows. */
    readonly genericBatch?: LegacyStandardWorkflowBatchAdapter;
    /** TBC-only read bound to the same immutable network context. */
    readonly balances?: Pick<LegacyTbcBalanceReader, "chainId" | "networkSourceIdentity" | "read">;
    /** Shared transaction orchestration for FT create and Pool business flows. */
    readonly transactions?: TbcKitLegacyTransactionOptions;
    /** Historical merge aliases mapped into the shared bounded public coordinator. */
    readonly multiRoundMerge?: TbcKitLegacyMultiRoundMergeOptions;
    /** Wallet-owned platform string channel post operation. */
    readonly post: (serialized: string) => void | Promise<void>;
}
export interface TbcKitLegacyWebViewNativeController {
    readonly initialize: () => void;
    /** Routes Kit-owned Baseline, message and configured business requests. */
    readonly supportsRequest: (method: LegacyMethod, params: unknown) => boolean;
    readonly acceptPageMessage: (serialized: string) => Promise<void>;
    readonly close: (reason?: TbcTransportCloseReason) => Promise<void>;
}
/** One Kit-owned mapper for historical sign-only batch transaction steps. */
export declare function createTbcKitLegacyBatchSendResolver(options: Readonly<{
    chainId: string;
    transactions: TbcKitLegacyTransactionOptions;
}>): LegacyStandardWorkflowBatchOptions["resolveSendTransaction"];
/**
 * Creates the wallet-native half of the frozen window.Turing bridge for the
 * Baseline-A account/session surface, Bitcoin message signing and the optional
 * sign-only FT-transfer slice. Page data can select only a historical method;
 * this controller constructs every canonical Provider request and leaves
 * account, permission, approval, Host, Signer and platform authority injected.
 */
export declare function createTbcKitLegacyWebViewNativeController(options: TbcKitLegacyWebViewNativeOptions): TbcKitLegacyWebViewNativeController;
//# sourceMappingURL=legacy-webview-native.d.ts.map