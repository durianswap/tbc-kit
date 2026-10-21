import { htlcClaimDisclosureWarnings } from "./htlc-privacy.js";
import {
  TWS_RELEASE,
  TWS_METHOD_DEFINITIONS,
  assertValidTws,
  base64urlEncode,
  canonicalize,
  createTwsCore,
  hashCanonical,
  validateAuthoritySnapshot,
  hexToBytes,
  utf8,
  resolveTransactionSigningAccounts,
  assertTransactionSigningSnapshot,
  transactionSigningAccountIds,
  type TransactionRoleRequest,
  type TransactionRoleAccount,
  type AnyPortCall,
  type CancelInput,
  type TransactionEngine,
  type TwsCapabilityConfiguration,
} from "@tbc-wallet/core";
import type {
  CommitAckInput,
  PortOperation,
  SchemaCoreTransition,
  StartInput,
} from "./internal/core/index.js";
import {
  createMemoryTwsHostStore,
  createTwsHost,
  deriveHostAuthorityIdentity,
  type TwsAuthoritySnapshot,
  type TwsAuthoritySource,
  type TwsHostOperationResult,
  type TwsHostOperationInspection,
  type TwsHostPortHandler,
  type TwsHostPortOutcome,
  type TwsHostPorts,
  type TwsHostStore,
} from "@tbc-wallet/host";
import {
  assertTbcProviderEvent,
  assertTbcProviderRequest,
  createTbcProvider,
  type TbcJsonRpcId,
  type TbcJsonRpcRequest,
  type TbcTransportDelivery,
} from "@tbc-wallet/provider";
import { createInMemoryTransport } from "@tbc-wallet/provider/in-memory";
import type {
  TbcWallet,
  TbcWalletAccount,
} from "@tbc-wallet/wallet-standard";
import { createTbcEngine } from "./engine.js";
import {
  createDefaultTbcNetwork,
  createDefaultTbcTestnetNetwork,
  type DefaultTbcNetworkOptions,
  type DefaultTbcTestnetNetworkOptions,
} from "./default-network.js";
import { assertTbcNetworkContext, type TbcNetworkContext } from "./network-context.js";
import {
  assertTbcMultiRoundMergeInput,
  createTbcMultiRoundMergeOrchestrator,
  hashTbcMultiRoundMergeState,
  type TbcMultiRoundMergeApprovalDecision,
  type TbcMultiRoundMergeApprovalRequest,
  type TbcMultiRoundMergeAsset,
  type TbcMultiRoundMergeLimits,
  type TbcMultiRoundMergeProgress,
  type TbcMultiRoundMergeResult,
  type TbcMultiRoundMergeState,
  TbcMultiRoundMergeInputError,
} from "./multi-round-merge.js";
import type { TbcKitBroadcastJournalRecord } from "./broadcast-journal.js";
import type { TestnetClient } from "./testnet-client.js";
import type { PoolMergeIndex } from "./pool-material.js";
import { createLegacyKitFacade, type LegacyKitFacade, type LegacyKitOptions } from "./legacy-mapper.js";
import { preparedChainDataRequirement } from "./prepared-chain-data.js";
import { hasBrowserWalletStandardEnvironment } from "./runtime-environment.js";
import type {
  StandardApprovalPreparationApproval,
  StandardApprovalPreparationDecision,
  StandardApprovalPreparationHandle,
  StandardApprovalPreparationMethod,
  StandardApprovalPreparationOperationKind,
  StandardApprovalPreparationOutcome,
  StandardApprovalPreparationPresentation,
  StandardApprovalPreparationReviewedTransactionScope,
  StandardApprovalPreparationStart,
} from "./standard-approval-preparation.js";
import type {
  KitProvider,
  KitSupportedIntent,
  KitTransactionEngine,
  KitTransactionRequest,
} from "./public-types.js";

const TBC_PROVIDER_FEATURE = "tbc:provider" as const;
const TBC_PROVIDER_FEATURE_VERSION = "1.0.0" as const;
const DEFAULT_PRODUCT_ID = "org.tbc.kit.wallet";
const PRODUCT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const DATA_IMAGE = /^data:image\/(?:gif|png|svg\+xml|webp);base64,/;
const REQUEST_PREPARATION_TTL_MS = 30_000;
const TBC721_FINALIZED_CACHE_INTENTS = new Set<string>([
  "tbc721-standard-create-collection", "tbc721-standard-mint", "tbc721-standard-batch-mint", "tbc721-standard-transfer",
]);
const WORKFLOW_PREPARATION_TTL_MS = 5 * 60_000;
const MULTI_ROUND_HOST_WAIT_LIMIT_MS = 30_000;

export { TBC_KIT_WALLET_INTENTS, TBC_KIT_UNIFIED_TEMPLATE_SUPPORT } from "./business-capabilities.js";

export type KitWalletCapabilityConfiguration = TwsCapabilityConfiguration;
const MULTI_ROUND_HOST_WAIT_MIN_DELAY_MS = 25;
const MULTI_ROUND_HOST_WAIT_MAX_DELAY_MS = 250;
async function registerBrowserWalletStandard(wallet: TbcWallet, beforeRegister: () => Promise<void>): Promise<void> {
  if (!hasBrowserWalletStandardEnvironment()) return;
  const { registerWallet } = await import("@wallet-standard/core");
  await beforeRegister();
  registerWallet(wallet);
}

export interface KitWalletAccount {
  readonly accountId: string;
  readonly address: string;
  readonly chainId: `tbc:${string}`;
  readonly publicKey: string;
}

export interface KitHostPortCall {
  readonly version: "1.0";
  readonly callId: string;
  readonly operation: PortOperation;
  readonly params: unknown;
  /** Wallet-selected lifecycle responsibility. DApp request data cannot set this. */
  readonly execution: Readonly<{
    readonly type: "session-only" | "durable";
  }>;
  /** Non-authorizing UI correlation, present only for the exact ready approval. */
  readonly approvalPreparation?: StandardApprovalPreparationApproval;
}

export type KitWalletAuthoritySnapshot = Readonly<{
  currentContext: StartInput["currentContext"];
  currentSession: StartInput["currentSession"];
}>;

export type KitWalletSessionMutation = Extract<
  SchemaCoreTransition,
  { readonly kind: "commit" }
>["mutation"];

export interface KitWalletSessionCommitRequest {
  readonly operationId: string;
  readonly commitId: string;
  readonly mutation: KitWalletSessionMutation;
  readonly expected: KitWalletAuthoritySnapshot;
}

export interface KitWalletSessionCommitResult {
  readonly acknowledgment: CommitAckInput["acknowledgment"];
  readonly authority: KitWalletAuthoritySnapshot;
}

/** Wallet-platform authority only. Never construct this from DApp request data. */
export interface KitWalletAuthoritySource {
  readonly read: () => Promise<KitWalletAuthoritySnapshot>;
  readonly compareAndSwapSession: (
    input: KitWalletSessionCommitRequest,
  ) => Promise<KitWalletSessionCommitResult>;
}

export interface KitWalletSignOnlyExecution {
  /**
   * One live-session Host store, normally from createTbcKitMemoryHostStore().
   * Kit routes every Core-declared pure-signing method here; callers do not
   * provide a method list and request params cannot select this store.
   */
  readonly hostStore: unknown;
}

export interface KitWalletSessionExecution {
  /**
   * One session-scoped memory Host store for all new wallet work, including
   * approval and signing evidence. It must not survive an app restart.
   */
  readonly hostStore: unknown;
}

type KitWalletSessionExecutionOptions = Readonly<{
  readonly execution?: KitWalletSessionExecution;
  /** @deprecated Use execution.hostStore. */
  readonly signOnly?: KitWalletSignOnlyExecution;
}>;

export type KitWalletSessionOptions = (
  | Readonly<{
      authority?: undefined;
      origin?: string;
      sessionId?: string;
      requestIdFactory?: () => string | number;
    }>
  | Readonly<{
      authority: KitWalletAuthoritySource;
      origin?: never;
      sessionId?: never;
      requestIdFactory?: () => string | number;
    }>
) & KitWalletSessionExecutionOptions;

export interface KitWalletOptions {
  /** Stable product metadata for discovery. This is not wallet authority or instance identity. */
  readonly productId?: string;
  readonly name?: string;
  readonly icon?: `data:${string}`;
  readonly profile?: string;
  /** Trusted wallet product declaration, scoped by chain and optionally exact account. */
  readonly capabilities?: KitWalletCapabilityConfiguration;
  readonly accounts: Readonly<{
    current: () => Promise<readonly KitWalletAccount[]>;
    /** Wallet-owned inventory for permission requests on a non-active chain. */
    forChain?: (chainId: `tbc:${string}`) => Promise<readonly KitWalletAccount[]>;
  }>;
  readonly approval: Readonly<{
    /** Declare only after formal and any early-consent UI show and bind these roles. */
    supportedSigningRoles?: readonly ("pool-controller" | "coin-admin")[];
    request: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
  }>;
  /** One native bounded consent for Kit-owned TBC/FT/Stablecoin/Pool multi-round maintenance. */
  readonly multiRoundMerge?: Readonly<{
    approve: (
      request: TbcMultiRoundMergeApprovalRequest,
    ) => Promise<TbcMultiRoundMergeApprovalDecision>;
    /** Issue the exact formal Core credential without presenting another UI. */
    authorizeStep: (input: Readonly<{
      scope: import("./multi-round-merge.js").TbcMultiRoundMergeScope;
      scopeHash: string;
      approval: Extract<TbcMultiRoundMergeApprovalDecision, { status: "approved" }>;
      params: unknown;
    }>, call: KitHostPortCall) => Promise<unknown>;
    waitForIndex?: (input: Readonly<{
      attempt: number;
      delayMs: number;
      txid: string;
    }>) => Promise<void>;
  }>;
  /** Shared early-display/decision lifecycle for every current approval method. */
  readonly approvalPreparation?: StandardApprovalPreparationPresentation;
  readonly signer: Readonly<{
    sign: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
  }>;
  /** Optional account-bound BIE1 execution. Key material stays inside the wallet. */
  readonly crypto?: Readonly<{
    execute: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
  }>;
  /** Optional raw/associated review and approved execution boundary. */
  readonly reviewedTransaction?: Readonly<{
    review: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
    execute: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
  }>;
  readonly storage: Readonly<{
    /** @deprecated Audit/cancel access for historical durable Host rows only. */
    hostStore?: unknown;
    loadPermissions: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
    commitPermissions: (params: unknown, call: KitHostPortCall) => Promise<unknown>;
  }>;
  readonly network:
    | KitWalletNetwork
    | Readonly<{
        /** Wallet-owned network resources for the selected session chain. */
        forChain: (chainId: `tbc:${string}`) => KitWalletNetwork | Promise<KitWalletNetwork>;
      }>
    | Readonly<{
        defaultNetwork: Omit<DefaultTbcNetworkOptions, "accounts">;
      }>
    | Readonly<{
        defaultTestnet: Omit<DefaultTbcTestnetNetworkOptions, "accounts">;
      }>;
  readonly engine?: KitTransactionEngine;
  readonly legacy?: boolean | LegacyKitOptions;
  readonly clock?: (call?: KitHostPortCall) => string | Promise<string>;
  readonly randomBytes?: (length: number, call?: KitHostPortCall) => Uint8Array | Promise<Uint8Array>;
  /** Sanitized diagnostics only. Observer failures never alter wallet execution. */
  readonly onPerformance?: (event: KitWalletPerformanceEvent) => void;
}

export type KitWalletPerformanceStage =
  | "port-call-snapshot"
  | "port-wallet-callback"
  | "port-result-snapshot";

export interface KitWalletPerformanceEvent {
  readonly component: "host-port";
  readonly stage: KitWalletPerformanceStage;
  readonly operation: PortOperation;
  readonly durationMs: number;
  readonly count: 1;
  /** UTF-8 canonical JSON bytes for snapshot stages; zero for callback timing. */
  readonly bytes: number;
}

export interface KitWalletNetwork {
  readonly network?: TbcNetworkContext;
  /** Wallet-startup warmup for immutable native capability metadata. */
  readonly warmup?: () => Promise<void>;
  /**
   * The optional account is a session-verified binding supplied by Kit. The
   * default network uses it to avoid rereading the account provider while
   * still validating the exact accountId in Chain Data.
   */
  readonly resolveChainData: (
    params: unknown,
    call?: KitHostPortCall,
    account?: KitWalletAccount,
  ) => Promise<unknown>;
  readonly resolvePolicy: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
  readonly broadcastSubmit: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
  readonly broadcastSubmitBatch: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
  readonly broadcastReconcile: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
  readonly listBroadcastRecovery?: (limit?: number) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
  readonly recoverBroadcasts?: (txids: readonly string[]) => Promise<unknown>;
  /** Wallet-private authoritative Pool inventory; never exposed to a page. */
  readonly readPoolMergeIndex?: (input: Readonly<{
    address: string;
    poolContractId: string;
    kind: "pool-ft" | "ftlp";
  }>) => Promise<PoolMergeIndex>;
  /** Wallet-local immutable-byte reuse only; it must not retain confirmations. */
  readonly rememberFinalizedTransaction?: (transaction: Readonly<{
    txid: string;
    rawTransaction: string;
  }>) => void;
}

export type KitWalletRequest = Readonly<{
  id: string | number;
  method: string;
  params?: unknown;
}>;

export type KitWalletRequestPreparationDiagnostic = Readonly<{
  readonly status: "ready" | "discarded" | "miss";
  readonly stage:
    | "lifecycle"
    | "authority"
    | "normalize"
    | "account"
    | "chain-data"
    | "binding";
  readonly category:
    | "ready"
    | "cancelled"
    | "expired"
    | "superseded"
    | "request-mismatch"
    | "authority-changed"
    | "chain-data-unavailable"
    | "chain-data-conflict"
    | "chain-data-unauthorized"
    | "chain-data-invalid-input"
    | "unexpected";
}>;

export interface KitWalletRequestPreparation {
  /** Hash of the exact wallet-owned JSON-RPC request, including id and params. */
  readonly requestIdentity: string;
  /** Resolves without throwing; a miss always falls back to normal resolution. */
  readonly ready: Promise<"ready" | "discarded" | "miss">;
  /** Sanitized wallet-only outcome. It never contains URLs, material or raw errors. */
  readonly diagnostic: Promise<KitWalletRequestPreparationDiagnostic>;
  /** Wallet-owned rejection/navigation invalidation. Network I/O may finish but is never consumed. */
  readonly cancel: () => void;
}

export interface KitWalletSession {
  readonly provider: KitProvider;
  readonly legacy: LegacyKitFacade;
  readonly handleRequest: (request: KitWalletRequest) => Promise<Readonly<{
    deliveryId: string;
    response: unknown;
    events: readonly unknown[];
  }>>;
  /**
   * Wallet-trusted, memory-only read preparation. Call only after native review
   * is visible. It never enters Host/Core approval, signing, finalization, or
   * broadcast and is consumed only by an exact later handleRequest call.
   */
  readonly prefetchRequest: (request: KitWalletRequest) => KitWalletRequestPreparation;
  /** Starts the shared non-authorizing approval lifecycle. */
  readonly beginApprovalPreparation: (
    input: StandardApprovalPreparationStart,
  ) => StandardApprovalPreparationHandle;
  /**
   * Production TBC/FT bounded merge. Kit owns index reads, selection/planning,
   * exact formal bindings, execution and reconciliation.
   */
  readonly runMultiRoundMerge: (input: Readonly<{
    asset: TbcMultiRoundMergeAsset;
    limits: TbcMultiRoundMergeLimits;
    signal?: AbortSignal;
    onProgress?: (progress: TbcMultiRoundMergeProgress) => void;
  }>) => Promise<TbcMultiRoundMergeResult>;
  /** Wallet-owned Legacy bridge only; never expose this method to page code. */
  readonly handleLegacyRequest: (request: Readonly<{
    id: string | number;
    method: "tbc_signMessage";
    params: unknown;
  }>) => Promise<Readonly<{
    deliveryId: string;
    response: unknown;
    events: readonly unknown[];
  }>>;
  /** Wallet-owned Legacy batch bridge into the standard one-approval workflow. Never expose to page code. */
  readonly handleLegacyWorkflowRequest: (request: Readonly<{
    id: string | number;
    method: "tbc_signWorkflow";
    params: unknown;
    approvalPreparation?: StandardApprovalPreparationHandle;
  }>) => Promise<Readonly<{
    deliveryId: string;
    response: unknown;
    events: readonly unknown[];
  }>>;
  /** Wallet-owned Legacy single-operation bridge. Never expose to page code. */
  readonly handleLegacyActionRequest: (request: Readonly<{
    id: string | number;
    method: "tbc_signReviewedTransaction" | "tbc_encrypt" | "tbc_decrypt";
    params: unknown;
    approvalPreparation?: StandardApprovalPreparationHandle;
  }>) => Promise<Readonly<{
    deliveryId: string;
    response: unknown;
    events: readonly unknown[];
  }>>;
  readonly cancelRequest: (requestId: string | number) => Promise<void>;
  /** Wallet-native resumable execution over the same Kit Core/Host composition. */
  readonly startOperation: (request: KitWalletRequest) => Promise<TwsHostOperationResult>;
  readonly resumeOperation: (operationId: string) => Promise<TwsHostOperationResult>;
  readonly inspectOperation: (operationId: string) => Promise<TwsHostOperationInspection>;
  readonly cancelOperation: (
    operationId: string,
    reason?: CancelInput["reason"],
  ) => Promise<TwsHostOperationResult>;
  readonly recoverPending: (limit?: number) => Promise<readonly unknown[]>;
  /** @deprecated Durable Host operations are no longer restart-resumed. */
  readonly recoverPostSigner: (operationId: string) => Promise<unknown>;
  /** Lists only persisted submit-boundary identities; no transaction is resumed. */
  readonly listBroadcastRecovery: (limit?: number) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
  /** Explicit status-only recovery; unknown remains pending and is never POSTed. */
  readonly recoverBroadcasts: (txids: readonly string[]) => Promise<unknown>;
  /** Wallet-private historical-chain journal read; never exposed to a page. */
  readonly listBroadcastRecoveryForChain: (chainId: string, limit?: number) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
  /** Wallet-private status-only reconciliation for a configured chain; never POSTs. */
  readonly recoverBroadcastsForChain: (chainId: string, txids: readonly string[]) => Promise<unknown>;
  readonly close: () => void;
}

export interface KitWalletStandardDescriptor {
  readonly productId: string;
  readonly name: string;
  readonly icon: `data:${string}`;
  readonly accounts: readonly KitWalletAccount[];
  readonly provider: KitProvider;
}

export interface KitWalletRuntime {
  readonly openSession: (options?: KitWalletSessionOptions) => Promise<KitWalletSession>;
  /** Reuse an owned, live session opened with platform authority; never creates a hidden session. */
  readonly register: (session: KitWalletSession) => Promise<void>;
  readonly standardWallet: (session: KitWalletSession) => Promise<Readonly<KitWalletStandardDescriptor>>;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) immutable(nested);
    Object.freeze(value);
  }
  return value;
}

function performanceNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function same(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function transactionEngineRequest(request: KitWalletRequest): unknown {
  if (![
    "tbc_signTransaction",
    "tbc_signPreparedTransaction",
    "tbc_sendTransaction",
    "tbc_sendPreparedTransaction",
  ].includes(request.method)) {
    throw new TypeError("Only transaction requests support wallet preparation");
  }
  const prepared = request.method === "tbc_signPreparedTransaction" ||
    request.method === "tbc_sendPreparedTransaction";
  assertValidTws(prepared ? "preparedTransactionRequest" : "transactionRequest", request.params);
  if (!prepared) return request.params;
  const { proposal: _proposal, ...engineRequest } = request.params as Readonly<Record<string, unknown>> & {
    readonly proposal: unknown;
  };
  return engineRequest;
}

function walletRequestIdentity(request: KitWalletRequest): string {
  return hashCanonical({
    domain: "tbc-kit/wallet-request-preparation/1",
    request: {
      id: request.id,
      method: request.method,
      ...(request.params === undefined ? {} : { params: request.params }),
    },
  });
}

function approvalPreparationKind(
  method: string,
): StandardApprovalPreparationOperationKind | undefined {
  const definition = TWS_METHOD_DEFINITIONS.find(({ name }) => name === method);
  if (definition === undefined || definition.approval === "none") return undefined;
  if (
    definition.operationKind !== "permission" &&
    definition.operationKind !== "switchChain" &&
    definition.operationKind !== "message" &&
    definition.operationKind !== "typedData" &&
    definition.operationKind !== "transaction" &&
    definition.operationKind !== "workflow" &&
    definition.operationKind !== "crypto"
  ) throw new Error(`Unsupported approval preparation kind: ${String(definition.operationKind)}`);
  return definition.operationKind;
}

/**
 * Chain-data preparation is useful only for requests whose canonical
 * execution contains transaction material.  Message/typed-data/crypto-only
 * workflows must remain read-free even when they use the same approval UI.
 */
function approvalRequestNeedsChainData(request: KitWalletRequest): boolean {
  const operationKind = approvalPreparationKind(request.method);
  if (operationKind === "transaction") return true;
  if (operationKind !== "workflow" || request.params === null ||
      typeof request.params !== "object") return false;
  const steps = Reflect.get(request.params, "steps");
  return Array.isArray(steps) && steps.some((step) => {
    if (step === null || typeof step !== "object") return false;
    const kind = Reflect.get(step, "kind");
    return kind === "transaction" ||
      kind === "preparedTransaction" ||
      kind === "reviewedTransaction";
  });
}

function explicitApprovalFeeCap(request: KitWalletRequest): string | undefined {
  if (request.params === null || typeof request.params !== "object") return undefined;
  const operationKind = approvalPreparationKind(request.method);
  const candidate = operationKind === "workflow"
    ? Reflect.get(request.params, "maxTotalFee")
    : operationKind === "transaction"
      ? Reflect.get(Reflect.get(request.params, "constraints") ?? {}, "maxFee")
      : undefined;
  return typeof candidate === "string" && /^(0|[1-9][0-9]*)$/u.test(candidate)
    ? candidate
    : undefined;
}

function approvalPreparationRequiresFeeCap(
  request: KitWalletRequest,
  operationKind: StandardApprovalPreparationOperationKind,
): boolean {
  if (operationKind === "transaction") return true;
  if (operationKind !== "workflow" || request.params === null ||
      typeof request.params !== "object") return false;
  const steps = Reflect.get(request.params, "steps");
  return Array.isArray(steps) && steps.some((step) => {
    if (step === null || typeof step !== "object") return false;
    const kind = Reflect.get(step, "kind");
    return kind === "transaction" ||
      kind === "preparedTransaction" ||
      kind === "reviewedTransaction";
  });
}

function approvalPreparationExpiry(request: KitWalletRequest): number | undefined {
  if (request.params === null || typeof request.params !== "object") return undefined;
  const direct = Reflect.get(request.params, "expiresAt");
  const constrained = Reflect.get(Reflect.get(request.params, "constraints") ?? {}, "expiresAt");
  const candidates: unknown[] = [direct, constrained];
  // These requests have passed Provider schema validation. The early shell
  // uses the same proposal ceiling as Core, but grants no signing authority.
  if (request.method === "tbc_signPreparedTransaction" || request.method === "tbc_sendPreparedTransaction") {
    candidates.push((request.params as { proposal: { payload: { expiresAt: string } } }).proposal.payload.expiresAt);
  } else if (request.method === "tbc_signPreparedWorkflow" || request.method === "tbc_sendPreparedWorkflow") {
    const steps = (request.params as { steps: readonly { kind: string; proposal?: { payload: { expiresAt: string } } }[] }).steps;
    for (const step of steps) if (step.kind === "preparedTransaction") candidates.push(step.proposal?.payload.expiresAt);
  }
  const expiries = candidates.flatMap(candidate => {
    const parsed = typeof candidate === "string" ? Date.parse(candidate) : NaN;
    return Number.isFinite(parsed) ? [parsed] : [];
  });
  return expiries.length === 0 ? undefined : Math.min(...expiries);
}

function approvalPreparationWarningScope(
  request: KitWalletRequest,
  reviewedTransactionScope?: StandardApprovalPreparationReviewedTransactionScope,
): readonly string[] {
  return Object.freeze([...new Set([...baseApprovalPreparationWarningScope(request, reviewedTransactionScope),
    ...walletBuiltFundingWarningScope(request),
    ...htlcClaimDisclosureWarnings(request.params)])]);
}

function walletBuiltFundingWarningScope(request: KitWalletRequest): readonly string[] {
  const params = request.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return [];
  const hasIntent = (value: unknown): boolean => value !== null && typeof value === "object" &&
    !Array.isArray(value) && typeof Reflect.get(value, "type") === "string";
  const builtTransaction = ["tbc_signTransaction", "tbc_sendTransaction"].includes(request.method) &&
    hasIntent(Reflect.get(params, "intent"));
  const steps = Reflect.get(params, "steps");
  const builtChild = ["tbc_signWorkflow", "tbc_sendWorkflow", "tbc_signPreparedWorkflow", "tbc_sendPreparedWorkflow"].includes(request.method) &&
    Array.isArray(steps) && steps.some(step => step !== null && typeof step === "object" &&
      !Array.isArray(step) && Reflect.get(step, "kind") === "transaction" && hasIntent(Reflect.get(step, "intent")));
  // Disclose a possible same-account funding prerequisite BEFORE consent.
  // It remains inside the exact intent, total fee ceiling and validated Engine
  // plan. This is not a wildcard for new warnings, raw/Reviewed or Prepared
  // transactions, and does not authorize a separate maintenance request.
  return builtTransaction || builtChild ? ["MULTI_TRANSACTION", "MAINTENANCE_TRANSACTION"] : [];
}

function baseApprovalPreparationWarningScope(
  request: KitWalletRequest,
  reviewedTransactionScope?: StandardApprovalPreparationReviewedTransactionScope,
): readonly string[] {
  if (reviewedTransactionScope !== undefined) {
    return reviewedTransactionScope.warnings;
  }
  if (
    (request.method === "tbc_signTransaction" || request.method === "tbc_sendTransaction") &&
    request.params !== null &&
    typeof request.params === "object" &&
    !Array.isArray(request.params)
  ) {
    const intent = Reflect.get(request.params, "intent");
    if (
      intent !== null &&
      typeof intent === "object" &&
      !Array.isArray(intent) &&
      Reflect.get(intent, "type") === "tbc.ft.create"
    ) return Object.freeze(["FT_MINT_V4"]);
  }
  if (
    !["tbc_signWorkflow", "tbc_sendWorkflow", "tbc_signPreparedWorkflow", "tbc_sendPreparedWorkflow"].includes(request.method) ||
    request.params === null ||
    typeof request.params !== "object" ||
    Array.isArray(request.params)
  ) return Object.freeze([]);
  const steps = Reflect.get(request.params, "steps");
  if (!Array.isArray(steps)) return Object.freeze([]);
  const hasDisplayedDynamicBinding = steps.some((step) => {
    if (step === null || typeof step !== "object" || Array.isArray(step)) return false;
    const bindings = Reflect.get(step, "bindings");
    return Array.isArray(bindings) && bindings.length > 0;
  });
  // Reviewed children already belong to the exact request approved by the
  // user. Disclose their known multi-transaction shape before early consent,
  // just as for a standalone Reviewed request; do not whitelist later warnings.
  const reviewedWarnings = steps.flatMap((step) => {
    if (step === null || typeof step !== "object" || Array.isArray(step) ||
      Reflect.get(step, "kind") !== "reviewedTransaction") return [];
    return approvalPreparationReviewedTransactionScope({
      id: request.id,
      method: "tbc_signReviewedTransaction",
      params: { request: Reflect.get(step, "request") },
    })?.warnings ?? [];
  });
  return Object.freeze([...new Set([...reviewedWarnings,
    ...(hasDisplayedDynamicBinding ? ["DYNAMIC_BINDING"] : []),
  ])]);
}

function approvalPreparationReviewedTransactionScope(
  request: KitWalletRequest,
): StandardApprovalPreparationReviewedTransactionScope | undefined {
  if (
    request.method !== "tbc_signReviewedTransaction" ||
    request.params === null ||
    typeof request.params !== "object" ||
    Array.isArray(request.params)
  ) return undefined;
  const reviewedRequest = Reflect.get(request.params, "request");
  if (
    reviewedRequest === null ||
    typeof reviewedRequest !== "object" ||
    Array.isArray(reviewedRequest)
  ) return undefined;
  const payload = Reflect.get(reviewedRequest, "payload");
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const format = Reflect.get(payload, "format");
  let transactionCount: number;
  let dependencyCount: number;
  if (format === "raw") {
    const transactions = Reflect.get(payload, "transactions");
    if (!Array.isArray(transactions) || transactions.length < 1) return undefined;
    transactionCount = transactions.length;
    dependencyCount = 0;
  } else if (format === "associated") {
    const children = Reflect.get(payload, "children");
    if (!Array.isArray(children)) return undefined;
    transactionCount = 1 + children.length;
    dependencyCount = children.length;
  } else {
    return undefined;
  }
  return Object.freeze({
    format,
    transactionCount,
    dependencyCount,
    warnings: Object.freeze(transactionCount > 1 ? ["MULTI_TRANSACTION" as const] : []),
  });
}

function checkedAuthority(
  value: KitWalletAuthoritySnapshot,
): KitWalletAuthoritySnapshot {
  validateAuthoritySnapshot(value.currentContext, value.currentSession);
  return immutable(clone(value));
}

function assertInitialAuthority(
  authority: KitWalletAuthoritySnapshot,
  profile: string,
  chainId: string,
  accounts: readonly KitWalletAccount[],
): void {
  const session = authority.currentSession;
  const expectedAccountIds = accounts.map(({ accountId }) => accountId).sort();
  if (
    session.scope.walletProfile !== profile ||
    session.state.connected !== true ||
    session.state.activeChainId !== chainId ||
    !same(session.state.activeAccountIds, expectedAccountIds)
  ) {
    throw new TypeError("Wallet authority does not match the configured profile, chain, and active accounts");
  }
}

async function entropy(
  options: KitWalletOptions,
  length: number,
  call?: KitHostPortCall,
): Promise<Uint8Array> {
  if (options.randomBytes !== undefined) return Uint8Array.from(await options.randomBytes(length, call));
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues === undefined) throw new Error("A secure random source is required");
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function createTbcWallet(options: KitWalletOptions): KitWalletRuntime {
  if (options === null || typeof options !== "object") throw new TypeError("TBC wallet options are required");
  if (typeof options.signer?.sign !== "function") throw new TypeError("A wallet-owned Signer is required");
  if (
    options.approvalPreparation !== undefined &&
    (typeof options.approvalPreparation.begin !== "function" ||
      typeof options.approvalPreparation.review !== "function" ||
      (options.approvalPreparation.finish !== undefined &&
        typeof options.approvalPreparation.finish !== "function"))
  ) throw new TypeError("Invalid Standard approval preparation presentation");
  const approvalPreparation = options.approvalPreparation;
  const productId = options.productId ?? DEFAULT_PRODUCT_ID;
  if (!PRODUCT_ID.test(productId)) throw new TypeError("Invalid TBC wallet productId");
  const displayName = options.name ?? "TBC Kit Wallet";
  if (displayName.trim().length === 0) throw new TypeError("Invalid TBC wallet name");
  const displayIcon = options.icon ?? "data:image/svg+xml;base64,PHN2Zy8+";
  if (!DATA_IMAGE.test(displayIcon)) throw new TypeError("Invalid TBC wallet icon");
  const profile = options.profile ?? "tbc-kit-wallet";
  const legacyEnabled = options.legacy !== false;
  const legacyOptions = typeof options.legacy === "object" ? options.legacy : undefined;
  const historicalStore = options.storage.hostStore as TwsHostStore | undefined;
  let trustedSessionAccountScopeHash: string | undefined;
  const configuredNetwork: KitWalletNetwork | undefined = "forChain" in options.network
    ? undefined
    : "defaultNetwork" in options.network
    ? (() => {
        const configured = createDefaultTbcNetwork({
          accounts: options.accounts,
          ...options.network.defaultNetwork,
          broadcastAccountScopeHash: async () => {
            if (trustedSessionAccountScopeHash === undefined) throw new Error("No trusted wallet account scope is active");
            return trustedSessionAccountScopeHash;
          },
        });
        return Object.freeze({
          ...configured,
          resolveChainData: (
            params: unknown,
            _call?: KitHostPortCall,
            account?: KitWalletAccount,
          ) => configured.resolveChainData(params, account),
        });
      })()
    : "defaultTestnet" in options.network
      ? (() => {
          const configured = createDefaultTbcTestnetNetwork({
            accounts: options.accounts,
            ...options.network.defaultTestnet,
            broadcastAccountScopeHash: async () => {
              if (trustedSessionAccountScopeHash === undefined) throw new Error("No trusted wallet account scope is active");
              return trustedSessionAccountScopeHash;
            },
          });
          return Object.freeze({
            ...configured,
            resolveChainData: (
              params: unknown,
              _call?: KitHostPortCall,
              account?: KitWalletAccount,
            ) => configured.resolveChainData(params, account),
          });
        })()
      : options.network;
  let sessionSequence = 0;
  type DiscoveryState = {
    readView: () => Readonly<{ revision: string; accounts: readonly KitWalletAccount[] }>;
    assertLive: () => Promise<void>;
    descriptor?: Readonly<KitWalletStandardDescriptor>;
    internal?: TbcWallet;
    registration?: Promise<void>;
  };
  const discoverySessions = new WeakMap<KitWalletSession, DiscoveryState>();
  const reportPerformance = (event: KitWalletPerformanceEvent): void => {
    try {
      options.onPerformance?.(Object.freeze(event));
    } catch {
      // Diagnostics cannot change wallet execution or error semantics.
    }
  };

  async function openSession(sessionOptions: KitWalletSessionOptions = {}): Promise<KitWalletSession> {
    const currentAccounts = await options.accounts.current();
    const accounts = Object.freeze([...currentAccounts]);
    if (accounts.length === 0) throw new Error("The wallet has no active TBC account");
    const chainId = accounts[0]!.chainId;
    if (accounts.some((account) => account.chainId !== chainId)) throw new Error("One provider session cannot mix TBC chains");
    const networkResources = new Map<string, KitWalletNetwork>();
    const networkForChain = async (requestedChainId: string): Promise<KitWalletNetwork> => {
      const cached = networkResources.get(requestedChainId);
      if (cached !== undefined) return cached;
      if (!("forChain" in options.network)) throw new Error("Wallet network catalog is unavailable");
      const selected = await options.network.forChain(requestedChainId as `tbc:${string}`);
      if (selected === null || typeof selected !== "object" ||
          selected.network === undefined ||
          typeof selected.resolveChainData !== "function" ||
          typeof selected.resolvePolicy !== "function" ||
          typeof selected.broadcastSubmit !== "function" ||
          typeof selected.broadcastSubmitBatch !== "function" ||
          typeof selected.broadcastReconcile !== "function") {
        throw new TypeError("Invalid wallet-owned network resources");
      }
      const canonicalNetwork = assertTbcNetworkContext(selected.network);
      if (!same(selected.network, canonicalNetwork)) {
        throw new TypeError("Wallet network catalog contains a noncanonical network context");
      }
      if (selected.network.chainId !== requestedChainId) {
        throw new TypeError("Wallet network catalog does not match the requested chain");
      }
      networkResources.set(requestedChainId, selected);
      return selected;
    };
    const network = configuredNetwork ?? await networkForChain(chainId);
    networkResources.set(chainId, network);
    // Only a committed Provider Session may select one of these snapshots.
    // Target-chain permission discovery is not itself an active account view.
    const sessionAccountsByChain = new Map<string, readonly KitWalletAccount[]>([[chainId, accounts]]);
    const prepareTargetAccountView = async (target: Readonly<{
      activeChainId: string;
      activeAccountIds: readonly string[];
    }>): Promise<readonly KitWalletAccount[]> => {
      // Only a Core-approved Session mutation reaches here. The wallet, not
      // page params, supplies both the target network and account inventory.
      await networkForChain(target.activeChainId);
      if (options.accounts.forChain === undefined) {
        throw new Error("Target-chain wallet accounts are unavailable");
      }
      const available = await options.accounts.forChain(target.activeChainId as `tbc:${string}`);
      assertValidTws("accountsResolveResult", { accounts: available });
      const byId = new Map<string, KitWalletAccount>();
      for (const account of available) {
        if (account.chainId !== target.activeChainId ||
            account.accountId !== `${account.chainId}:${account.address}` ||
            byId.has(account.accountId)) {
          throw new Error("Invalid target-chain wallet account inventory");
        }
        byId.set(account.accountId, account);
      }
      if (target.activeAccountIds.length === 0 ||
          target.activeAccountIds.some((accountId) => !byId.has(accountId))) {
        throw new Error("Provider Session target accounts are unavailable in the wallet");
      }
      return Object.freeze(target.activeAccountIds.map((accountId) => byId.get(accountId)!));
    };
    trustedSessionAccountScopeHash = hashCanonical(Object.freeze({
      version: "1.0",
      chainId,
      accountIds: Object.freeze(accounts.map((account) => account.accountId).sort()),
    }));
    if (network.network !== undefined && network.network.chainId !== chainId) {
      throw new Error("The active account does not match the configured TBC network");
    }
    // Warm immutable native capability metadata only after the session's
    // account/network binding is accepted. A rejected cross-network session
    // must remain inert and must not touch the configured API endpoint.
    await network.warmup?.().catch(() => undefined);
    const injectedAuthority = sessionOptions.authority;
    if (Object.hasOwn(sessionOptions, "authority") && injectedAuthority === undefined) {
      throw new TypeError("Injected wallet authority is unavailable");
    }
    if (
      injectedAuthority !== undefined &&
      (Object.hasOwn(sessionOptions, "origin") || Object.hasOwn(sessionOptions, "sessionId"))
    ) {
      throw new TypeError("Injected wallet authority cannot be combined with origin or sessionId");
    }
    let boundAuthority: KitWalletAuthoritySnapshot;
    let authoritySource: TwsAuthoritySource;
    if (injectedAuthority === undefined) {
      const sessionId = sessionOptions.sessionId ?? `kit-session-${++sessionSequence}`;
      const origin = sessionOptions.origin ?? "https://local.tbc-kit.invalid";
      const createdAt = new Date().toISOString();
      let authority: TwsAuthoritySnapshot = Object.freeze({
        currentContext: Object.freeze({ sessionId, transport: "remote" as const, origin, topOrigin: origin, frame: "top" as const, createdAt }),
        currentSession: Object.freeze({
          version: "1.0" as const,
          scope: Object.freeze({ walletProfile: profile, sessionId }),
          state: Object.freeze({
            version: "1.0" as const,
            sessionId,
            revision: "0",
            connected: true,
            activeChainId: chainId,
            activeAccountIds: Object.freeze(accounts.map((account) => account.accountId).sort()),
          }),
        }),
      });
      boundAuthority = authority;
      authoritySource = Object.freeze({
        read: async () => clone(authority),
        compareAndSwapSession: async (input: Parameters<NonNullable<TwsAuthoritySource["compareAndSwapSession"]>>[0]) => {
          const target = input.mutation.payload.target;
          const targetAccounts = same(target.activeAccountIds, authority.currentSession.state.activeAccountIds) &&
              target.activeChainId === authority.currentSession.state.activeChainId
            ? undefined : await prepareTargetAccountView(target);
          if (!same(input.expected, authority)) throw new Error("Authority compare-and-swap is stale");
          authority = Object.freeze({
            currentContext: clone(input.expected.currentContext),
            currentSession: Object.freeze({
              version: "1.0" as const,
              scope: clone(input.mutation.payload.scope),
              state: clone(input.mutation.payload.target),
            }),
          });
          if (targetAccounts !== undefined) sessionAccountsByChain.set(target.activeChainId, targetAccounts);
          boundAuthority = authority;
          return Object.freeze({
            acknowledgment: Object.freeze({ version: "1.0" as const, commitId: input.commitId, status: "committed" as const, revision: input.mutation.payload.target.revision }),
            authority: clone(authority),
          });
        },
      });
    } else {
      boundAuthority = checkedAuthority(await injectedAuthority.read());
      assertInitialAuthority(boundAuthority, profile, chainId, accounts);
      authoritySource = Object.freeze({
        read: async () => checkedAuthority(await injectedAuthority.read()),
        compareAndSwapSession: async (
          input: Parameters<TwsAuthoritySource["compareAndSwapSession"]>[0],
        ) => {
          const target = input.mutation.payload.target;
          const prior = boundAuthority;
          const targetAccounts = target.activeChainId === prior.currentSession.state.activeChainId &&
              same(target.activeAccountIds, prior.currentSession.state.activeAccountIds)
            ? undefined : await prepareTargetAccountView(target);
          const result = await injectedAuthority.compareAndSwapSession(clone(input));
          const nextAuthority = checkedAuthority(result.authority);
          if (!same(nextAuthority.currentContext, prior.currentContext) ||
              !same(nextAuthority.currentSession.state, target) ||
              !same(nextAuthority.currentSession.scope, input.mutation.payload.scope)) {
            throw new Error("Wallet authority context changed during Provider Session commit");
          }
          if (targetAccounts !== undefined) sessionAccountsByChain.set(target.activeChainId, targetAccounts);
          boundAuthority = nextAuthority;
          return Object.freeze({
            acknowledgment: immutable(clone(result.acknowledgment)),
            authority: clone(nextAuthority),
          });
        },
      });
    }
    const sessionId = boundAuthority.currentContext.sessionId;
    const networkForPort = (requestedChainId: unknown, historicalRead = false): KitWalletNetwork => {
      if (typeof requestedChainId !== "string" || !requestedChainId.startsWith("tbc:")) {
        throw new TypeError("Host Port has no valid TBC chain binding");
      }
      // This is the already-committed native/Host session state, not a page
      // chain hint. An old in-flight request must never acquire the resources
      // of a newly selected chain. Read-only journal reconciliation may use
      // resources that were already bound in this session.
      if (!historicalRead && requestedChainId !== boundAuthority.currentSession.state.activeChainId) {
        throw new Error("Host Port chain changed during wallet execution");
      }
      const selected = networkResources.get(requestedChainId);
      if (selected === undefined) throw new Error("Wallet network resources are unavailable for the Host Port chain");
      return selected;
    };
    const activeAccountView = (): Readonly<{
      chainId: string;
      accounts: readonly KitWalletAccount[];
      network: KitWalletNetwork;
      revision: string;
    }> => {
      const state = boundAuthority.currentSession.state;
      const selectedAccounts = sessionAccountsByChain.get(state.activeChainId);
      const selectedNetwork = networkResources.get(state.activeChainId);
      if (selectedAccounts === undefined || selectedNetwork === undefined) {
        throw new Error("Committed wallet account/network view is unavailable");
      }
      if (selectedAccounts.some((account) => account.chainId !== state.activeChainId) ||
          state.activeAccountIds.some((accountId) => !selectedAccounts.some((account) => account.accountId === accountId))) {
        throw new Error("Committed wallet accounts do not match the Provider Session");
      }
      return Object.freeze({
        chainId: state.activeChainId,
        accounts: selectedAccounts,
        network: selectedNetwork,
        revision: state.revision,
      });
    };
    const legacyDigest = legacyOptions?.bitcoinMessageDigest;
    const legacyRouteToken = legacyDigest === undefined
      ? undefined
      : base64urlEncode(await entropy(options, 16));
    const authorizedLegacyRequestIds = new Set<string>();
    let legacyRequestSequence = 0;
    const officialEngine = (options.engine ?? createTbcEngine()) as TransactionEngine;
    const transactionEngine: TransactionEngine = Object.freeze({
      normalizeRequest: (params: Parameters<TransactionEngine["normalizeRequest"]>[0]) =>
        officialEngine.normalizeRequest(params),
      plan: (params: Parameters<TransactionEngine["plan"]>[0]) =>
        officialEngine.plan(params),
      validate: (params: Parameters<TransactionEngine["validate"]>[0]) =>
        officialEngine.validate(params),
      async finalize(params: Parameters<TransactionEngine["finalize"]>[0]) {
        const finalizedNetwork = networkForPort(params.request.chainId);
        const result = await officialEngine.finalize(params);
        if (networkForPort(params.request.chainId) !== finalizedNetwork) {
          throw new Error("Wallet network changed during transaction finalization");
        }
        if (
          finalizedNetwork.rememberFinalizedTransaction !== undefined &&
          (params.request.intent.type.startsWith("tbc20Lp.") ||
            params.request.intent.type === "amm.mergeToken" ||
            params.request.intent.type === "amm.swap" ||
            params.request.intent.type === "amm.addLiquidity" ||
            params.request.intent.type === "amm.removeLiquidity" ||
            params.request.intent.type === "tbc721.transfer" ||
            params.request.intent.type === "tbc20.transfer" ||
            params.request.intent.type === "tbc20.merge" ||
            params.request.intent.type === "tbc20Stablecoin.transfer" ||
            params.request.intent.type === "tbc20Stablecoin.merge" ||
            params.request.intent.type === "tbc.ft.transfer" ||
            params.request.intent.type === "tbc.stablecoin.transfer" ||
            params.request.intent.type === "tbc.stablecoin.merge" ||
            params.request.intent.type === "tbc.ft.create" ||
            params.request.intent.type === "tbc20-standard-create" ||
            params.request.intent.type === "tbc20-standard-transfer" ||
            params.request.intent.type === "tbc20-standard-merge" ||
            params.request.intent.type === "tbc20-stablecoin-transfer" ||
            params.request.intent.type === "tbc20-stablecoin-create" ||
            params.request.intent.type === "tbc20-stablecoin-merge" ||
            params.request.intent.type === "tbc20-stablecoin-mint" ||
            params.request.intent.type === "tbc20-stablecoin-freeze" ||
            params.request.intent.type === "tbc20-stablecoin-unfreeze" ||
            TBC721_FINALIZED_CACHE_INTENTS.has(params.request.intent.type) ||
            params.request.intent.type === "tbc.collection.create" ||
            params.request.intent.type === "tbc.nft.mint" ||
            params.request.intent.type === "tbc.nft.transfer") &&
          "bundle" in result &&
          result.validation.valid
        ) {
          for (const transaction of result.bundle.transactions ?? []) {
            try {
              finalizedNetwork.rememberFinalizedTransaction(transaction);
            } catch {
              // Optional immutable-byte reuse cannot turn a completed
              // signature into a failed operation. A miss reads the node.
            }
          }
        }
        return result;
      },
    });
    const calls = new Map<string, Readonly<{
      canonicalCall: string;
      promise: Promise<unknown>;
    }>>();
    type PreparationEntry = {
      readonly exactRequest: KitWalletRequest;
      readonly requestIdentity: string;
      readonly startedAt: number;
      readonly ready: Promise<"ready" | "discarded" | "miss">;
      readonly diagnostic: Promise<KitWalletRequestPreparationDiagnostic>;
      settle: (diagnostic: KitWalletRequestPreparationDiagnostic) => void;
      active: boolean;
      consumed: boolean;
      executions: number;
      expiresAt: number;
      expiryTimer: ReturnType<typeof setTimeout> | undefined;
      authorityIdentity?: string;
      account?: KitWalletAccount;
      roleBinding?: Readonly<{ request: TransactionRoleRequest; accounts: readonly TransactionRoleAccount[] }>;
      chainDataParamsCanonical?: string;
      result?: Promise<unknown | undefined>;
      started?: Promise<boolean>;
      handle?: KitWalletRequestPreparation;
    };
    let preparation: PreparationEntry | undefined;
    type WorkflowPreparationEntry = {
      readonly handle: StandardApprovalPreparationHandle;
      readonly preparationId: string;
      readonly requestId: string | number;
      readonly startedAt: number;
      readonly context: StartInput["currentContext"];
      readonly requestCount: number;
      readonly inputHash: string;
      readonly presentation: "approval" | undefined;
      active: boolean;
      presented: boolean;
      expiresAt: number;
      expiryTimer: ReturnType<typeof setTimeout> | undefined;
      method: StandardApprovalPreparationMethod;
      operationKind?: StandardApprovalPreparationOperationKind;
      requiresFeeCap?: boolean;
      requestHash?: string;
      preparedApproval?: Readonly<{ callId: string; requestHash: string }>;
      chainId?: string;
      accountId?: string;
      readyCallId?: string;
      feeCapAtomic?: string;
      approvedWarningScope?: readonly string[];
      reviewedTransactionScope?: StandardApprovalPreparationReviewedTransactionScope;
      earlyConsent?: Promise<StandardApprovalPreparationDecision | undefined>;
      settleEarlyCancellation: (() => void) | undefined;
    };
    const workflowPreparationHandles = new WeakMap<object, WorkflowPreparationEntry>();
    const workflowPreparations = new Set<WorkflowPreparationEntry>();
    const workflowPreparationsByRequestHash = new Map<string, Set<WorkflowPreparationEntry>>();
    const preparationsAwaitingAuthorization = new Map<string, Readonly<{
      entry: WorkflowPreparationEntry;
      request: KitWalletRequest;
      accept: (entry: PreparationEntry | undefined) => void;
    }>>();
    let workflowPreparationSequence = 0;
    let closed = false;

    function authorizationPreparationIdentity(
      requestId: unknown,
      operation: Readonly<{ method: unknown; params?: unknown }>,
    ): string {
      return canonicalize({
        id: requestId,
        method: operation.method,
        params: operation.params === undefined ? [] : operation.params,
      });
    }

    async function startAuthorizedPreparation(
      requestId: unknown,
      operation: Readonly<{ method: unknown; params?: unknown }>,
    ): Promise<void> {
      const identity = authorizationPreparationIdentity(requestId, operation);
      const pending = preparationsAwaitingAuthorization.get(identity);
      if (pending === undefined) return;
      preparationsAwaitingAuthorization.delete(identity);
      if (!pending.entry.active || !pending.entry.presented) return;
      try {
        prefetchRequest(pending.request);
        pending.accept(await beginPreparedExecution(pending.request));
      } catch {
        // Preparation is an optimization; normal execution remains the
        // fail-closed fallback when a read cannot be started.
      }
    }

    function notifyWorkflowPreparationFinish(
      entry: WorkflowPreparationEntry,
      outcome: StandardApprovalPreparationOutcome,
    ): void {
      if (!entry.presented) return;
      try {
        const finish = approvalPreparation?.finish;
        finish?.(Object.freeze({
          preparationId: entry.preparationId,
          outcome,
        }));
      } catch {
        // Presentation cleanup cannot alter wallet execution semantics.
      }
    }

    function finishWorkflowPreparation(
      entry: WorkflowPreparationEntry,
      outcome: StandardApprovalPreparationOutcome,
    ): void {
      if (!entry.active) return;
      entry.settleEarlyCancellation?.();
      entry.settleEarlyCancellation = undefined;
      entry.active = false;
      if (entry.expiryTimer !== undefined) clearTimeout(entry.expiryTimer);
      entry.expiryTimer = undefined;
      if (entry.requestHash !== undefined) {
        const entries = workflowPreparationsByRequestHash.get(entry.requestHash);
        entries?.delete(entry);
        if (entries?.size === 0) workflowPreparationsByRequestHash.delete(entry.requestHash);
      }
      workflowPreparations.delete(entry);
      notifyWorkflowPreparationFinish(entry, outcome);
    }

    function cancelWorkflowPreparation(entry: WorkflowPreparationEntry): void {
      if (
        entry.active &&
        entry.requestHash !== undefined &&
        entry.earlyConsent !== undefined &&
        entry.settleEarlyCancellation !== undefined
      ) {
        entry.settleEarlyCancellation();
        entry.settleEarlyCancellation = undefined;
        return;
      }
      finishWorkflowPreparation(entry, "cancelled");
    }

    function scheduleWorkflowPreparationExpiry(entry: WorkflowPreparationEntry): void {
      if (!entry.active) return;
      if (entry.expiryTimer !== undefined) clearTimeout(entry.expiryTimer);
      entry.expiryTimer = setTimeout(
        () => finishWorkflowPreparation(entry, "expired"),
        Math.max(0, entry.expiresAt - Date.now()),
      );
    }

    function beginApprovalPreparation(
      input: StandardApprovalPreparationStart,
    ): StandardApprovalPreparationHandle {
      if (closed) throw new Error("The wallet session is closed");
      if (
        (typeof input.requestId !== "string" && typeof input.requestId !== "number") ||
        approvalPreparationKind(input.method) === undefined ||
        !Number.isSafeInteger(input.requestCount) ||
        input.requestCount < 1 ||
        input.requestCount > 5 ||
        !/^[0-9a-f]{64}$/u.test(input.inputHash)
      ) throw new TypeError("Invalid Standard approval preparation input");
      const startedAt = Date.now();
      const context = immutable(clone(boundAuthority.currentContext));
      const preparationId = hashCanonical(Object.freeze({
        domain: "tbc-kit/standard-approval-preparation/1" as const,
        context,
        requestId: input.requestId,
        method: input.method,
        inputHash: input.inputHash,
        sequence: ++workflowPreparationSequence,
      }));
      let entry!: WorkflowPreparationEntry;
      const handle: StandardApprovalPreparationHandle = Object.freeze({
        preparationId,
        cancel: (outcome: "cancelled" | "failed" = "cancelled") => {
          if (outcome === "cancelled") cancelWorkflowPreparation(entry);
          else finishWorkflowPreparation(entry, outcome);
        },
      });
      entry = {
        handle,
        preparationId,
        requestId: input.requestId,
        startedAt,
        context,
        requestCount: input.requestCount,
        inputHash: input.inputHash,
        method: input.method,
        presentation: approvalPreparation !== undefined ? "approval" : undefined,
        active: true,
        presented: false,
        expiresAt: startedAt + WORKFLOW_PREPARATION_TTL_MS,
        expiryTimer: undefined,
        settleEarlyCancellation: undefined,
      };
      workflowPreparationHandles.set(handle, entry);
      workflowPreparations.add(entry);
      scheduleWorkflowPreparationExpiry(entry);
      try {
        if (entry.presentation === "approval") {
          approvalPreparation!.begin(Object.freeze({
            preparationId,
            method: input.method,
            requestCount: input.requestCount,
            inputHash: input.inputHash,
            startedAt,
            expiresAt: entry.expiresAt,
            context,
          }));
        }
        entry.presented = entry.presentation !== undefined;
      } catch {
        // A loading shell is never an authorization requirement. The exact
        // approval Port remains available if presentation startup fails.
      }
      return handle;
    }

    function bindWorkflowPreparation(
      handle: StandardApprovalPreparationHandle,
      request: KitWalletRequest,
    ): WorkflowPreparationEntry {
      const entry = workflowPreparationHandles.get(handle as object);
      if (entry === undefined || !entry.active || entry.handle !== handle) {
        throw new Error("Unknown or expired Standard approval preparation");
      }
      const operationKind = approvalPreparationKind(request.method);
      if (operationKind === undefined || entry.method !== request.method) {
        throw new TypeError("Approval preparation method changed");
      }
      assertTbcProviderRequest({
        jsonrpc: "2.0",
        id: request.id,
        method: request.method,
        ...(request.params === undefined ? {} : { params: request.params }),
      });
      const params = request.params as Readonly<{
        chainId?: string;
        from?: string;
        expiresAt?: string;
        signingRoles?: TransactionRoleRequest["signingRoles"];
        steps?: readonly Readonly<{ signingRoles?: TransactionRoleRequest["signingRoles"] }>[];
      }> | undefined;
      const requestHash = request.method === "tbc_requestAccounts"
        ? hashCanonical(Object.freeze([Object.freeze({
            tbc_accounts: Object.freeze({
              chains: Object.freeze([boundAuthority.currentSession.state.activeChainId]),
              maxAccounts: 1,
            }),
          })]))
        : hashCanonical(request.params ?? []);
      if (
        (request.method === "tbc_signPreparedTransaction" || request.method === "tbc_sendPreparedTransaction") &&
        (entry.requestId !== request.id || entry.inputHash !== requestHash)
      ) throw new Error("Prepared approval preparation changed its exact input");
      if (entry.requestHash !== undefined && entry.requestHash !== requestHash) {
        throw new Error("Standard approval preparation changed its exact request");
      }
      entry.operationKind = operationKind;
      entry.requestHash = requestHash;
      const reviewedTransactionScope = approvalPreparationReviewedTransactionScope(request);
      if (reviewedTransactionScope !== undefined) {
        entry.reviewedTransactionScope = reviewedTransactionScope;
      }
      if (entry.presentation === "approval") {
        entry.approvedWarningScope = approvalPreparationWarningScope(
          request,
          entry.reviewedTransactionScope,
        );
      }
      if (typeof params?.chainId === "string") entry.chainId = params.chainId;
      if (typeof params?.chainId === "string" && typeof params.from === "string") {
        entry.accountId = `${params.chainId}:${params.from}`;
      }
      const requestExpiry = approvalPreparationExpiry(request);
      if (requestExpiry !== undefined) {
        entry.expiresAt = Math.min(entry.expiresAt, requestExpiry);
        scheduleWorkflowPreparationExpiry(entry);
      }
      const unsupportedRole = (roles: TransactionRoleRequest["signingRoles"]) => roles?.some(({ role }) =>
        !options.approval.supportedSigningRoles?.includes(role));
      const genericPresentation = unsupportedRole(params?.signingRoles) || params?.steps?.some(step =>
        unsupportedRole(step.signingRoles)) ? undefined : approvalPreparation;
      if (genericPresentation !== undefined) {
        const requiresFeeCap = approvalPreparationRequiresFeeCap(request, operationKind);
        const suggestedFeeCapAtomic = explicitApprovalFeeCap(request);
        entry.requiresFeeCap = requiresFeeCap;
        if (suggestedFeeCapAtomic !== undefined) entry.feeCapAtomic = suggestedFeeCapAtomic;
        let settleEarlyCancellation!: () => void;
        const earlyCancellation = new Promise<StandardApprovalPreparationDecision>((resolve) => {
          settleEarlyCancellation = () => resolve(Object.freeze({ status: "rejected" as const }));
        });
        entry.settleEarlyCancellation = settleEarlyCancellation;
        const review = Promise.resolve().then(async () => {
          if (genericPresentation !== undefined) {
            const decision = await genericPresentation.review(Object.freeze({
              preparationId: entry.preparationId,
              method: entry.method,
              operationKind,
              requestHash,
              ...(entry.chainId === undefined ? {} : { chainId: entry.chainId }),
              ...(entry.accountId === undefined ? {} : { accountId: entry.accountId }),
              ...(suggestedFeeCapAtomic === undefined ? {} : { suggestedFeeCapAtomic }),
              requiresFeeCap,
              warningScope: entry.approvedWarningScope ?? Object.freeze([]),
              ...(entry.reviewedTransactionScope === undefined
                ? {}
                : { reviewedTransactionScope: entry.reviewedTransactionScope }),
              expiresAt: entry.expiresAt,
              context: entry.context,
              request: immutable(clone(request.params ?? [])),
            }));
            if (decision?.status === "rejected") return Object.freeze({ status: "rejected" as const });
            if (decision?.status !== "approved") return undefined;
            const decisionFeeCap = decision.feeCapAtomic ?? suggestedFeeCapAtomic;
            if (
              requiresFeeCap &&
              (typeof decisionFeeCap !== "string" || !/^(0|[1-9][0-9]*)$/u.test(decisionFeeCap))
            ) return undefined;
            if (
              decision.feeCapAtomic !== undefined &&
              suggestedFeeCapAtomic !== undefined &&
              BigInt(decision.feeCapAtomic) > BigInt(suggestedFeeCapAtomic)
            ) return undefined;
            return Object.freeze({
              status: "approved" as const,
              ...(decisionFeeCap === undefined ? {} : { feeCapAtomic: decisionFeeCap }),
            });
          }
        }).catch(() => undefined);
        entry.earlyConsent = Promise.race([review, earlyCancellation]);
      }
      let entries = workflowPreparationsByRequestHash.get(requestHash);
      if (entries === undefined) {
        entries = new Set();
        workflowPreparationsByRequestHash.set(requestHash, entries);
      }
      entries.add(entry);
      return entry;
    }

    async function workflowPreparationForApproval(
      params: unknown,
      callId: string,
    ): Promise<Readonly<{
      approvalPreparation: StandardApprovalPreparationApproval;
    }> | undefined> {
      if (params === null || typeof params !== "object") return undefined;
      const binding = Reflect.get(params, "binding");
      const requester = Reflect.get(params, "requester");
      if (
        binding === null || typeof binding !== "object" ||
        requester === null || typeof requester !== "object"
      ) return undefined;
      const payload = Reflect.get(binding, "payload");
      if (payload === null || typeof payload !== "object") return undefined;
      const requestHash = Reflect.get(payload, "requestHash");
      if (typeof requestHash !== "string") return undefined;
      const isPreparedTransaction = Reflect.get(payload, "method") === "tbc_signPreparedTransaction" ||
        Reflect.get(payload, "method") === "tbc_sendPreparedTransaction";
      // Prepared's formal hash excludes the proposal. Only the exact Core
      // approval call, correlated below to the original full request, may use
      // its early consent; matching the normalized intent alone is insufficient.
      const candidates = isPreparedTransaction
        ? [...workflowPreparations].filter((entry) =>
            entry.preparedApproval?.callId === callId && entry.preparedApproval.requestHash === requestHash)
        : [...(workflowPreparationsByRequestHash.get(requestHash) ?? [])];
      const entries = candidates
        .filter((entry) =>
          entry.active &&
          entry.readyCallId === undefined &&
          entry.method === Reflect.get(payload, "method") &&
          entry.operationKind === Reflect.get(payload, "operationKind") &&
          entry.chainId === Reflect.get(payload, "chainId") &&
          entry.accountId === Reflect.get(payload, "accountId") &&
          entry.context.sessionId === Reflect.get(payload, "sessionId") &&
          entry.context.origin === Reflect.get(payload, "origin") &&
          entry.context.origin === Reflect.get(requester, "origin") &&
          entry.context.topOrigin === Reflect.get(requester, "topOrigin") &&
          entry.context.transport === Reflect.get(requester, "transport") &&
          entry.context.frame === Reflect.get(requester, "frame") &&
          Date.now() < entry.expiresAt
        );
      // Ambiguous identical concurrent requests deliberately fall back to the
      // ordinary approval UI instead of risking cross-request presentation.
      if (entries.length !== 1) return undefined;
      const entry = entries[0]!;
      entry.readyCallId = callId;
      const preview = Reflect.get(params, "preview");
      const totalFee = preview !== null && typeof preview === "object"
        ? Reflect.get(preview, "totalFee")
        : undefined;
      const warnings = preview !== null && typeof preview === "object"
        ? Reflect.get(preview, "warnings")
        : undefined;
      const transactionCount = preview !== null && typeof preview === "object"
        ? Reflect.get(preview, "transactionCount")
        : undefined;
      const decision = entry.earlyConsent === undefined
        ? undefined
        : await entry.earlyConsent;
      // A bound refusal (including timer/session cancellation) grants no
      // authority. Preserve it across expiry instead of silently reopening
      // formal approval with already-expired material. Late approval below
      // still requires every live preparation and scope check.
      if (decision?.status === "rejected") {
        return Object.freeze({ approvalPreparation: Object.freeze({
          preparationId: entry.preparationId,
          method: entry.method,
          operationKind: entry.operationKind!,
          requestHash,
          startedAt: entry.startedAt,
          state: "ready" as const,
          earlyConsent: Object.freeze({ status: "rejected" as const }),
        }) });
      }
      // The review can remain open across expiry, cancellation or session
      // invalidation. Recheck after awaiting it; a timer is only cleanup, not
      // an authorization guarantee.
      if (
        !entry.active ||
        entry.readyCallId !== callId ||
        (isPreparedTransaction ? entry.preparedApproval?.requestHash : entry.requestHash) !== requestHash ||
        Date.now() >= entry.expiresAt ||
        !workflowPreparations.has(entry)
      ) return undefined;
      const warningsAreWithinScope = entry.operationKind === "permission" ||
        entry.operationKind === "switchChain" ||
        (Array.isArray(warnings) && warnings.every((warning) =>
          typeof warning === "string" && entry.approvedWarningScope?.includes(warning) === true
        ));
      // Dependency count is bound by the exact requestHash; the final review
      // must additionally preserve the user-visible transaction/warning scope.
      const reviewedTransactionScopeMatches = entry.method !== "tbc_signReviewedTransaction" ||
        (entry.reviewedTransactionScope !== undefined &&
          transactionCount === entry.reviewedTransactionScope.transactionCount &&
          same(warnings, entry.reviewedTransactionScope.warnings));
      const approvedFeeCap = decision?.status === "approved"
        ? decision.feeCapAtomic ?? entry.feeCapAtomic
        : undefined;
      const feeIsWithinScope = entry.requiresFeeCap !== true ||
        (typeof approvedFeeCap === "string" && /^(0|[1-9][0-9]*)$/u.test(approvedFeeCap) &&
          typeof totalFee === "string" && /^(0|[1-9][0-9]*)$/u.test(totalFee) &&
          BigInt(totalFee) <= BigInt(approvedFeeCap));
      const earlyConsent = decision === undefined
        ? undefined
        : warningsAreWithinScope && reviewedTransactionScopeMatches && feeIsWithinScope
            ? Object.freeze({
                status: "approved" as const,
                ...(approvedFeeCap === undefined ? {} : { feeCapAtomic: approvedFeeCap }),
              })
            : undefined;
      const approvalPreparation = Object.freeze({
        preparationId: entry.preparationId,
        method: entry.method,
        operationKind: entry.operationKind!,
        requestHash,
        startedAt: entry.startedAt,
        state: "ready" as const,
        ...(earlyConsent === undefined ? {} : { earlyConsent }),
      });
      return Object.freeze({ approvalPreparation });
    }

    function finishPreparation(
      entry: PreparationEntry,
      status?: "ready" | "discarded" | "miss",
      stage: KitWalletRequestPreparationDiagnostic["stage"] = "lifecycle",
      category: KitWalletRequestPreparationDiagnostic["category"] = "unexpected",
    ): void {
      if (entry.expiryTimer !== undefined) clearTimeout(entry.expiryTimer);
      entry.expiryTimer = undefined;
      entry.active = false;
      if (preparation === entry) preparation = undefined;
      if (status !== undefined) entry.settle(Object.freeze({ status, stage, category }));
    }

    function schedulePreparationExpiry(entry: PreparationEntry, expiresAt: number): void {
      if (!entry.active) return;
      entry.expiresAt = Math.min(entry.expiresAt, expiresAt);
      if (entry.expiryTimer !== undefined) clearTimeout(entry.expiryTimer);
      const delay = Math.max(0, entry.expiresAt - Date.now());
      entry.expiryTimer = setTimeout(
        () => finishPreparation(entry, "discarded", "lifecycle", "expired"),
        delay,
      );
    }

    async function preparationBindingCurrent(entry: PreparationEntry): Promise<boolean> {
      if (!entry.active || entry.account === undefined || entry.authorityIdentity === undefined) return false;
      const currentAuthority = checkedAuthority(await authoritySource.read());
      if (
        deriveHostAuthorityIdentity(currentAuthority) !== entry.authorityIdentity ||
        deriveHostAuthorityIdentity(boundAuthority) !== entry.authorityIdentity
      ) return false;
      const state = currentAuthority.currentSession.state;
      if (
        state.connected !== true ||
        state.activeChainId !== entry.account.chainId ||
        !state.activeAccountIds.includes(entry.account.accountId)
      ) return false;
      const currentAccounts = await options.accounts.current();
      if (entry.roleBinding !== undefined) {
        const { request, accounts: boundAccounts } = entry.roleBinding;
        if (!transactionSigningAccountIds(request).every(id => state.activeAccountIds.includes(id))) return false;
        try {
          return same(resolveTransactionSigningAccounts(request, currentAccounts), resolveTransactionSigningAccounts(request, boundAccounts));
        } catch { return false; }
      }
      return currentAccounts.some((candidate) => same(candidate, entry.account));
    }

    function prefetchRequest(rawRequest: KitWalletRequest): KitWalletRequestPreparation {
      if (closed) throw new Error("The wallet session is closed");
      if (
        rawRequest === null ||
        typeof rawRequest !== "object" ||
        (typeof rawRequest.id !== "string" && typeof rawRequest.id !== "number") ||
        typeof rawRequest.method !== "string"
      ) throw new TypeError("Invalid wallet request preparation");
      const exactRequest = immutable(clone(rawRequest));
      const requestIdentity = walletRequestIdentity(exactRequest);
      if (preparation?.active === true && preparation.requestIdentity === requestIdentity) {
        return preparation.handle!;
      }
      if (preparation !== undefined) {
        finishPreparation(preparation, "discarded", "lifecycle", "superseded");
      }
      let settleReady!: (status: "ready" | "discarded" | "miss") => void;
      let settleDiagnostic!: (diagnostic: KitWalletRequestPreparationDiagnostic) => void;
      let settled = false;
      const ready = new Promise<"ready" | "discarded" | "miss">((resolve) => {
        settleReady = resolve;
      });
      const diagnostic = new Promise<KitWalletRequestPreparationDiagnostic>((resolve) => {
        settleDiagnostic = resolve;
      });
      const settle = (outcome: KitWalletRequestPreparationDiagnostic) => {
          if (settled) return;
          settled = true;
          settleReady(outcome.status);
          settleDiagnostic(outcome);
      };
      const startedAt = Date.now();
      const entry: PreparationEntry = {
        exactRequest,
        requestIdentity,
        startedAt,
        ready,
        diagnostic,
        settle,
        active: true,
        consumed: false,
        executions: 0,
        expiresAt: startedAt + REQUEST_PREPARATION_TTL_MS,
        expiryTimer: undefined,
      };
      const handle = Object.freeze({
        requestIdentity,
        ready,
        diagnostic,
        cancel: () =>
          finishPreparation(entry, "discarded", "lifecycle", "cancelled"),
      });
      entry.handle = handle;
      preparation = entry;
      schedulePreparationExpiry(entry, entry.expiresAt);
      entry.started = (async () => {
        let stage: KitWalletRequestPreparationDiagnostic["stage"] = "authority";
        try {
        const requestView = activeAccountView();
        const authority = checkedAuthority(await authoritySource.read());
        const authorityIdentity = deriveHostAuthorityIdentity(authority);
        if (authorityIdentity !== deriveHostAuthorityIdentity(boundAuthority) ||
            authority.currentSession.state.activeChainId !== requestView.chainId ||
            authority.currentSession.state.revision !== requestView.revision) {
          finishPreparation(entry, "discarded", "authority", "authority-changed");
          return false;
        }
        stage = "normalize";
        const engineRequest = transactionEngineRequest(exactRequest);
        const normalizeParams = Object.freeze({ version: "1.0" as const, request: engineRequest });
        assertValidTws("normalizeRequestParams", normalizeParams);
        const normalized = await transactionEngine.normalizeRequest(
          normalizeParams as Parameters<TransactionEngine["normalizeRequest"]>[0],
        ) as Readonly<{
          request: Readonly<{
            chainId: string;
            from: string;
            intent: Readonly<Record<string, unknown>> & { readonly type: string };
            constraints?: Readonly<{ expiresAt?: string }>;
            signingRoles?: TransactionRoleRequest["signingRoles"];
          }>;
          requestHash: string;
        }>;
        assertValidTws("normalizeRequestResult", normalized);
        if (hashCanonical(normalized.request) !== normalized.requestHash) {
          throw new Error("Normalized request hash mismatch");
        }
        const originalRoles = (engineRequest as TransactionRoleRequest).signingRoles;
        if (originalRoles !== undefined || normalized.request.signingRoles !== undefined) {
          const original = engineRequest as TransactionRoleRequest;
          if (original.chainId !== normalized.request.chainId || original.from !== normalized.request.from ||
              !same(originalRoles ?? [], normalized.request.signingRoles ?? [])) throw new Error("Normalized signing role selection changed");
        }
        stage = "account";
        const account = requestView.accounts.find((candidate) =>
          candidate.chainId === normalized.request.chainId &&
          candidate.address === normalized.request.from
        );
        if (account === undefined) {
          finishPreparation(entry, "discarded", "account", "authority-changed");
          return false;
        }
        const state = authority.currentSession.state;
        if (
          state.connected !== true ||
          state.activeChainId !== account.chainId ||
          !state.activeAccountIds.includes(account.accountId)
        ) {
          finishPreparation(entry, "discarded", "account", "authority-changed");
          return false;
        }
        const currentAccounts = await options.accounts.current();
        if (!currentAccounts.some((candidate) => same(candidate, account))) {
          finishPreparation(entry, "discarded", "account", "authority-changed");
          return false;
        }
        const roleAccounts = normalized.request.signingRoles === undefined ? undefined
          : resolveTransactionSigningAccounts(normalized.request, requestView.accounts);
        if (roleAccounts !== undefined) {
          if (!transactionSigningAccountIds(normalized.request).every(id => state.activeAccountIds.includes(id)) ||
              !same(roleAccounts, resolveTransactionSigningAccounts(normalized.request, currentAccounts))) {
            finishPreparation(entry, "discarded", "account", "authority-changed");
            return false;
          }
          entry.roleBinding = immutable({ request: clone(normalized.request), accounts: [roleAccounts.primary, ...roleAccounts.additional] });
        }
        const requestExpiry = normalized.request.constraints?.expiresAt;
        if (requestExpiry !== undefined) {
          const expiry = Date.parse(requestExpiry);
          if (!Number.isFinite(expiry) || expiry <= Date.now()) {
            finishPreparation(entry, "discarded", "lifecycle", "expired");
            return false;
          }
          schedulePreparationExpiry(entry, expiry);
        }
        if (!entry.active) return false;
        const chainDataParams = immutable({
          version: "1.0" as const,
          chainId: account.chainId,
          accountId: account.accountId,
          requirement: preparedChainDataRequirement(
            normalized.request as KitTransactionRequest<KitSupportedIntent>,
          ),
          ...(roleAccounts === undefined ? {} : {
            signingRoles: normalized.request.signingRoles,
            ...(roleAccounts.additional.length === 0 ? {} : { signingAccounts: roleAccounts.additional }),
          }),
        });
        entry.authorityIdentity = authorityIdentity;
        entry.account = immutable(clone(account));
        entry.chainDataParamsCanonical = canonicalize(chainDataParams);
        stage = "chain-data";
        entry.result = Promise.resolve()
          .then(() => {
            if (activeAccountView().revision !== requestView.revision ||
                activeAccountView().chainId !== requestView.chainId) {
              throw new Error("Wallet account view changed before prepared Chain Data");
            }
            return requestView.network.resolveChainData(chainDataParams, undefined, entry.account);
          })
          .then(async (result) => {
            const portError = (result as Readonly<{
              portError?: Readonly<{ name?: unknown }>;
            }>).portError;
            if (portError !== undefined) {
              const category = portError.name === "UNAVAILABLE"
                ? "chain-data-unavailable"
                : portError.name === "CONFLICT"
                  ? "chain-data-conflict"
                  : portError.name === "UNAUTHORIZED"
                    ? "chain-data-unauthorized"
                    : portError.name === "INVALID_INPUT"
                      ? "chain-data-invalid-input"
                      : "unexpected";
              finishPreparation(entry, "miss", "chain-data", category);
              return undefined;
            }
            assertValidTws("chainDataResolveResult", result);
            const snapshot = result as Readonly<{
              payload: Readonly<{
                chainId: string;
                expiresAt: string;
                account: KitWalletAccount;
                signingAccounts?: readonly TransactionRoleAccount[];
              }>;
              snapshotHash: string;
            }>;
            if (
              hashCanonical(snapshot.payload) !== snapshot.snapshotHash ||
              snapshot.payload.chainId !== account.chainId ||
              !same(snapshot.payload.account, account)
            ) throw new Error("Prepared Chain Data binding mismatch");
            if (entry.roleBinding !== undefined) assertTransactionSigningSnapshot(
              entry.roleBinding.request, entry.roleBinding.accounts, snapshot.payload,
            );
            const expiry = Date.parse(snapshot.payload.expiresAt);
            if (!Number.isFinite(expiry) || expiry <= Date.now()) {
              throw new Error("Prepared Chain Data is expired");
            }
            schedulePreparationExpiry(entry, expiry);
            stage = "binding";
            if (!await preparationBindingCurrent(entry)) {
              finishPreparation(entry, "discarded", "binding", "authority-changed");
              return undefined;
            }
            if (entry.active) {
              entry.settle(Object.freeze({
                status: "ready",
                stage: "chain-data",
                category: "ready",
              }));
            }
            return result;
          })
          .catch(() => {
            finishPreparation(entry, "miss", stage, "unexpected");
            return undefined;
          });
        return true;
        } catch {
          finishPreparation(entry, "miss", stage, "unexpected");
          return false;
        }
      })().catch(() => {
        finishPreparation(entry, "miss", "lifecycle", "unexpected");
        return false;
      });
      return handle;
    }

    async function beginPreparedExecution(request: KitWalletRequest): Promise<PreparationEntry | undefined> {
      const entry = preparation;
      if (entry === undefined || !entry.active) return undefined;
      const requestIdentity = walletRequestIdentity(request);
      if (entry.requestIdentity !== requestIdentity) {
        if (same(entry.exactRequest.id, request.id)) {
          finishPreparation(
            entry,
            "discarded",
            "lifecycle",
            "request-mismatch",
          );
        }
        return undefined;
      }
      if (!await entry.started || !entry.active || Date.now() >= entry.expiresAt) {
        finishPreparation(entry, "discarded", "lifecycle", "expired");
        return undefined;
      }
      if (!await preparationBindingCurrent(entry)) {
        finishPreparation(entry, "discarded", "binding", "authority-changed");
        return undefined;
      }
      entry.executions += 1;
      return entry;
    }

    async function consumePreparedChainData(params: unknown): Promise<Readonly<{
      hit: boolean;
      result?: unknown;
    }>> {
      const entry = preparation;
      if (
        entry === undefined ||
        !entry.active ||
        entry.consumed ||
        entry.executions !== 1 ||
        entry.chainDataParamsCanonical !== canonicalize(params) ||
        entry.result === undefined ||
        Date.now() >= entry.expiresAt
      ) return Object.freeze({ hit: false });
      if (!await preparationBindingCurrent(entry)) {
        finishPreparation(entry, "discarded");
        return Object.freeze({ hit: false });
      }
      const result = await entry.result;
      if (
        result === undefined ||
        !entry.active ||
        Date.now() >= entry.expiresAt ||
        !await preparationBindingCurrent(entry)
      ) {
        finishPreparation(entry, "discarded");
        return Object.freeze({ hit: false });
      }
      entry.consumed = true;
      finishPreparation(entry);
      return Object.freeze({ hit: true, result });
    }

    let activeMultiRoundExecution: Readonly<{
      scope: import("./multi-round-merge.js").TbcMultiRoundMergeScope;
      scopeHash: string;
      approval: Extract<TbcMultiRoundMergeApprovalDecision, { status: "approved" }>;
      requestHash: string;
      maximumFee: string;
      authority: Readonly<{
        chainId: string;
        accountId: string;
        origin: string;
        sessionId: string;
      }>;
    }> | undefined;
    let activeMultiRoundBroadcast: "not-started" | "started" | "accepted" | "known" | "rejected" = "not-started";
    let activeMultiRoundRun = false;

    async function invokePort(
      call: AnyPortCall,
      executionType: KitHostPortCall["execution"]["type"],
    ): Promise<unknown> {
      // Closing a session also fences queued continuations, not just the page
      // transport. Already-dispatched effects retain their journal semantics.
      if (closed) throw new Error("The wallet session is closed");
      // Core/Host already validate the Port schema. Snapshot the complete call
      // exactly once here because wallet callbacks are an external boundary.
      // The earlier implementation canonicalized/cloned the same large
      // transaction material four times per Port and cloned cached results on
      // every read, which was visible between a batch transaction and its
      // dependent message signature on mobile.
      const callSnapshotStartedAt =
        options.onPerformance === undefined ? undefined : performanceNow();
      const canonicalCall = canonicalize(call);
      const cacheKey = `${executionType}:${call.callId}`;
      const prior = calls.get(cacheKey);
      if (prior !== undefined) {
        if (callSnapshotStartedAt !== undefined) {
          reportPerformance({
            component: "host-port",
            stage: "port-call-snapshot",
            operation: call.operation,
            durationMs: performanceNow() - callSnapshotStartedAt,
            count: 1,
            bytes: utf8(canonicalCall).length,
          });
        }
        if (prior.canonicalCall !== canonicalCall) throw new Error("Host Port call ID collision");
        return await prior.promise;
      }
      const envelope = immutable({
        ...(JSON.parse(canonicalCall) as AnyPortCall),
        execution: { type: executionType },
      }) as KitHostPortCall;
      if (callSnapshotStartedAt !== undefined) {
        reportPerformance({
          component: "host-port",
          stage: "port-call-snapshot",
          operation: call.operation,
          durationMs: performanceNow() - callSnapshotStartedAt,
          count: 1,
          bytes: utf8(canonicalCall).length,
        });
      }
      const executePort = async (): Promise<unknown> => {
        switch (call.operation) {
          case "accounts.resolve": {
            const requested = call.params as { chainId?: unknown; mode?: unknown };
            const view = activeAccountView();
            if (requested?.mode === "available" &&
                typeof requested.chainId === "string" &&
                requested.chainId !== view.chainId) {
              const available = await options.accounts.forChain?.(requested.chainId as `tbc:${string}`) ?? [];
              // This is wallet-owned target-chain inventory, not the active
              // session snapshot. Reject an inconsistent inventory before Core
              // can present or commit a grant for it. The active hot path does
              // not acquire another account read.
              assertValidTws("accountsResolveResult", { accounts: available });
              const seen = new Set<string>();
              for (const account of available) {
                if (account.chainId !== requested.chainId ||
                    account.accountId !== `${account.chainId}:${account.address}` ||
                    seen.has(account.accountId)) {
                  throw new Error("Invalid target-chain wallet account inventory");
                }
                seen.add(account.accountId);
              }
              return { accounts: clone(available) };
            }
            if (requested?.chainId !== view.chainId) {
              throw new Error("Account resolution is outside the committed wallet chain");
            }
            return { accounts: clone(view.accounts) };
          }
          case "chainData.resolve": {
            const portNetwork = networkForPort((call.params as { chainId?: unknown }).chainId);
            const prepared = await consumePreparedChainData(call.params);
            // Preparation may have waited for chain data while a native
            // authority commit revoked the old session view.
            if (networkForPort((call.params as { chainId?: unknown }).chainId) !== portNetwork) {
              throw new Error("Wallet network resources changed during Chain Data preparation");
            }
            const accountId = call.params !== null && typeof call.params === "object"
              ? Reflect.get(call.params, "accountId")
              : undefined;
            const account = typeof accountId === "string"
              ? activeAccountView().accounts.find((candidate) => candidate.accountId === accountId)
              : undefined;
            return prepared.hit
              ? prepared.result
              : portNetwork.resolveChainData(call.params, envelope, account);
          }
          case "policy.resolve": return networkForPort(
            (call.params as { request?: { chainId?: unknown } }).request?.chainId,
          ).resolvePolicy(call.params, envelope);
          case "permissionStore.load": return options.storage.loadPermissions(call.params, envelope);
          case "permissionStore.commit": return options.storage.commitPermissions(call.params, envelope);
          case "approval.request": {
            const rolePreview = (call.params as { preview?: { signingRoles?: readonly { role: string }[] } }).preview?.signingRoles;
            if (rolePreview !== undefined && rolePreview.some(({ role }) =>
              !options.approval.supportedSigningRoles?.some(supported => supported === role))) {
              return { portError: { name: "UNAVAILABLE", message: "Wallet review does not support the requested signing role", retryable: false } };
            }
            const bounded = activeMultiRoundExecution;
            if (bounded !== undefined) {
              const params = call.params as Readonly<{
                binding: Readonly<{
                  bindingHash: string;
                  payload: Readonly<{
                    operationKind: string;
                    requestHash: string;
                    chainId?: string;
                    accountId?: string;
                    origin: string;
                    sessionId: string;
                    expiresAt: string;
                  }>;
                }>;
                preview: Readonly<{ transactionCount: number; totalFee: string }>;
              }>;
              const payload = params.binding.payload;
              if (
                payload.operationKind !== "transaction" ||
                payload.requestHash !== bounded.requestHash ||
                payload.chainId !== bounded.authority.chainId ||
                payload.accountId !== bounded.authority.accountId ||
                payload.origin !== bounded.authority.origin ||
                payload.sessionId !== bounded.authority.sessionId ||
                params.preview.transactionCount !== 1 ||
                typeof params.preview.totalFee !== "string" ||
                !/^(?:0|[1-9][0-9]*)$/u.test(params.preview.totalFee) ||
                BigInt(params.preview.totalFee) > BigInt(bounded.maximumFee) ||
                Date.parse(payload.expiresAt) > Date.parse(bounded.approval.expiresAt)
              ) throw new Error("Multi-round formal approval is outside the bounded consent");
              // This is a wallet-local expiry check inside the approval Host
              // call, not a nested clock.now Host operation. Passing the
              // approval envelope here would misidentify the clock adapter's
              // Port call and must remain distinct from the clock.now case.
              const approvedAt = await (options.clock?.() ?? new Date().toISOString());
              if (Date.parse(approvedAt) >= Date.parse(payload.expiresAt)) {
                throw new Error("Multi-round formal approval expired before execution");
              }
              return options.multiRoundMerge!.authorizeStep(Object.freeze({
                scope: bounded.scope,
                scopeHash: bounded.scopeHash,
                approval: bounded.approval,
                params: call.params,
              }), envelope);
            }
            const approvalPreparation = await workflowPreparationForApproval(
              call.params,
              call.callId,
            );
            const approvalEnvelope = approvalPreparation === undefined
              ? envelope
              : immutable({ ...envelope, ...approvalPreparation });
            return options.approval.request(call.params, approvalEnvelope);
          }
          case "signer.sign": return options.signer.sign(call.params, envelope);
          case "crypto.execute": {
            if (options.crypto === undefined) throw new Error("Wallet crypto capability is unavailable");
            return options.crypto.execute(call.params, envelope);
          }
          case "reviewedTransaction.review": {
            if (options.reviewedTransaction === undefined) {
              throw new Error("Wallet reviewed transaction capability is unavailable");
            }
            return options.reviewedTransaction.review(call.params, envelope);
          }
          case "reviewedTransaction.execute": {
            if (options.reviewedTransaction === undefined) {
              throw new Error("Wallet reviewed transaction capability is unavailable");
            }
            return options.reviewedTransaction.execute(call.params, envelope);
          }
          case "broadcast.submit": {
            const portNetwork = networkForPort((call.params as { chainId?: unknown }).chainId);
            if (activeMultiRoundExecution !== undefined) activeMultiRoundBroadcast = "started";
            const result = await portNetwork.broadcastSubmit(call.params, envelope) as Readonly<{ status?: unknown }>;
            if (
              activeMultiRoundExecution !== undefined &&
              (result.status === "accepted" || result.status === "known" || result.status === "rejected")
            ) activeMultiRoundBroadcast = result.status;
            return result;
          }
          case "broadcast.submitBatch": return networkForPort(
            (call.params as { chainId?: unknown }).chainId,
          ).broadcastSubmitBatch(call.params, envelope);
          case "broadcast.reconcile": return networkForPort(
            (call.params as { chainId?: unknown }).chainId,
            true,
          ).broadcastReconcile(call.params, envelope);
          case "clock.now": return { now: await (options.clock?.(envelope) ?? new Date().toISOString()) };
          case "entropy.randomBytes": return {
            bytes: base64urlEncode(await entropy(
              options,
              Number((call.params as { readonly length: number }).length),
              envelope,
            )),
          };
          default: {
            const exhaustive: never = call;
            throw new Error(`Unsupported Host Port call: ${String((exhaustive as AnyPortCall).operation)}`);
          }
        }
      };
      const callbackStartedAt =
        options.onPerformance === undefined ? undefined : performanceNow();
      const execute = executePort().then((result) => {
        if (callbackStartedAt !== undefined) {
          reportPerformance({
            component: "host-port",
            stage: "port-wallet-callback",
            operation: call.operation,
            durationMs: performanceNow() - callbackStartedAt,
            count: 1,
            bytes: 0,
          });
        }
        const resultSnapshotStartedAt =
          options.onPerformance === undefined ? undefined : performanceNow();
        const canonicalResult = canonicalize(result);
        const snapshot = immutable(JSON.parse(canonicalResult));
        if (resultSnapshotStartedAt !== undefined) {
          reportPerformance({
            component: "host-port",
            stage: "port-result-snapshot",
            operation: call.operation,
            durationMs: performanceNow() - resultSnapshotStartedAt,
            count: 1,
            bytes: utf8(canonicalResult).length,
          });
        }
        return snapshot;
      });
      calls.set(cacheKey, Object.freeze({ canonicalCall, promise: execute }));
      try {
        return await execute;
      } catch (error) {
        calls.delete(cacheKey);
        throw error;
      }
    }
    function portHandler<K extends PortOperation>(
      executionType: KitHostPortCall["execution"]["type"],
    ): TwsHostPortHandler<K> {
      return (call) => invokePort(call, executionType) as Promise<TwsHostPortOutcome<K>>;
    }
    function createPorts(
      executionType: KitHostPortCall["execution"]["type"],
    ): TwsHostPorts {
      return Object.freeze({
        accounts: portHandler<"accounts.resolve">(executionType),
        chainData: portHandler<"chainData.resolve">(executionType),
        policy: portHandler<"policy.resolve">(executionType),
        permissionStore: portHandler<"permissionStore.load" | "permissionStore.commit">(executionType),
        approval: portHandler<"approval.request">(executionType),
        signer: portHandler<"signer.sign">(executionType),
        ...(options.crypto === undefined
          ? {}
          : { crypto: portHandler<"crypto.execute">(executionType) }),
        ...(options.reviewedTransaction === undefined
          ? {}
          : {
              reviewedTransaction: portHandler<
                "reviewedTransaction.review" | "reviewedTransaction.execute"
              >(executionType),
            }),
        broadcast: portHandler<"broadcast.submit" | "broadcast.submitBatch" | "broadcast.reconcile">(executionType),
        clock: portHandler<"clock.now">(executionType),
        entropy: portHandler<"entropy.randomBytes">(executionType),
      } satisfies TwsHostPorts);
    }
    const coreImplementation = createTwsCore({
      transactionEngine,
      ...(options.capabilities === undefined
        ? {}
        : { capabilities: options.capabilities }),
      ...(legacyDigest === undefined
        ? {}
        : {
            legacyBitcoinMessageDigest: async ({ requestId, message }) => {
              if (
                typeof requestId === "string" &&
                authorizedLegacyRequestIds.has(requestId)
              ) {
                return legacyDigest(Object.freeze({
                  version: "1.0",
                  message,
                }));
              }
              return undefined;
            },
          }),
    });
    const core = Object.freeze({
      ...coreImplementation,
      async resume(input: Parameters<typeof coreImplementation.resume>[0]) {
        const transition = await coreImplementation.resume(input);
        if (workflowPreparations.size !== 0 && transition.kind === "waiting" && transition.checkpoint.payload.state === "approval") {
          const operation = transition.checkpoint.payload.operation as { method?: unknown; params?: unknown };
          if (operation.method === "tbc_signPreparedTransaction" || operation.method === "tbc_sendPreparedTransaction") {
            const requestHash = hashCanonical(operation.params ?? []);
            const matches = [...workflowPreparations].filter((entry) =>
              entry.active && entry.method === operation.method &&
              entry.requestId === transition.checkpoint.payload.requestId &&
              entry.requestHash === requestHash && entry.inputHash === requestHash &&
              Date.now() < entry.expiresAt);
            const approvalCall = transition.calls.find((call) => call.operation === "approval.request");
            if (matches.length === 1 && approvalCall?.operation === "approval.request") {
              matches[0]!.preparedApproval = Object.freeze({
                callId: approvalCall.callId,
                requestHash: approvalCall.params.binding.payload.requestHash,
              });
            }
          }
        }
        if (
          input.checkpoint.payload.state === "authorizing" &&
          transition.checkpoint.payload.state === "resolving"
        ) {
          const operation = transition.checkpoint.payload.operation;
          if (operation !== null && typeof operation === "object" && !Array.isArray(operation)) {
            await startAuthorizedPreparation(
              transition.checkpoint.payload.requestId,
              operation as Readonly<{ method: unknown; params?: unknown }>,
            );
          }
        }
        return transition;
      },
    });
    function createHost(
      store: TwsHostStore,
      executionType: KitHostPortCall["execution"]["type"],
    ) {
      return createTwsHost({
        core,
        ports: createPorts(executionType),
        // A supported 500-input merge requires a freshness checkpoint and
        // signature transition per input, plus planning/approval/finalization.
        // This is a finite work ceiling, not extra work for smaller requests.
        maxSteps: 2_048,
        store,
        authority: authoritySource,
        ownerId: `${profile}:${sessionId}:${executionType}`,
        scheduleLeaseHeartbeat: (delayMs, run) => {
          const handle = setTimeout(run, delayMs);
          return () => clearTimeout(handle);
        },
      });
    }
    if (sessionOptions.execution !== undefined && sessionOptions.signOnly !== undefined) {
      throw new TypeError("Configure one session execution Host store");
    }
    const configuredSessionStore = (
      sessionOptions.execution?.hostStore ?? sessionOptions.signOnly?.hostStore
    ) as TwsHostStore | undefined;
    // Every new Core/Host transition is live-session state. Durable state starts
    // only inside the broadcast journal at broadcast.submit.
    const sessionHost = createHost(
      configuredSessionStore ?? createMemoryTwsHostStore(),
      "session-only",
    );
    // Historical Candidate rows are read/cancel-only. They are never selected
    // for a new operation and can never be resumed after restart.
    const historicalHost = historicalStore === undefined
      ? undefined
      : createHost(historicalStore, "durable");
    const hostForMethod = (_method: string) => sessionHost;
    const operationByRequest = new Map<TbcJsonRpcId, Readonly<{
      host: ReturnType<typeof createHost>;
      operationId: string;
    }>>();
    const deliveriesByRequest = new Map<TbcJsonRpcId, {
      readonly requestIdentity: string;
      readonly promise: Promise<TbcTransportDelivery>;
      readonly preparationId?: string;
      authoritySnapshotIdentity?: string;
    }>();
    const dappMultiRoundAbortByRequest = new Map<TbcJsonRpcId, AbortController>();
    let runMultiRoundMerge!: KitWalletSession["runMultiRoundMerge"];
    const hostByOperation = new Map<string, ReturnType<typeof createHost>>();
    const startWalletOperation = async (
      request: KitWalletRequest,
    ): Promise<TwsHostOperationResult> => {
      const host = hostForMethod(request.method);
      const result = await host.startOperation({
        version: "1.0",
        release: TWS_RELEASE,
        request: {
          jsonrpc: "2.0",
          id: request.id,
          method: request.method as TbcJsonRpcRequest["method"],
          ...(request.params === undefined ? {} : { params: request.params }),
        } as TbcJsonRpcRequest,
        ...(injectedAuthority === undefined ? {} : {
          expectedAuthorityIdentity: deriveHostAuthorityIdentity(boundAuthority),
        }),
      });
      hostByOperation.set(result.operationId, host);
      return result;
    };
    const hostForOperation = (operationId: string) => {
      if (typeof operationId !== "string" || operationId.length === 0) {
        throw new TypeError("An operationId is required");
      }
      const host = hostByOperation.get(operationId);
      if (host === undefined) throw new Error("The wallet operation is not active in this session");
      return host;
    };
    const executeProviderRequest = async (
      request: TbcJsonRpcRequest,
      providedWorkflowPreparation?: StandardApprovalPreparationHandle,
    ): Promise<TbcTransportDelivery> => {
      if (
        typeof request.id === "string" &&
        (request.id.startsWith("kit-legacy:") ||
          request.id.startsWith("kit-legacy-action:") ||
          request.id.startsWith("kit-legacy-workflow:")) &&
        !authorizedLegacyRequestIds.has(request.id)
      ) {
        throw new Error("Reserved wallet-owned request identity");
      }
      const walletRequest = request as KitWalletRequest;
      const operationKind = approvalPreparationKind(request.method);
      if (operationKind === undefined && providedWorkflowPreparation !== undefined) {
        providedWorkflowPreparation.cancel("failed");
        throw new TypeError("Standard approval preparation requires an approval method");
      }
      let workflowPreparation: WorkflowPreparationEntry | undefined;
      if (operationKind !== undefined) {
        let validRequest = true;
        try {
          assertTbcProviderRequest(request);
        } catch {
          validRequest = false;
        }
        if (validRequest) {
          const requestCount = operationKind === "workflow" &&
              request.params !== null && typeof request.params === "object" &&
              Array.isArray(Reflect.get(request.params, "steps"))
            ? (Reflect.get(request.params, "steps") as readonly unknown[]).length
            : 1;
          const handle = providedWorkflowPreparation ??
            (approvalPreparation !== undefined
              ? beginApprovalPreparation({
                  requestId: request.id,
                  method: request.method as StandardApprovalPreparationMethod,
                  requestCount,
                  inputHash: hashCanonical(request.params ?? []),
                })
              : undefined);
          if (handle !== undefined) {
            workflowPreparation = bindWorkflowPreparation(handle, walletRequest);
          }
        } else {
          providedWorkflowPreparation?.cancel("failed");
        }
      }
      let preparedExecution = await beginPreparedExecution(request as KitWalletRequest);
      // Arm memory-only Chain Data preparation after the native approval shell
      // begins, but start it only when Core has validated permissions and
      // advances from authorizing to resolving. This preserves early overlap
      // without allowing an unauthorized request to trigger remote reads.
      if (
        preparedExecution === undefined &&
        workflowPreparation?.presented === true &&
        approvalRequestNeedsChainData(walletRequest)
      ) {
        preparationsAwaitingAuthorization.set(
          authorizationPreparationIdentity(request.id, {
            method: request.method,
            params: request.params ?? [],
          }),
          Object.freeze({
            entry: workflowPreparation,
            request: walletRequest,
            accept: (entry: PreparationEntry | undefined) => {
              preparedExecution = entry;
            },
          }),
        );
      }
      const host = hostForMethod(request.method);
      let workflowOutcome: StandardApprovalPreparationOutcome = "failed";
      try {
        let result: TwsHostOperationResult = await startWalletOperation(request as KitWalletRequest);
        operationByRequest.set(request.id, Object.freeze({ host, operationId: result.operationId }));
        for (let attempt = 0; (result.status === "waiting" || result.status === "busy") && attempt < 64; attempt += 1) {
          await Promise.resolve();
          result = await host.resumeOperation({ operationId: result.operationId });
        }
        if (result.status === "failed") {
          throw new Error(`Host operation did not produce a response: ${result.status}`);
        }
        if ((result.status !== "complete" && result.status !== "cancelled") || result.completion.delivery !== "respond") {
          throw new Error(`Host operation did not produce a response: ${result.status}`);
        }
        const response = result.completion.response as Readonly<Record<string, unknown>>;
        const error = response !== null && typeof response === "object"
          ? Reflect.get(response, "error")
          : undefined;
        const code = error !== null && typeof error === "object"
          ? Reflect.get(error, "code")
          : undefined;
        workflowOutcome = result.status === "cancelled"
          ? "cancelled"
          : code === 4001
            ? "rejected"
            : error === undefined
              ? "complete"
              : "failed";
        return Object.freeze({
          deliveryId: result.deliveryId,
          response: result.completion.response,
          events: result.completion.events.map(assertTbcProviderEvent),
        });
      } finally {
        preparationsAwaitingAuthorization.delete(
          authorizationPreparationIdentity(request.id, {
            method: request.method,
            params: request.params ?? [],
          }),
        );
        operationByRequest.delete(request.id);
        if (workflowPreparation !== undefined) {
          finishWorkflowPreparation(workflowPreparation, workflowOutcome);
        }
        if (preparedExecution !== undefined) {
          preparedExecution.executions -= 1;
          if (preparedExecution.active && preparedExecution.executions === 0) {
            finishPreparation(preparedExecution, "discarded");
          }
        }
      }
    };
    const executeDappMultiRoundMergeRequest = async (
      request: TbcJsonRpcRequest,
    ): Promise<TbcTransportDelivery> => {
      const response = (body:
        | Readonly<{ readonly result: unknown }>
        | Readonly<{ readonly error: Readonly<{
            readonly code: -32602 | -32603 | 4100;
            readonly message: string;
          }> }>
      ): TbcTransportDelivery => immutable({
        deliveryId: hashCanonical({
          domain: "tbc-kit/dapp-multi-round-delivery/1",
          origin: boundAuthority.currentContext.origin,
          sessionId: boundAuthority.currentContext.sessionId,
          request,
          response: body,
        }),
        response: "result" in body
          ? immutable({ jsonrpc: "2.0" as const, id: request.id, result: body.result })
          : immutable({ jsonrpc: "2.0" as const, id: request.id, error: body.error }),
        events: Object.freeze([]),
      });
      try {
        const params = request.params;
        if (params === null || typeof params !== "object" || Array.isArray(params)) {
          throw new TbcMultiRoundMergeInputError("Invalid DApp multi-round merge params");
        }
        const keys = Reflect.ownKeys(params);
        if (keys.some((key) => typeof key !== "string" || ![
          "version",
          "chainId",
          "from",
          "clientRequestId",
          "asset",
          "limits",
        ].includes(key))) throw new TbcMultiRoundMergeInputError("Invalid DApp multi-round merge field");
        const account = activeAccountView().accounts[0]!;
        const clientRequestId = Reflect.get(params, "clientRequestId");
        if (
          Reflect.get(params, "version") !== "1.0" ||
          Reflect.get(params, "chainId") !== account.chainId ||
          Reflect.get(params, "from") !== account.address ||
          typeof clientRequestId !== "string" ||
          !/^[A-Za-z0-9._:-]{1,128}$/u.test(clientRequestId)
        ) throw new TbcMultiRoundMergeInputError("Invalid DApp multi-round merge authority binding");
        const input = immutable(clone({
          asset: Reflect.get(params, "asset") as TbcMultiRoundMergeAsset,
          limits: Reflect.get(params, "limits") as TbcMultiRoundMergeLimits,
        }));
        assertTbcMultiRoundMergeInput(input);
        const abort = new AbortController();
        dappMultiRoundAbortByRequest.set(request.id, abort);
        const progress: TbcMultiRoundMergeProgress[] = [];
        try {
          const result = await runMultiRoundMerge({
            ...input,
            signal: abort.signal,
            onProgress: (entry) => {
              progress.push(immutable(clone(entry)));
            },
          });
          return response({
            result: immutable({
              ...result,
              atomic: false as const,
              progress: Object.freeze(progress),
            }),
          });
        } finally {
          if (dappMultiRoundAbortByRequest.get(request.id) === abort) {
            dappMultiRoundAbortByRequest.delete(request.id);
          }
        }
      } catch (error) {
        const concurrentRun = error !== null && typeof error === "object" &&
          Reflect.get(error, "code") === -32002;
        const code: -32602 | -32603 | 4100 = error instanceof TbcMultiRoundMergeInputError
          ? -32602
          : error !== null && typeof error === "object" && Reflect.get(error, "code") === 4100
            ? 4100
            : -32603;
        const message = code === -32602
          ? error instanceof Error ? error.message : "Invalid DApp multi-round merge params"
          : concurrentRun
            ? "A multi-round merge is already active in this wallet session"
          : code === 4100
            ? "Multi-round merge is not authorized for the active account"
            : "Multi-round merge failed";
        return response({ error: immutable({ code, message }) });
      }
    };
    const handleProviderRequest = (
      request: TbcJsonRpcRequest,
      providedWorkflowPreparation?: StandardApprovalPreparationHandle,
    ): Promise<TbcTransportDelivery> => {
      if (closed) return Promise.reject(new Error("The wallet session is closed"));
      const requestIdentity = canonicalize(request);
      const existing = deliveriesByRequest.get(request.id);
      if (existing !== undefined) {
        if (existing.requestIdentity !== requestIdentity) {
          providedWorkflowPreparation?.cancel("failed");
          return Promise.reject(new Error("A wallet request id cannot be reused with different input"));
        }
        if (
          existing.authoritySnapshotIdentity === undefined ||
          existing.authoritySnapshotIdentity === canonicalize(boundAuthority)
        ) {
          if (
            providedWorkflowPreparation !== undefined &&
            providedWorkflowPreparation.preparationId !== existing.preparationId
          ) {
            providedWorkflowPreparation.cancel("cancelled");
          }
          return existing.promise;
        }
        deliveriesByRequest.delete(request.id);
      }
      let entry: {
        readonly requestIdentity: string;
        readonly promise: Promise<TbcTransportDelivery>;
        readonly preparationId?: string;
        authoritySnapshotIdentity?: string;
      };
      const promise = (
        request.method === "tbc_runMultiRoundMerge"
          ? executeDappMultiRoundMergeRequest(request)
          : executeProviderRequest(request, providedWorkflowPreparation)
      ).then(
        (delivery) => {
          entry.authoritySnapshotIdentity = canonicalize(boundAuthority);
          return delivery;
        },
        (error: unknown) => {
          if (deliveriesByRequest.get(request.id) === entry) {
            deliveriesByRequest.delete(request.id);
          }
          throw error;
        },
      );
      entry = {
        requestIdentity,
        promise,
        ...(providedWorkflowPreparation === undefined
          ? {}
          : { preparationId: providedWorkflowPreparation.preparationId }),
      };
      deliveriesByRequest.set(request.id, entry);
      return promise;
    };
    const cancelRequest = async (requestId: TbcJsonRpcId) => {
      dappMultiRoundAbortByRequest.get(requestId)?.abort();
      if (preparation !== undefined && same(preparation.exactRequest.id, requestId)) {
        finishPreparation(preparation, "discarded");
      }
      const operation = operationByRequest.get(requestId);
      if (operation !== undefined) {
        await operation.host.cancelOperation({
          operationId: operation.operationId,
          reason: "REQUEST_ABORTED",
        });
      }
      for (const entry of [...workflowPreparations]) {
        if (same(entry.requestId, requestId)) {
          cancelWorkflowPreparation(entry);
        }
      }
    };
    const controller = createInMemoryTransport({
      handler: handleProviderRequest,
      async onCancel(requestId) {
        await cancelRequest(requestId);
      },
    });
    const provider = createTbcProvider({
      transport: controller.transport,
      ...(sessionOptions.requestIdFactory === undefined ? {} : { requestIdFactory: sessionOptions.requestIdFactory }),
    }) as unknown as KitProvider;
    runMultiRoundMerge = async (input) => {
      if (activeMultiRoundRun) {
        const error = new Error("A multi-round merge is already active in this wallet session") as Error & { code: number };
        error.code = -32002;
        throw error;
      }
      activeMultiRoundRun = true;
      try {
      const configured = options.multiRoundMerge;
      const runView = activeAccountView();
      const client = (runView.network as KitWalletNetwork & { readonly client?: TestnetClient }).client;
      if (configured === undefined || client === undefined) {
        throw new Error("Default Kit multi-round merge requires a bounded approval UI and default network");
      }
      const account = runView.accounts[0]!;
      const authority = immutable({
        chainId: account.chainId,
        accountId: account.accountId,
        origin: boundAuthority.currentContext.origin,
        sessionId: boundAuthority.currentContext.sessionId,
      });
      // Reuse Core's permission-read path before the first private index read or
      // bounded-consent UI. Core has already filtered origin, chain and expiry;
      // this final intersection binds both required capabilities to the account.
      const permissions = await provider.request({ method: "wallet_getPermissions" });
      const permits = (capability: string): boolean => Array.isArray(permissions) && permissions.some((value) => {
        if (value === null || typeof value !== "object") return false;
        const permission = value as Readonly<{
          parentCapability?: unknown;
          caveats?: readonly Readonly<{ type?: unknown; value?: unknown }>[];
        }>;
        if (permission.parentCapability !== capability || !Array.isArray(permission.caveats)) return false;
        const accountIds = permission.caveats.find(({ type }) => type === "restrictAccounts")?.value;
        return Array.isArray(accountIds) && accountIds.includes(authority.accountId);
      });
      if (!permits("tbc_accounts") || !permits("tbc_sendTransaction")) {
        const error = new Error("Multi-round merge is not authorized for the active account") as Error & { code: number };
        error.code = 4100;
        throw error;
      }
      // Anchor deadline checks to the wallet's trusted clock.  Date.now() is
      // used only for monotonic elapsed time so host wall-clock skew cannot
      // turn an otherwise valid bounded consent into an immediate expiry.
      const trustedStartedAt = Date.parse(
        await (options.clock?.() ?? new Date().toISOString()),
      );
      if (!Number.isFinite(trustedStartedAt)) throw new Error("Wallet clock returned an invalid timestamp");
      const monotonicStartedAt = performanceNow();
      const mergeNow = (): number => trustedStartedAt + Math.max(0, performanceNow() - monotonicStartedAt);
      const assertLiveAuthority = async () => {
        const live = checkedAuthority(await authoritySource.read());
        if (
          live.currentContext.origin !== authority.origin ||
          live.currentContext.sessionId !== authority.sessionId ||
          live.currentSession.state.connected !== true ||
          live.currentSession.state.activeChainId !== authority.chainId ||
          !live.currentSession.state.activeAccountIds.includes(authority.accountId)
        ) throw new Error("Wallet authority changed during multi-round merge");
        const current = await options.accounts.current();
        if (!current.some((candidate) => same(candidate, account))) {
          throw new Error("Wallet account changed during multi-round merge");
        }
      };
      const accepted = new Set<string>();
      const indexedByState = new Map<string, readonly Readonly<Record<string, unknown>>[]>();
      const readState = async (
        _authority: typeof authority,
        asset: TbcMultiRoundMergeAsset,
      ): Promise<TbcMultiRoundMergeState> => {
        await assertLiveAuthority();
        const observedAt = await (options.clock?.() ?? new Date().toISOString());
        const poolIndex = asset.kind === "pool-ft" || asset.kind === "ftlp"
          ? await runView.network.readPoolMergeIndex?.({
              address: account.address,
              poolContractId: asset.poolContractId,
              kind: asset.kind,
            })
          : undefined;
        if ((asset.kind === "pool-ft" || asset.kind === "ftlp") && poolIndex === undefined) {
          throw new Error("Default Kit Pool multi-round merge requires a canonical Pool index");
        }
        const indexed = asset.kind === "tbc"
          ? (await client.getUtxos(account.address)).utxos
          : asset.kind === "ft"
            ? await client.getFtUtxos(account.address, asset.contractId)
            : asset.kind === "stablecoin"
              ? await client.getStablecoinUtxos(account.address, asset.contractId)
            : poolIndex!.utxos;
        const rows = immutable(indexed.map((row) =>
          clone(row as unknown as Readonly<Record<string, unknown>>),
        ));
        const revision = hashCanonical(rows);
        const payload = immutable({
          version: "1.0" as const,
          authority,
          asset,
          observedAt,
          revision,
          utxoCount: rows.length,
          ...(poolIndex === undefined ? {} : {
            poolIdentity: immutable({
              poolContractId: poolIndex.poolContractId,
              ftContractId: poolIndex.ftContractId,
              currentPoolTxid: poolIndex.currentPoolTxid,
            }),
          }),
          observedTransactionIds: [...accepted].filter((txid) =>
            rows.some((row) => Reflect.get(row, "txid") === txid),
          ),
        });
        const state = immutable({ ...payload, stateHash: hashTbcMultiRoundMergeState(payload) });
        indexedByState.set(state.stateHash, rows);
        return state;
      };
      const orchestrator = createTbcMultiRoundMergeOrchestrator({
        readState,
        approve: configured.approve,
        async prepareStep({ scope, scopeHash, approval, state, stepIndex, remainingFee, acceptedTxids }) {
          const rows = indexedByState.get(state.stateHash);
          if (rows === undefined) throw new Error("Verified merge index snapshot is unavailable");
          const selected = [...rows].sort((left, right) => {
            const amountKey = scope.asset.kind === "tbc"
              ? "satoshis"
              : scope.asset.kind === "ft" || scope.asset.kind === "stablecoin"
                ? "ftAmount"
                : "assetAmount";
            const leftAmount = BigInt(String(Reflect.get(left, amountKey)));
            const rightAmount = BigInt(String(Reflect.get(right, amountKey)));
            return leftAmount === rightAmount
              ? String(Reflect.get(left, "txid")).localeCompare(String(Reflect.get(right, "txid"))) ||
                Number(Reflect.get(left, "vout")) - Number(Reflect.get(right, "vout"))
              : leftAmount < rightAmount ? -1 : 1;
          }).slice(0, scope.impact.maxAssetInputsPerTransaction);
          const dependsOn = acceptedTxids.filter((txid) =>
            selected.some((row) => Reflect.get(row, "txid") === txid),
          );
          const expiryMs = Math.min(
            Date.parse(scope.limits.expiresAt),
            Date.parse(approval.expiresAt),
          );
          // New unbound request: retain the exact earliest deadline. Existing
          // scope and approval bytes remain untouched for binding verification.
          const expiresAt = new Date(expiryMs).toISOString();
          // A new bounded approval over an unchanged index is still a new Host
          // operation. Bind its internal id to the consent identity so an old
          // pre-submit failure cannot be replayed into the new run.
          const runStepIdentity = hashCanonical({
            domain: "tbc-kit/multi-round-step/1",
            scopeHash,
            approvalId: approval.approvalId,
            stepIndex,
          });
          const request = immutable({
            version: "1.0" as const,
            chainId: authority.chainId,
            from: account.address,
            clientRequestId: `kit-multi-round-${runStepIdentity}`,
            intent: scope.asset.kind === "tbc"
              ? { version: "1.0" as const, type: "tbc.maintenance.merge" as const }
              : scope.asset.kind === "ft"
                ? {
                  version: "1.0" as const,
                  type: "tbc.ft.merge" as const,
                  contractId: scope.asset.contractId,
                }
                : scope.asset.kind === "stablecoin"
                  ? {
                    version: "1.0" as const,
                    type: "tbc.stablecoin.merge" as const,
                    contractId: scope.asset.contractId,
                  }
                : {
                    version: "1.0" as const,
                    type: scope.asset.kind === "pool-ft"
                      ? "tbc.pool.ft.merge" as const
                      : "tbc.pool.ftlp.merge" as const,
                    poolContractId: scope.asset.poolContractId,
                  },
            constraints: {
              expiresAt,
              maxFee: remainingFee,
              feePreference: "standard" as const,
              // The public merge may select up to 500 inputs. A bounded
              // multi-round approval still owns this exact smaller selection.
              ...(scope.asset.kind === "tbc" ? { inputOutpoints: selected.map(row => ({
                txid: String(Reflect.get(row, "txid")), vout: Number(Reflect.get(row, "vout")),
              })) } : {}),
            },
          });
          return immutable({
            version: "1.0" as const,
            stepId: `merge-${String(stepIndex)}`,
            stepIndex,
            authority,
            asset: scope.asset,
            stateHash: state.stateHash,
            materialHash: hashCanonical(request),
            inputCount: selected.length,
            outputCount: 1 as const,
            feeKind: "maximum" as const,
            fee: remainingFee,
            expiresAt,
            dependsOn,
            prepared: request,
          });
        },
        assertAuthority: async () => assertLiveAuthority(),
        async executePreparedStep({ scope, scopeHash, approval, step }) {
          activeMultiRoundExecution = Object.freeze({
            scope,
            scopeHash,
            approval,
            requestHash: step.materialHash,
            maximumFee: step.fee,
            authority,
          });
          activeMultiRoundBroadcast = "not-started";
          let recoveryId: string | undefined;
          const pendingResult = (operationId: string, error: string) => Object.freeze({
            status: "pending" as const,
            stepId: step.stepId,
            materialHash: step.materialHash,
            recoveryId: operationId,
            error,
          });
          try {
            const requestId = Reflect.get(step.prepared as object, "clientRequestId");
            if (typeof requestId !== "string") throw new Error("Prepared merge request identity is unavailable");
            let operation = await startWalletOperation({
              id: requestId,
              method: "tbc_sendTransaction",
              params: step.prepared,
            });
            recoveryId = operation.operationId;
            const waitStartedAt = Date.now();
            const executionExpiresAt = Date.parse(step.expiresAt);
            let waitAttempt = 0;
            let cancellationReason: CancelInput["reason"] | undefined;
            let lastHostError = "The durable Host operation is still pending";
            while (
              operation.status === "waiting" ||
              operation.status === "busy" ||
              operation.status === "failed"
            ) {
              if (operation.status === "failed") {
                lastHostError = `${operation.error.code}: ${operation.error.message}`;
              }
              try {
                const inspection = await sessionHost.inspectOperation({ operationId: recoveryId });
                if (inspection.terminal) {
                  try {
                    operation = await sessionHost.resumeOperation({ operationId: recoveryId });
                    if (operation.status === "failed") {
                      lastHostError = `${operation.error.code}: ${operation.error.message}`;
                    }
                  } catch (error) {
                    lastHostError = error instanceof Error ? error.message : lastHostError;
                  }
                }
              } catch (error) {
                lastHostError = error instanceof Error ? error.message : lastHostError;
              }
              if (operation.status === "complete" || operation.status === "cancelled") break;

              const currentTime = mergeNow();
              const requiredCancellation = input.signal?.aborted === true
                ? "REQUEST_ABORTED" as const
                : currentTime >= executionExpiresAt
                  ? "REQUEST_EXPIRED" as const
                  : undefined;
              if (requiredCancellation !== undefined && cancellationReason === undefined) {
                cancellationReason = requiredCancellation;
                try {
                  operation = await sessionHost.cancelOperation({
                    operationId: recoveryId,
                    reason: requiredCancellation,
                  });
                  if (operation.status === "failed") {
                    lastHostError = `${operation.error.code}: ${operation.error.message}`;
                  }
                } catch (error) {
                  lastHostError = error instanceof Error ? error.message : lastHostError;
                }
              }
              if (operation.status === "complete" || operation.status === "cancelled") break;
              if (Date.now() - waitStartedAt >= MULTI_ROUND_HOST_WAIT_LIMIT_MS) {
                if (activeMultiRoundBroadcast !== "not-started") {
                  const error = new Error(lastHostError) as Error & { recoveryId: string };
                  error.recoveryId = recoveryId;
                  throw error;
                }
                return pendingResult(recoveryId, lastHostError);
              }
              const delayMs = Math.min(
                MULTI_ROUND_HOST_WAIT_MIN_DELAY_MS * 2 ** Math.min(waitAttempt, 3),
                MULTI_ROUND_HOST_WAIT_MAX_DELAY_MS,
              );
              waitAttempt += 1;
              await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
              try {
                operation = await sessionHost.resumeOperation({ operationId: recoveryId });
              } catch (error) {
                lastHostError = error instanceof Error ? error.message : lastHostError;
              }
            }
            if (operation.status !== "complete" || operation.completion.delivery !== "respond") {
              throw new Error(`Multi-round Host operation did not complete: ${operation.status}`);
            }
            const response = operation.completion.response as Readonly<Record<string, unknown>>;
            if (Object.hasOwn(response, "error")) {
              const message = String(Reflect.get(response.error as object, "message") ?? "Multi-round transaction failed");
              const broadcastState = String(activeMultiRoundBroadcast);
              if (broadcastState === "not-started" || broadcastState === "rejected") {
                const code = Reflect.get(response.error as object, "code");
                return Object.freeze({
                  status: code === 4001 || code === 4100 || broadcastState === "rejected"
                    ? "rejected" as const
                    : "failed" as const,
                  stepId: step.stepId,
                  materialHash: step.materialHash,
                  error: message,
                });
              }
              throw new Error(message);
            }
            const result = response.result as Readonly<{
              totalFee: string;
              transactions: readonly Readonly<{ txid: string; status: string }>[];
            }>;
            const transaction = result.transactions[0];
            if (result.transactions.length !== 1 || transaction === undefined || transaction.status !== "submitted") {
              throw new Error("Multi-round merge did not return one submitted transaction");
            }
            accepted.add(transaction.txid);
            return Object.freeze({
              status: "accepted" as const,
              stepId: step.stepId,
              materialHash: step.materialHash,
              txid: transaction.txid,
              fee: result.totalFee,
              inputsConsumed: step.inputCount,
              outputsCreated: 1 as const,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Multi-round execution failed";
            if (recoveryId === undefined) {
              return Object.freeze({
                status: "failed" as const,
                stepId: step.stepId,
                materialHash: step.materialHash,
                error: message,
              });
            }
            if (activeMultiRoundBroadcast === "not-started") {
              try {
                const inspection = await sessionHost.inspectOperation({ operationId: recoveryId });
                if (!inspection.terminal) return pendingResult(recoveryId, message);
              } catch {
                return pendingResult(recoveryId, message);
              }
              return Object.freeze({
                status: "failed" as const,
                stepId: step.stepId,
                materialHash: step.materialHash,
                error: message,
              });
            }
            const wrapped = new Error(message) as Error & {
              recoveryId: string;
            };
            wrapped.recoveryId = recoveryId;
            throw wrapped;
          } finally {
            activeMultiRoundExecution = undefined;
          }
        },
        async reconcile({ txid }) {
          const result = await client.getTransactionStatus(txid);
          return Object.freeze({
            txid,
            status: result.status === "mempool" || result.status === "confirmed"
              ? "known" as const
              : result.status === "rejected"
                ? "rejected" as const
                : "unknown" as const,
          });
        },
        ...(configured.waitForIndex === undefined ? {} : { waitForIndex: configured.waitForIndex }),
      }, { now: mergeNow });
      return await orchestrator.run({
        authority,
        asset: input.asset,
        limits: input.limits,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      });
      } finally {
        activeMultiRoundRun = false;
      }
    };
    const handleLegacyRequest: KitWalletSession["handleLegacyRequest"] =
      async (request) => {
        if (!legacyEnabled || legacyDigest === undefined || legacyRouteToken === undefined) {
          throw new Error("Legacy Bitcoin message signing is unavailable");
        }
        if (
          request.method !== "tbc_signMessage" ||
          request.params === null ||
          typeof request.params !== "object" ||
          Array.isArray(request.params) ||
          typeof Reflect.get(request.params, "clientRequestId") !== "string" ||
          !/^legacy-bitcoin:[0-9a-f]{64}$/u.test(
            Reflect.get(request.params, "clientRequestId") as string,
          )
        ) {
          throw new Error("Invalid wallet-owned Legacy Bitcoin message request");
        }
        const internalRequestId =
          `kit-legacy:${legacyRouteToken}:${String(++legacyRequestSequence)}`;
        authorizedLegacyRequestIds.add(internalRequestId);
        try {
          const delivery = await handleProviderRequest({
            jsonrpc: "2.0",
            id: internalRequestId,
            method: request.method,
            params: request.params,
          } as TbcJsonRpcRequest);
          const response = delivery.response as Readonly<Record<string, unknown>>;
          return Object.freeze({
            ...delivery,
            response: Object.freeze({ ...response, id: request.id }),
          });
        } finally {
          authorizedLegacyRequestIds.delete(internalRequestId);
        }
      };
    const handleLegacyWorkflowRequest: KitWalletSession["handleLegacyWorkflowRequest"] =
      async (request) => {
        if (!legacyEnabled || legacyDigest === undefined || legacyRouteToken === undefined) {
          throw new Error("Legacy standard workflow signing is unavailable");
        }
        if (request.method !== "tbc_signWorkflow") {
          throw new Error("Invalid wallet-owned Legacy workflow request");
        }
        try {
          assertValidTws("workflowRequest", request.params);
        } catch {
          throw new Error("Invalid wallet-owned Legacy workflow request");
        }
        const internalRequestId = `kit-legacy-workflow:${hashCanonical(Object.freeze({
          version: "1.0" as const,
          chainId: activeAccountView().chainId,
          origin: boundAuthority.currentContext.origin,
          sessionId,
          requestId: request.id,
        }))}`;
        authorizedLegacyRequestIds.add(internalRequestId);
        try {
          const delivery = await handleProviderRequest({
            jsonrpc: "2.0",
            id: internalRequestId,
            method: request.method,
            params: request.params,
          } as TbcJsonRpcRequest, request.approvalPreparation);
          const response = delivery.response as Readonly<Record<string, unknown>>;
          return Object.freeze({
            ...delivery,
            response: Object.freeze({ ...response, id: request.id }),
          });
        } finally {
          authorizedLegacyRequestIds.delete(internalRequestId);
        }
      };
    const handleLegacyActionRequest: KitWalletSession["handleLegacyActionRequest"] =
      async (request) => {
        if (!legacyEnabled || legacyDigest === undefined || legacyRouteToken === undefined) {
          throw new Error("Legacy standard wallet action is unavailable");
        }
        if (
          request.method !== "tbc_signReviewedTransaction" &&
          request.method !== "tbc_encrypt" &&
          request.method !== "tbc_decrypt"
        ) {
          throw new Error("Invalid wallet-owned Legacy action request");
        }
        try {
          assertTbcProviderRequest({
            jsonrpc: "2.0",
            id: request.id,
            method: request.method,
            params: request.params,
          } as TbcJsonRpcRequest);
        } catch {
          throw new Error("Invalid wallet-owned Legacy action request");
        }
        const internalRequestId = `kit-legacy-action:${hashCanonical(Object.freeze({
          version: "1.0" as const,
          chainId: activeAccountView().chainId,
          origin: boundAuthority.currentContext.origin,
          sessionId,
          requestId: request.id,
          method: request.method,
        }))}`;
        authorizedLegacyRequestIds.add(internalRequestId);
        try {
          const delivery = await handleProviderRequest({
            jsonrpc: "2.0",
            id: internalRequestId,
            method: request.method,
            params: request.params,
          } as TbcJsonRpcRequest, request.approvalPreparation);
          const response = delivery.response as Readonly<Record<string, unknown>>;
          return Object.freeze({
            ...delivery,
            response: Object.freeze({ ...response, id: request.id }),
          });
        } finally {
          authorizedLegacyRequestIds.delete(internalRequestId);
        }
      };
    let legacyFacadeSequence = 0;
    const legacy = createLegacyKitFacade({
      provider,
      chainId,
      readChainId: () => activeAccountView().chainId as `tbc:${string}`,
      readSessionRevision: () => activeAccountView().revision,
      enabled: legacyEnabled,
      ...(legacyOptions === undefined ? {} : { options: legacyOptions }),
      readAccount: async () => {
        const view = activeAccountView();
        const selected = view.accounts[0];
        if (selected === undefined) throw new Error("The active wallet has no account");
        const current = await options.accounts.current();
        const nextView = activeAccountView();
        if (nextView.revision !== view.revision || nextView.chainId !== view.chainId) {
          throw new Error("The wallet chain changed during Legacy account resolution");
        }
        const active = current.find((account) => same(account, selected));
        if (active === undefined) throw new Error("The active wallet account changed");
        return active.address;
      },
      requestLegacyMessage: async (params) => {
        const delivery = await handleLegacyRequest({
          id: `kit-legacy-facade-${String(++legacyFacadeSequence)}`,
          method: "tbc_signMessage",
          params,
        });
        const response = delivery.response as Readonly<Record<string, unknown>>;
        if (Object.hasOwn(response, "error")) {
          const errorValue = response.error as Readonly<Record<string, unknown>>;
          const error = new Error(String(errorValue.message ?? "Wallet request failed")) as Error & { code?: unknown };
          error.code = errorValue.code;
          throw error;
        }
        return response.result;
      },
    });
    const session: KitWalletSession = Object.freeze({
      provider,
      legacy,
      runMultiRoundMerge,
      prefetchRequest,
      beginApprovalPreparation,
      handleRequest: (request: Parameters<KitWalletSession["handleRequest"]>[0]) => handleProviderRequest({
        jsonrpc: "2.0",
        id: request.id,
        method: request.method as TbcJsonRpcRequest["method"],
        ...(request.params === undefined ? {} : { params: request.params }),
      } as unknown as TbcJsonRpcRequest) as ReturnType<KitWalletSession["handleRequest"]>,
      handleLegacyRequest,
      handleLegacyActionRequest,
      handleLegacyWorkflowRequest,
      cancelRequest,
      startOperation: startWalletOperation,
      resumeOperation: (operationId: string) =>
        hostForOperation(operationId).resumeOperation({ operationId }),
      inspectOperation: (operationId: string) => {
        const active = hostByOperation.get(operationId);
        if (active !== undefined) return active.inspectOperation({ operationId });
        if (historicalHost !== undefined) return historicalHost.inspectOperation({ operationId });
        throw new Error("The wallet operation is not active in this session");
      },
      cancelOperation: (operationId: string, reason: CancelInput["reason"] = "REQUEST_ABORTED") => {
        const active = hostByOperation.get(operationId);
        if (active !== undefined) return active.cancelOperation({ operationId, reason });
        if (historicalHost !== undefined) return historicalHost.cancelOperation({ operationId, reason });
        throw new Error("The wallet operation is not active in this session");
      },
      recoverPending: async (_limit?: number) => Object.freeze([]),
      recoverPostSigner: async (_operationId: string) => {
        throw new Error("Kit does not resume Host operations after restart; reconcile the broadcast journal instead");
      },
      listBroadcastRecovery: (limit?: number) =>
        activeAccountView().network.listBroadcastRecovery?.(limit) ?? Promise.resolve(Object.freeze([])),
      recoverBroadcasts: (txids: readonly string[]) =>
        activeAccountView().network.recoverBroadcasts?.(txids) ?? Promise.reject(new Error("Broadcast recovery is not configured")),
      listBroadcastRecoveryForChain: async (requestedChainId: string, limit?: number) => {
        const selected = await networkForChain(requestedChainId);
        return selected.listBroadcastRecovery?.(limit) ?? Object.freeze([]);
      },
      recoverBroadcastsForChain: async (requestedChainId: string, txids: readonly string[]) => {
        const selected = await networkForChain(requestedChainId);
        if (selected.recoverBroadcasts === undefined) throw new Error("Broadcast recovery is not configured");
        return selected.recoverBroadcasts(txids);
      },
      close: () => {
        closed = true;
        for (const controller of dappMultiRoundAbortByRequest.values()) controller.abort();
        dappMultiRoundAbortByRequest.clear();
        deliveriesByRequest.clear();
        preparationsAwaitingAuthorization.clear();
        if (preparation !== undefined) finishPreparation(preparation, "discarded");
        for (const entry of [...workflowPreparations]) {
          finishWorkflowPreparation(entry, "cancelled");
        }
        legacy.close();
        controller.close();
      },
    });
    if (injectedAuthority !== undefined) {
      discoverySessions.set(session, {
        readView: () => {
          if (closed) return Object.freeze({ revision: "closed", accounts: Object.freeze([]) });
          const view = activeAccountView();
          return Object.freeze({ revision: view.revision, accounts: view.accounts });
        },
        assertLive: async () => {
          if (closed) throw new Error("The wallet session is closed");
          const live = checkedAuthority(await injectedAuthority.read());
          if (closed) throw new Error("The wallet session is closed");
          if (!same(live.currentContext, boundAuthority.currentContext)) {
            throw new Error("Wallet authority context changed before discovery registration");
          }
          if (!same(live.currentSession, boundAuthority.currentSession)) {
            throw new Error("Wallet authority state changed before discovery registration");
          }
          activeAccountView();
        },
      });
    }
    return session;
  }

  async function discoveryState(session: KitWalletSession): Promise<DiscoveryState> {
    const state = discoverySessions.get(session);
    if (state === undefined) {
      throw new TypeError("Discovery requires an owned platform-authorized session from openSession({ authority })");
    }
    await state.assertLive();
    if (state.descriptor === undefined) {
      let cachedRevision: string | undefined;
      let cachedAccounts: readonly KitWalletAccount[] = Object.freeze([]);
      let cachedStandardAccounts: readonly TbcWalletAccount[] = Object.freeze([]);
      let cachedChains: readonly `tbc:${string}`[] = Object.freeze([]);
      const readDiscoveryView = () => {
        const view = state.readView();
        if (cachedRevision !== view.revision) {
          cachedAccounts = immutable(clone(view.accounts));
          cachedStandardAccounts = Object.freeze(view.accounts.map((account) => Object.freeze({
            address: account.address,
            publicKey: hexToBytes(account.publicKey),
            chains: Object.freeze([account.chainId]),
            features: Object.freeze([TBC_PROVIDER_FEATURE]),
          })));
          cachedChains = Object.freeze([...new Set(view.accounts.map((account) => account.chainId))]);
          cachedRevision = view.revision;
        }
        return Object.freeze({ accounts: cachedAccounts, standardAccounts: cachedStandardAccounts, chains: cachedChains });
      };
      const internal: TbcWallet = Object.freeze({
        version: "1.0.0",
        name: displayName,
        icon: displayIcon as TbcWallet["icon"],
        get chains() { return readDiscoveryView().chains; },
        get accounts() { return readDiscoveryView().standardAccounts; },
        features: Object.freeze({
          [TBC_PROVIDER_FEATURE]: Object.freeze({
            version: TBC_PROVIDER_FEATURE_VERSION,
            productId,
            provider: session.provider as never,
          }),
        }),
      });
      state.internal = internal;
      state.descriptor = Object.freeze({
        productId,
        name: internal.name,
        icon: displayIcon,
        get accounts() { return readDiscoveryView().accounts; },
        provider: session.provider,
      });
    }
    return state;
  }

  return Object.freeze({
    openSession,
    async register(session: KitWalletSession) {
      const state = await discoveryState(session);
      if (!hasBrowserWalletStandardEnvironment()) return;
      state.registration ??= registerBrowserWalletStandard(state.internal!, state.assertLive).catch((error) => {
        delete state.registration;
        throw error;
      });
      await state.registration;
    },
    async standardWallet(session: KitWalletSession) {
      return (await discoveryState(session)).descriptor!;
    },
  });
}
