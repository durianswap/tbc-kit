import { type ReviewedTokenCode } from "./reviewed-token.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TbcOfficialApiClient } from "./official-api.js";
export type ReviewedTokenAsset = Readonly<{
    type: "ft" | "stablecoin";
    symbol: string;
    contractId: string;
}>;
/** Indexed labels are not identity proof. Match full exact Code identity before
 * accepting a contract ID. One request per distinct identity; no ancestry scan. */
export declare function authenticateReviewedTokenAssets(native: PoolMaterialNativeProviderInput, api: TbcOfficialApiClient, requests: readonly Readonly<{
    code: ReviewedTokenCode;
    contractId: string;
}>[]): Promise<ReadonlyMap<string, ReviewedTokenAsset>>;
/** Raw HTLC has no contract-ID commitment. Obtain only an indexed hint for a
 * selected Token prevout, then authenticate it using the same full Code check
 * as LOP. Decoder balances/decimals/labels are deliberately not consumed. */
export declare function discoverReviewedTokenAssets(native: PoolMaterialNativeProviderInput, api: TbcOfficialApiClient, inputs: readonly Readonly<{
    code: ReviewedTokenCode;
    txid: string;
    vout: number;
}>[]): Promise<ReadonlyMap<string, ReviewedTokenAsset>>;
