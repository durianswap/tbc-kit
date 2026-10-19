import { bytesToHex, canonicalize } from "@tbc-wallet/core";

import { parseTbcTransaction } from "./testnet-validation.js";

export interface PoolApprovalTransaction {
  readonly id: string;
  readonly role: string;
  readonly dependsOn: readonly string[];
  readonly fee: string;
  readonly unsignedTransaction: string;
}

export interface PoolApprovalUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly classification: string;
  readonly contractId?: string;
  readonly satoshis: string;
  readonly scriptPubKey: string;
}

export interface PoolApprovalBinding {
  readonly bindingHash: string;
  readonly payload: Readonly<{ readonly expiresAt: string }>;
}

/** Exact material membership; ordering and repeated references are immaterial. */
export function containsCanonicalEvidence(
  current: readonly unknown[],
  expected: readonly unknown[],
): boolean {
  if (expected.length === 0) return true;
  const encoded = new Set(current.map((item) => canonicalize(item)));
  return expected.every((item) => encoded.has(canonicalize(item)));
}

/** Bounded Pool removal recipe: one FTLP maintenance prefix, then its dependent primary. */
export function collectPoolRemoveInputEvidence(
  transactions: readonly Readonly<PoolApprovalTransaction>[],
  utxos: readonly Readonly<PoolApprovalUtxo>[],
  poolContractId: string,
): Readonly<{
  readonly inputOutpoints: readonly string[];
  readonly externalOutpoints: readonly string[];
}> {
  const fail = (): never => {
    throw new Error("Unbound Pool removal maintenance inputs");
  };
  if (transactions.length === 1) {
    const inputOutpoints = collectTransactionInputOutpoints(transactions);
    return Object.freeze({ inputOutpoints, externalOutpoints: inputOutpoints });
  }
  const [prefix, primary] = transactions;
  if (
    transactions.length !== 2 ||
    !prefix ||
    !primary ||
    prefix.id !== "ftlp-merge-0" ||
    prefix.role !== "maintenance" ||
    prefix.dependsOn.length !== 0 ||
    primary.id !== "pool-liquidity-remove" ||
    primary.role !== "primary" ||
    canonicalize(primary.dependsOn) !== canonicalize([prefix.id])
  )
    return fail();
  const maintenance = parseTbcTransaction(prefix.unsignedTransaction);
  const snapshot = new Map(utxos.map((utxo) => [`${utxo.txid}:${utxo.vout}`, utxo]));
  const selected = maintenance.inputs.map((input) => {
    const utxo = snapshot.get(`${input.txid}:${input.vout}`);
    if (!utxo) return fail();
    return utxo;
  });
  if (
    selected.some(
      (utxo) =>
        !["ftlp", "native"].includes(utxo.classification) ||
        (utxo.classification === "ftlp" && utxo.contractId !== poolContractId),
    )
  )
    fail();
  const lp = selected.filter((utxo) => utxo.classification === "ftlp");
  const native = selected.filter((utxo) => utxo.classification === "native");
  const [code, tape, change] = maintenance.outputs;
  if (
    lp.length < 2 ||
    native.length !== 1 ||
    maintenance.outputs.length !== 3 ||
    !code ||
    !tape ||
    !change ||
    lp.some(
      (utxo) =>
        utxo.scriptPubKey !== bytesToHex(code.scriptPubKey) ||
        utxo.satoshis !== code.satoshis.toString(),
    ) ||
    tape.satoshis !== 0n ||
    tape.scriptPubKey.length === 0 ||
    change.satoshis <= 0n ||
    bytesToHex(change.scriptPubKey) !== native[0]?.scriptPubKey ||
    selected.reduce((total, utxo) => total + BigInt(utxo.satoshis), 0n) -
      maintenance.outputs.reduce((total, output) => total + output.satoshis, 0n) !==
      BigInt(prefix.fee) ||
    BigInt(prefix.fee) <= 0n
  )
    fail();
  const zero = "0".repeat(64);
  const dependent = parseTbcTransaction(primary.unsignedTransaction).inputs.filter(
    (input) => input.txid === zero,
  );
  if (
    canonicalize(dependent.map((input) => input.vout).sort()) !==
    canonicalize([0, 2])
  )
    fail();
  const resolvedOutpoints = transactions.flatMap((transaction) =>
    parseTbcTransaction(transaction.unsignedTransaction).inputs.map((input) =>
      input.txid === zero
        ? `${prefix.id}:${input.vout}`
        : `${input.txid}:${input.vout}`,
    ),
  );
  if (new Set(resolvedOutpoints).size !== resolvedOutpoints.length) fail();
  return Object.freeze({
    inputOutpoints: collectTransactionInputOutpoints(transactions),
    externalOutpoints: Object.freeze(
      resolvedOutpoints.filter((outpoint) => !outpoint.startsWith(`${prefix.id}:`)),
    ),
  });
}

/** One-entry, approval-scoped ancestry read; never a durable authorization. */
export function createPoolRemoveApprovalMaterialReader<T>(
  load: (
    input: Readonly<{
      readonly address: string;
      readonly receiver: string;
      readonly poolContractId: string;
      readonly lpAmount: string;
    }>,
  ) => Promise<T>,
  now: () => number = Date.now,
) {
  return createPoolApprovalMaterialReader(load, now);
}

/** Read-only single-flight; full binding + exact request, never beyond expiry. */
export function createPoolApprovalMaterialReader<T, I>(
  load: (input: I) => Promise<T>,
  now: () => number = Date.now,
): (binding: Readonly<PoolApprovalBinding>, input: I) => Promise<T> {
  let cached: { key: string; value: Promise<T> } | undefined;
  return async (binding, input): Promise<T> => {
    const expires = Date.parse(binding.payload.expiresAt);
    if (!Number.isFinite(expires) || expires <= now()) {
      cached = undefined;
      throw new Error("Pool approval evidence expired");
    }
    const key = canonicalize({ binding, input });
    if (cached?.key !== key) {
      cached = { key, value: Promise.resolve().then(() => load(input)) };
    }
    const entry = cached;
    try {
      const value = await entry.value;
      if (expires <= now()) throw new Error("Pool approval evidence expired");
      return value;
    } catch (error) {
      if (cached === entry) cached = undefined;
      throw error;
    }
  };
}

/** Fresh confirmations can grow; the approved immutable input identity cannot. */
export function matchesCurrentPoolUtxoEvidence(
  planned: Readonly<{ readonly confirmations?: string }>,
  current: Readonly<{ readonly confirmations?: string }>,
  policy?: Readonly<{ readonly minConfirmations: string }>,
): boolean {
  const { confirmations: before, ...plannedIdentity } = planned;
  const { confirmations: after, ...currentIdentity } = current;
  const valid = (value: unknown): value is string =>
    typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= 0xffff_ffffn;
  if ((Object.hasOwn(planned, "confirmations") && !valid(before)) ||
      (Object.hasOwn(current, "confirmations") && !valid(after)) ||
      (policy !== undefined && !valid(policy.minConfirmations))) return false;
  if (before === undefined || after === undefined) {
    // Only the wallet's explicit zero policy can accept unobserved counts.
    // A previously observed count must never be silently downgraded to unknown.
    return before === undefined && policy?.minConfirmations === "0" &&
      canonicalize(plannedIdentity) === canonicalize(currentIdentity);
  }
  return (
    valid(before) && valid(after) &&
    (policy === undefined || BigInt(before) >= BigInt(policy.minConfirmations)) &&
    BigInt(after) >= BigInt(before) &&
    canonicalize(plannedIdentity) === canonicalize(currentIdentity)
  );
}

export function collectTransactionInputOutpoints(
  transactions: readonly Readonly<{ readonly unsignedTransaction: string }>[],
): readonly string[] {
  return Object.freeze(
    transactions.flatMap(({ unsignedTransaction }) =>
      parseTbcTransaction(unsignedTransaction).inputs.map(
        ({ txid, vout }) => `${txid}:${String(vout)}`,
      ),
    ),
  );
}
