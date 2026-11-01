import { type BroadcastSubmitResult } from "./core-runtime.js";
import type { KitSqliteDriver } from "./sqlite.js";
export type TbcKitBroadcastJournalSchema = "kit-v1" | "legacy-tws-mobile-v1";
export interface TbcKitBroadcastIdentity {
    readonly idempotencyKey: string;
    readonly rawHash: string;
    readonly txid: string;
    /** Digest of the exact trusted Host submit call. Older journal rows omit it. */
    readonly submitContextHash?: string;
    /** Digest of the wallet-owned active account scope. Older rows omit it. */
    readonly accountScopeHash?: string;
}
export interface TbcKitBroadcastPreparation {
    readonly record: TbcKitBroadcastJournalRecord;
    /** True only for the caller that atomically created this submit intent. */
    readonly created: boolean;
}
export interface TbcKitBroadcastBatchPreparation {
    /** Exact input order; null means another batch owns only part of this identity set. */
    readonly records: readonly (TbcKitBroadcastJournalRecord | null)[];
    /** True only when this caller atomically created every submit intent. */
    readonly created: boolean;
}
export interface TbcKitBroadcastJournalRecord extends TbcKitBroadcastIdentity {
    readonly state: "prepared" | "uncertain" | "completed" | "not-submitted";
    readonly createdAt: string;
    readonly result?: BroadcastSubmitResult;
}
export type TbcKitBroadcastPreNetworkAbortEvidence = Readonly<{
    version: "1.0";
    kind: "local-preflight";
    failureCode: "INVALID_INPUT" | "NODE_RESPONSE_INVALID";
}> | Readonly<{
    version: "1.0";
    kind: "historical-reconciliation";
    networkPostCount: 0;
    chainStatus: "unknown";
    observedInputs: readonly Readonly<{
        txid: string;
        vout: number;
        satoshis: string;
        unspent: true;
    }>[];
    tipHeight: string;
    tipHash: string;
    observedAt: string;
}>;
export interface TbcKitBroadcastJournal {
    readonly beginSubmit: (identity: TbcKitBroadcastIdentity) => Promise<TbcKitBroadcastPreparation>;
    readonly beginSubmitBatch: (identities: readonly TbcKitBroadcastIdentity[]) => Promise<TbcKitBroadcastBatchPreparation>;
    readonly prepare: (identity: TbcKitBroadcastIdentity) => Promise<TbcKitBroadcastJournalRecord>;
    readonly markUncertain: (identity: TbcKitBroadcastIdentity) => Promise<TbcKitBroadcastJournalRecord>;
    readonly complete: (identity: TbcKitBroadcastIdentity, result: BroadcastSubmitResult) => Promise<TbcKitBroadcastJournalRecord>;
    readonly abortPreNetwork: (identity: TbcKitBroadcastIdentity, evidence: TbcKitBroadcastPreNetworkAbortEvidence) => Promise<TbcKitBroadcastJournalRecord>;
    readonly read: (idempotencyKey: string) => Promise<TbcKitBroadcastJournalRecord | null>;
    readonly readByTxids: (txids: readonly string[]) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
    readonly listIncomplete: (limit?: number, scope?: Readonly<{
        idempotencyKeyPrefix?: string;
        accountScopeHash?: string;
    }>) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
}
export interface CreateTbcKitSqliteBroadcastJournalOptions {
    readonly driver: KitSqliteDriver;
    /** Use legacy mode to consume Mobile's existing three tables in place. */
    readonly schema?: TbcKitBroadcastJournalSchema;
    readonly now?: () => number;
}
export declare class TbcKitBroadcastConflictError extends Error {
    readonly name = "TbcKitBroadcastConflictError";
}
export declare function createTbcKitSqliteBroadcastJournal(options: CreateTbcKitSqliteBroadcastJournalOptions): Promise<TbcKitBroadcastJournal>;
