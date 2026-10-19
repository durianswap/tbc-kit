import { type ApprovalBinding } from "../bindings.js";
import { type OperationCheckpoint } from "../checkpoint.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
import { type AccountIdentity, type CryptoTask, type ReviewedTransactionTask, type ReviewedTransactionReview } from "./private-action-kernel.js";
type RecordValue = Readonly<Record<string, unknown>>;
type Review = Pick<ReviewedTransactionReview, "payload" | "reviewHash">;
export type WalletActionMethod = "tbc_signReviewedTransaction" | "tbc_encrypt" | "tbc_decrypt";
export type WalletActionTaskSummary = Readonly<{
    readonly purpose: "reviewedTransaction";
    readonly taskId: string;
    readonly requestHash: string;
    readonly reviewHash: string;
}> | Readonly<{
    readonly purpose: "encrypt" | "decrypt";
    readonly taskId: string;
    readonly algorithm: CryptoTask["algorithm"];
}>;
export interface WalletActionApprovalEvidence {
    readonly kind: "reviewed-transaction" | "crypto";
    readonly method: WalletActionMethod;
    readonly request: Readonly<Record<string, unknown>>;
    readonly requestHash: string;
    readonly contextHash: string;
    readonly origin: string;
    readonly chainId: string;
    readonly accountId: string;
    readonly from: string;
    readonly expiresAt: string;
    readonly planHash: string;
    readonly approvalBinding: ApprovalBinding;
    readonly preview: Readonly<Record<string, unknown>>;
    readonly task: WalletActionTaskSummary;
}
export interface WalletActionApprovalEvidenceInput {
    readonly checkpoint: unknown;
    readonly approvalCall: unknown;
    readonly approvalRequest: unknown;
}
export declare function isWalletAction(method: string): boolean;
export declare function beginWalletAction(checkpoint: OperationCheckpoint, account: AccountIdentity, memory: Readonly<Record<string, unknown>>): CoreTransition;
export declare function reduceWalletActionReview(checkpoint: OperationCheckpoint, call: PortCall, value: unknown): CoreTransition;
export declare function assertWalletActionApproval(checkpoint: OperationCheckpoint): {
    plan: Readonly<{
        payload: Readonly<{
            requestHash: string;
            contextHash: string;
            chainId: string;
            accountId: string;
            expiresAt: string;
            task: CryptoTask | ReviewedTransactionTask;
            preview: RecordValue;
            review?: Review;
        }>;
        planHash: string;
    }>;
    account: AccountIdentity;
    binding: ApprovalBinding;
};
/**
 * Verifies and projects one wallet-action approval from an authoritative Host
 * checkpoint. Hash-valid input is not authority by itself: callers must obtain
 * all three values from the same trusted Host evidence read.
 */
export declare function assertWalletActionApprovalEvidence(input: WalletActionApprovalEvidenceInput): WalletActionApprovalEvidence;
export declare function reduceWalletActionApproval(checkpoint: OperationCheckpoint, call: PortCall, value: unknown): CoreTransition;
export declare function reduceWalletActionResult(checkpoint: OperationCheckpoint, call: PortCall, value: unknown): CoreTransition;
export {};
