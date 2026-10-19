import { inspectTimelockCode } from "./timelock-material.js";
import { bytesToHex } from "./network-bytes.js";
import { tbcAddressFromPublicKeyHash } from "./testnet-validation.js";
import type { HtlcReviewRow } from "./reviewed-htlc-flows.js";

/** Exact public height-lock terms from already authenticated prevouts. No
 * node-tip read: transaction lock conditions are not a chain-maturity proof. */
export function reviewNativeTimelockFlow(row: HtlcReviewRow, options: Readonly<{
  addressVersion: number; accountAddress: string;
}>): Readonly<Record<string, unknown>> | undefined {
  if (!row.inputs.some(i => i.scriptPubKey.length === 106) &&
      !row.transaction.outputs.some(o => o.scriptPubKey.length === 53)) return undefined;
  const sides = [row.inputs.map(i => ({ script: i.scriptPubKey, amount: BigInt(i.satoshis) })),
    row.transaction.outputs.map(o => ({ script: bytesToHex(o.scriptPubKey), amount: o.satoshis }))] as const;
  const codes = sides.map(side => side.map(o => {
    try { return inspectTimelockCode(o.script); } catch { return undefined; }
  }));
  if (!codes.some(side => side.some(Boolean))) return undefined;
  if (row.transaction.inputs.some(i => i.scriptSig.length !== 0)) throw new Error("TimeLock review requires unsigned inputs");
  const timeLocks: Readonly<Record<string, unknown>>[] = [];
  const flows: Readonly<Record<string, unknown>>[] = [];
  const balances = new Map<string, bigint>();
  sides.forEach((outputs, side) => outputs.forEach((output, index) => {
    if (output.amount < 0n) throw new Error("Invalid TimeLock amount");
    const code = codes[side]![index];
    if (code) {
      const owner = tbcAddressFromPublicKeyHash(code.ownerHash, options.addressVersion);
      const sequence = side === 0 ? row.transaction.inputs[index]!.sequence : undefined;
      if (output.amount === 0n) throw new Error("Empty TimeLock deposit");
      if (side === 0 && (owner !== options.accountAddress || sequence === 0xffff_ffff ||
          row.transaction.locktime >= 500_000_000 || row.transaction.locktime < code.lockHeight)) {
        throw new Error("TimeLock owner or transaction lock condition mismatch");
      }
      timeLocks.push(Object.freeze({ position: side === 0 ? "input" : "output", index, owner,
        amount: output.amount.toString(), lockHeight: code.lockHeight, domain: "height",
        transactionLockTime: row.transaction.locktime, ...(sequence === undefined ? {} : { sequence }),
        verification: "exact-template", scriptLockChecked: side === 0,
        chainMaturityChecked: false, scriptExecutionVerified: false }));
      flows.push({ purpose: side === 0 ? "release" : "lock", direction: side === 0 ? "out" : "in",
        recognized: true, amount: { raw: output.amount.toString() },
        ...(side === 0 ? { from: { address: owner } } : { to: { address: owner } }) });
      return;
    }
    const match = /^76a914([0-9a-f]{40})88ac$/u.exec(output.script);
    if (!match) throw new Error("Unrecognized script in native TimeLock review");
    const address = tbcAddressFromPublicKeyHash(match[1]!, options.addressVersion);
    balances.set(address, (balances.get(address) ?? 0n) + (side === 0 ? -output.amount : output.amount));
  }));
  if (timeLocks.length > 256) throw new Error("Too many TimeLock terms");
  for (const [address, delta] of balances) {
    if (delta === 0n) continue;
    flows.push({ purpose: "transfer", direction: delta > 0n ? "in" : "out", recognized: true,
      amount: { raw: (delta > 0n ? delta : -delta).toString() },
      ...(delta > 0n ? { to: { address } } : { from: { address } }) });
  }
  const fee = sides[0].reduce((sum, o) => sum + o.amount, 0n) - sides[1].reduce((sum, o) => sum + o.amount, 0n);
  if (fee < 0n) throw new Error("TimeLock transaction overspend");
  return Object.freeze({ index: row.index, txid: row.txid, feeSatoshis: fee.toString(),
    classification: { protocol: "tbc-timelock", action: codes[0]!.some(Boolean) ? "spend-or-transition" : "lock", conformance: "standard" },
    timeLocks: Object.freeze(timeLocks), groups: [{ key: "native", asset: { type: "tbc", symbol: "TBC" }, flows }] });
}
