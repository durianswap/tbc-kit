import type { PortCall, PortOperation, PortResponse, SchemaCoreTransition } from "./internal/core/index.js";
export { createSqliteTwsHostStore, type TwsSqliteBindings, type TwsSqliteDriver, type TwsSqliteRow, type TwsSqliteTransaction, type TwsSqliteValue, } from "./internal/host/sqlite.js";
export type KitSqliteValue = null | string | number | Uint8Array;
export type KitSqliteBindings = Readonly<Record<string, KitSqliteValue>>;
export type KitSqliteRow = Readonly<Record<string, KitSqliteValue>>;
export interface KitSqliteRunResult {
    readonly changes: number;
}
export interface KitSqliteTransaction {
    readonly run: (sql: string, bindings?: KitSqliteBindings) => Promise<KitSqliteRunResult>;
    readonly get: (sql: string, bindings?: KitSqliteBindings) => Promise<KitSqliteRow | null>;
    readonly all: (sql: string, bindings?: KitSqliteBindings) => Promise<readonly KitSqliteRow[]>;
}
export interface KitSqliteDriver {
    readonly dialect: "sqlite";
    readonly transaction: <T>(work: (transaction: KitSqliteTransaction) => Promise<T>) => Promise<T>;
    readonly close?: () => Promise<void>;
}
export interface KitSqliteHostStoreOptions {
    readonly driver: KitSqliteDriver;
    /** Use a new namespace for the Kit release; never point it at legacy Host records. */
    readonly namespace: string;
    readonly now?: () => number;
    /** Trusted wallet-bootstrap SHA-256 primitive for the shared private Kit runtime. */
    readonly sha256?: TbcKitStoreSha256Backend;
}
export interface KitMemoryHostStoreOptions {
    readonly now?: () => number;
    /** Trusted wallet-bootstrap SHA-256 primitive for the shared private Kit runtime. */
    readonly sha256?: TbcKitStoreSha256Backend;
}
export type TbcKitStoreSha256Backend = (bytes: Uint8Array) => Uint8Array;
declare const kitHostStoreBrand: unique symbol;
/** Opaque same-release store for `createTbcWallet({ storage: { hostStore } })`. */
export interface KitHostStore {
    readonly storeVersion: "1.0";
    readonly [kitHostStoreBrand]: true;
}
export type KitHostJournalStatus = "prepared" | "uncertain" | "completed";
export interface KitHostOperationRecord {
    readonly operationId: string;
    readonly transition: SchemaCoreTransition;
    readonly transitionIdentity: string;
    readonly transitionKind: SchemaCoreTransition["kind"];
    readonly checkpointHash: string;
    readonly revision: string;
    readonly storeRevision: string;
    readonly releaseFingerprint: string;
    readonly terminal: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
}
export type KitHostCallRecord<K extends PortOperation = PortOperation> = K extends PortOperation ? Readonly<{
    callId: string;
    operationId: string;
    operation: K;
    identity: string;
    call: PortCall<K>;
    status: KitHostJournalStatus;
    response?: PortResponse<K>;
    revision: string;
    createdAt: string;
    updatedAt: string;
}> : never;
export type KitProviderCompletion = Extract<SchemaCoreTransition, {
    readonly kind: "complete";
}>["completion"];
export type KitHostDeliveryStatus = "pending" | "delivered";
export interface KitHostDeliveryRecord {
    readonly operationId: string;
    readonly deliveryId: string;
    readonly completionIdentity: string;
    readonly completion: KitProviderCompletion;
    readonly status: KitHostDeliveryStatus;
    readonly revision: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}
/** Read-only, same-release journal evidence. It cannot mutate or drive recovery. */
export interface KitHostEvidenceReader {
    readonly readOperation: (operationId: string) => Promise<KitHostOperationRecord | null>;
    readonly readCall: (callId: string) => Promise<KitHostCallRecord | null>;
    readonly readDelivery: (operationId: string) => Promise<KitHostDeliveryRecord | null>;
}
export interface KitPostSignerRecoveryCandidate {
    readonly operationId: string;
    readonly state: "broadcasting" | "reconciliation";
    readonly authority: Readonly<{
        currentContext: SchemaCoreTransition["checkpoint"]["payload"]["context"];
        currentSession: SchemaCoreTransition["checkpoint"]["payload"]["session"];
    }>;
    readonly createdAt: string;
    readonly updatedAt: string;
}
export interface KitPostSignerRecoveryReader {
    /** Lists only post-Signer wallet-broadcast work; approval/signing is never selected. */
    readonly list: (limit?: number) => Promise<readonly KitPostSignerRecoveryCandidate[]>;
}
export declare const TBC_KIT_HOST_RELEASE_FINGERPRINT: "8c2a5a935335463ecedef622011c187c645a9130df1b18610b0fba1262504ce9";
export declare const TBC_KIT_HOST_SQLITE_SCHEMA_VERSION = 1;
export declare const TBC_KIT_HOST_SQLITE_TABLES: readonly ["tws_host_metadata", "tws_host_operations", "tws_host_calls", "tws_host_session_commits", "tws_host_deliveries", "tws_host_leases"];
export declare const TBC_KIT_HOST_SQLITE_MAX_CANONICAL_JSON_BYTES: number;
export declare function createTbcKitSqliteHostStore(options: KitSqliteHostStoreOptions): KitHostStore;
/**
 * Same-release Host journal for one live session. It preserves exact Host
 * validation and read-only approval evidence, but intentionally does not
 * survive process loss. Use the SQLite store for wallet-owned submission and
 * recovery flows.
 */
export declare function createTbcKitMemoryHostStore(options?: KitMemoryHostStoreOptions): KitHostStore;
export declare function createTbcKitHostEvidenceReader(store: KitHostStore): KitHostEvidenceReader;
export declare function createTbcKitPostSignerRecoveryReader(store: KitHostStore): KitPostSignerRecoveryReader;
export { TbcKitBroadcastConflictError, createTbcKitSqliteBroadcastJournal, type CreateTbcKitSqliteBroadcastJournalOptions, type TbcKitBroadcastIdentity, type TbcKitBroadcastJournal, type TbcKitBroadcastJournalRecord, type TbcKitBroadcastJournalSchema, type TbcKitBroadcastPreNetworkAbortEvidence, } from "./broadcast-journal.js";
