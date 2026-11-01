import { type ResolvedTransactionSigningRole } from "./internal/core/index.js";
import type { createApprovedHostTaskReader } from "./approved-host-task.js";
import type { KitHostPortCall } from "./wallet-runtime.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TbcReviewedPolicyMaterial } from "./reviewed-transaction-types.js";
type RecordValue = Readonly<Record<string, unknown>>;
type Evidence = Awaited<ReturnType<ReturnType<typeof createApprovedHostTaskReader>["readReviewed"]>>;
export type TbcReviewedInputSigningTask = Readonly<{
    inputIndex: number;
    accountId: string;
    publicKey: string;
    digest: string;
    algorithm: "secp256k1-ecdsa" | "secp256k1-schnorr";
}>;
/** Wallet-private custody only. The adapter must retain its normal Vault/user
 * authorization and one-shot checks, including when it delegates to MuSig.
 * Stage/request material stays in memory; never log or persist it. */
export interface TbcReviewedRoleSigner {
    readonly approvedTasks: Pick<ReturnType<typeof createApprovedHostTaskReader>, "readReviewed">;
    readonly signStage: (input: Readonly<{
        evidence: Evidence;
        tasks: readonly TbcReviewedInputSigningTask[];
        transactionIndex: number;
        stage: RecordValue;
        /** The exact keyless material to bind at approval and independently
         * reconstruct in custody. Private memory only; never page authority. */
        material: Readonly<{
            format: "raw" | "associated";
            request: RecordValue;
            policyMaterial: TbcReviewedPolicyMaterial;
        }>;
    }>, call: KitHostPortCall) => Promise<readonly string[]>;
}
/** One shared, keyless continuation loop for role-aware raw/associated requests.
 * No HTTP, broadcast, durable writes or key ownership. Only public material is
 * mapped here; Core/Host approval and wallet custody remain authoritative. */
export declare function createReviewedRoleExecutor(): (options: Readonly<{
    native: PoolMaterialNativeProviderInput;
    signer: TbcReviewedRoleSigner;
    request: RecordValue;
    params: RecordValue;
    call: KitHostPortCall;
    format?: "raw" | "associated";
    primary: Readonly<{
        accountId: string;
        publicKey: string;
    }>;
    roles: readonly ResolvedTransactionSigningRole[];
    policyMaterial: TbcReviewedPolicyMaterial;
    assertAuthority: () => Promise<void>;
}>) => Promise<Readonly<{
    transactions: readonly string[];
    detachedSignatures?: readonly (readonly string[])[];
}>>;
export {};
