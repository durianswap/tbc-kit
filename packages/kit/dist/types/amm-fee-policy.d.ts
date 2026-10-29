import type { AmmFeePolicy } from "./public-types.js";
/** Pure configuration validation, shared by creation helpers and presentation.
 * Does not quote, read an index, or override an existing pool's chain config. */
export declare function normalizeAmmFeePolicy(value: unknown): AmmFeePolicy;
/** Display data only. Values remain part of the bound request; approval and
 * Engine still validate the complete plan, including continuation stages. */
export declare function describeAmmFeePolicy(value: unknown): Readonly<{
    feePolicy: Readonly<{
        lpFeeRate: number;
        taxFeeRate: number;
        serviceProviderFeeRate: number;
        protocolFeeRate: number;
        feeAddress: string;
    }>;
    totalFeeBps: number;
    lpFeeBps: number;
    nonLpFeeBps: number;
    feeAddress: string;
}>;
//# sourceMappingURL=amm-fee-policy.d.ts.map