import { inspectHtlcCode } from "./htlc-material.js";
import { bytesToHex } from "./network-bytes.js";
import { tbcAddressFromPublicKeyHash, type parseTbcTransaction } from "./testnet-validation.js";
import type { TbcVerifiedTransactionInput } from "./reviewed-transaction-types.js";
import { inspectAssociatedHtlcWitness } from "./reviewed-htlc-witness.js";

export type HtlcReviewRow = Readonly<{ index: number; txid: string; transaction: ReturnType<typeof parseTbcTransaction>;
  inputs: readonly TbcVerifiedTransactionInput[] }>;
export type HtlcReviewOptions = Readonly<{ addressVersion: number; accountAddress: string; associated: boolean;
  /** Ephemeral exact request row; never copy into the public review. */
  associatedInputs?: readonly Readonly<Record<string, unknown>>[] }>;
const P2PKH = /^76a914([0-9a-f]{40})88ac$/u;

/** Public native HTLC terms only, using prevouts already authenticated by the
 * shared reviewer. No fetch, VM or maturity claim.
 * Detached raw signing cannot determine which branch a later witness selects.
 * Associated input witnesses are checked locally; only public terms escape.
 */
export function inspectReviewedHtlc(row: HtlcReviewRow, options: HtlcReviewOptions) {
  // Ordinary transaction paths do not allocate or decode additional materials.
  if (!row.inputs.some(i => i.scriptPubKey.length === 274) &&
      !row.transaction.outputs.some(o => o.scriptPubKey.length === 137)) return undefined;
  const sides = [row.inputs.map(i => ({ script: i.scriptPubKey, amount: BigInt(i.satoshis) })),
    row.transaction.outputs.map(o => ({ script: bytesToHex(o.scriptPubKey), amount: o.satoshis }))] as const;
  const codes = sides.map(outputs => outputs.map(o => {
    try { return inspectHtlcCode(o.script); } catch { return undefined; }
  }));
  if (!codes.some(side => side.some(Boolean))) return undefined;
  // Never admit caller-supplied witnesses into this public-terms-only path.
  if (row.transaction.inputs.some(i => i.scriptSig.length !== 0)) throw new Error("HTLC raw review requires unsigned inputs");
  const htlcLocks: Readonly<Record<string, unknown>>[] = [];
  sides.forEach((outputs, side) => outputs.forEach((output, index) => {
    const code = codes[side]![index];
    if (output.amount < 0n) throw new Error("Invalid native HTLC amount");
    if (code === undefined) return;
    if (code.lockTime === 0 || code.lockTime > 0x7fff_ffff || output.amount === 0n) throw new Error("Unsupported HTLC terms");
    const sender = tbcAddressFromPublicKeyHash(code.senderHash, options.addressVersion);
    const receiver = tbcAddressFromPublicKeyHash(code.receiverHash, options.addressVersion);
    if (side === 0 && options.accountAddress !== sender && options.accountAddress !== receiver) throw new Error("HTLC review account has no committed role");
    let branch: "unresolved" | "claim" | "refund" = "unresolved";
    let preimageVerified = false;
    if (side === 0 && options.associated) {
      const input = options.associatedInputs?.[index];
      if (input?.scriptSigType !== "other" || typeof input.unfinishedScriptSig !== "string") {
        throw new Error("Invalid associated HTLC witness");
      }
      ({ branch, preimageVerified } = inspectAssociatedHtlcWitness({ scriptPubKey: output.script,
        unlockingScriptTemplate: input.unfinishedScriptSig, accountAddress: options.accountAddress,
        addressVersion: options.addressVersion, sequence: row.transaction.inputs[index]!.sequence,
        transactionLockTime: row.transaction.locktime }));
    }
    htlcLocks.push(Object.freeze({ position: side === 0 ? "input" : "output", index,
      amount: output.amount.toString(), hashlock: code.hashlock, sender, receiver,
      lockTime: code.lockTime, domain: code.lockTime < 500_000_000 ? "height" : "timestamp",
      transactionLockTime: row.transaction.locktime,
      ...(side === 0 ? { sequence: row.transaction.inputs[index]!.sequence } : {}),
      verification: "exact-template", branch, preimageVerified,
      chainMaturityChecked: false, scriptExecutionVerified: false }));
  }));
  if (htlcLocks.length > 256) throw new Error("Too many HTLC terms");
  const fee = sides[0].reduce((sum, o) => sum + o.amount, 0n) - sides[1].reduce((sum, o) => sum + o.amount, 0n);
  if (fee < 0n) throw new Error("Native HTLC transaction overspend");
  return { sides, codes, htlcLocks: Object.freeze(htlcLocks), fee };
}

export function reviewNativeHtlcFlow(row: HtlcReviewRow, options: HtlcReviewOptions,
  material = inspectReviewedHtlc(row, options)): Readonly<Record<string, unknown>> | undefined {
  if (!material) return undefined;
  const { sides, codes, htlcLocks, fee } = material;
  const flows: Readonly<Record<string, unknown>>[] = [];
  const balances = new Map<string, bigint>();
  sides.forEach((outputs, side) => outputs.forEach((output, index) => {
    if (codes[side]![index]) {
      // Conditional value is not assigned unconditionally to either party.
      flows.push({ purpose: side === 0 ? "release" : "lock", direction: side === 0 ? "out" : "in",
        amount: { raw: output.amount.toString() }, recognized: true });
      return;
    }
    const match = P2PKH.exec(output.script);
    if (!match) throw new Error("Unrecognized script in native HTLC review");
    const address = tbcAddressFromPublicKeyHash(match[1]!, options.addressVersion);
    balances.set(address, (balances.get(address) ?? 0n) + (side === 0 ? -output.amount : output.amount));
  }));
  for (const [address, delta] of balances) {
    if (delta === 0n) continue;
    flows.push({ purpose: "transfer", direction: delta > 0n ? "in" : "out", recognized: true,
      amount: { raw: (delta > 0n ? delta : -delta).toString() },
      ...(delta > 0n ? { to: { address } } : { from: { address } }) });
  }
  return Object.freeze({ index: row.index, txid: row.txid, feeSatoshis: fee.toString(),
    classification: { protocol: "tbc-htlc", action: codes[0]!.some(Boolean) ? "spend-or-transition" : "lock", conformance: "standard" },
    htlcLocks: Object.freeze(htlcLocks), groups: [{ key: "native", asset: { type: "tbc", symbol: "TBC" }, flows }] });
}
