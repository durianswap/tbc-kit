import {
  TWS_RELEASE,
  TWS_RELEASE_FINGERPRINT,
  canonicalize,
  createTwsCore,
  deriveOperationId,
  hashCanonical,
  hexToBytes,
  type AnyPortCall,
  type BroadcastReconcileParams,
  type BroadcastReconcileResult,
  type BroadcastSubmitParams,
  type BroadcastSubmitResult,
  type FinalizeParams,
  type NormalizeRequestParams,
  type PermissionStoreLoadResult,
  type PlanParams,
  type PortOperation,
  type SignerSignParams,
  type SignerSignResult,
  type TransactionEngine,
  type ValidateParams,
} from "@tbc-wallet/core";
import {
  createMemoryTwsHostStore,
  createTwsHost,
  type TwsAuthoritySnapshot,
  type TwsAuthoritySource,
  type TwsHostOperationResult,
  type TwsHostPortHandler,
  type TwsHostPortOutcome,
  type TwsHostPorts,
} from "@tbc-wallet/host";
import {
  assertTbcProviderEvent,
  createTbcProvider,
  type TbcJsonRpcId,
  type TbcJsonRpcRequest,
  type TbcProvider,
  type TbcProviderOptions,
  type TbcProviderTransport,
  type TbcTransportCloseReason,
} from "@tbc-wallet/provider";
import {
  createInMemoryTransport,
  type TbcInMemoryTransportController,
} from "@tbc-wallet/provider/in-memory";
import {
  createTbcTransferEngine,
  type TbcEngineBackend,
} from "@tbc-wallet/tbc-engine";
import {
  TBC_PROVIDER_FEATURE,
  TBC_PROVIDER_FEATURE_VERSION,
  registerTbcWallet,
  type TbcWallet,
  type TbcWalletAccount,
} from "@tbc-wallet/wallet-standard";

import type { MinimalTransferFixture } from "./fixtures.js";

type Permission = PermissionStoreLoadResult["permissions"][number];

export interface MinimalThirdPartyWalletOptions {
  readonly fixture: MinimalTransferFixture;
  readonly engineBackend: TbcEngineBackend;
  readonly signDigest: (
    task: SignerSignParams["task"],
  ) => SignerSignResult | Promise<SignerSignResult>;
  readonly preauthorizeAccounts?: boolean;
  readonly beforePort?: (operation: string) => void | Promise<void>;
  readonly clockNow?: () => string | Promise<string>;
  readonly broadcastSubmit?: (
    params: BroadcastSubmitParams,
  ) => BroadcastSubmitResult | Promise<BroadcastSubmitResult>;
  readonly broadcastReconcile?: (
    params: BroadcastReconcileParams,
  ) => BroadcastReconcileResult | Promise<BroadcastReconcileResult>;
}

export interface MinimalProviderSession {
  readonly provider: TbcProvider;
  readonly controller: TbcInMemoryTransportController;
}

export interface MinimalThirdPartyWallet {
  readonly provider: TbcProvider;
  readonly controller: TbcInMemoryTransportController;
  readonly standardWallet: TbcWallet;
  readonly trace: string[];
  readonly engineCalls: Array<Readonly<{
    operation: string;
    params: unknown;
    result: unknown;
  }>>;
  readonly openProviderSession: (
    options?: Pick<TbcProviderOptions, "requestIdFactory">,
  ) => MinimalProviderSession;
  readonly register: () => void;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function permissionFor(
  fixture: MinimalTransferFixture,
  origin: string,
  capability: "tbc_accounts" | "tbc_signTransaction" | "tbc_sendTransaction",
): Permission {
  return {
    id: `example-${capability.replaceAll("_", "-")}`,
    parentCapability: capability,
    invoker: origin,
    date: Date.parse("2026-09-02T00:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [fixture.request.chainId] },
      { type: "restrictAccounts", value: [fixture.account.accountId] },
      { type: "restrictMethods", value: [capability] },
    ],
  };
}

function tracedEngine(
  backend: TbcEngineBackend,
  trace: string[],
  engineCalls: MinimalThirdPartyWallet["engineCalls"],
): TransactionEngine {
  const engine = createTbcTransferEngine({ backend });
  function invoke<P, R>(
    operation: keyof TransactionEngine,
    params: P,
    execute: (input: P) => R,
  ): R {
    const phase = operation === "validate" &&
      typeof params === "object" &&
      params !== null &&
      "phase" in params
      ? `:${String(params.phase)}`
      : "";
    trace.push(`engine.${operation}${phase}`);
    const result = execute(params);
    engineCalls.push({
      operation,
      params: clone(params),
      result: clone(result),
    });
    return result;
  }
  return Object.freeze({
    normalizeRequest: (params: NormalizeRequestParams) =>
      invoke("normalizeRequest", params, engine.normalizeRequest),
    plan: (params: PlanParams) => invoke("plan", params, engine.plan),
    validate: (params: ValidateParams) =>
      invoke("validate", params, engine.validate),
    finalize: (params: FinalizeParams) =>
      invoke("finalize", params, engine.finalize),
  });
}

export function createMinimalThirdPartyWallet(
  options: MinimalThirdPartyWalletOptions,
): MinimalThirdPartyWallet {
  const { fixture } = options;
  const trace: string[] = [];
  const engineCalls: MinimalThirdPartyWallet["engineCalls"] = [];
  const calls = new Map<string, Readonly<{ identity: unknown; result: unknown }>>();
  const approvedBindings = new Set<string>();
  const submitted = new Map<string, string>();
  const permissions = new Map<string, { revision: string; permissions: Permission[] }>();
  const initialPermissions = [
    permissionFor(fixture, "https://third-party.example", "tbc_signTransaction"),
    permissionFor(fixture, "https://third-party.example", "tbc_sendTransaction"),
    ...(options.preauthorizeAccounts
      ? [permissionFor(fixture, "https://third-party.example", "tbc_accounts")]
      : []),
  ];
  permissions.set(fixture.request.chainId, {
    revision: "0",
    permissions: initialPermissions,
  });

  const trustedNow = () =>
    options.clockNow?.() ?? "2026-09-02T00:00:10Z";

  let authority: TwsAuthoritySnapshot = {
    currentContext: {
      sessionId: "third-party-session-1",
      transport: "remote",
      origin: "https://third-party.example",
      topOrigin: "https://third-party.example",
      frame: "top",
      createdAt: "2026-09-02T00:00:00Z",
    },
    currentSession: {
      version: "1.0",
      scope: {
        walletProfile: "third-party-wallet",
        sessionId: "third-party-session-1",
      },
      state: {
        version: "1.0",
        sessionId: "third-party-session-1",
        revision: "0",
        connected: true,
        activeChainId: fixture.request.chainId,
        activeAccountIds: [fixture.account.accountId],
      },
    },
  };

  const invokePort = async (call: AnyPortCall): Promise<unknown> => {
    const existing = calls.get(call.callId);
    const identity = { operation: call.operation, params: call.params };
    if (existing !== undefined) {
      if (!same(existing.identity, identity)) {
        throw new Error("Host Port call ID collision.");
      }
      return clone(existing.result);
    }
    if (call.operation === "approval.request") {
      trace.push(`approval.binding:${call.params.binding.bindingHash}`);
    }
    trace.push(`port.${call.operation}`);
    await options.beforePort?.(call.operation);

    let result: unknown;
    switch (call.operation) {
      case "clock.now":
        result = { now: await trustedNow() };
        break;
      case "permissionStore.load": {
        const current = permissions.get(call.params.scope.chainId) ?? {
          revision: "0",
          permissions: [],
        };
        result = clone(current);
        break;
      }
      case "permissionStore.commit": {
        const revisions = call.params.changes.map((change) => {
          const current = permissions.get(change.scope.chainId) ?? {
            revision: "0",
            permissions: [],
          };
          if (current.revision !== change.expectedRevision) {
            throw new Error("Permission revision conflict.");
          }
          const revision = String(BigInt(change.expectedRevision) + 1n);
          permissions.set(change.scope.chainId, {
            revision,
            permissions: clone(change.permissions) as Permission[],
          });
          return { scope: clone(change.scope), revision };
        });
        result = { revisions };
        break;
      }
      case "accounts.resolve":
        result = { accounts: [clone(fixture.account)] };
        break;
      case "chainData.resolve":
        result = clone(fixture.snapshot);
        break;
      case "policy.resolve":
        result = clone(fixture.policy);
        break;
      case "approval.request": {
        const bindingHash = call.params.binding.bindingHash;
        approvedBindings.add(bindingHash);
        result = {
          status: "approved",
          approvalId: `approval-${call.callId}`,
          approvalToken: `token-${call.callId}`,
          bindingHash,
          approvedAt: await trustedNow(),
          expiresAt: call.params.binding.payload.expiresAt,
        };
        break;
      }
      case "signer.sign":
        if (!approvedBindings.has(call.params.approval.bindingHash)) {
          throw new Error("Signer received an unapproved binding.");
        }
        result = await options.signDigest(call.params.task);
        break;
      case "broadcast.submit": {
        const prior = submitted.get(call.params.idempotencyKey);
        if (prior !== undefined && prior !== call.params.transaction.txid) {
          throw new Error("Broadcast idempotency conflict.");
        }
        submitted.set(call.params.idempotencyKey, call.params.transaction.txid);
        result = options.broadcastSubmit === undefined
          ? { txid: call.params.transaction.txid, status: "accepted" }
          : await options.broadcastSubmit(call.params);
        break;
      }
      case "broadcast.reconcile":
        result = options.broadcastReconcile === undefined
          ? {
              transactions: call.params.txids.map((txid) => ({
                txid,
                status: "mempool",
              })),
            }
          : await options.broadcastReconcile(call.params);
        break;
      case "entropy.randomBytes":
        result = { bytes: "AAECAwQFBgcICQoLDA0ODw" };
        break;
      case "crypto.execute":
      case "reviewedTransaction.review":
      case "reviewedTransaction.execute":
      case "broadcast.submitBatch":
        // This controlled example implements single TBC transfers only. The
        // complete Kit example owns these additional capabilities; never fake
        // support or loop single POSTs as a substitute for batch submission.
        throw new Error("Unsupported operation in the single-transfer example.");
      default: {
        const unsupported: never = call;
        void unsupported;
        throw new Error("Unsupported Host Port operation.");
      }
    }
    calls.set(call.callId, { identity: clone(identity), result: clone(result) });
    return clone(result);
  };

  function portHandler<K extends PortOperation>(): TwsHostPortHandler<K> {
    return (call) =>
      invokePort(call) as Promise<TwsHostPortOutcome<K>>;
  }
  const ports = Object.freeze({
    accounts: portHandler<"accounts.resolve">(),
    chainData: portHandler<"chainData.resolve">(),
    policy: portHandler<"policy.resolve">(),
    permissionStore: portHandler<
      "permissionStore.load" | "permissionStore.commit"
    >(),
    approval: portHandler<"approval.request">(),
    signer: portHandler<"signer.sign">(),
    broadcast: portHandler<"broadcast.submit" | "broadcast.submitBatch" | "broadcast.reconcile">(),
    clock: portHandler<"clock.now">(),
    entropy: portHandler<"entropy.randomBytes">(),
  } satisfies TwsHostPorts);
  const durableAuthority: TwsAuthoritySource = {
    read: async () => clone(authority),
    compareAndSwapSession: async (input) => {
      if (!same(input.expected, authority)) {
        throw new Error("Authority compare-and-swap is stale.");
      }
      authority = {
        currentContext: clone(input.expected.currentContext),
        currentSession: {
          version: "1.0",
          scope: clone(input.mutation.payload.scope),
          state: clone(input.mutation.payload.target),
        },
      };
      return {
        acknowledgment: {
          version: "1.0",
          commitId: input.commitId,
          status: "committed",
          revision: input.mutation.payload.target.revision,
        },
        authority: clone(authority),
      };
    },
  };
  Object.freeze(durableAuthority);
  const host = createTwsHost({
    core: createTwsCore({
      transactionEngine: tracedEngine(options.engineBackend, trace, engineCalls),
    }),
    ports,
    store: createMemoryTwsHostStore(),
    authority: durableAuthority,
    ownerId: "third-party-wallet-host",
    scheduleLeaseHeartbeat: (delayMs, run) => {
      const handle = setTimeout(run, delayMs);
      return () => clearTimeout(handle);
    },
  });
  async function toDelivery(
    request: TbcJsonRpcRequest,
    onOperation: (operationId: string) => void,
    onSettled: (operationId: string) => void,
  ): Promise<Readonly<{
    deliveryId: string;
    response: import("@tbc-wallet/provider").TbcJsonRpcResponse;
    events: readonly import("@tbc-wallet/provider").TbcProviderEvent[];
  }>> {
    const current = await durableAuthority.read();
    const operationId = deriveOperationId({
      releaseFingerprint: TWS_RELEASE_FINGERPRINT,
      contextHash: hashCanonical(current.currentContext),
      requestId: request.id,
      operation: {
        method: request.method,
        params: request.params === undefined ? [] : request.params,
      },
    });
    onOperation(operationId);
    try {
      let result: TwsHostOperationResult = await host.startOperation({
        version: "1.0",
        release: TWS_RELEASE,
        request,
      });
      for (let attempts = 0; result.status === "waiting" && attempts < 8; attempts += 1) {
        result = await host.resumeOperation({ operationId: result.operationId });
      }
      trace.push(
        `adapter.result:${operationId}:${result.status}${
          result.status === "failed" ? `:${result.error.code}` : ""
        }`,
      );
      if (
        (result.status !== "complete" && result.status !== "cancelled") ||
        result.completion.delivery !== "respond"
      ) {
        throw new Error("Host did not produce a deliverable completion.");
      }
      trace.push(`adapter.delivery:${result.deliveryId}`);
      return Object.freeze({
        deliveryId: result.deliveryId,
        response: result.completion.response,
        events: result.completion.events.map(assertTbcProviderEvent),
      });
    } finally {
      onSettled(operationId);
    }
  }

  function openProviderSession(
    providerOptions: Pick<TbcProviderOptions, "requestIdFactory"> = {},
  ): MinimalProviderSession {
    type RequestRegistration = {
      handlerStarted: boolean;
      resolved: boolean;
      readonly operation: Promise<string | undefined>;
      readonly resolveOperation: (operationId: string | undefined) => void;
    };
    const operationByRequest = new Map<TbcJsonRpcId, string>();
    const registrationByRequest = new Map<TbcJsonRpcId, RequestRegistration>();
    const cancellationReasonByRequest = new Map<
      TbcJsonRpcId,
      "REQUEST_ABORTED" | "TRANSPORT_CLOSED"
    >();
    const cancellationByRequest = new Map<TbcJsonRpcId, Promise<void>>();
    const settledByOperation = new Map<
      string,
      Readonly<{ promise: Promise<void>; resolve: () => void }>
    >();
    let closingReason: TbcTransportCloseReason | undefined;
    let closing: Promise<void> | undefined;

    function createRegistration(): RequestRegistration {
      let resolveOperation!: (operationId: string | undefined) => void;
      const operation = new Promise<string | undefined>((resolve) => {
        resolveOperation = resolve;
      });
      return {
        handlerStarted: false,
        resolved: false,
        operation,
        resolveOperation,
      };
    }

    function resolveRegistration(
      registration: RequestRegistration,
      operationId: string | undefined,
    ): void {
      if (registration.resolved) return;
      registration.resolved = true;
      registration.resolveOperation(operationId);
    }

    function discardUnstartedRegistration(
      requestId: TbcJsonRpcId,
      registration: RequestRegistration,
    ): void {
      if (
        registration.handlerStarted ||
        registrationByRequest.get(requestId) !== registration
      ) {
        return;
      }
      resolveRegistration(registration, undefined);
      registrationByRequest.delete(requestId);
      cancellationReasonByRequest.delete(requestId);
    }

    function ensureCancellation(requestId: TbcJsonRpcId): Promise<void> {
      const existing = cancellationByRequest.get(requestId);
      if (existing !== undefined) return existing;
      const registration = registrationByRequest.get(requestId);
      const reason = cancellationReasonByRequest.get(requestId);
      if (registration === undefined || reason === undefined) {
        return Promise.resolve();
      }
      const cancellation = (async () => {
        const operationId = await registration.operation;
        if (operationId === undefined) return;
        const settled = settledByOperation.get(operationId);
        let result: TwsHostOperationResult | undefined;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          result = await host.cancelOperation({ operationId, reason });
          if (
            result.status !== "failed" ||
            result.error.code !== "HOST_NOT_FOUND"
          ) {
            break;
          }
          await Promise.resolve();
        }
        if (result?.status === "busy" || result?.status === "failed") {
          await settled?.promise;
        }
        const inspection = await host.inspectOperation({ operationId });
        if (inspection.state === "cancelled") {
          trace.push(`adapter.cancelled:${operationId}`);
        }
      })();
      cancellationByRequest.set(requestId, cancellation);
      const cleanup = () => {
        cancellationByRequest.delete(requestId);
        cancellationReasonByRequest.delete(requestId);
      };
      void cancellation.then(cleanup, cleanup);
      return cancellation;
    }

    function cancelRequest(
      requestId: TbcJsonRpcId,
      reason: "REQUEST_ABORTED" | TbcTransportCloseReason,
    ): Promise<void> {
      if (!cancellationReasonByRequest.has(requestId)) {
        cancellationReasonByRequest.set(
          requestId,
          reason === "REQUEST_ABORTED" ? reason : "TRANSPORT_CLOSED",
        );
      }
      trace.push(
        `adapter.cancel:${operationByRequest.get(requestId) ?? "pending"}`,
      );
      return ensureCancellation(requestId);
    }

    function beginClose(reason: TbcTransportCloseReason): Promise<void> {
      if (closing !== undefined) return closing;
      closingReason = reason;
      const requestIds = [...registrationByRequest.keys()];
      closing = Promise.all(
        requestIds.map((requestId) => cancelRequest(requestId, reason)),
      ).then(() => undefined);
      return closing;
    }

    const baseController = createInMemoryTransport({
      handler: (request) => {
        const registration = registrationByRequest.get(request.id);
        if (registration === undefined) {
          throw new Error("Provider request was not registered before dispatch.");
        }
        registration.handlerStarted = true;
        return toDelivery(
          request,
          (operationId) => {
            operationByRequest.set(request.id, operationId);
            let resolveSettled!: () => void;
            const promise = new Promise<void>((resolve) => {
              resolveSettled = resolve;
            });
            settledByOperation.set(operationId, {
              promise,
              resolve: resolveSettled,
            });
            resolveRegistration(registration, operationId);
            if (
              cancellationReasonByRequest.has(request.id) ||
              closingReason !== undefined
            ) {
              if (!cancellationReasonByRequest.has(request.id)) {
                cancellationReasonByRequest.set(
                  request.id,
                  "TRANSPORT_CLOSED",
                );
              }
              void ensureCancellation(request.id);
            }
          },
          (operationId) => {
            settledByOperation.get(operationId)?.resolve();
            settledByOperation.delete(operationId);
            resolveRegistration(registration, undefined);
            if (operationByRequest.get(request.id) === operationId) {
              operationByRequest.delete(request.id);
            }
            if (registrationByRequest.get(request.id) === registration) {
              registrationByRequest.delete(request.id);
            }
          },
        );
      },
      onCancel: (requestId) => cancelRequest(requestId, "REQUEST_ABORTED"),
    });
    const transport: TbcProviderTransport = Object.freeze({
      send(request: TbcJsonRpcRequest) {
        if (closingReason !== undefined) {
          return Promise.reject(new Error("The Provider session is closing."));
        }
        if (registrationByRequest.has(request.id)) {
          return baseController.transport.send(request);
        }
        const registration = createRegistration();
        registrationByRequest.set(request.id, registration);
        let sent: ReturnType<TbcProviderTransport["send"]>;
        try {
          sent = baseController.transport.send(request);
        } catch (error) {
          discardUnstartedRegistration(request.id, registration);
          throw error;
        }
        void sent.catch(() => {
          discardUnstartedRegistration(request.id, registration);
        });
        return sent;
      },
      subscribe: baseController.transport.subscribe,
      cancel: (requestId: TbcJsonRpcId, reason: "REQUEST_ABORTED") =>
        baseController.transport.cancel?.(requestId, reason),
      async close() {
        const cancelled = beginClose("TRANSPORT_CLOSED");
        await baseController.transport.close?.();
        await cancelled;
      },
    });
    const controller: TbcInMemoryTransportController = Object.freeze({
      transport,
      emitEvent: baseController.emitEvent,
      close(reason: TbcTransportCloseReason = "TRANSPORT_CLOSED") {
        void beginClose(reason).catch(() => undefined);
        baseController.close(reason);
      },
    });
    const provider = createTbcProvider({
      transport,
      ...providerOptions,
    });
    return Object.freeze({ provider, controller });
  }

  const initial = openProviderSession();
  const chainId = fixture.request.chainId as `tbc:${string}`;
  const walletAccount: TbcWalletAccount = Object.freeze({
    address: fixture.account.address,
    publicKey: hexToBytes(fixture.account.publicKey),
    chains: Object.freeze([chainId]),
    features: Object.freeze([TBC_PROVIDER_FEATURE]),
  });
  const standardWallet: TbcWallet = Object.freeze({
    version: "1.0.0",
    name: "Minimal Third-Party TBC Wallet",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains: Object.freeze([chainId]),
    accounts: Object.freeze([walletAccount]),
    features: Object.freeze({
      [TBC_PROVIDER_FEATURE]: Object.freeze({
        version: TBC_PROVIDER_FEATURE_VERSION,
        provider: initial.provider,
      }),
    }),
  });

  return Object.freeze({
    provider: initial.provider,
    controller: initial.controller,
    standardWallet,
    trace,
    engineCalls,
    openProviderSession,
    register: () => registerTbcWallet(standardWallet),
  });
}
