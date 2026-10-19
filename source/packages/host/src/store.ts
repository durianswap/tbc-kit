import type {
  PortCall,
  PortOperation,
  PortResponse,
  SchemaCoreTransition,
} from "@tbc-wallet/core";
import type {
  TwsAuthoritySnapshot,
  TwsProviderCompletion,
  TwsProviderSessionCommitAck,
  TwsProviderSessionMutation,
} from "./types.js";

export type TwsHostJournalStatus = "prepared" | "uncertain" | "completed";

export interface TwsHostLeaseRecord {
  readonly operationId: string;
  readonly ownerId: string;
  readonly fencingToken: string;
  readonly expiresAt: string;
}

export interface TwsHostOperationRecord {
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

export type TwsHostCallRecord<K extends PortOperation = PortOperation> =
  K extends PortOperation
    ? Readonly<{
        callId: string;
        operationId: string;
        operation: K;
        identity: string;
        call: PortCall<K>;
        status: TwsHostJournalStatus;
        response?: PortResponse<K>;
        revision: string;
        createdAt: string;
        updatedAt: string;
      }>
    : never;

export interface TwsHostSessionCommitRecord {
  readonly commitId: string;
  readonly operationId: string;
  readonly identity: string;
  readonly mutation: TwsProviderSessionMutation;
  readonly expectedAuthorityIdentity: string;
  readonly expectedAuthority: TwsAuthoritySnapshot;
  readonly status: TwsHostJournalStatus;
  readonly acknowledgment?: TwsProviderSessionCommitAck;
  readonly authority?: TwsAuthoritySnapshot;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TwsHostDeliveryStatus = "pending" | "delivered";

export interface TwsHostDeliveryRecord {
  readonly operationId: string;
  readonly deliveryId: string;
  readonly completionIdentity: string;
  readonly completion: TwsProviderCompletion;
  readonly status: TwsHostDeliveryStatus;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TwsHostOperationCas {
  readonly storeRevision: string;
  readonly checkpointHash: string;
}

export interface TwsHostTransitionCommitInput {
  readonly lease: TwsHostLeaseRecord;
  readonly expected: TwsHostOperationCas | null;
  readonly transition: SchemaCoreTransition;
}

export interface TwsHostTransitionCommitResult {
  readonly operation: TwsHostOperationRecord;
  readonly calls: readonly TwsHostCallRecord[];
  readonly sessionCommit?: TwsHostSessionCommitRecord;
  readonly delivery?: TwsHostDeliveryRecord;
}

export interface TwsHostRecoverableQuery {
  readonly releaseFingerprint: string;
  readonly limit?: number;
}

export interface TwsHostStore {
  readonly storeVersion: "1.0";

  readonly readOperation: (
    operationId: string,
  ) => Promise<TwsHostOperationRecord | null>;
  readonly listRecoverable: (
    query: TwsHostRecoverableQuery,
  ) => Promise<readonly TwsHostOperationRecord[]>;
  readonly commitTransition: (
    input: TwsHostTransitionCommitInput,
  ) => Promise<TwsHostTransitionCommitResult>;

  readonly readCall: (callId: string) => Promise<TwsHostCallRecord | null>;
  readonly markCallUncertain: <K extends PortOperation>(input: {
    readonly lease: TwsHostLeaseRecord;
    readonly call: PortCall<K>;
  }) => Promise<TwsHostCallRecord<K>>;
  readonly completeCall: <K extends PortOperation>(input: {
    readonly lease: TwsHostLeaseRecord;
    readonly call: PortCall<K>;
    readonly response: PortResponse<K>;
  }) => Promise<TwsHostCallRecord<K>>;

  readonly readSessionCommit: (
    commitId: string,
  ) => Promise<TwsHostSessionCommitRecord | null>;
  readonly markSessionCommitUncertain: (input: {
    readonly lease: TwsHostLeaseRecord;
    readonly mutation: TwsProviderSessionMutation;
  }) => Promise<TwsHostSessionCommitRecord>;
  readonly completeSessionCommit: (input: {
    readonly lease: TwsHostLeaseRecord;
    readonly mutation: TwsProviderSessionMutation;
    readonly acknowledgment: TwsProviderSessionCommitAck;
    readonly authority: TwsAuthoritySnapshot;
  }) => Promise<TwsHostSessionCommitRecord>;

  readonly readDelivery: (
    operationId: string,
  ) => Promise<TwsHostDeliveryRecord | null>;
  readonly markDeliveryDelivered: (input: {
    readonly lease: TwsHostLeaseRecord;
    readonly operationId: string;
    readonly deliveryId: string;
    readonly completionIdentity: string;
  }) => Promise<TwsHostDeliveryRecord>;

  readonly acquireLease: (input: {
    readonly operationId: string;
    readonly ownerId: string;
    readonly ttlMs: number;
  }) => Promise<TwsHostLeaseRecord | null>;
  readonly renewLease: (input: {
    readonly lease: TwsHostLeaseRecord;
    readonly ttlMs: number;
  }) => Promise<TwsHostLeaseRecord>;
  readonly releaseLease: (input: {
    readonly lease: TwsHostLeaseRecord;
  }) => Promise<boolean>;
}
