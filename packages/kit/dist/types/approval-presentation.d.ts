import { type ApprovalHostEvidenceEnvelope, type ApprovalHostRequestShape } from "./approval-host-evidence.js";
export type TbcApprovalPresentationSource = "core-binding" | "engine-preview" | "engine-plan" | "bound-request" | "preparation-scope";
export type TbcApprovalPresentationField<Value> = Readonly<{
    status: "known";
    value: Value;
    source: TbcApprovalPresentationSource;
}> | Readonly<{
    status: "unknown";
    reason: "NOT_BOUND" | "NOT_AVAILABLE";
}>;
export interface TbcApprovalPresentationAmount {
    /** Canonical smallest-unit integer from the bound Engine preview. */
    readonly atomic: string;
    readonly precision: TbcApprovalPresentationField<number>;
    readonly display: TbcApprovalPresentationField<string>;
}
export interface TbcApprovalPresentationAsset {
    readonly kind: string;
    readonly direction: string;
    readonly contractId: TbcApprovalPresentationField<string>;
    readonly symbol: TbcApprovalPresentationField<string>;
    readonly amount: TbcApprovalPresentationAmount;
    readonly from: TbcApprovalPresentationField<string>;
    readonly to: TbcApprovalPresentationField<string>;
    readonly source: "engine-preview";
}
export interface TbcApprovalContractExecution {
    readonly businessType: string;
    readonly implementation: string;
    readonly generation: "current" | "historical";
}
export interface TbcApprovalPresentationStep {
    readonly id: string;
    readonly kind: string;
    readonly dependsOn: readonly string[];
    readonly businessType: TbcApprovalPresentationField<string>;
    readonly contractExecution: TbcApprovalPresentationField<TbcApprovalContractExecution>;
    /** Bound intent display projection; HTLC preimages are omitted, not unbound. */
    readonly businessTerms: TbcApprovalPresentationField<Readonly<Record<string, unknown>>>;
    readonly assets: readonly TbcApprovalPresentationAsset[];
    readonly actualFeeAtomic: TbcApprovalPresentationField<string>;
    readonly signingTaskCount: TbcApprovalPresentationField<number>;
    /** Step-local warnings. Never attribute a flattened batch warning to every step. */
    readonly warnings: readonly string[];
    /** Chain transactions, not workflow steps. Never duplicate aggregate flows. */
    readonly transactions: readonly TbcApprovalPresentationTransaction[];
    readonly transactionsStatus: "not-bound" | "available" | "not-available" | "not-applicable";
}
export interface TbcApprovalPresentationTransaction {
    readonly id: string;
    readonly role: TbcApprovalPresentationField<string>;
    readonly dependsOn: readonly string[];
    /** A template commitment, never presented as a broadcast txid. */
    readonly templateHash: TbcApprovalPresentationField<string>;
    readonly feeAtomic: TbcApprovalPresentationField<string>;
    readonly assets: readonly TbcApprovalPresentationAsset[];
    readonly assetsStatus: "available" | "step-summary-only";
    readonly warnings: readonly string[];
    /** Exact output balances, NOT net user debits. Includes change/internal/pool
     * outputs; do not sum with the business summary or with network fees. */
    readonly outputs: readonly TbcApprovalPresentationOutput[];
    readonly outputsStatus: "available" | "partial" | "not-available";
}
export interface TbcApprovalPresentationOutput {
    readonly outputIndices: readonly number[];
    readonly kind: string;
    /** Code identity / NFT origin, not an invented API contract ID. */
    readonly assetIdentity: TbcApprovalPresentationField<string>;
    readonly amountAtomic: TbcApprovalPresentationField<string>;
    readonly recipient: TbcApprovalPresentationField<string>;
    readonly nativeValueAtomic: string;
    readonly lockTime: TbcApprovalPresentationField<number>;
    readonly warnings: readonly string[];
}
export interface TbcApprovalPresentation {
    readonly version: "1.0";
    readonly phase: "preparation" | "formal";
    readonly trust: "intent-bounded" | "binding-verified";
    readonly method: string;
    readonly operationKind: string;
    readonly prepared: boolean;
    readonly businessType: TbcApprovalPresentationField<string>;
    /** Actual successful Engine route; unknown during early consent, never inferred from an API label. */
    readonly contractExecution: TbcApprovalPresentationField<TbcApprovalContractExecution>;
    /** Bound intent display projection, excluding HTLC preimages and Prepared material. */
    readonly businessTerms: TbcApprovalPresentationField<Readonly<Record<string, unknown>>>;
    readonly requester: TbcApprovalPresentationField<Readonly<{
        transport: string;
        origin: string;
        topOrigin: string;
        frame: string;
    }>>;
    readonly chainId: TbcApprovalPresentationField<string>;
    readonly accountId: TbcApprovalPresentationField<string>;
    /** Additional authority; workflow roles apply only to the named step, not the entire batch. */
    readonly signingRoles?: TbcApprovalPresentationField<readonly Readonly<{
        role: "pool-controller" | "coin-admin";
        accountId: string;
        stepId?: string;
    }>[]>;
    readonly expiresAt: TbcApprovalPresentationField<string>;
    readonly fees: Readonly<{
        maximumAtomic: TbcApprovalPresentationField<string>;
        actualAtomic: TbcApprovalPresentationField<string>;
    }>;
    readonly counts: Readonly<{
        steps: TbcApprovalPresentationField<number>;
        transactions: TbcApprovalPresentationField<number>;
        signingTasks: TbcApprovalPresentationField<number>;
    }>;
    readonly assets: readonly TbcApprovalPresentationAsset[];
    readonly steps: readonly TbcApprovalPresentationStep[];
    readonly transactions: readonly TbcApprovalPresentationTransaction[];
    readonly transactionsStatus: TbcApprovalPresentationStep["transactionsStatus"];
    readonly warnings: readonly string[];
    readonly binding: Readonly<{
        status: "not-created" | "verified";
        requestHash: string;
        operationHash?: string;
        bindingHash?: string;
    }>;
    readonly evidence: Readonly<{
        sources: readonly TbcApprovalPresentationSource[];
        previewHash?: string;
        callId?: string;
        operationId?: string;
        releaseFingerprint?: string;
    }>;
    /** Fields intentionally unavailable from the currently bound evidence. */
    readonly unknown: readonly string[];
}
export interface TbcApprovalPreparationPresentationInput {
    readonly method: string;
    readonly operationKind: string;
    readonly requestHash: string;
    readonly chainId?: string;
    readonly accountId?: string;
    readonly suggestedFeeCapAtomic?: string;
    readonly warningScope: readonly string[];
    readonly expiresAt: number;
    readonly request: unknown;
}
/**
 * Purely projects one already validated Host approval checkpoint into a UI
 * model. It performs no I/O, metadata lookup, planning, signing or persistence.
 */
export declare function projectTbcApprovalPresentation(evidence: ApprovalHostEvidenceEnvelope<ApprovalHostRequestShape>): TbcApprovalPresentation;
/**
 * Projects the early bounded-intent phase without waiting for Chain Data or an
 * Engine plan. It is deliberately not formal approval and does not infer asset
 * flows, actual fees or signing counts from business intent.
 */
export declare function projectTbcApprovalPreparation(input: TbcApprovalPreparationPresentationInput): TbcApprovalPresentation;
//# sourceMappingURL=approval-presentation.d.ts.map