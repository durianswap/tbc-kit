/** Preview-only refund constraints from an exact Code/witness pair. Caller
 * authenticates its parent; Engine independently checks the actual signer.
 * Claim templates/preimages are never decoded or copied by this helper. */
export declare function associatedHtlcRefundLock(script: string, template: unknown): number | undefined;
/** Public approval terms for one authenticated HTLC prevout. This helper is
 * not an authorizer: callers must bind the full request, authenticate prevouts,
 * and use the Engine's independent prepare/finalize checks before signing.
 * Secret bytes are borrowed locally and never returned, formatted or logged.
 */
export declare function inspectAssociatedHtlcWitness(input: Readonly<{
    scriptPubKey: string;
    unlockingScriptTemplate: string;
    accountAddress: string;
    addressVersion: number;
    sequence: number;
    transactionLockTime: number;
}>): Readonly<{
    branch: "claim" | "refund";
    preimageVerified: boolean;
    disclosureWarning?: string;
}>;
