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
/**
 * Freezes and validates the protocol policy shared by every Pool vertical.
 * `expectedServiceFeeRate` is used by initialize to bind native descriptor
 * policy to the indexed Pool metadata without performing another read.
 */
export declare function createCanonicalPoolPolicy(input: Readonly<{
    lpPlan: number;
    serviceProviderTag: string;
    serviceFeeRate: number;
}>, label?: string, expectedServiceFeeRate?: number): CanonicalPoolPolicy;
/**
 * Deduplicates already identity-checked parent bytes while making the output
 * immutable. The first occurrence wins, so callers retain deterministic
 * ancestry ordering without re-decoding or fetching a parent.
 */
export declare function freezeCanonicalPoolParents(parents: readonly CanonicalPoolParent[]): readonly CanonicalPoolParent[];
/**
 * Chooses one sufficient owner input without merging unrelated fragments.
 * The smallest sufficient balance wins; txid/outputIndex make ties stable.
 */
export declare function selectCanonicalPoolInput<Candidate extends Readonly<{
    txid: string;
    outputIndex: number;
    balance: string;
}>>(candidates: readonly Candidate[], requiredBalance: string): Candidate | undefined;
//# sourceMappingURL=pool-material-helpers.d.ts.map