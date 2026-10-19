/** Pure quote over supplied, locally validated Pool transaction bytes. This
 * does not fetch, prove unspentness/ancestry, authorize or prepare a trade. */
export type TbcAmmQuoteAction =
  | Readonly<{ kind: "addTbc"; amount: string; initialFtAmount?: string }>
  | Readonly<{ kind: "addFt" | "buy" | "sell" | "remove"; amount: string }>;
export type TbcAmmQuoteInput = Readonly<{
  pool: Readonly<{ txid: string; rawTransaction: string }>;
  action: TbcAmmQuoteAction;
}>;
export type TbcAmmQuoteOptions = Readonly<{
  /** Reuse the application's existing Native or WASM keyless engine. */
  engine: Readonly<{ execute(operation: string, requestJson: string): Promise<string> }>;
}>;
export type TbcAmmQuoteState = Readonly<{
  ftLpAmount: string; ftAAmount: string; tbcAmount: string; poolValue: string;
}>;
export type TbcAmmQuoteFees = Readonly<{
  baseTbcSat: string; totalFeeSat: string; lpFeeSat: string;
  serviceFeeAccruedSat: string; serviceFeePaidSat: string;
  serviceFeeRetainedSat: string; poolFeeRetainedSat: string; netAmountSat: string;
}>;
type QuoteIdentity = Readonly<{
  standardId: "tbc-amm";
  basis: "local-pool-transaction";
  poolOutpoint: Readonly<{ txid: string; vout: 0 }>;
  templateRevision: string; poolCodeHash: string; ftContractId: string;
  feePolicy: Readonly<{ totalFeeBps: number; lpFeeBps: number; serviceFeeAddress: string }>;
}>;
export type TbcAmmQuote = QuoteIdentity & (
  | Readonly<{ kind: "addTbc" | "addFt"; quote: Readonly<{
    nextState: TbcAmmQuoteState; isFirstAddLP: boolean; tbcIncrementSat: string;
    tbcReserveIncrementSat: string; ftAIncrementRaw: string; ftLpIncrementRaw: string;
  }> }>
  | Readonly<{ kind: "buy"; quote: Readonly<{
    nextState: TbcAmmQuoteState; inputTbcSat: string; effectiveTbcIncrementSat: string;
    poolValueIncrementSat: string; ftOutRaw: string; fees: TbcAmmQuoteFees;
  }> }>
  | Readonly<{ kind: "sell"; quote: Readonly<{
    nextState: TbcAmmQuoteState; inputFtRaw: string; grossTbcOutSat: string;
    tbcOutSat: string; poolValueDecrementSat: string; fees: TbcAmmQuoteFees;
  }> }>
  | Readonly<{ kind: "remove"; quote: Readonly<{
    nextState: TbcAmmQuoteState; ftLpBurnRaw: string; ftADecrementRaw: string;
    tbcDecrementSat: string; poolValueDecrementSat: string;
  }> }>
);

const HASH = /^[0-9a-f]{64}$/u;
const UINT = /^(0|[1-9][0-9]{0,18})$/u;
const AMOUNTS = {
  addTbc: ["tbcIncrementSat", "tbcReserveIncrementSat", "ftAIncrementRaw", "ftLpIncrementRaw"],
  addFt: ["tbcIncrementSat", "tbcReserveIncrementSat", "ftAIncrementRaw", "ftLpIncrementRaw"],
  buy: ["inputTbcSat", "effectiveTbcIncrementSat", "poolValueIncrementSat", "ftOutRaw"],
  sell: ["inputFtRaw", "grossTbcOutSat", "tbcOutSat", "poolValueDecrementSat"],
  remove: ["ftLpBurnRaw", "ftADecrementRaw", "tbcDecrementSat", "poolValueDecrementSat"],
} as const;
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid AMM quote object");
  return value as Record<string, unknown>;
}
function amounts(value: unknown, fields: readonly string[]) {
  const row = object(value);
  for (const field of fields) {
    const amount = row[field];
    if (typeof amount !== "string" || !UINT.test(amount) || BigInt(amount) > 9_223_372_036_854_775_807n) {
      throw new TypeError("Invalid AMM quote atomic amount");
    }
  }
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}

/** All amounts use atomic-unit decimal strings, not display units or JS numbers.
 * Fees come from the supplied Pool Code/Tape; callers cannot override them.
 * A quote is not an execution promise. The normal planner must still verify
 * fresh state, input ownership, ancestry, authorization and minimum outputs. */
export async function quoteTbcAmm(input: TbcAmmQuoteInput, options: TbcAmmQuoteOptions): Promise<TbcAmmQuote> {
  const top = object(input);
  if (Object.keys(top).some(key => key !== "pool" && key !== "action")) throw new TypeError("Unknown AMM quote input");
  // Capture before the asynchronous native boundary; no mutable-state cache.
  const request = JSON.stringify({ phase: "quote", pool: input.pool, action: input.action });
  if (request.length > 2 * 1_048_576 + 1024) throw new TypeError("AMM quote exceeds byte bound");
  const captured = JSON.parse(request) as { pool?: { txid?: unknown }; action?: { kind?: unknown } };
  const kind = captured.action?.kind, txid = captured.pool?.txid;
  if (typeof txid !== "string" || !HASH.test(txid) || typeof kind !== "string" || !Object.hasOwn(AMOUNTS, kind)) {
    throw new TypeError("Invalid AMM quote identity or action");
  }
  const raw = await options.engine.execute("inspectAmmMaterial", request);
  if (raw.length > 16_384) throw new TypeError("AMM quote result exceeds byte bound");
  const result = object(JSON.parse(raw)), point = object(result.poolOutpoint);
  if (result.standardId !== "tbc-amm" || result.basis !== "local-pool-transaction" || result.kind !== kind || point.txid !== txid || point.vout !== 0 ||
      [result.templateRevision, result.poolCodeHash, result.ftContractId].some(value => typeof value !== "string" || !HASH.test(value))) {
    throw new TypeError("AMM quote result identity mismatch");
  }
  const quote = object(result.quote), policy = object(result.feePolicy);
  amounts(quote.nextState, ["ftLpAmount", "ftAAmount", "tbcAmount", "poolValue"]);
  amounts(quote, AMOUNTS[kind as keyof typeof AMOUNTS]);
  if (!Number.isInteger(policy.totalFeeBps) || !Number.isInteger(policy.lpFeeBps) ||
      (policy.lpFeeBps as number) < 0 || (policy.totalFeeBps as number) < (policy.lpFeeBps as number) || (policy.totalFeeBps as number) > 10_000 ||
      typeof policy.serviceFeeAddress !== "string" || policy.serviceFeeAddress.length > 64 || policy.serviceFeeAddress.length < 1) throw new TypeError("Invalid AMM quote fee policy");
  if (kind === "buy" || kind === "sell") amounts(quote.fees, ["baseTbcSat", "totalFeeSat", "lpFeeSat", "serviceFeeAccruedSat", "serviceFeePaidSat", "serviceFeeRetainedSat", "poolFeeRetainedSat", "netAmountSat"]);
  else if (kind !== "remove" && typeof quote.isFirstAddLP !== "boolean") throw new TypeError("Invalid AMM liquidity quote");
  freeze(result);
  return result as TbcAmmQuote;
}
