/**
 * Pure Kit-owned Pool material helpers.
 *
 * These helpers consume already-validated records from PoolMaterialSource or
 * the restricted native adapter. They never read a network, wallet Port,
 * signer, key store or durable journal.
 */

export type CanonicalPoolPolicy = Readonly<{
  lpPlan: number;
  serviceProviderTag: string;
  serviceFeeRate: number;
}>;

export type CanonicalPoolParent = Readonly<{
  txid: string;
  rawTransaction: string;
}>;

const HASH32 = /^[0-9a-f]{64}$/u;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/u;

/**
 * Freezes and validates the protocol policy shared by every Pool vertical.
 * `expectedServiceFeeRate` is used by initialize to bind native descriptor
 * policy to the indexed Pool metadata without performing another read.
 */
export function createCanonicalPoolPolicy(
  input: Readonly<{
    lpPlan: number;
    serviceProviderTag: string;
    serviceFeeRate: number;
  }>,
  label = "Pool",
  expectedServiceFeeRate?: number,
): CanonicalPoolPolicy {
  if (
    !Number.isSafeInteger(input.lpPlan) ||
    input.lpPlan < 1 ||
    input.lpPlan > 6 ||
    !Number.isSafeInteger(input.serviceFeeRate) ||
    input.serviceFeeRate < 0 ||
    input.serviceProviderTag.length === 0 ||
    input.serviceProviderTag.length > 64 ||
    !PRINTABLE_ASCII.test(input.serviceProviderTag) ||
    (expectedServiceFeeRate !== undefined &&
      input.serviceFeeRate !== expectedServiceFeeRate)
  ) {
    throw new Error(`Invalid canonical ${label} policy`);
  }
  return Object.freeze({
    lpPlan: input.lpPlan,
    serviceProviderTag: input.serviceProviderTag,
    serviceFeeRate: input.serviceFeeRate,
  });
}

/**
 * Deduplicates already identity-checked parent bytes while making the output
 * immutable. The first occurrence wins, so callers retain deterministic
 * ancestry ordering without re-decoding or fetching a parent.
 */
export function freezeCanonicalPoolParents(
  parents: readonly CanonicalPoolParent[],
): readonly CanonicalPoolParent[] {
  const seen = new Set<string>();
  const result: CanonicalPoolParent[] = [];
  for (const parent of parents) {
    if (
      !HASH32.test(parent.txid) ||
      typeof parent.rawTransaction !== "string" ||
      parent.rawTransaction.length === 0
    ) {
      throw new Error("Invalid canonical Pool parent material");
    }
    if (seen.has(parent.txid)) continue;
    seen.add(parent.txid);
    result.push(
      Object.freeze({
        txid: parent.txid,
        rawTransaction: parent.rawTransaction,
      }),
    );
  }
  return Object.freeze(result);
}

/**
 * Chooses one sufficient owner input without merging unrelated fragments.
 * The smallest sufficient balance wins; txid/outputIndex make ties stable.
 */
export function selectCanonicalPoolInput<
  Candidate extends Readonly<{
    txid: string;
    outputIndex: number;
    balance: string;
  }>,
>(candidates: readonly Candidate[], requiredBalance: string): Candidate | undefined {
  const required = BigInt(requiredBalance);
  return [...candidates]
    .filter((candidate) => BigInt(candidate.balance) >= required)
    .sort((left, right) =>
      BigInt(left.balance) === BigInt(right.balance)
        ? left.txid.localeCompare(right.txid) ||
          left.outputIndex - right.outputIndex
        : BigInt(left.balance) < BigInt(right.balance)
          ? -1
          : 1,
    )[0];
}
