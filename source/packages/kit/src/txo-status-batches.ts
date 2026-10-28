import type { TbcOfficialApiClient, TbcApiTxoStatusInput, TbcApiTxoStatusResult } from "./official-api.js";
import type { TbcRequestOptions } from "./network-transport.js";

const BATCH_SIZE = 25;
const CONCURRENCY = 4;
type BatchResult = PromiseSettledResult<Readonly<{
  requested: readonly TbcApiTxoStatusInput[];
  response: TbcApiTxoStatusResult;
}>>;

/** Private read-only batching. Callers retain their own validation/failure policy.
 * Reuses the supplied preparation-scoped API; no retries, cache or extra reads. */
export async function forEachTxoStatusBatch(
  api: Pick<TbcOfficialApiClient, "txoStatus">,
  txos: readonly TbcApiTxoStatusInput[],
  visit: (result: BatchResult) => void,
  options: TbcRequestOptions = { category: "asset-index" },
): Promise<void> {
  for (let offset = 0; offset < txos.length; offset += BATCH_SIZE * CONCURRENCY) {
    const batches: (readonly TbcApiTxoStatusInput[])[] = [];
    for (let start = offset; start < Math.min(offset + BATCH_SIZE * CONCURRENCY, txos.length); start += BATCH_SIZE) {
      batches.push(txos.slice(start, start + BATCH_SIZE));
    }
    // Drain the entire window before a caller can reject it, including
    // synchronous adapter failures. No sibling reads remain in the background.
    const results = await Promise.allSettled(batches.map(async requested => ({ requested,
      response: await api.txoStatus({ txos: requested }, options),
    })));
    for (const result of results) visit(result);
  }
}
