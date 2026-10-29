import { inspectReviewedHtlc, type HtlcReviewRow } from "./reviewed-htlc-flows.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TbcOfficialApiClient, TbcApiTxoStatus } from "./official-api.js";
type Material = NonNullable<ReturnType<typeof inspectReviewedHtlc>>;
type Point = Readonly<{
    txid: string;
    vout: number;
}>;
/** Shared unsigned raw review. Exact templates and selected sibling Tapes are
 * reused; this does not execute witnesses, authenticate ancestry or prove chain
 * maturity. Associated secret-bearing templates are rejected upstream. */
export declare function reviewHtlcTokenFlows(rows: readonly Readonly<{
    row: HtlcReviewRow;
    material: Material;
}>[], options: Readonly<{
    native: PoolMaterialNativeProviderInput;
    api: TbcOfficialApiClient;
    addressVersion: number;
    readStatuses: (points: readonly Point[]) => Promise<ReadonlyMap<string, TbcApiTxoStatus>>;
}>): Promise<ReadonlyMap<number, Readonly<Record<string, unknown>>>>;
export {};
//# sourceMappingURL=reviewed-htlc-token-flows.d.ts.map