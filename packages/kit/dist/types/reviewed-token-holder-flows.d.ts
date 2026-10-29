import { type parseTbcTransaction } from "./testnet-validation.js";
import { type ReviewedTokenCode } from "./reviewed-token.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TbcOfficialApiClient, TbcApiTxoStatus } from "./official-api.js";
import type { TbcVerifiedTransactionInput } from "./reviewed-transaction-types.js";
type Point = Readonly<{
    txid: string;
    vout: number;
}>;
type Row = Readonly<{
    index: number;
    txid: string;
    transaction: ReturnType<typeof parseTbcTransaction>;
    inputs: readonly TbcVerifiedTransactionInput[];
    associatedInputs?: readonly Readonly<Record<string, unknown>>[];
    signingPublicKeys?: readonly (string | null)[];
}>;
/** Address-held current Token/Coin and authenticated Coin administrator updates,
 * not administrative issuance or arbitrary holder covenant execution.
 * Reuses the dispatcher's exact Code inspection.
 * Only selected sibling Tapes and authenticated per-identity labels are read.
 * Returned evidence is not ancestry/consensus verification or chain maturity. */
export declare function reviewCurrentTokenHolderFlows(options: Readonly<{
    rows: readonly Row[];
    codes: ReadonlyMap<string, ReviewedTokenCode | null>;
    native: PoolMaterialNativeProviderInput;
    api: TbcOfficialApiClient;
    addressVersion: number;
    accountAddress: string;
    administratorPublicKey?: string;
    readStatuses: (points: readonly Point[]) => Promise<ReadonlyMap<string, TbcApiTxoStatus>>;
}>): Promise<ReadonlyMap<number, Readonly<Record<string, unknown>>>>;
export {};
//# sourceMappingURL=reviewed-token-holder-flows.d.ts.map