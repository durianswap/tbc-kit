import {
  TWS_HOST_PORT_NAMES,
  TWS_RELEASE,
  TWS_RELEASE_FINGERPRINT,
  advanceCheckpoint,
  assertApprovalBinding,
  assertApprovalReceipt,
  assertAuthorityUnchanged,
  assertPortResult,
  assertProviderCommitAcknowledgment,
  assertValidTws,
  base64urlEncode,
  bytesToHex,
  canonicalize,
  classifyAuthorityChange,
  concatBytes,
  configureSha256Backend,
  createApprovalBinding,
  createApprovalRequest,
  createCheckpoint,
  createMemoryTwsHostStore,
  createTwsCore,
  createTwsHost,
  deriveBroadcastIdempotencyKey,
  deriveCallId,
  deriveHostAuthorityIdentity,
  deriveOperationId,
  hashCanonical,
  hexToBytes,
  projectApprovalRequester,
  readApprovalDecision,
  reduceApprovalClock,
  sha256Bytes,
  sha256Hex,
  utf8,
  validateAuthoritySnapshot,
  verifyTbcRecoverableSignature,
  verifyCheckpoint,
  type AnyPortCall,
  type ApprovalRequestParams,
  type ApprovalRequestResult,
  type BroadcastReconcileResult,
  type BroadcastSubmitParams,
  type BroadcastSubmitResult,
  type ChainDataResolveResult,
  type CoreTransition,
  type OperationCheckpoint,
  type PermissionStoreCommitParams,
  type PermissionStoreCommitResult,
  type PermissionStoreLoadResult,
  type PlanResult,
  type PortCall,
  type PortOperation,
  type PortResponse,
  type ResumeInput,
  type SchemaCoreTransition,
  type SignerSignParams,
  type SignerSignResult,
  type TransactionEngine,
  type TransactionRequest,
  type TwsAuthoritySnapshot,
  type TwsAuthoritySource,
  type TwsCore,
  type TwsHost,
  type TwsHostLeaseRecord,
  type TwsHostOperationRecord,
  type TwsHostOperationResult,
  type TwsHostPortHandler,
  type TwsHostPortName,
  type TwsHostPortOutcome,
  type TwsHostPorts,
  type TwsHostStore,
  type TwsProviderSessionCommitAck,
  type TwsProviderSessionMutation,
  type TwsSessionCommitRequest,
  type TwsSessionCommitResult,
} from "../../dist/types/wallet.js";
import {
  createTbcKitPostSignerRecoveryReader,
  createTbcKitSqliteBroadcastJournal,
  createTbcKitSqliteHostStore,
  createSqliteTwsHostStore,
  type KitPostSignerRecoveryCandidate,
  type TbcKitBroadcastJournal,
  type TwsSqliteBindings,
  type TwsSqliteDriver,
  type TwsSqliteRow,
  type TwsSqliteTransaction,
  type TwsSqliteValue,
} from "../../dist/types/sqlite.js";

declare const core: TwsCore;
declare const ports: TwsHostPorts;
declare const store: TwsHostStore;
declare const authority: TwsAuthoritySource;
declare const driver: TwsSqliteDriver;

const host: TwsHost = createTwsHost({
  core,
  ports,
  store,
  authority,
  ownerId: "public-consumer",
  scheduleLeaseHeartbeat: () => () => undefined,
});
const sqliteStore: TwsHostStore = createSqliteTwsHostStore({
  driver,
  namespace: "public-consumer",
});
const kitSqliteStore = createTbcKitSqliteHostStore({
  driver,
  namespace: "public-consumer-kit",
});
const postSignerRecovery = createTbcKitPostSignerRecoveryReader(kitSqliteStore);
const broadcastJournal: Promise<TbcKitBroadcastJournal> =
  createTbcKitSqliteBroadcastJournal({ driver, schema: "kit-v1" });

void [
  TWS_HOST_PORT_NAMES,
  TWS_RELEASE,
  TWS_RELEASE_FINGERPRINT,
  advanceCheckpoint,
  assertApprovalBinding,
  assertApprovalReceipt,
  assertAuthorityUnchanged,
  assertPortResult,
  assertProviderCommitAcknowledgment,
  assertValidTws,
  base64urlEncode,
  bytesToHex,
  canonicalize,
  classifyAuthorityChange,
  concatBytes,
  configureSha256Backend,
  createApprovalBinding,
  createApprovalRequest,
  createCheckpoint,
  createMemoryTwsHostStore,
  createTwsCore,
  deriveBroadcastIdempotencyKey,
  deriveCallId,
  deriveHostAuthorityIdentity,
  deriveOperationId,
  hashCanonical,
  hexToBytes,
  projectApprovalRequester,
  readApprovalDecision,
  reduceApprovalClock,
  sha256Bytes,
  sha256Hex,
  utf8,
  validateAuthoritySnapshot,
  verifyTbcRecoverableSignature,
  verifyCheckpoint,
  host,
  sqliteStore,
  kitSqliteStore,
  postSignerRecovery,
  broadcastJournal,
];

type PublicCoreTypes =
  | AnyPortCall
  | ApprovalRequestParams
  | ApprovalRequestResult
  | BroadcastReconcileResult
  | BroadcastSubmitParams
  | BroadcastSubmitResult
  | ChainDataResolveResult
  | CoreTransition
  | OperationCheckpoint
  | PermissionStoreCommitParams
  | PermissionStoreCommitResult
  | PermissionStoreLoadResult
  | PlanResult
  | PortCall
  | PortOperation
  | PortResponse
  | ResumeInput
  | SchemaCoreTransition
  | SignerSignParams
  | SignerSignResult
  | TransactionEngine
  | TransactionRequest;
type PublicHostTypes =
  | TwsAuthoritySnapshot
  | TwsHostLeaseRecord
  | TwsHostOperationRecord
  | TwsHostOperationResult
  | TwsHostPortHandler<PortOperation>
  | TwsHostPortName
  | TwsHostPortOutcome<PortOperation>
  | TwsProviderSessionCommitAck
  | TwsProviderSessionMutation
  | TwsSessionCommitRequest
  | TwsSessionCommitResult;
type PublicSqliteTypes =
  | KitPostSignerRecoveryCandidate
  | TbcKitBroadcastJournal
  | TwsSqliteBindings
  | TwsSqliteRow
  | TwsSqliteTransaction
  | TwsSqliteValue;

declare const publicTypes: PublicCoreTypes | PublicHostTypes | PublicSqliteTypes;
void publicTypes;
