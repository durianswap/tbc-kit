import { TbcApiError } from "./official-api.js";

type IndexedOutput = Readonly<{ txid: string; index?: string | number; vout?: string | number }>;
type Page<T> = Readonly<{ utxos: readonly T[]; next_cursor?: string }>;

/** One request on unpaged indexes. Follow only an explicit next_cursor, keeping
 * the caller's existing selection bound. No raw-parent reads or policy changes.
 * A target query is a single selection response: use the direct API method
 * for that case rather than treating its selection as a complete UTXO scan. */
export async function collectTbcUtxoPages<T extends IndexedOutput>(
  readPage: (after?: string) => Promise<Page<T>>,
  options: Readonly<{ maxRows: number; maxPages?: number }>,
): Promise<Readonly<{ utxos: readonly T[] }>> {
  const maxPages = options.maxPages ?? 16;
  if (!Number.isSafeInteger(options.maxRows) || options.maxRows < 1 || options.maxRows > 10_000 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 64) throw new TypeError("Invalid TBC UTXO page bounds");
  const seen = new Set<string>(), cursors = new Set<string>(), outputs: T[] = [];
  let after: string | undefined;
  for (let n = 0; n < maxPages; n++) {
    const page = await readPage(after), current = new Set<string>();
    if (!Array.isArray(page.utxos) || page.utxos.length > 10_000) throw new TbcApiError("INVALID_RESPONSE", "Invalid UTXO page");
    for (const row of page.utxos) {
      const index = row?.index ?? row?.vout;
      if (typeof row?.txid !== "string" || !/^[0-9a-f]{64}$/u.test(row.txid) ||
          (typeof index !== "string" && typeof index !== "number") || !/^(0|[1-9][0-9]*)$/u.test(String(index)) ||
          BigInt(index) > 0xffff_ffffn) throw new TbcApiError("INVALID_RESPONSE", "Invalid UTXO outpoint");
      const point = `${row.txid}:${index}`;
      if (current.has(point)) throw new TbcApiError("INVALID_RESPONSE", "Duplicate UTXO within a page");
      current.add(point);
      if (seen.has(point)) continue;
      seen.add(point); outputs.push(row);
      if (outputs.length > options.maxRows) throw new TbcApiError("INVALID_RESPONSE", "UTXO selection bound exceeded");
    }
    const next = page.next_cursor;
    if (next === undefined || next === "") return Object.freeze({ utxos: Object.freeze(outputs) });
    if (typeof next !== "string" || next.length > 2048 || cursors.has(next)) throw new TbcApiError("INVALID_RESPONSE", "Invalid or repeated UTXO cursor");
    cursors.add(next); after = next;
  }
  throw new TbcApiError("INVALID_RESPONSE", "UTXO page bound exceeded");
}
