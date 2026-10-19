import type { KitRequestLedger } from "./request-ledger.js";

export interface ImmutableTransactionBytes {
  readonly txid: string;
  readonly rawTransaction: string;
}

export interface ImmutableTransactionCache {
  readonly get: (txid: string) => ImmutableTransactionBytes | undefined;
  readonly remember: (value: ImmutableTransactionBytes) => void;
  readonly size: () => Readonly<{ entries: number; hexCharacters: number }>;
}

export function createImmutableTransactionCache(options: Readonly<{
  maxEntries?: number;
  maxHexCharacters?: number;
}> = {}): ImmutableTransactionCache {
  const maxEntries = options.maxEntries ?? 32;
  const maxHexCharacters = options.maxHexCharacters ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 256 || !Number.isSafeInteger(maxHexCharacters) || maxHexCharacters < 1024) {
    throw new TypeError("Invalid immutable transaction cache bounds");
  }
  const values = new Map<string, ImmutableTransactionBytes>();
  let retained = 0;
  function removeOldest() {
    const key = values.keys().next().value as string | undefined;
    if (key === undefined) return;
    retained -= values.get(key)!.rawTransaction.length;
    values.delete(key);
  }
  return Object.freeze({
    get(txid: string) {
      const value = values.get(txid);
      if (value === undefined) return undefined;
      values.delete(txid);
      values.set(txid, value);
      return value;
    },
    remember(value: ImmutableTransactionBytes) {
      if (!/^[0-9a-f]{64}$/u.test(value.txid) || !/^(?:[0-9a-f]{2})+$/u.test(value.rawTransaction)) {
        throw new TypeError("Invalid immutable transaction bytes");
      }
      if (value.rawTransaction.length > maxHexCharacters) return;
      const existing = values.get(value.txid);
      if (existing !== undefined && existing.rawTransaction !== value.rawTransaction) {
        throw new Error("Immutable transaction bytes conflict");
      }
      if (existing !== undefined) {
        values.delete(value.txid);
        values.set(value.txid, existing);
        return;
      }
      while (values.size >= maxEntries || retained + value.rawTransaction.length > maxHexCharacters) removeOldest();
      const frozen = Object.freeze({ txid: value.txid, rawTransaction: value.rawTransaction });
      values.set(value.txid, frozen);
      retained += value.rawTransaction.length;
    },
    size: () => Object.freeze({ entries: values.size, hexCharacters: retained }),
  });
}

export interface SelectedAncestryResult<TCandidate, TParent> {
  readonly selected: readonly TCandidate[];
  readonly parents: readonly TParent[];
}

export async function selectThenLoadAncestry<TCandidate, TParent>(options: Readonly<{
  candidates: readonly TCandidate[];
  select: (candidates: readonly TCandidate[]) => readonly TCandidate[];
  parentTxid: (candidate: TCandidate) => string;
  loadParent: (txid: string) => Promise<TParent>;
  ledger?: KitRequestLedger;
  concurrencyGroup?: string;
}>): Promise<SelectedAncestryResult<TCandidate, TParent>> {
  const selected = Object.freeze([...options.select(options.candidates)]);
  const txids = Object.freeze([...new Set(selected.map(options.parentTxid))]);
  const parents = await Promise.all(txids.map((txid) => {
    const execute = () => options.loadParent(txid);
    return options.ledger === undefined
      ? execute()
      : options.ledger.run({
          category: "txraw",
          key: txid,
          ...(options.concurrencyGroup === undefined ? {} : { concurrencyGroup: options.concurrencyGroup }),
          execute,
        });
  }));
  return Object.freeze({ selected, parents: Object.freeze(parents) });
}

export async function loadIndependentGroups<T extends Readonly<Record<string, () => Promise<unknown>>>>(
  groups: T,
): Promise<{ readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const entries = Object.entries(groups);
  const values = await Promise.all(entries.map(([, load]) => load()));
  return Object.freeze(Object.fromEntries(entries.map(([key], index) => [key, values[index]]))) as {
    readonly [K in keyof T]: Awaited<ReturnType<T[K]>>;
  };
}
