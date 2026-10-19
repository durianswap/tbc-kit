import { type parseTbcTransaction } from "./testnet-validation.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { createTbcOfficialApi, TbcApiTxoStatus } from "./official-api.js";
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
/** Dispatch exact current Token material to holder or LOP flow review.
 * Not a consensus verifier or blind-sign fallback.
 * Inputs are already exact-checked against the configured trusted node. Only
 * missing adjacent tapes and per-asset official metadata are queried, batched
 * and deduplicated for this review. No fee-parent fetch, issuance history walk,
 * signing, broadcast, permanent cache or database. */
export declare function reviewCurrentTokenFlows(options: Readonly<{
    rows: readonly Row[];
    native: PoolMaterialNativeProviderInput;
    api: ReturnType<typeof createTbcOfficialApi>;
    addressVersion: number;
    /** Associated holders additionally require exact profiles and shared proof preflight. */
    holderAccountAddress?: string;
    administratorPublicKey?: string;
    readStatuses: (points: readonly Point[]) => Promise<ReadonlyMap<string, TbcApiTxoStatus>>;
}>): Promise<ReadonlyMap<number, Readonly<Record<string, unknown>>>>;
export {};
