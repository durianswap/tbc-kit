type IndexedOutput = Readonly<{
    txid: string;
    index?: string | number;
    vout?: string | number;
}>;
type Page<T> = Readonly<{
    utxos: readonly T[];
    next_cursor?: string;
}>;
/** One request on unpaged indexes. Follow only an explicit next_cursor, keeping
 * the caller's existing selection bound. No raw-parent reads or policy changes.
 * A target query is a single selection response: use the direct API method
 * for that case rather than treating its selection as a complete UTXO scan. */
export declare function collectTbcUtxoPages<T extends IndexedOutput>(readPage: (after?: string) => Promise<Page<T>>, options: Readonly<{
    maxRows: number;
    maxPages?: number;
}>): Promise<Readonly<{
    utxos: readonly T[];
}>>;
export {};
