type Point = Readonly<{ txid: string; vout: number }>;
const UINT = /^(0|[1-9][0-9]*)$/u;

/** A caller-selected zero token output is not permission to replace its input. */
export class SelectedZeroBalanceInputError extends Error {
  readonly reason = "SELECTED_ZERO_BALANCE_INPUT";
  constructor() { super("An explicitly selected token input has zero balance"); }
}

/** Holder selection only, never Pool reserve/state selection. Validate index
 * amounts and duplicates before skipping zero balances; do not download their
 * parents or count them against a spend/confirmation-discovery budget. Exact
 * selections fail explicitly instead of silently dropping a requested input.
 */
export function positiveHolderCandidates<T extends Point>(
  rows: readonly T[], amountOf: (row: T) => unknown, requested?: readonly Point[],
): readonly T[] {
  const seen = new Set<string>();
  const selected = requested === undefined ? undefined : new Set(requested.map(p => `${p.txid}:${p.vout}`));
  const result: T[] = [];
  for (const row of rows) {
    const key = `${row.txid}:${row.vout}`, amount = amountOf(row);
    if (seen.has(key)) throw new Error("Duplicate token index outpoint");
    seen.add(key);
    if (typeof amount !== "string" || !UINT.test(amount)) throw new Error("Invalid token index amount");
    if (amount === "0") {
      if (selected?.has(key)) throw new SelectedZeroBalanceInputError();
      continue;
    }
    result.push(row);
  }
  return result;
}
