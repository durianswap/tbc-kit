import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";

export type LopReviewScripts = Readonly<{
  inputs: readonly string[];
  outputs: readonly string[];
}>;
export type LopOrderInspection = Readonly<{
  verification: "exact-template";
  assetIdentityVerified: false;
  inputs: readonly Readonly<{ index: number; terms: Readonly<Record<string, unknown>> }>[];
  outputs: readonly Readonly<{ index: number; terms: Readonly<Record<string, unknown>> }>[];
}>;
export type LopReviewMaterial = Readonly<{
  orders: LopOrderInspection;
  inputControllers: ReadonlyMap<number, string>;
  outputControllers: ReadonlyMap<number, string>;
}>;

/** One batched local call over already available scripts; no chain reads or
 * approval authority. Exact Rust codec is shared with planning, not a tail-tag
 * recognizer. Token IDs here are committed order terms, not authenticated
 * token issuance identities. Rejected asset flows stay rejected by reviewer. */
export async function inspectReviewedLopOrders(
  native: PoolMaterialNativeProviderInput,
  transactions: readonly LopReviewScripts[],
): Promise<readonly LopOrderInspection[]> {
  return Object.freeze((await inspect(native, transactions, false)).map(item => item.orders));
}
export function inspectReviewedLopMaterials(native: PoolMaterialNativeProviderInput, transactions: readonly LopReviewScripts[]): Promise<readonly LopReviewMaterial[]> {
  return inspect(native, transactions, true);
}
async function inspect(native: PoolMaterialNativeProviderInput, transactions: readonly LopReviewScripts[], withControllers: boolean): Promise<readonly LopReviewMaterial[]> {
  const snapshot = transactions.map(tx => ({ inputs: [...tx.inputs], outputs: [...tx.outputs] }));
  const scripts = [...new Set(snapshot.flatMap(tx => [...tx.inputs, ...tx.outputs]))];
  if (scripts.length === 0 || scripts.length > 256) {
    throw new Error("LOP review script bound exceeded");
  }
  if (scripts.some(script => typeof script !== "string" || script.length > 131_072 ||
      script.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(script))) {
    throw new Error("Invalid LOP review script");
  }
  const result: unknown = JSON.parse(await native.execute("inspectLopMaterial", JSON.stringify({
    phase: "inspectOrderScripts", scripts,
  })));
  if (result === null || typeof result !== "object" ||
      !Array.isArray((result as { orders?: unknown }).orders)) {
    throw new Error("Invalid LOP review inspection");
  }
  const orders = (result as { orders: unknown[] }).orders;
  const controllers = (result as { controllers?: unknown[] }).controllers;
  if (orders.length !== scripts.length || orders.some(order => order !== null &&
      (typeof order !== "object" || (order as { standardId?: unknown }).standardId !== "tbc-lop"))) {
    throw new Error("Invalid LOP review inspection mapping");
  }
  if (withControllers && (!Array.isArray(controllers) || controllers.length !== scripts.length ||
      controllers.some((value, index) => orders[index] === null ? value !== null : typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)))) {
    throw new Error("Invalid LOP review controller mapping");
  }
  const positions = new Map(scripts.map((script, index) => [script, index]));
  const select = (values: readonly string[]) => Object.freeze(values.flatMap((script, index) => {
    const order = orders[positions.get(script)!];
    return order === null ? [] : [Object.freeze({ index, terms: order as Readonly<Record<string, unknown>> })];
  }));
  const controls = (values: readonly string[]) => new Map(values.flatMap((s, index) => {
    const value = controllers?.[positions.get(s)!];
    return typeof value === "string" ? [[index, value] as const] : [];
  }));
  return Object.freeze(snapshot.map(tx => Object.freeze({
    orders: Object.freeze({
    verification: "exact-template" as const,
    assetIdentityVerified: false,
    inputs: select(tx.inputs), outputs: select(tx.outputs),
    }),
    inputControllers: controls(tx.inputs), outputControllers: controls(tx.outputs),
  })));
}
