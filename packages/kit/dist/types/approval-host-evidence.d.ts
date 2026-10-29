export type ApprovalHostEvidencePerformanceStage = "call-read" | "call-clone" | "params-clone" | "operation-read" | "operation-clone";
export interface ApprovalHostEvidencePerformanceEvent {
    readonly component: "approval-host-evidence";
    readonly stage: ApprovalHostEvidencePerformanceStage;
    readonly durationMs: number;
    readonly count: 1;
    /** UTF-8 canonical JSON bytes for clone stages; zero for store reads. */
    readonly bytes: number;
}
export declare class ApprovalHostEvidenceConflictError extends Error {
    readonly name = "ApprovalHostEvidenceConflictError";
}
export interface ApprovalHostRequestShape {
    readonly binding: Readonly<{
        readonly bindingHash: string;
    }>;
    readonly preview: unknown;
}
export interface ApprovalHostEvidenceEnvelope<Request extends ApprovalHostRequestShape> {
    readonly callId: string;
    readonly operationId: string;
    readonly releaseFingerprint: string;
    readonly call: Readonly<Record<string, unknown>>;
    readonly params: Request;
    readonly operation: Readonly<Record<string, unknown>>;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly memory: Readonly<Record<string, unknown>>;
}
export interface ApprovalHostEvidenceReader<Request extends ApprovalHostRequestShape> {
    readonly read: (callId: string, bindingHash: string) => Promise<ApprovalHostEvidenceEnvelope<Request>>;
}
export interface WalletActionApprovalHostRequest extends ApprovalHostRequestShape {
    readonly version: "1.0";
}
export type WalletActionApprovalTaskSummary = Readonly<{
    readonly purpose: "reviewedTransaction";
    readonly taskId: string;
    readonly requestHash: string;
    readonly reviewHash: string;
}> | Readonly<{
    readonly purpose: "encrypt" | "decrypt";
    readonly taskId: string;
    readonly algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
}>;
export interface WalletActionApprovalEvidence {
    readonly kind: "reviewed-transaction" | "crypto";
    readonly method: "tbc_signReviewedTransaction" | "tbc_encrypt" | "tbc_decrypt";
    readonly request: Readonly<Record<string, unknown>>;
    readonly requestHash: string;
    readonly contextHash: string;
    readonly origin: string;
    readonly chainId: string;
    readonly accountId: string;
    readonly from: string;
    readonly expiresAt: string;
    readonly planHash: string;
    readonly approvalBinding: Readonly<{
        readonly payload: Readonly<{
            readonly version: "1.0";
            readonly method: string;
            readonly operationKind: string;
            readonly contextHash: string;
            readonly origin: string;
            readonly sessionId: string;
            readonly chainId?: string;
            readonly chainIds?: readonly string[];
            readonly accountId?: string;
            readonly requestHash: string;
            readonly operationHash: string;
            readonly expiresAt: string;
        }>;
        readonly bindingHash: string;
    }>;
    readonly preview: Readonly<Record<string, unknown>>;
    readonly task: WalletActionApprovalTaskSummary;
}
export interface StablecoinApprovalHostRequest extends ApprovalHostRequestShape {
    readonly version: "1.0";
}
export interface StablecoinApprovalEvidence {
    readonly kind: "stablecoin";
    readonly operation: "transfer" | "merge";
    readonly requestHash: string;
    readonly planHash: string;
    readonly approvalBindingHash: string;
    readonly chainId: string;
    readonly accountId: string;
    readonly source: string;
    readonly recipient: string;
    readonly contractId: string;
    /** The contract genesis transaction. It is not the coinNFT contract id. */
    readonly creationTxid: string;
    readonly rawAmount: string;
    readonly assetInputCount: number;
    readonly feeAtomic: string;
    /** Every planned transaction input, in transaction then input order. */
    readonly inputOutpoints: readonly Readonly<{
        readonly txid: string;
        readonly vout: number;
    }>[];
    readonly transactionCount: number;
    readonly preview: Readonly<Record<string, unknown>>;
}
/**
 * Validates and projects stablecoin approval display data from the exact Host
 * checkpoint that requested approval. This is a pure, read-free boundary: it
 * neither refreshes chain material nor signs or persists anything.
 */
export declare function assertStablecoinApprovalEvidence(evidence: ApprovalHostEvidenceEnvelope<StablecoinApprovalHostRequest>): StablecoinApprovalEvidence;
/**
 * Validates and projects a wallet-action approval from one detached Host
 * evidence envelope. This function performs no I/O and cannot turn DApp/page
 * input into trusted authority. Pass only the result of the trusted wallet's
 * createApprovalHostEvidenceReader instance.
 */
export declare function assertWalletActionApprovalEvidence(evidence: ApprovalHostEvidenceEnvelope<WalletActionApprovalHostRequest>): WalletActionApprovalEvidence;
/**
 * Minimal read-only structural boundary accepted from any Host release.
 * Runtime record identity and shape are verified inside this module.
 */
export interface ApprovalHostEvidenceStoreReader {
    readonly readCall: (callId: string) => Promise<unknown | null>;
    readonly readOperation: (operationId: string) => Promise<unknown | null>;
}
export interface ApprovalHostEvidenceReaderOptions<Request extends ApprovalHostRequestShape> {
    readonly store: ApprovalHostEvidenceStoreReader;
    /** Exact release fingerprint of the Host that owns `store`; no default. */
    readonly releaseFingerprint: string;
    readonly parseApprovalRequest: (value: unknown) => Request;
    /** Wallet-specific error identity; it cannot change conflict semantics. */
    readonly createConflictError?: (message: string) => Error;
    /** Sanitized diagnostics only. Observer failures never alter evidence reads. */
    readonly onPerformance?: (event: ApprovalHostEvidencePerformanceEvent) => void;
}
/**
 * Reads and verifies the generic authoritative Host envelope for one approval.
 * Operation-specific artifacts, material re-reads, display and policy remain
 * outside this reader and must consume the returned exact payload and memory.
 */
export declare function createApprovalHostEvidenceReader<Request extends ApprovalHostRequestShape>(options: ApprovalHostEvidenceReaderOptions<Request>): ApprovalHostEvidenceReader<Request>;
//# sourceMappingURL=approval-host-evidence.d.ts.map