import type { OperationCheckpoint } from "../checkpoint.js";
import type { ApprovalReceipt } from "../bindings.js";
import type { TransactionRoleRequest, ResolvedTransactionSigningRole } from "../transaction-signing-roles.js";
export declare function assertCryptoOutcome(params: unknown, result: CryptoResult, task: CryptoTask, approval: ApprovalReceipt): void;
export declare function assertReviewedOutcome(params: unknown, result: ReviewedTransactionResult, task: ReviewedTransactionTask, review: Pick<ReviewedTransactionReview, "payload" | "reviewHash">, account: AccountIdentity, approval: ApprovalReceipt): void;
type EncodedMessage = Readonly<{
    encoding: "utf8" | "hex" | "base64";
    data: string;
}>;
type CryptoStep = Readonly<{
    id: string;
    algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
}> & (Readonly<{
    kind: "encrypt";
    message: EncodedMessage;
}> | Readonly<{
    kind: "decrypt";
    ciphertext: string;
}>);
interface ReviewedTransactionStep {
    readonly id: string;
    readonly request: Readonly<Record<string, unknown>>;
    readonly signingRoles?: TransactionRoleRequest["signingRoles"];
}
export interface AccountIdentity {
    readonly address: string;
    readonly accountId: string;
    readonly chainId: string;
    readonly publicKey: string;
}
export type CryptoTask = Readonly<{
    readonly taskId: string;
    readonly purpose: "encrypt" | "decrypt";
    readonly algorithm: CryptoStep["algorithm"];
    readonly origin: string;
    readonly accountId: string;
    readonly publicKey: string;
    readonly message?: EncodedMessage;
    readonly ciphertext?: string;
}>;
export type CryptoResult = Readonly<{
    readonly taskId: string;
    readonly algorithm: CryptoStep["algorithm"];
    readonly ciphertext?: string;
    readonly message?: EncodedMessage;
}>;
export type ReviewedPolicyMaterial = Readonly<{
    readonly resolvedOutputs: readonly Readonly<{
        readonly txid: string;
        readonly vout: number;
        readonly satoshis: string;
        readonly scriptPubKey: string;
    }>[];
}>;
export type ReviewedTransactionTask = Readonly<{
    readonly signingRoles?: readonly ResolvedTransactionSigningRole[];
    readonly taskId: string;
    readonly purpose: "reviewedTransaction";
    readonly contextHash: string;
    readonly requestHash: string;
    readonly reviewHash: string;
    readonly policyMaterial: ReviewedPolicyMaterial;
    readonly chainId: string;
    readonly accountId: string;
    readonly publicKey: string;
    readonly request: Readonly<Record<string, unknown>>;
}>;
export type ReviewedTransactionReview = Readonly<{
    readonly stepId: string;
    readonly payload: Readonly<{
        readonly preview: Readonly<Record<string, unknown>>;
        readonly totalFee: string;
        readonly expiresAt: string;
        readonly policyMaterial: ReviewedPolicyMaterial;
    }>;
    readonly reviewHash: string;
}>;
export type ReviewedTransactionResult = Readonly<{
    readonly taskId: string;
    readonly reviewHash: string;
    readonly bundle: SignedBundle;
}>;
export declare function reviewedDetachedSignaturesMatch(task: ReviewedTransactionTask, bundle: SignedBundle): boolean;
export interface SignedBundle {
    readonly version: "1.0";
    readonly chainId: string;
    readonly from: string;
    readonly requestHash: string;
    readonly approvalId: string;
    readonly transactions: readonly {
        readonly txid: string;
        readonly role: string;
        readonly [key: string]: unknown;
    }[];
    readonly totalFee: string;
    readonly artifacts?: Readonly<Record<string, string>>;
    readonly detachedSignatures?: readonly (readonly string[])[];
}
export declare function reviewedSigningRoleContext(checkpoint: OperationCheckpoint, step: ReviewedTransactionStep, account: AccountIdentity, memory?: Readonly<Record<string, unknown>>): {
    request: {
        chainId: string;
        from: string;
        request: Readonly<Record<string, unknown>>;
        signingRoles: readonly Readonly<{
            role: "pool-controller" | "coin-admin";
            accountId: string;
        }>[] | undefined;
    };
    accounts: readonly AccountIdentity[];
    roles: readonly Readonly<{
        role: "pool-controller" | "coin-admin";
        account: import("../transaction-signing-roles.js").TransactionRoleAccount;
    }>[] | undefined;
};
export declare function reviewedTransactionTask(checkpoint: OperationCheckpoint, step: ReviewedTransactionStep, review: ReviewedTransactionReview, account: AccountIdentity, memory?: Readonly<Record<string, unknown>>): ReviewedTransactionTask;
export declare function cryptoTask(step: CryptoStep, account: AccountIdentity, origin: string): CryptoTask;
export {};
//# sourceMappingURL=private-action-kernel.d.ts.map