import type { HtlcReviewRow } from "./reviewed-htlc-flows.js";
/** Exact public height-lock terms from already authenticated prevouts. No
 * node-tip read: transaction lock conditions are not a chain-maturity proof. */
export declare function reviewNativeTimelockFlow(row: HtlcReviewRow, options: Readonly<{
    addressVersion: number;
    accountAddress: string;
}>): Readonly<Record<string, unknown>> | undefined;
//# sourceMappingURL=reviewed-timelock-flows.d.ts.map