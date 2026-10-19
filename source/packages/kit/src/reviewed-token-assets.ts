import { inspectReviewedTokenCodes, type ReviewedTokenCode } from "./reviewed-token.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TbcOfficialApiClient } from "./official-api.js";
export type ReviewedTokenAsset = Readonly<{ type: "ft" | "stablecoin"; symbol: string; contractId: string }>;
const HASH = /^[0-9a-f]{64}$/u;
function rec(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid reviewed asset metadata");
  return value as Record<string, unknown>;
}

/** Indexed labels are not identity proof. Match full exact Code identity before
 * accepting a contract ID. One request per distinct identity; no ancestry scan. */
export async function authenticateReviewedTokenAssets(native: PoolMaterialNativeProviderInput, api: TbcOfficialApiClient,
  requests: readonly Readonly<{ code: ReviewedTokenCode; contractId: string }>[]): Promise<ReadonlyMap<string, ReviewedTokenAsset>> {
  if (requests.length === 0 || requests.length > 256) throw new Error("Invalid reviewed asset batch");
  const unique = new Map<string, { code: ReviewedTokenCode; contractId: string }>();
  for (const request of requests) {
    const item = { code: Object.freeze({ ...request.code }), contractId: request.contractId };
    if (!HASH.test(item.contractId)) throw new Error("Invalid reviewed contract ID");
    const old = unique.get(item.code.codeIdentity);
    if (old && (old.contractId !== item.contractId || old.code.standardId !== item.code.standardId)) throw new Error("Ambiguous reviewed asset identity");
    unique.set(item.code.codeIdentity, item);
  }
  const items = [...unique.values()];
  const scripts = await Promise.all(items.map(async ({ code, contractId }) => {
    const data = rec(code.standardId === "tbc20-standard" ? await api.ftInfo({ contract_id: contractId }, { category: "asset-index" })
      : await api.stablecoinInfo({ stablecoin_id: contractId }, { category: "asset-index" }));
    if (code.standardId === "tbc20-stablecoin" && data.stablecoin_id !== contractId) throw new Error("Coin metadata asset ID differs");
    if (typeof data.code_script !== "string") throw new Error("Indexed Token Code unavailable");
    return data.code_script;
  }));
  const indexed = await inspectReviewedTokenCodes(native, scripts);
  return new Map(items.map(({ code, contractId }, i) => {
    if (indexed[i]?.codeIdentity !== code.codeIdentity || indexed[i]?.standardId !== code.standardId) throw new Error("Indexed Token Code identity differs from reviewed material");
    return [code.codeIdentity, Object.freeze({ type: code.standardId === "tbc20-standard" ? "ft" as const : "stablecoin" as const, symbol: contractId, contractId })];
  }));
}

/** Raw HTLC has no contract-ID commitment. Obtain only an indexed hint for a
 * selected Token prevout, then authenticate it using the same full Code check
 * as LOP. Decoder balances/decimals/labels are deliberately not consumed. */
export async function discoverReviewedTokenAssets(native: PoolMaterialNativeProviderInput, api: TbcOfficialApiClient,
  inputs: readonly Readonly<{ code: ReviewedTokenCode; txid: string; vout: number }>[]): Promise<ReadonlyMap<string, ReviewedTokenAsset>> {
  if (inputs.length === 0 || inputs.length > 256) throw new Error("Invalid reviewed Token inputs");
  const unique = new Map<string, { code: ReviewedTokenCode; txid: string; vout: number }>();
  for (const input of inputs) {
    if (!HASH.test(input.txid) || !Number.isInteger(input.vout) || input.vout < 0 || input.vout > 0xffff_ffff) throw new Error("Invalid reviewed Token outpoint");
    if (!unique.has(input.code.codeIdentity)) unique.set(input.code.codeIdentity, { ...input, code: Object.freeze({ ...input.code }) });
  }
  const decoded = new Map<string, Promise<Record<string, unknown>>>();
  const requests = await Promise.all([...unique.values()].map(async ({ code, txid, vout }) => {
    const key = `${code.standardId}:${txid}`;
    let pending = decoded.get(key);
    if (!pending) {
      pending = (code.standardId === "tbc20-standard" ? api.ftDecode({ txid }, { category: "asset-index" })
        : api.stablecoinDecode({ txid }, { category: "asset-index" })).then(rec);
      decoded.set(key, pending);
    }
    const data = await pending;
    if (data.txid !== txid || typeof data.contract_id !== "string" || !HASH.test(data.contract_id) ||
        !Array.isArray(data.output) || data.output.length > 65536 ||
        !data.output.some(value => { const output = rec(value); return output.txid === txid && (output.vout === vout || output.vout === String(vout)); })) {
      throw new Error("Indexed Token hint is not bound to selected output");
    }
    return { code, contractId: data.contract_id };
  }));
  return authenticateReviewedTokenAssets(native, api, requests);
}
