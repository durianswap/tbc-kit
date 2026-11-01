import { type TransactionRoleAccount } from "./internal/core/index.js";
import type { TbcAssociatedTransactionReviewer, TbcRawTransactionReviewer } from "./reviewed-transaction-types.js";
import type { TbcWalletPrivateNativeAdapters } from "./wallet-private-native.js";
import type { KitWalletOptions } from "./wallet-runtime.js";
import type { TbcKitWebViewVerifiedNavigation } from "./wallet-webview.js";
import type { TbcReviewedPolicyMaterial } from "./reviewed-transaction-types.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import { type TbcReviewedRoleSigner } from "./reviewed-role-executor.js";
type PlainRecord = Readonly<Record<string, unknown>>;
export type { TbcWalletPrivateNativeAdapters } from "./wallet-private-native.js";
export type TbcStandardWorkflowAccount = Readonly<{
    accountId: string;
    address: string;
    publicKey: string;
}>;
export type TbcStandardWorkflowAuthoritySnapshot = Readonly<{
    accountId: string;
    address: string;
    networkSourceIdentity: string;
    publicKey?: string;
    /** Current wallet-controlled additional accounts, never page metadata. */
    signingAccounts?: readonly TransactionRoleAccount[];
}>;
export interface TbcStandardWorkflowCapabilitiesOptions {
    /** Immutable native-verified WebView authority for this wallet session. */
    readonly navigation: TbcKitWebViewVerifiedNavigation;
    readonly chainId: `tbc:${string}`;
    readonly account: TbcStandardWorkflowAccount;
    /** Wallet-selected network identity; never take this value from page data. */
    readonly networkSourceIdentity: string;
    /** Wallet/platform state only; return null when session/navigation authority
     * is invalidated. Role execution also requires the current publicKey and
     * trusted signingAccounts, checked across asynchronous preparation/signing. */
    readonly readCurrentAuthority: () => Promise<TbcStandardWorkflowAuthoritySnapshot | null>;
    readonly rawReviewer: TbcRawTransactionReviewer;
    readonly associatedReviewer: TbcAssociatedTransactionReviewer;
    /** Reuse the same platform codec instance as the supplied reviewers. */
    readonly materialNative?: PoolMaterialNativeProviderInput;
    /** Required only for role-aware Reviewed signing; ordinary adapters are unchanged. */
    readonly reviewedRoleSigner?: TbcReviewedRoleSigner;
    /**
     * Returns wallet-private one-shot adapters for the exact account. The
     * implementation may close over SecureStore/native handles; key bytes are
     * deliberately absent from this interface.
     */
    readonly privateNative: TbcWalletPrivateNativeAdapters | ((accountId: string) => TbcWalletPrivateNativeAdapters | Promise<TbcWalletPrivateNativeAdapters>);
    /** Trusted wallet clock used only to bound the review artifact. */
    readonly now?: () => string;
}
export type TbcStandardWorkflowCapabilities = Readonly<{
    crypto: NonNullable<KitWalletOptions["crypto"]>;
    reviewedTransaction: NonNullable<KitWalletOptions["reviewedTransaction"]>;
    /** Wallet-private approval projection. Input must come from verified Host
     * evidence, not a DApp. Does not authorize signing or query chain data. */
    resolveReviewedSigningMaterial: (task: unknown) => Promise<Readonly<{
        format: "raw" | "associated";
        request: PlainRecord;
        policyMaterial: TbcReviewedPolicyMaterial;
    }>>;
}>;
/** Exact execution material for trusted native custody adapters, not a public
 * display projection. Associated templates can contain an HTLC claim preimage.
 * Keep this request in session memory only; never log/persist/display it. Use
 * the bound approval presentation for UI. Does not approve or sign. */
export declare function normalizeTbcReviewedTransactionMaterial(request: unknown): Readonly<{
    format: "raw" | "associated";
    request: Readonly<Record<string, unknown>>;
}>;
/**
 * Creates the reusable Standard reviewed-transaction and crypto Port adapters.
 *
 * This composer is independent of `KitWalletOptions.legacy`: a wallet may omit
 * or disable Legacy entirely. It adds no network read, approval or retry. The
 * injected reviewers perform the one trusted review; private callbacks are
 * invoked by the Host Port call after Core approval; Host persistence follows
 * the selected runtime policy, not this private execution capability.
 */
export declare function createTbcStandardWorkflowCapabilities(options: TbcStandardWorkflowCapabilitiesOptions): TbcStandardWorkflowCapabilities;
