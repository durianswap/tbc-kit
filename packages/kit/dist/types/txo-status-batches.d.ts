import type { TbcOfficialApiClient, TbcApiTxoStatusInput, TbcApiTxoStatusResult } from "./official-api.js";
import type { TbcRequestOptions } from "./network-transport.js";
type BatchResult = PromiseSettledResult<Readonly<{
    requested: readonly TbcApiTxoStatusInput[];
    response: TbcApiTxoStatusResult;
}>>;
/** Private read-only batching. Callers retain their own validation/failure policy.
 * Reuses the supplied preparation-scoped API; no retries, cache or extra reads. */
export declare function forEachTxoStatusBatch(api: Pick<TbcOfficialApiClient, "txoStatus">, txos: readonly TbcApiTxoStatusInput[], visit: (result: BatchResult) => void, options?: TbcRequestOptions): Promise<void>;
export {};
