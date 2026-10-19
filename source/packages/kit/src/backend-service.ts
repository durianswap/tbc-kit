import { createMemoryTwsHostStore } from "./host-runtime.js";
import { canonicalize, hashCanonical } from "./core-runtime.js";
import {
  prepareTbcTransaction,
  prepareTbcWorkflow,
  type TbcPreparedTransactionRequest,
  type TbcPreparedWorkflowRequest,
  type TbcWorkflowRequest,
} from "./prepared.js";
import type {
  KitSupportedIntent,
  KitTransactionEngine,
  KitTransactionRequest,
} from "./public-types.js";
import {
  createTbcWallet,
  type KitHostPortCall,
  type KitWalletAccount,
  type KitWalletAuthoritySnapshot,
  type KitWalletAuthoritySource,
  type KitWalletNetwork,
  type KitWalletOptions,
  type KitWalletSession,
  type KitWalletSessionCommitRequest,
} from "./wallet-runtime.js";

const BACKEND_ORIGIN = "https://backend.tbc-kit.invalid";
const BACKEND_IDENTITY_CREATED_AT = "2020-01-01T00:00:00Z";
const BACKEND_METHODS = Object.freeze([
  "tbc_signPreparedTransaction",
  "tbc_sendPreparedTransaction",
  "tbc_signPreparedWorkflow",
  "tbc_sendPreparedWorkflow",
] as const);
const BACKEND_CAPABILITIES = Object.freeze([
  "tbc_accounts",
  "tbc_signTransaction",
  "tbc_sendTransaction",
  "tbc_signWorkflow",
] as const);

type BackendMethod = (typeof BACKEND_METHODS)[number];
type BackendCapability = (typeof BACKEND_CAPABILITIES)[number];

export type TbcBackendAuthorizationDecision =
  | Readonly<{
      status: "approved";
      decisionId: string;
      approvedAt: string;
    }>
  | Readonly<{
      status: "rejected";
      rejectedAt: string;
    }>;

export interface TbcBackendAuthorizationRequest {
  /** Existing Core approval input with exact preview, binding, fee and expiry. */
  readonly approvalRequest: unknown;
  readonly call: KitHostPortCall;
}

export interface TbcBackendNetwork
  extends Pick<KitWalletNetwork, "resolveChainData" | "resolvePolicy">,
    Partial<Pick<
      KitWalletNetwork,
      | "network"
      | "warmup"
      | "broadcastSubmit"
      | "broadcastSubmitBatch"
      | "broadcastReconcile"
      | "listBroadcastRecovery"
      | "recoverBroadcasts"
      | "readPoolMergeIndex"
      | "rememberFinalizedTransaction"
    >> {}

export interface CreateTbcBackendServiceOptions {
  /** Stable service identity; this is not an origin supplied by a remote caller. */
  readonly serviceId: string;
  readonly account: KitWalletAccount;
  readonly network: TbcBackendNetwork;
  readonly engine: KitTransactionEngine;
  /** Required only for sign/send execution. Preparation remains keyless. */
  readonly authorize?: (
    request: TbcBackendAuthorizationRequest,
  ) => Promise<TbcBackendAuthorizationDecision>;
  /** Opaque service-owned Signer. Private keys never enter Kit inputs. */
  readonly signer?: KitWalletOptions["signer"];
  readonly clock?: KitWalletOptions["clock"];
  readonly randomBytes?: KitWalletOptions["randomBytes"];
}

export type TbcBackendPreparedExecution =
  | Readonly<{
      kind: "transaction";
      action: "sign" | "send";
      prepared: TbcPreparedTransactionRequest;
    }>
  | Readonly<{
      kind: "workflow";
      action: "sign" | "send";
      prepared: TbcPreparedWorkflowRequest;
    }>;

export interface TbcBackendService {
  readonly prepareTransaction: <TIntent extends KitSupportedIntent>(
    request: KitTransactionRequest<TIntent>,
  ) => Promise<TbcPreparedTransactionRequest<TIntent>>;
  readonly prepareWorkflow: (
    request: TbcWorkflowRequest,
  ) => Promise<TbcPreparedWorkflowRequest>;
  readonly executePrepared: (input: TbcBackendPreparedExecution) => Promise<unknown>;
  readonly listBroadcastRecovery: (limit?: number) => Promise<readonly unknown[]>;
  readonly recoverBroadcasts: (txids: readonly string[]) => Promise<unknown>;
  readonly close: () => void;
}

export class TbcBackendServiceError extends Error {
  override readonly name = "TbcBackendServiceError";
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function approvalBinding(value: unknown): Readonly<{ bindingHash: string; expiresAt: string }> {
  const request = record(value, "backend approval request");
  const binding = record(request.binding, "backend approval binding");
  const payload = record(binding.payload, "backend approval payload");
  if (typeof binding.bindingHash !== "string" || typeof payload.expiresAt !== "string") {
    throw new TypeError("Invalid backend approval binding");
  }
  return Object.freeze({ bindingHash: binding.bindingHash, expiresAt: payload.expiresAt });
}

function permission(capability: BackendCapability, account: KitWalletAccount) {
  return Object.freeze({
    id: `backend-${capability}`,
    parentCapability: capability,
    invoker: BACKEND_ORIGIN,
    date: Date.parse("2020-01-01T00:00:00Z"),
    caveats: Object.freeze([
      Object.freeze({ type: "restrictChains", value: Object.freeze([account.chainId]) }),
      Object.freeze({ type: "restrictAccounts", value: Object.freeze([account.accountId]) }),
      Object.freeze({ type: "restrictMethods", value: Object.freeze([capability]) }),
    ]),
  });
}

function unavailable(name: string): (...args: readonly unknown[]) => Promise<never> {
  return async () => {
    throw new Error(`${name} is not configured for this backend service`);
  };
}

function providerResult(delivery: Awaited<ReturnType<KitWalletSession["handleRequest"]>>): unknown {
  const response = record(delivery.response, "backend Provider response");
  if (response.error !== undefined) {
    const error = record(response.error, "backend Provider error");
    throw new TbcBackendServiceError(
      typeof error.code === "number" ? error.code : -32603,
      typeof error.message === "string" ? error.message : "Backend execution failed",
      error.data,
    );
  }
  if (!("result" in response)) throw new TbcBackendServiceError(-32603, "Backend execution returned no result");
  return response.result;
}

function stableAuthority(
  serviceId: string,
  account: KitWalletAccount,
): KitWalletAuthoritySource {
  const sessionId = `backend-${serviceId}`;
  let authority: KitWalletAuthoritySnapshot = Object.freeze({
    currentContext: Object.freeze({
      sessionId,
      transport: "remote" as const,
      origin: BACKEND_ORIGIN,
      topOrigin: BACKEND_ORIGIN,
      frame: "top" as const,
      createdAt: BACKEND_IDENTITY_CREATED_AT,
    }),
    currentSession: Object.freeze({
      version: "1.0" as const,
      scope: Object.freeze({ walletProfile: "tbc-kit-wallet", sessionId }),
      state: Object.freeze({
        version: "1.0" as const,
        sessionId,
        revision: "0",
        connected: true,
        activeChainId: account.chainId,
        activeAccountIds: Object.freeze([account.accountId]),
      }),
    }),
  });
  return Object.freeze({
    read: async () => authority,
    compareAndSwapSession: async (input: KitWalletSessionCommitRequest) => {
      if (canonicalize(input.expected) !== canonicalize(authority)) {
        throw new Error("Backend authority compare-and-swap is stale");
      }
      authority = Object.freeze({
        currentContext: input.expected.currentContext,
        currentSession: Object.freeze({
          version: "1.0" as const,
          scope: input.mutation.payload.scope,
          state: input.mutation.payload.target,
        }),
      });
      return Object.freeze({
        acknowledgment: Object.freeze({
          version: "1.0" as const,
          commitId: input.commitId,
          status: "committed" as const,
          revision: input.mutation.payload.target.revision,
        }),
        authority,
      });
    },
  });
}

function executionRequestId(
  serviceId: string,
  input: TbcBackendPreparedExecution,
): string {
  return `backend-${hashCanonical(Object.freeze({
    version: "1.0",
    serviceId,
    kind: input.kind,
    action: input.action,
    prepared: input.prepared,
  }))}`;
}

/**
 * Thin service facade over the existing Prepared and Wallet/Core/Host paths.
 * Construction is keyless. Execution is unavailable until both an explicit
 * service authorization callback and an external Signer are injected.
 */
export function createTbcBackendService(
  options: CreateTbcBackendServiceOptions,
): TbcBackendService {
  if (options === null || typeof options !== "object") throw new TypeError("Backend service options are required");
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(options.serviceId)) {
    throw new TypeError("Invalid backend serviceId");
  }
  const account = Object.freeze({ ...options.account });
  const engine = options.engine;
  const network = options.network;
  let closed = false;
  let sessionPromise: Promise<KitWalletSession> | undefined;

  const ensureOpen = (): void => {
    if (closed) throw new Error("Backend service is closed");
  };

  const session = (): Promise<KitWalletSession> => {
    ensureOpen();
    if (options.authorize === undefined || options.signer === undefined) {
      throw new Error("Backend execution requires explicit authorize and signer capabilities");
    }
    sessionPromise ??= createTbcWallet({
      productId: options.serviceId,
      name: options.serviceId,
      accounts: Object.freeze({ current: async () => Object.freeze([account]) }),
      approval: Object.freeze({
        request: async (params: unknown, call: KitHostPortCall) => {
          const binding = approvalBinding(params);
          const decision = await options.authorize!({ approvalRequest: params, call });
          if (decision.status === "rejected") {
            return Object.freeze({
              status: "rejected" as const,
              bindingHash: binding.bindingHash,
              rejectedAt: decision.rejectedAt,
            });
          }
          if (decision.decisionId.length < 1) throw new TypeError("Backend authorization decisionId is required");
          return Object.freeze({
            status: "approved" as const,
            approvalId: decision.decisionId,
            approvalToken: decision.decisionId,
            bindingHash: binding.bindingHash,
            approvedAt: decision.approvedAt,
            expiresAt: binding.expiresAt,
          });
        },
      }),
      signer: options.signer,
      storage: Object.freeze({
        hostStore: createMemoryTwsHostStore(),
        loadPermissions: async () => Object.freeze({
          revision: "0",
          permissions: Object.freeze(BACKEND_CAPABILITIES.map((capability) => permission(capability, account))),
        }),
        commitPermissions: unavailable("Backend permission mutation"),
      }),
      network: Object.freeze({
        ...network,
        broadcastSubmit: network.broadcastSubmit ?? unavailable("Single broadcast"),
        broadcastSubmitBatch: network.broadcastSubmitBatch ?? unavailable("Batch broadcast"),
        broadcastReconcile: network.broadcastReconcile ?? unavailable("Broadcast reconciliation"),
      }),
      engine,
      legacy: false,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
    }).openSession({
      authority: stableAuthority(options.serviceId, account),
      execution: Object.freeze({ hostStore: createMemoryTwsHostStore() }),
    });
    return sessionPromise;
  };

  return Object.freeze({
    async prepareTransaction<TIntent extends KitSupportedIntent>(
      request: KitTransactionRequest<TIntent>,
    ) {
      ensureOpen();
      return prepareTbcTransaction({ request, network, engine });
    },
    async prepareWorkflow(request: TbcWorkflowRequest) {
      ensureOpen();
      return prepareTbcWorkflow({ request, network, engine });
    },
    async executePrepared(input: TbcBackendPreparedExecution) {
      ensureOpen();
      if (input.action === "send") {
        const available = input.kind === "workflow"
          ? network.broadcastSubmitBatch !== undefined
          : network.broadcastSubmit !== undefined;
        if (!available || network.broadcastReconcile === undefined) {
          throw new Error("Backend send requires explicit broadcast and reconciliation capabilities");
        }
      }
      const active = await session();
      const method: BackendMethod = input.kind === "workflow"
        ? input.action === "send" ? "tbc_sendPreparedWorkflow" : "tbc_signPreparedWorkflow"
        : input.action === "send" ? "tbc_sendPreparedTransaction" : "tbc_signPreparedTransaction";
      const delivery = await active.handleRequest({
        id: executionRequestId(options.serviceId, input),
        method,
        params: input.prepared,
      });
      return providerResult(delivery);
    },
    listBroadcastRecovery(limit?: number) {
      ensureOpen();
      return network.listBroadcastRecovery?.(limit) ?? Promise.resolve(Object.freeze([]));
    },
    recoverBroadcasts(txids: readonly string[]) {
      ensureOpen();
      return network.recoverBroadcasts?.(txids) ?? Promise.reject(
        new Error("Broadcast recovery is not configured for this backend service"),
      );
    },
    close() {
      if (closed) return;
      closed = true;
      void sessionPromise?.then(
        (active) => active.close(),
        () => undefined,
      );
    },
  });
}
