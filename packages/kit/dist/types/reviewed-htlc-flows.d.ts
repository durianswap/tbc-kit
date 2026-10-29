import { type parseTbcTransaction } from "./testnet-validation.js";
import type { TbcVerifiedTransactionInput } from "./reviewed-transaction-types.js";
export type HtlcReviewRow = Readonly<{
    index: number;
    txid: string;
    transaction: ReturnType<typeof parseTbcTransaction>;
    inputs: readonly TbcVerifiedTransactionInput[];
}>;
export type HtlcReviewOptions = Readonly<{
    addressVersion: number;
    accountAddress: string;
    associated: boolean;
    /** Ephemeral exact request row; never copy into the public review. */
    associatedInputs?: readonly Readonly<Record<string, unknown>>[];
}>;
/** Public native HTLC terms only, using prevouts already authenticated by the
 * shared reviewer. No fetch, VM or maturity claim.
 * Detached raw signing cannot determine which branch a later witness selects.
 * Associated input witnesses are checked locally; only public terms escape.
 */
export declare function inspectReviewedHtlc(row: HtlcReviewRow, options: HtlcReviewOptions): {
    sides: readonly [{
        script: string;
        amount: bigint;
    }[], {
        script: string;
        amount: bigint;
    }[]];
    codes: (Readonly<{
        hashlock: string;
        receiverHash: string;
        senderHash: string;
        lockTime: number;
    }> | undefined)[][];
    htlcLocks: readonly Readonly<Record<string, unknown>>[];
    fee: bigint;
} | undefined;
export declare function reviewNativeHtlcFlow(row: HtlcReviewRow, options: HtlcReviewOptions, material?: {
    sides: readonly [{
        script: string;
        amount: bigint;
    }[], {
        script: string;
        amount: bigint;
    }[]];
    codes: (Readonly<{
        hashlock: string;
        receiverHash: string;
        senderHash: string;
        lockTime: number;
    }> | undefined)[][];
    htlcLocks: readonly Readonly<Record<string, unknown>>[];
    fee: bigint;
} | undefined): Readonly<Record<string, unknown>> | undefined;
//# sourceMappingURL=reviewed-htlc-flows.d.ts.map