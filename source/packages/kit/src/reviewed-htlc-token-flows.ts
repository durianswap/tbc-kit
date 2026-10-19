import { ripemd160 } from "@noble/hashes/ripemd160";
import { bytesToHex, hexToBytes, sha256Bytes } from "./network-bytes.js";
import { tbcAddressFromPublicKeyHash } from "./testnet-validation.js";
import { inspectReviewedHtlc, type HtlcReviewRow } from "./reviewed-htlc-flows.js";
import { inspectReviewedTokenCodes, inspectReviewedTokenPairs, type ReviewedTokenCode, type ReviewedTokenPairInput } from "./reviewed-token.js";
import { discoverReviewedTokenAssets } from "./reviewed-token-assets.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TbcOfficialApiClient, TbcApiTxoStatus } from "./official-api.js";

type Material = NonNullable<ReturnType<typeof inspectReviewedHtlc>>;
type Point = Readonly<{ txid: string; vout: number }>;
type Token = { side: number; index: number; code: ReviewedTokenCode; amount: string; lockTime?: number };
type Group = { asset: Readonly<Record<string, unknown>>; totals: [bigint, bigint]; flows: Readonly<Record<string, unknown>>[];
  endpoints: Map<string, { address: string; locked: boolean; input: bigint; output: bigint }> };
const P2PKH = /^76a914([0-9a-f]{40})88ac$/u;
const key = (p: Point) => `${p.txid}:${p.vout}`;

/** Shared unsigned raw review. Exact templates and selected sibling Tapes are
 * reused; this does not execute witnesses, authenticate ancestry or prove chain
 * maturity. Associated secret-bearing templates are rejected upstream. */
export async function reviewHtlcTokenFlows(rows: readonly Readonly<{ row: HtlcReviewRow; material: Material }>[], options: Readonly<{
  native: PoolMaterialNativeProviderInput; api: TbcOfficialApiClient; addressVersion: number;
  readStatuses: (points: readonly Point[]) => Promise<ReadonlyMap<string, TbcApiTxoStatus>>;
}>): Promise<ReadonlyMap<number, Readonly<Record<string, unknown>>>> {
  const scripts = [...new Set(rows.flatMap(({ material }) => material.sides.flatMap(side => side.map(o => o.script))))];
  const decoded = await inspectReviewedTokenCodes(options.native, scripts);
  const codes = new Map(scripts.map((s, i) => [s, decoded[i]!]));
  const dependencies = new Map<string, Point>();
  const tokens = rows.map(({ row, material }) => {
    const found: Token[] = [];
    material.sides.forEach((outputs, side) => outputs.forEach((o, index) => {
      const code = codes.get(o.script);
      if (code) {
        found.push({ side, index, code, amount: "" });
        if (side === 0) {
          const input = row.inputs[index]!;
          if (input.vout === 0xffff_ffff) throw new Error("HTLC Token sibling overflow");
          const p = { txid: input.txid, vout: input.vout + 1 }; dependencies.set(key(p), p);
        }
      } else if (!P2PKH.test(o.script) && !material.codes[side]![index] &&
          !(side === 1 && index > 0 && codes.get(outputs[index - 1]!.script) && o.amount === 0n)) {
        throw new Error("Unrecognized HTLC Token raw script");
      }
    }));
    if (!found.some(t => t.side === 0)) throw new Error("HTLC Token review has no selected Token inputs");
    return found;
  });
  const statuses = await options.readStatuses([...dependencies.values()]);
  const pairInputs: ReviewedTokenPairInput[] = [];
  rows.forEach(({ row, material }, r) => tokens[r]!.forEach(token => {
    const o = material.sides[token.side]![token.index]!;
    const prior = token.side === 0 ? row.inputs[token.index]! : undefined;
    const tape = prior ? statuses.get(key({ txid: prior.txid, vout: prior.vout + 1 })) : undefined;
    const next = material.sides[1][token.index + 1];
    const tapeScript = prior ? tape?.scriptPubKey : next?.script;
    const tapeValue = prior ? tape?.value : next?.amount.toString();
    if (tapeScript === undefined || tapeValue !== "0") throw new Error("HTLC Token Tape unavailable");
    pairInputs.push({ codeScript: o.script, codeSatoshis: Number(o.amount), tapeScript, tapeSatoshis: 0,
      ...(token.side === 0 && token.code.standardId === "tbc20-stablecoin" ? {
        inputLock: { sequence: row.transaction.inputs[token.index]!.sequence, transactionLockTime: row.transaction.locktime },
      } : {}) });
  }));
  const pairs = await inspectReviewedTokenPairs(options.native, pairInputs);
  tokens.flat().forEach((token, i) => { token.amount = pairs[i]!.balanceRaw; if (pairs[i]!.lockTime !== undefined) token.lockTime = pairs[i]!.lockTime!; });
  const assets = await discoverReviewedTokenAssets(options.native, options.api, rows.flatMap(({ row }, r) => tokens[r]!.filter(t => t.side === 0).map(t => ({
    code: t.code, txid: row.inputs[t.index]!.txid, vout: row.inputs[t.index]!.vout,
  }))));
  const result = new Map<number, Readonly<Record<string, unknown>>>();
  rows.forEach(({ row, material }, r) => {
    const found = tokens[r]!, linked = new Set<Token>();
    const htlcLocks = material.htlcLocks.map(lock => {
      const side = lock.position === "input" ? 0 : 1, index = Number(lock.index), o = material.sides[side][index]!;
      const token = found.find(t => t.side === side && (side === 1 ? t.index === index + 1 :
        row.inputs[t.index]!.txid === row.inputs[index]!.txid && row.inputs[t.index]!.vout === row.inputs[index]!.vout + 1));
      const controller = bytesToHex(ripemd160(sha256Bytes(sha256Bytes(hexToBytes(o.script))))) + "01";
      if (o.amount !== 100n || (side === 1 ? index !== 0 : row.inputs[index]!.vout !== 0) || !token || token.code.controller !== controller ||
          BigInt(token.amount) === 0n || BigInt(token.amount) > (1n << 63n) - 1n) throw new Error("HTLC escrow Token binding mismatch");
      if (token.lockTime && (token.lockTime < 500_000_000) !== (Number(lock.lockTime) < 500_000_000)) throw new Error("HTLC and Coin refund domains differ");
      const asset = assets.get(token.code.codeIdentity); if (!asset) throw new Error("Unidentified HTLC output asset");
      linked.add(token);
      return Object.freeze({ ...lock, escrowToken: Object.freeze({ index: token.index, standardId: token.code.standardId,
        contractId: asset.contractId, amount: token.amount,
        ...(token.lockTime === undefined ? {} : { coinLockTime: token.lockTime, coinInputLockChecked: side === 0 }) }) });
    });
    const groups = new Map<string, Group>();
    const add = (id: string, asset: Readonly<Record<string, unknown>>, side: number, amount: bigint, locked: boolean, address?: string) => {
      const group: Group = groups.get(id) ?? { asset, totals: [0n, 0n], flows: [], endpoints: new Map() };
      group.totals[side as 0 | 1] += amount;
      if (address !== undefined) {
        const key = `${locked ? "locked" : "address"}:${address}`, endpoint = group.endpoints.get(key) ?? { address, locked, input: 0n, output: 0n };
        endpoint[side === 0 ? "input" : "output"] += amount; group.endpoints.set(key, endpoint);
      } else if (amount > 0n) group.flows.push({ purpose: side === 0 ? "release" : "lock",
        direction: side === 0 ? "out" : "in", amount: { raw: amount.toString() }, recognized: true });
      groups.set(id, group);
    };
    const coinLocks: Readonly<Record<string, unknown>>[] = [];
    for (const token of found) {
      const asset = assets.get(token.code.codeIdentity); if (!asset) throw new Error("Unidentified HTLC output asset");
      const isAddress = token.code.controller.endsWith("00"), conditional = linked.has(token);
      if (!isAddress && !conditional) throw new Error("Orphan HTLC Token controller");
      const address = isAddress ? tbcAddressFromPublicKeyHash(token.code.controller.slice(0, 40), options.addressVersion) : undefined;
      add(token.code.codeIdentity, asset, token.side, BigInt(token.amount), conditional || !!token.lockTime, address);
      if (token.lockTime !== undefined && address !== undefined) coinLocks.push({ position: token.side === 0 ? "input" : "output",
        index: token.index, contractId: asset.contractId, amount: token.amount, owner: address, lockTime: token.lockTime,
        domain: token.lockTime === 0 ? "none" : token.lockTime < 500_000_000 ? "height" : "timestamp",
        transactionLockTime: row.transaction.locktime, scriptLockChecked: token.side === 0, chainMaturityChecked: false,
        ...(token.side === 0 ? { sequence: row.transaction.inputs[token.index]!.sequence } : {}) });
    }
    material.sides.forEach((outputs, side) => outputs.forEach((o, index) => {
      if (o.amount === 0n) return;
      const plain = P2PKH.exec(o.script), token = found.find(t => t.side === side && t.index === index);
      const conditional = !!material.codes[side]![index] || (token !== undefined && linked.has(token));
      const hash = plain?.[1] ?? (token?.code.controller.endsWith("00") ? token.code.controller.slice(0, 40) : undefined);
      const address = hash === undefined ? undefined : tbcAddressFromPublicKeyHash(hash, options.addressVersion);
      if (!conditional && address === undefined) throw new Error("Unrecognized native collateral owner");
      add("native", { type: "tbc", symbol: "TBC" }, side, o.amount, conditional, address);
    }));
    for (const [id, group] of groups) {
      if (id !== "native" && group.totals[0] !== group.totals[1]) throw new Error("HTLC Token conservation differs");
      for (const { address, locked, input, output } of group.endpoints.values()) {
        const delta = output - input;
        if (delta === 0n) {
          if (input > 0n) group.flows.push({ purpose: "self", direction: "self", amount: { raw: input.toString() }, recognized: true,
            from: { address }, to: { address } });
        } else group.flows.push({ purpose: locked ? delta > 0n ? "lock" : "release" : "transfer", direction: delta > 0n ? "in" : "out",
          amount: { raw: (delta > 0n ? delta : -delta).toString() }, recognized: true,
          ...(delta > 0n ? { to: { address } } : { from: { address } }) });
      }
    }
    result.set(row.index, Object.freeze({ index: row.index, txid: row.txid, feeSatoshis: material.fee.toString(),
      classification: { protocol: "tbc-htlc", action: material.codes[0]!.some(Boolean) ? "spend-or-transition" : "lock", conformance: "standard" },
      htlcLocks, ...(coinLocks.length === 0 ? {} : { coinLocks }),
      groups: [...groups].map(([key, group]) => ({ key, asset: group.asset, flows: group.flows })) }));
  });
  return result;
}
