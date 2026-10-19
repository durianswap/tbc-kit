import { bytesToHex } from "./network-bytes.js";
import { tbcAddressFromPublicKeyHash, type parseTbcTransaction } from "./testnet-validation.js";
import { inspectReviewedLopMaterials } from "./reviewed-lop.js";
import { inspectReviewedTokenCodes, inspectReviewedTokenPairs, type ReviewedTokenCode, type ReviewedTokenPairInput } from "./reviewed-token.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { createTbcOfficialApi, TbcApiTxoStatus } from "./official-api.js";
import type { TbcVerifiedTransactionInput } from "./reviewed-transaction-types.js";
import { authenticateReviewedTokenAssets } from "./reviewed-token-assets.js";
import { reviewCurrentTokenHolderFlows } from "./reviewed-token-holder-flows.js";

type Point = Readonly<{ txid: string; vout: number }>;
type Row = Readonly<{ index: number; txid: string; transaction: ReturnType<typeof parseTbcTransaction>; inputs: readonly TbcVerifiedTransactionInput[];
  associatedInputs?: readonly Readonly<Record<string, unknown>>[];
  signingPublicKeys?: readonly (string | null)[] }>;
type Output = Readonly<{ script: string; satoshis: bigint }>;
type Token = { side: "input" | "output"; index: number; code: ReviewedTokenCode; balance: string; lockTime?: number };
const HASH = /^[0-9a-f]{64}$/u;
const P2PKH = /^76a914([0-9a-f]{40})88ac$/u;
function rec(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid LOP review metadata");
  return value as Record<string, unknown>;
}
function key(p: Point): string { return `${p.txid}:${p.vout}`; }

/** Dispatch exact current Token material to holder or LOP flow review.
 * Not a consensus verifier or blind-sign fallback.
 * Inputs are already exact-checked against the configured trusted node. Only
 * missing adjacent tapes and per-asset official metadata are queried, batched
 * and deduplicated for this review. No fee-parent fetch, issuance history walk,
 * signing, broadcast, permanent cache or database. */
export async function reviewCurrentTokenFlows(options: Readonly<{
  rows: readonly Row[]; native: PoolMaterialNativeProviderInput;
  api: ReturnType<typeof createTbcOfficialApi>; addressVersion: number;
  /** Associated holders additionally require exact profiles and shared proof preflight. */
  holderAccountAddress?: string;
  administratorPublicKey?: string;
  readStatuses: (points: readonly Point[]) => Promise<ReadonlyMap<string, TbcApiTxoStatus>>;
}>): Promise<ReadonlyMap<number, Readonly<Record<string, unknown>>>> {
  const { native } = options;
  let rows = options.rows;
  const scripts = rows.map(row => ({ inputs: row.inputs.map(i => i.scriptPubKey), outputs: row.transaction.outputs.map(o => bytesToHex(o.scriptPubKey)) }));
  const flat = [...new Set(scripts.flatMap(r => [...r.inputs, ...r.outputs]))];
  let [materials, decodedCodes] = await Promise.all([inspectReviewedLopMaterials(native, scripts), inspectReviewedTokenCodes(native, flat)]);
  const codes = new Map(flat.map((s, i) => [s, decodedCodes[i]!]));
  const holderIndexes = new Set(materials.flatMap((m, i) => m.orders.inputs.length + m.orders.outputs.length === 0 ? [i] : []));
  if (rows.some((row,index) => row.signingPublicKeys?.some(key => key !== null) && !holderIndexes.has(index))) {
    throw new Error("Raw administrator and order controller combination unsupported");
  }
  const holderReviews = options.holderAccountAddress === undefined || holderIndexes.size === 0 ? new Map<number, Readonly<Record<string, unknown>>>()
    : await reviewCurrentTokenHolderFlows({ ...options, accountAddress: options.holderAccountAddress, codes, rows: rows.filter((_, i) => holderIndexes.has(i)) });
  if (holderReviews.size !== 0) {
    rows = rows.filter((_, i) => !holderIndexes.has(i));
    materials = materials.filter((_, i) => !holderIndexes.has(i));
    if (rows.length === 0) return holderReviews;
  }
  const dependencies = new Map<string, Point>();
  rows.forEach(row => row.inputs.forEach(input => {
    if (codes.get(input.scriptPubKey)) {
      if (input.vout === 0xffff_ffff) throw new Error("Token Tape index overflow");
      const p = { txid: input.txid, vout: input.vout + 1 }; dependencies.set(key(p), p);
    }
  }));
  // Reject unrelated unknown scripts before making additional network requests.
  rows.forEach((row, r) => {
    const m = materials[r]!;
    if (m.orders.inputs.length + m.orders.outputs.length === 0) throw new Error("Unrecognized current raw transaction impact");
    for (const [side, outputs] of [["input", row.inputs.map(i => ({ script: i.scriptPubKey, satoshis: BigInt(i.satoshis) }))],
      ["output", row.transaction.outputs.map(o => ({ script: bytesToHex(o.scriptPubKey), satoshis: BigInt(o.satoshis) }))]] as const) {
      const orders = side === "input" ? m.orders.inputs : m.orders.outputs;
      outputs.forEach((o, i) => {
        if (P2PKH.test(o.script) || codes.get(o.script) || orders.some(order => order.index === i)) return;
        if (side === "output" && i > 0 && codes.get(outputs[i - 1]!.script) && o.satoshis === 0n) return;
        throw new Error("Unrecognized current raw transaction script");
      });
    }
  });
  const statuses = await options.readStatuses([...dependencies.values()]);
  const pairInputs: ReviewedTokenPairInput[] = [];
  const tokenRows: Token[][] = rows.map(() => []);
  rows.forEach((row, r) => {
    row.inputs.forEach((input, i) => {
      const descriptor = codes.get(input.scriptPubKey); if (!descriptor) return;
      const tape = statuses.get(key({ txid: input.txid, vout: input.vout + 1 }));
      if (tape?.scriptPubKey === undefined || tape.value !== "0") throw new Error("Trusted Token Tape unavailable");
      pairInputs.push({ codeScript: input.scriptPubKey, codeSatoshis: input.satoshis, tapeScript: tape.scriptPubKey, tapeSatoshis: 0,
        ...(descriptor.standardId === "tbc20-stablecoin" ? { inputLock: { sequence: row.transaction.inputs[i]!.sequence, transactionLockTime: row.transaction.locktime } } : {}) });
      tokenRows[r]!.push({ side: "input", index: i, code: descriptor, balance: "" });
    });
    row.transaction.outputs.forEach((output, i) => {
      const s = bytesToHex(output.scriptPubKey), descriptor = codes.get(s); if (!descriptor) return;
      const tape = row.transaction.outputs[i + 1]; if (!tape) throw new Error("Output Token Tape unavailable");
      pairInputs.push({ codeScript: s, codeSatoshis: Number(output.satoshis), tapeScript: bytesToHex(tape.scriptPubKey), tapeSatoshis: Number(tape.satoshis) });
      tokenRows[r]!.push({ side: "output", index: i, code: descriptor, balance: "" });
    });
  });
  if (pairInputs.length === 0) throw new Error("No supported current Token material");
  const pairs = await inspectReviewedTokenPairs(native, pairInputs);
  tokenRows.flat().forEach((token, i) => { token.balance = pairs[i]!.balanceRaw; if (pairs[i]!.lockTime !== undefined) token.lockTime = pairs[i]!.lockTime!; });
  // Contract IDs come from exact order commitments, but are not trusted until
  // official indexed Code matches full identity, not merely its display label.
  const commitments = new Map<string, string>();
  for (const m of materials) for (const order of [...m.orders.inputs, ...m.orders.outputs]) {
    for (const field of [order.terms.baseAsset, order.terms.quoteAsset]) {
      const asset = rec(field); if (asset.kind === "native") continue;
      if (asset.kind !== "token" || typeof asset.partialHash !== "string" || !HASH.test(asset.partialHash) || typeof asset.contractId !== "string" || !HASH.test(asset.contractId)) throw new Error("Invalid LOP asset commitment");
      const previous = commitments.get(asset.partialHash);
      if (previous !== undefined && previous !== asset.contractId) throw new Error("Ambiguous LOP asset commitment");
      commitments.set(asset.partialHash, asset.contractId);
    }
  }
  const identities = new Map<string, ReviewedTokenCode>();
  for (const token of tokenRows.flat()) identities.set(token.code.codeIdentity, token.code);
  const assetRequests = [...identities].map(([identity, descriptor]) => {
    const id = commitments.get(identity.slice(0, 64)); if (!id) throw new Error("Token identity is not committed by an order");
    return { code: descriptor, contractId: id };
  });
  const assets = await authenticateReviewedTokenAssets(native, options.api, assetRequests);
  const result = new Map<number, Readonly<Record<string, unknown>>>(holderReviews);
  rows.forEach((row, r) => {
    const m = materials[r]!, tokens = tokenRows[r]!;
    const inputOutputs: Output[] = row.inputs.map(i => ({ script: i.scriptPubKey, satoshis: BigInt(i.satoshis) }));
    const outputOutputs: Output[] = row.transaction.outputs.map(o => ({ script: bytesToHex(o.scriptPubKey), satoshis: BigInt(o.satoshis) }));
    const owners = new Map<string, string>();
    const linkedTokens = new Set<string>();
    for (const [side, orders, controllers, outputs] of [["input", m.orders.inputs, m.inputControllers, inputOutputs], ["output", m.orders.outputs, m.outputControllers, outputOutputs]] as const) {
      for (const order of orders) {
        const t = order.terms, output = outputs[order.index]!;
        if (typeof t.ownerHash !== "string" || !/^[0-9a-f]{40}$/u.test(t.ownerHash)) throw new Error("Invalid LOP owner");
        const owner = tbcAddressFromPublicKeyHash(t.ownerHash, options.addressVersion), controller = controllers.get(order.index)!;
        owners.set(controller + "01", owner);
        const nativeSell = t.market === "native-token" && t.side === "sell";
        if (output.satoshis !== (nativeSell ? BigInt(String(t.saleVolume)) : 300n)) throw new Error("LOP order value differs from terms");
        if (!nativeSell) {
          const token = tokens.find(token => token.side === side && (side === "output" ? token.index === order.index + 1 :
            row.inputs[token.index]!.txid === row.inputs[order.index]!.txid && row.inputs[token.index]!.vout === row.inputs[order.index]!.vout + 1));
          const committed = rec(t.market === "token-token" && t.side === "buy" ? t.quoteAsset : t.market === "native-token" ? t.quoteAsset : t.baseAsset);
          if (!token || token.code.controller !== controller + "01" || token.code.codeIdentity.slice(0, 64) !== committed.partialHash) throw new Error("LOP escrow is not bound to its adjacent order");
          linkedTokens.add(`${side}:${token.index}`);
        }
      }
    }
    const sums = new Map<string, { asset: Record<string, unknown>; input: bigint; output: bigint; endpoints: Map<string, { in: bigint; out: bigint; locked: boolean }> }>();
    const add = (id: string, asset: Record<string, unknown>, address: string, amount: bigint, side: "input" | "output", locked: boolean) => {
      const group = sums.get(id) ?? { asset, input: 0n, output: 0n, endpoints: new Map() };
      group[side] += amount;
      const endpointKey = `${locked ? "lock" : "address"}:${address}`, endpoint = group.endpoints.get(endpointKey) ?? { in: 0n, out: 0n, locked };
      endpoint[side === "input" ? "in" : "out"] += amount;group.endpoints.set(endpointKey, endpoint);sums.set(id, group);
    };
    const coinLocks: Readonly<Record<string, unknown>>[] = [];
    for (const token of tokens) {
      const isAddress = token.code.controller.endsWith("00");
      if (!isAddress && !linkedTokens.has(`${token.side}:${token.index}`)) throw new Error("Orphan LOP Token escrow");
      const address = isAddress ? tbcAddressFromPublicKeyHash(token.code.controller.slice(0, 40), options.addressVersion) : owners.get(token.code.controller);
      if (!address) throw new Error("Unsupported Token controller in raw review");
      if (token.lockTime !== undefined) coinLocks.push(Object.freeze({
        position: token.side, index: token.index, contractId: assets.get(token.code.codeIdentity)!.contractId,
        amount: token.balance, owner: address, lockTime: token.lockTime,
        domain: token.lockTime === 0 ? "none" : token.lockTime < 500_000_000 ? "height" : "timestamp",
        transactionLockTime: row.transaction.locktime, scriptLockChecked: token.side === "input", chainMaturityChecked: false,
        ...(token.side === "input" ? { sequence: row.transaction.inputs[token.index]!.sequence } : {}),
      }));
      add(token.code.codeIdentity, assets.get(token.code.codeIdentity)!, address, BigInt(token.balance), token.side, !isAddress);
    }
    for (const [side, outputs, orders] of [["input", inputOutputs, m.orders.inputs], ["output", outputOutputs, m.orders.outputs]] as const) {
      outputs.forEach((o, i) => {
        const plain = P2PKH.exec(o.script), order = orders.find(order => order.index === i), token = tokens.find(token => token.side === side && token.index === i);
        if (o.satoshis === 0n) return;
        const hash = plain?.[1] ?? (order ? String(order.terms.ownerHash) : token?.code.controller.endsWith("00") ? token.code.controller.slice(0, 40) : undefined);
        const address = hash ? tbcAddressFromPublicKeyHash(hash, options.addressVersion) : token ? owners.get(token.code.controller) : undefined;
        if (!address) throw new Error("Native collateral recipient is unknown");
        add("native", { type: "tbc", symbol: "TBC" }, address, o.satoshis, side, !plain && (order !== undefined || token?.code.controller.endsWith("00") === false));
      });
    }
    const fee = inputOutputs.reduce((s, o) => s + o.satoshis, 0n) - outputOutputs.reduce((s, o) => s + o.satoshis, 0n);
    if (fee < 0n) throw new Error("Raw transaction native overspend");
    const groups = [...sums].map(([id, group]) => {
      if (id !== "native" && group.input !== group.output) throw new Error("Raw Token conservation differs");
      const flows = [...group.endpoints].flatMap(([key, endpoint]) => {
        const delta = endpoint.out - endpoint.in;
        const address = key.slice(key.indexOf(":") + 1), receiving = delta > 0n;
        if (delta === 0n) return endpoint.in === 0n ? [] : [{ purpose: "self", direction: "self", amount: { raw: endpoint.in.toString() },
          recognized: true, isSelf: true, from: { address }, to: { address } }];
        return [{ purpose: endpoint.locked ? receiving ? "lock" : "release" : "transfer", direction: receiving ? "in" : "out",
          amount: { raw: (receiving ? delta : -delta).toString() }, recognized: true, isSelf: false,
          ...(receiving ? { to: { address } } : { from: { address } }) }];
      });
      return { key: id, asset: group.asset, flows };
    });
    result.set(row.index, Object.freeze({ index: row.index, txid: row.txid, feeSatoshis: fee.toString(),
      classification: { protocol: "orderBook", action: m.orders.inputs.length === 0 ? "create" : m.orders.outputs.length === 0 ? "settle-or-cancel" : "continuation", conformance: "standard" },
      orderTerms: m.orders, ...(coinLocks.length === 0 ? {} : { coinLocks: Object.freeze(coinLocks) }), groups }));
  });
  return result;
}
