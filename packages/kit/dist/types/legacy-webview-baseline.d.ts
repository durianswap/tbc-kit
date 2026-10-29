export declare const LEGACY_BASELINE_A_METHODS: readonly ["connect", "disconnect", "isConnected", "getPubKey", "getAddress", "getNetwork", "getInfo"];
export type LegacyBaselineAMethod = (typeof LEGACY_BASELINE_A_METHODS)[number];
export interface LegacyMappingContext {
    readonly chainId: string;
    readonly address?: string;
    readonly platform?: "ios" | "android";
    readonly walletVersion?: string;
}
export interface LegacyBaselineARequest {
    readonly method: LegacyBaselineAMethod;
    readonly params: unknown;
    readonly chainId: string;
    readonly address?: string;
}
export type CanonicalBaselineARequest = Readonly<{
    method: "wallet_requestPermissions" | "tbc_disconnect" | "tbc_accounts" | "tbc_getAccount" | "tbc_chainId";
    params: readonly [] | Readonly<{
        address: string;
    }> | readonly [
        Readonly<{
            tbc_accounts: Readonly<{
                chains: readonly string[];
                maxAccounts: 1;
            }>;
            tbc_accountMetadata: Readonly<{
                chains: readonly string[];
            }>;
            tbc_signTransaction: Readonly<{
                chains: readonly string[];
            }>;
            tbc_signWorkflow: Readonly<{
                chains: readonly string[];
            }>;
            tbc_signMessage: Readonly<{
                chains: readonly string[];
            }>;
        }>
    ];
}>;
export declare function mapLegacyRequest(input: LegacyBaselineARequest): CanonicalBaselineARequest | undefined;
export declare function mapLegacyResult(method: LegacyBaselineAMethod, result: unknown, context: LegacyMappingContext): unknown;
//# sourceMappingURL=legacy-webview-baseline.d.ts.map