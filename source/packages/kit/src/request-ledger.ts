export type KitRequestCategory =
  | "rpc"
  | "api"
  | "tip"
  | "native-index"
  | "asset-index"
  | "pool"
  | "txraw"
  | "decode"
  | "broadcast"
  | "other";

export interface KitRequestLedgerEntry {
  readonly id: number;
  readonly category: KitRequestCategory;
  readonly key: string;
  readonly concurrencyGroup?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly durationMs?: number;
  readonly responseBytes?: number;
  readonly status: "pending" | "fulfilled" | "rejected" | "deduplicated";
}

export interface KitRequestLedgerSnapshot {
  readonly requests: readonly KitRequestLedgerEntry[];
  readonly counts: Readonly<Record<KitRequestCategory, number>>;
  readonly deduplicated: number;
  readonly responseBytes: number;
}

export interface KitRequestLedger {
  readonly run: <T>(input: Readonly<{
    category: KitRequestCategory;
    key: string;
    concurrencyGroup?: string;
    /** Private identity scope, excluded from observation. */
    scope?: object;
    deduplicate?: boolean;
    signal?: AbortSignal;
    responseBytes?: (value: T) => number | undefined;
    execute: (signal: AbortSignal) => Promise<T>;
  }>) => Promise<T>;
  readonly snapshot: () => KitRequestLedgerSnapshot;
  readonly clear: () => void;
}

const CATEGORIES: readonly KitRequestCategory[] = Object.freeze([
  "rpc",
  "api",
  "tip",
  "native-index",
  "asset-index",
  "pool",
  "txraw",
  "decode",
  "broadcast",
  "other",
]);

export function createRequestLedger(options: Readonly<{
  enabled?: boolean;
  now?: () => number;
}> = {}): KitRequestLedger {
  const enabled = options.enabled === true;
  const now = options.now ?? Date.now;
  const entries: KitRequestLedgerEntry[] = [];
  type Flight = {
    promise?: Promise<unknown>;
    controller: AbortController;
    subscribers: number;
    settled: boolean;
  };
  const inFlight = new Map<string | symbol, Flight>();
  const scopedFlights = new WeakMap<object, Map<string | symbol, Flight>>();
  let pendingCount = 0;
  let nextId = 1;

  function subscribe<T>(flight: Flight, signal: AbortSignal | undefined, remove: () => void): Promise<T> {
    flight.subscribers += 1;
    // An uncancellable subscriber keeps the flight alive until it settles;
    // it needs no listener or extra wrapper promise on the common path.
    if (signal === undefined) return flight.promise! as Promise<T>;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return false;
        done = true;
        signal?.removeEventListener("abort", abort);
        flight.subscribers -= 1;
        return true;
      };
      const abort = () => {
        if (!finish()) return;
        const reason = signal?.reason ?? new Error("TBC request was aborted");
        reject(reason);
        if (flight.subscribers === 0 && !flight.settled) {
          remove();
          flight.controller.abort(reason);
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      flight.promise!.then(
        (value) => { if (finish()) resolve(value as T); },
        (error: unknown) => { if (finish()) reject(error); },
      );
      if (signal?.aborted) abort();
    });
  }

  async function run<T>(input: Readonly<{
    category: KitRequestCategory;
    key: string;
    concurrencyGroup?: string;
    scope?: object;
    deduplicate?: boolean;
    signal?: AbortSignal;
    responseBytes?: (value: T) => number | undefined;
    execute: (signal: AbortSignal) => Promise<T>;
  }>): Promise<T> {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("TBC request was aborted");
    let flights = input.scope === undefined ? inFlight : scopedFlights.get(input.scope);
    if (flights === undefined) {
      flights = new Map();
      scopedFlights.set(input.scope!, flights);
    }
    const identity = input.deduplicate === false ? Symbol() : `${input.category}\u0000${input.key}`;
    const shared = flights.get(identity);
    if (shared !== undefined) {
      if (enabled) {
        const stamp = now();
        entries.push(Object.freeze({
          id: nextId++,
          category: input.category,
          key: input.key,
          ...(input.concurrencyGroup === undefined
            ? {}
            : { concurrencyGroup: input.concurrencyGroup }),
          startedAt: stamp,
          finishedAt: stamp,
          durationMs: 0,
          status: "deduplicated" as const,
        }));
      }
      return subscribe<T>(shared, input.signal, () => {
        if (flights.get(identity) === shared) flights.delete(identity);
      });
    }
    const id = nextId++;
    const startedAt = now();
    let entryIndex = -1;
    if (enabled) {
      entryIndex = entries.length;
      entries.push(Object.freeze({
        id,
        category: input.category,
        key: input.key,
        ...(input.concurrencyGroup === undefined
          ? {}
          : { concurrencyGroup: input.concurrencyGroup }),
        startedAt,
        status: "pending" as const,
      }));
    }
    const controller = new AbortController();
    const flight: Flight = { controller, subscribers: 0, settled: false };
    pendingCount += 1;
    // Calling execute here preserves same-turn start for independent reads.
    flight.promise = execute();
    if (!flight.settled) flights.set(identity, flight);
    return subscribe<T>(flight, input.signal, () => {
      if (flights.get(identity) === flight) flights.delete(identity);
    });

    async function execute(): Promise<T> {
      try {
        const value = await input.execute(controller.signal);
        if (enabled) {
          const finishedAt = now();
          const responseBytes = input.responseBytes?.(value);
          entries[entryIndex] = Object.freeze({
            id,
            category: input.category,
            key: input.key,
            ...(input.concurrencyGroup === undefined
              ? {}
              : { concurrencyGroup: input.concurrencyGroup }),
            startedAt,
            finishedAt,
            durationMs: Math.max(0, finishedAt - startedAt),
            ...(responseBytes === undefined ? {} : { responseBytes }),
            status: "fulfilled" as const,
          });
        }
        return value;
      } catch (error) {
        if (enabled) {
          const finishedAt = now();
          entries[entryIndex] = Object.freeze({
            id,
            category: input.category,
            key: input.key,
            ...(input.concurrencyGroup === undefined
              ? {}
              : { concurrencyGroup: input.concurrencyGroup }),
            startedAt,
            finishedAt,
            durationMs: Math.max(0, finishedAt - startedAt),
            status: "rejected" as const,
          });
        }
        throw error;
      } finally {
        flight.settled = true;
        pendingCount -= 1;
        if (flights!.get(identity) === flight) flights!.delete(identity);
      }
    }
  }

  return Object.freeze({
    run,
    snapshot() {
      const counts = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<KitRequestCategory, number>;
      let deduplicated = 0;
      let responseBytes = 0;
      for (const entry of entries) {
        if (entry.status === "deduplicated") deduplicated += 1;
        else counts[entry.category] += 1;
        responseBytes += entry.responseBytes ?? 0;
      }
      return Object.freeze({
        requests: Object.freeze([...entries]),
        counts: Object.freeze(counts),
        deduplicated,
        responseBytes,
      });
    },
    clear() {
      if (pendingCount !== 0) throw new Error("Cannot clear a request ledger while requests are active");
      entries.length = 0;
      nextId = 1;
    },
  });
}
