import { bytesToHex } from "./network-bytes.js";
import { tbcAddressFromPublicKeyHash, type parseTbcTransaction } from "./testnet-validation.js";
import { inspectReviewedTokenPairs, type ReviewedTokenCode, type ReviewedTokenPairInput } from "./reviewed-token.js";
import { discoverReviewedTokenAssets } from "./reviewed-token-assets.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TbcOfficialApiClient, TbcApiTxoStatus } from "./official-api.js";
import type { TbcVerifiedTransactionInput } from "./reviewed-transaction-types.js";
import { reviewedCoinAdminKey } from "./reviewed-coin-admin.js";

type Point = Readonly<{ txid: string; vout: number }>;
type Row = Readonly<{ index: number; txid: string; transaction: ReturnType<typeof parseTbcTransaction>; inputs: readonly TbcVerifiedTransactionInput[];
  associatedInputs?: readonly Readonly<Record<string, unknown>>[];
  signingPublicKeys?: readonly (string | null)[] }>;
type Token = { side: 0 | 1; index: number; code: ReviewedTokenCode; amount: bigint; lockTime?: number; administrator?: boolean };
const P2PKH = /^76a914([0-9a-f]{40})88ac$/u;
const key = (p: Point) => `${p.txid}:${p.vout}`;

/** Address-held current Token/Coin and authenticated Coin administrator updates,
 * not administrative issuance or arbitrary holder covenant execution.
 * Reuses the dispatcher's exact Code inspection.
 * Only selected sibling Tapes and authenticated per-identity labels are read.
 * Returned evidence is not ancestry/consensus verification or chain maturity. */
export async function reviewCurrentTokenHolderFlows(options: Readonly<{
  rows: readonly Row[]; codes: ReadonlyMap<string, ReviewedTokenCode | null>;
  native: PoolMaterialNativeProviderInput; api: TbcOfficialApiClient;
  addressVersion: number; accountAddress: string;
  administratorPublicKey?: string;
  readStatuses: (points: readonly Point[]) => Promise<ReadonlyMap<string, TbcApiTxoStatus>>;
}>): Promise<ReadonlyMap<number, Readonly<Record<string, unknown>>>> {
  const { rows, codes } = options;
  const address = (hash: string) => tbcAddressFromPublicKeyHash(hash, options.addressVersion);
  const ownerOf = (code: ReviewedTokenCode) => code.controller.endsWith("00")
    ? address(code.controller.slice(0, 40)) : `contract:${code.controller.slice(0, 40)}`;
  const endpoint = (owner: string) => owner.startsWith("contract:")
    ? { contractHash: owner.slice(9) } : { address: owner };
  const dependencies = new Map<string, Point>();
  const tokens = rows.map(row => {
    if (row.signingPublicKeys !== undefined && row.signingPublicKeys.length !== row.inputs.length) throw new Error("Raw input key matrix differs");
    if (row.associatedInputs !== undefined && row.associatedInputs.length !== row.inputs.length) {
      throw new Error("Associated holder input profile count differs");
    }
    const found: Token[] = [];
    const sides = [row.inputs.map(i => ({ script: i.scriptPubKey, value: BigInt(i.satoshis) })),
      row.transaction.outputs.map(o => ({ script: bytesToHex(o.scriptPubKey), value: o.satoshis }))];
    sides.forEach((outputs, side) => outputs.forEach((o, index) => {
      const code = codes.get(o.script), plain = P2PKH.exec(o.script);
      if (code) {
        if (side === 0 && row.associatedInputs !== undefined && row.associatedInputs[index]?.scriptSigType !== code.standardId) {
          throw new Error("Associated holder requires the exact current proof profile");
        }
        if (!/^(?:[0-9a-f]{40})(?:00|01)$/u.test(code.controller)) throw new Error("Unrecognized Token controller kind");
        const signingKey = side === 0 ? (row.signingPublicKeys?.[index] ?? row.associatedInputs?.[index]?.signingPublicKey) : undefined;
        const administrator = signingKey !== undefined;
        if (administrator && (options.administratorPublicKey === undefined ||
            signingKey !== reviewedCoinAdminKey(code, options.administratorPublicKey))) throw new Error("Unbound Reviewed Coin administrator input");
        // An administrator is committed separately by Coin Code. This does not
        // authorize the fee/holder key to consume an arbitrary contract input.
        if (side === 0 && !administrator && !code.controller.endsWith("00")) throw new Error("Raw holder review requires an address controller");
        if (side === 0 && !administrator && address(code.controller.slice(0, 40)) !== options.accountAddress) throw new Error("Raw Token input owner differs from signing account");
        found.push({ side: side as 0 | 1, index, code, amount: 0n, ...(administrator ? { administrator: true } : {}) });
        if (side === 0) {
          const input = row.inputs[index]!;
          if (input.vout === 0xffff_ffff) throw new Error("Token Tape index overflow");
          const p = { txid: input.txid, vout: input.vout + 1 }; dependencies.set(key(p), p);
        }
      } else if (plain) {
        if (side === 0 && row.signingPublicKeys?.[index] != null) throw new Error("Raw fee input cannot select administrator");
        if (side === 0 && row.associatedInputs !== undefined && row.associatedInputs[index]?.scriptSigType !== "p2pkh") {
          throw new Error("Associated holder fee input requires P2PKH profile");
        }
        if (side === 0 && address(plain[1]!) !== options.accountAddress) throw new Error("Raw fee input owner differs from signing account");
      } else if (!(side === 1 && index > 0 && codes.get(outputs[index - 1]!.script) && o.value === 0n)) {
        throw new Error("Unrecognized current raw transaction script");
      }
    }));
    if (!found.some(t => t.side === 0)) throw new Error("Raw holder review requires Token inputs");
    for (const token of found.filter(t => t.side === 1 && !t.code.controller.endsWith("00"))) {
      if (!found.some(t => t.side === 0 && t.administrator && t.code.codeIdentity === token.code.codeIdentity)) {
        throw new Error("Contract-held output requires the authenticated Coin administrator flow");
      }
    }
    return found;
  });
  const statuses = await options.readStatuses([...dependencies.values()]);
  const requests: ReviewedTokenPairInput[] = [];
  rows.forEach((row, r) => tokens[r]!.forEach(t => {
    const input = t.side === 0 ? row.inputs[t.index]! : undefined;
    const output = row.transaction.outputs[t.index]!;
    const tape = input ? statuses.get(key({ txid: input.txid, vout: input.vout + 1 })) : undefined;
    const next = row.transaction.outputs[t.index + 1];
    const tapeScript = input ? tape?.scriptPubKey : next && bytesToHex(next.scriptPubKey);
    const tapeValue = input ? tape?.value : next?.satoshis.toString();
    if (tapeScript === undefined || tapeValue !== "0") throw new Error("Trusted Token Tape unavailable");
    requests.push({ codeScript: input?.scriptPubKey ?? bytesToHex(output.scriptPubKey), codeSatoshis: input?.satoshis ?? Number(output.satoshis),
      tapeScript, tapeSatoshis: 0, ...(input && t.code.standardId === "tbc20-stablecoin" && !t.administrator ? {
        inputLock: { sequence: row.transaction.inputs[t.index]!.sequence, transactionLockTime: row.transaction.locktime },
      } : {}) });
  }));
  const pairs = await inspectReviewedTokenPairs(options.native, requests);
  tokens.flat().forEach((t, i) => {
    t.amount = BigInt(pairs[i]!.balanceRaw);
    if (pairs[i]!.lockTime !== undefined) t.lockTime = pairs[i]!.lockTime!;
  });
  // Check conservation locally before requesting indexed display identities.
  rows.forEach((_, r) => {
    const sums = new Map<string, [bigint, bigint]>();
    for (const t of tokens[r]!) { const sum = sums.get(t.code.codeIdentity) ?? [0n, 0n]; sum[t.side] += t.amount; sums.set(t.code.codeIdentity, sum); }
    for (const sum of sums.values()) if (sum[0] !== sum[1]) throw new Error("Raw Token conservation differs");
  });
  const assets = await discoverReviewedTokenAssets(options.native, options.api, rows.flatMap((row, r) => tokens[r]!.filter(t => t.side === 0).map(t => ({
    code: t.code, txid: row.inputs[t.index]!.txid, vout: row.inputs[t.index]!.vout,
  }))));
  return new Map(rows.map((row, r) => {
    const groups = new Map<string, { asset: Readonly<Record<string, unknown>>; endpoints: Map<string, [bigint, bigint]> }>();
    const add = (id: string, asset: Readonly<Record<string, unknown>>, owner: string, side: 0 | 1, amount: bigint) => {
      const group = groups.get(id) ?? { asset, endpoints: new Map() };
      const values = group.endpoints.get(owner) ?? [0n, 0n]; values[side] += amount;
      group.endpoints.set(owner, values); groups.set(id, group);
    };
    const locks: Readonly<Record<string, unknown>>[] = [];
    for (const t of tokens[r]!) {
      const asset = assets.get(t.code.codeIdentity);
      if (!asset) throw new Error("Unbound output Token identity");
      const owner = ownerOf(t.code);
      add(t.code.codeIdentity, asset, owner, t.side, t.amount);
      if (t.lockTime !== undefined) locks.push(Object.freeze({ position: t.side === 0 ? "input" : "output", index: t.index,
        ...(owner.startsWith("contract:") ? { controller: Object.freeze({ type: "contract", hash: owner.slice(9) }) } : { owner }),
        contractId: asset.contractId, amount: t.amount.toString(), lockTime: t.lockTime,
        domain: t.lockTime === 0 ? "none" : t.lockTime < 500_000_000 ? "height" : "timestamp",
        transactionLockTime: row.transaction.locktime, scriptLockChecked: t.side === 0 && !t.administrator, chainMaturityChecked: false,
        ...(t.administrator ? { authorization: "administrator" } : {}),
        ...(t.side === 0 ? { sequence: row.transaction.inputs[t.index]!.sequence } : {}) }));
    }
    const sides = [row.inputs.map(i => ({ script: i.scriptPubKey, value: BigInt(i.satoshis) })),
      row.transaction.outputs.map(o => ({ script: bytesToHex(o.scriptPubKey), value: o.satoshis }))];
    sides.forEach((outputs, side) => outputs.forEach(o => {
      if (o.value === 0n) return;
      const hash = P2PKH.exec(o.script)?.[1], code = codes.get(o.script);
      const owner = hash ? address(hash) : code ? ownerOf(code) : undefined;
      if (owner === undefined) throw new Error("Unknown native collateral recipient");
      add("native", { type: "tbc", symbol: "TBC" }, owner, side as 0 | 1, o.value);
    }));
    const fee = sides[0]!.reduce((s, o) => s + o.value, 0n) - sides[1]!.reduce((s, o) => s + o.value, 0n);
    if (fee < 0n) throw new Error("Raw transaction native overspend");
    return [row.index, Object.freeze({ index: row.index, txid: row.txid, feeSatoshis: fee.toString(),
      classification: { protocol: tokens[r]!.some(t => t.code.standardId === "tbc20-stablecoin") ? "stablecoin" : "ft", action: tokens[r]!.some(t => t.administrator) ? "administrator-update" : "transfer-or-merge", conformance: "standard" },
      ...(locks.length ? { coinLocks: Object.freeze(locks) } : {}), groups: [...groups].map(([id, g]) => ({ key: id, asset: g.asset,
        flows: [...g.endpoints].flatMap(([owner, [input, output]]) => {
          const delta = output - input;
          if (delta === 0n) return input === 0n ? [] : [{ purpose: "self", direction: "self", amount: { raw: input.toString() }, recognized: true, isSelf: !owner.startsWith("contract:"), from: endpoint(owner), to: endpoint(owner) }];
          return [{ purpose: "transfer", direction: delta > 0n ? "in" : "out", amount: { raw: (delta > 0n ? delta : -delta).toString() }, recognized: true,
            isSelf: false, ...(delta > 0n ? { to: endpoint(owner) } : { from: endpoint(owner) }) }];
        }) })) })];
  }));
}
