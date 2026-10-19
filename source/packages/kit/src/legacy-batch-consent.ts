import {
  canonicalize,
  deriveOperationId,
  hashCanonical,
  TWS_RELEASE_FINGERPRINT,
} from "@tbc-wallet/core";

import type { KitHostEvidenceReader } from "./sqlite.js";
import {
  createLegacyBatchRequestScope,
  type LegacyBatchRequestScope,
  matchesLegacyBatchRequest,
  withLegacyDependentTxids,
} from "./legacy-batch.js";
import { turingTransactionId } from "./testnet-validation.js";
import type {
  TbcKitWebViewJsonRpcRequest,
  TbcKitWebViewVerifiedNavigation,
} from "./wallet-webview.js";

const REQUEST_PREFIX = "legacy-request-batch:";
const REQUEST_TTL_MS = 5 * 60_000;
const MAX_LIVE_BATCHES = 1024;

export class LegacyBatchConsentConflictError extends Error {
  override readonly name = "LegacyBatchConsentConflictError";
}

export interface LegacyBatchReview {
  readonly batchId: string;
  readonly scopeHash: string;
  readonly messageTemplate: string;
  readonly singleRequest?: true;
}

export interface LegacyRequestBatchReview extends LegacyBatchRequestScope {
  readonly operationKind: "request-batch";
  readonly intentId: string;
  readonly verifiedOrigin: string;
  readonly chainId: string;
  readonly expiresAt: string;
  readonly batch: LegacyBatchReview;
}

export interface LegacyBatchConsentIntent {
  readonly intentId: string;
  readonly callId: string;
  readonly params: Readonly<{
    readonly binding: Readonly<{
      readonly bindingHash: string;
      readonly payload: Readonly<{
        readonly method: string;
        readonly requestHash: string;
        readonly contextHash: string;
        readonly origin: string;
        readonly sessionId: string;
        /** Optional on non-batch records returned by a general approval journal. */
        readonly chainId?: string;
        readonly accountId?: string;
      }>;
    }>;
    readonly preview: Readonly<{
      readonly operationKind: string;
      readonly transactionCount?: number;
      readonly totalFee?: string;
    }>;
  }>;
  readonly facts: Readonly<{
    readonly operationKind: string;
    readonly accountId?: string;
    readonly chainId?: string;
    readonly requestHash: string;
    readonly contextHash: string;
    readonly expiresAt: string;
  }>;
  readonly decision?: Readonly<{
    readonly status: "approved" | "rejected";
    readonly approvalId?: string;
  }>;
}

export interface LegacyBatchConsentJournal {
  readonly readIntent: (
    intentId: string,
  ) => Promise<LegacyBatchConsentIntent | null>;
}

export interface LegacyBatchConsentMachine {
  readonly requestApproval?: (
    navigation: TbcKitWebViewVerifiedNavigation,
    requestId: string,
    chainId: string,
    template: unknown,
    source: string | undefined,
    transaction: unknown,
    onVisible?: () => void,
  ) => Promise<boolean>;
  loadRequestReview(
    intentId: string,
  ): Promise<LegacyRequestBatchReview | undefined>;
  decideRequest(
    intentId: string,
    decision: "approved" | "rejected",
  ): Promise<boolean>;
  authorizeRequest(intent: LegacyBatchConsentIntent): Promise<boolean>;
  prepare(
    navigation: TbcKitWebViewVerifiedNavigation,
    requestId: string,
    chainId: string,
    template: unknown,
  ): Promise<void>;
  register(
    navigation: TbcKitWebViewVerifiedNavigation,
    requestId: string,
    request: TbcKitWebViewJsonRpcRequest,
    ftDecimals?: number,
  ): Promise<void>;
  review(
    intent: LegacyBatchConsentIntent,
  ): Promise<LegacyBatchReview | undefined>;
  bindRoot(intent: LegacyBatchConsentIntent): Promise<void>;
  authorizeDependent(intent: LegacyBatchConsentIntent): Promise<boolean>;
  verifyDependency(intent: LegacyBatchConsentIntent): Promise<void>;
}

export interface LegacyBatchConsentMachineOptions {
  readonly store: Pick<
    KitHostEvidenceReader,
    "readCall" | "readOperation" | "readDelivery"
  >;
  readonly journal: LegacyBatchConsentJournal;
  /** Must match the Host that owns `store`. */
  readonly releaseFingerprint?: string;
  readonly now?: () => number;
  readonly readAccount?: (
    navigation: TbcKitWebViewVerifiedNavigation,
  ) => Promise<string | null>;
  readonly presentRequest?: (
    intentId: string,
    onVisible?: () => void,
  ) => Promise<void>;
  /** Wallet-specific error identity; it cannot change conflict semantics. */
  readonly createConflictError?: (message: string) => Error;
}

interface Entry {
  batchId: string;
  scope: {
    requestId: string;
    contextHash: string;
    origin: string;
    sessionId: string;
    chainId: string;
    messageTemplate: string;
    singleRequest?: true;
    request?: {
      spend: LegacyBatchRequestScope;
      navigation: TbcKitWebViewVerifiedNavigation;
      expiresAt: string;
    };
  };
  requestDecision?: {
    status: "approved" | "rejected";
    scopeHash: string;
    decidedAt: string;
  };
  first?: { operationId: string; requestHash: string };
  second?: { operationId: string; requestHash: string };
  resolvedSecondOperationId?: string;
  root?: {
    intentId: string;
    bindingHash: string;
    accountId: string;
    expiresAt: string;
    scopeHash: string;
  };
}

interface EvidenceCall {
  readonly operation: string;
  readonly operationId: string;
  readonly call: Readonly<{
    readonly params: Readonly<{
      readonly binding: Readonly<{ readonly bindingHash: string }>;
    }>;
  }>;
}

interface EvidenceOperation {
  readonly transition: Readonly<{
    readonly checkpoint: Readonly<{
      readonly payload: Readonly<{
        readonly operation: Readonly<{ readonly params: unknown }>;
      }>;
    }>;
  }>;
}

interface EvidenceDelivery {
  readonly completion: Readonly<{
    readonly delivery: string;
    readonly response: Readonly<{ readonly result?: unknown }>;
  }>;
}

interface BoundEntryEvidence {
  readonly entry: Entry;
  readonly call: EvidenceCall;
}

/**
 * Session-only request-list consent state and dependency verification.
 * Authority, evidence, journal, clock, account and presentation stay injected.
 */
export function createLegacyBatchConsentMachine(
  options: LegacyBatchConsentMachineOptions,
): LegacyBatchConsentMachine {
  const now = options.now ?? Date.now;
  const releaseFingerprint =
    options.releaseFingerprint ?? TWS_RELEASE_FINGERPRINT;
  if (!/^[0-9a-f]{64}$/u.test(releaseFingerprint)) {
    throw new TypeError("Invalid Host release fingerprint");
  }
  const conflict = (): never => {
    const error =
      options.createConflictError?.("Batch consent binding mismatch") ??
      new LegacyBatchConsentConflictError("Batch consent binding mismatch");
    throw error instanceof Error
      ? error
      : new LegacyBatchConsentConflictError("Batch consent binding mismatch");
  };
  const contextHash = (navigation: TbcKitWebViewVerifiedNavigation): string => {
    if (
      navigation.frame !== "top" ||
      navigation.origin !== navigation.topOrigin
    ) {
      conflict();
    }
    return hashCanonical({
      sessionId: navigation.sessionId,
      transport: "webview",
      origin: navigation.origin,
      topOrigin: navigation.topOrigin,
      frame: navigation.frame,
      navigationId: navigation.navigationId,
      createdAt: navigation.createdAt,
    });
  };
  const identity = (scope: Pick<Entry["scope"], "contextHash" | "requestId">) =>
    hashCanonical({
      contextHash: scope.contextHash,
      requestId: scope.requestId,
    });

  // Consent intentionally never survives service restart.
  const entries = new Map<string, Entry>();
  const operations = new Map<string, string>();

  const checkRequestBinding = (
    entry: Entry,
    approved = false,
  ): NonNullable<Entry["scope"]["request"]> => {
    const request = entry.scope.request;
    if (
      request === undefined ||
      Date.parse(request.expiresAt) <= now() ||
      contextHash(request.navigation) !== entry.scope.contextHash
    ) {
      conflict();
    }
    if (
      approved &&
      (entry.requestDecision?.status !== "approved" ||
        entry.requestDecision.scopeHash !== hashCanonical(entry.scope))
    ) {
      conflict();
    }
    return request as NonNullable<Entry["scope"]["request"]>;
  };

  const checkRequest = async (entry: Entry, approved = false) => {
    const request = checkRequestBinding(entry);
    if (
      (await options.readAccount?.(request.navigation)) !== request.spend.source
    ) {
      conflict();
    }
    checkRequestBinding(entry, approved);
  };

  const update = async (
    batchId: string,
    work: (entry: Entry) => void,
  ): Promise<void> => {
    const previous = entries.get(batchId);
    if (previous === undefined) conflict();
    const entry = { ...previous } as Entry;
    work(entry);
    for (const child of [entry.first, entry.second]) {
      if (child === undefined) continue;
      const owner = operations.get(child.operationId);
      if (owner !== undefined && owner !== batchId) conflict();
    }
    // No await between the uniqueness check and both index replacements.
    entries.set(batchId, entry);
    for (const child of [entry.first, entry.second]) {
      if (child !== undefined) operations.set(child.operationId, batchId);
    }
  };

  const readRequest = async (intentId: string): Promise<Entry | undefined> => {
    if (!intentId.startsWith(REQUEST_PREFIX)) return undefined;
    const entry = entries.get(intentId.slice(REQUEST_PREFIX.length));
    if (entry === undefined) conflict();
    const active = entry as Entry;
    await checkRequest(active);
    return active;
  };

  const findEvidence = async (
    intent: LegacyBatchConsentIntent,
  ): Promise<BoundEntryEvidence | undefined> => {
    const call = (await options.store.readCall(intent.callId)) as
      | EvidenceCall
      | null;
    if (
      call === null ||
      call.operation !== "approval.request" ||
      call.call.params.binding.bindingHash !==
        intent.params.binding.bindingHash
    ) {
      conflict();
    }
    const evidenceCall = call as EvidenceCall;
    let batchId = operations.get(evidenceCall.operationId);
    let entry = batchId === undefined ? undefined : entries.get(batchId);
    const payload = intent.params.binding.payload;
    if (
      entry === undefined &&
      intent.facts.operationKind === "message" &&
      payload.method === "tbc_signMessage"
    ) {
      const candidates = [...entries.values()].filter(
        (candidate) =>
          candidate.second?.requestHash === payload.requestHash &&
          candidate.scope.contextHash === payload.contextHash &&
          candidate.scope.origin === payload.origin &&
          candidate.scope.sessionId === payload.sessionId &&
          candidate.scope.chainId === payload.chainId,
      );
      if (candidates.length > 1) conflict();
      const candidate = candidates[0];
      if (candidate !== undefined) {
        if (
          candidate.resolvedSecondOperationId !== undefined &&
          candidate.resolvedSecondOperationId !== evidenceCall.operationId
        ) {
          conflict();
        }
        batchId = candidate.batchId;
        await update(batchId, (current) => {
          if (
            current.second?.requestHash !== payload.requestHash ||
            (current.resolvedSecondOperationId !== undefined &&
              current.resolvedSecondOperationId !== evidenceCall.operationId)
          ) {
            conflict();
          }
          current.resolvedSecondOperationId = evidenceCall.operationId;
        });
        operations.set(evidenceCall.operationId, batchId);
        entry = entries.get(batchId);
      }
    }
    if (entry === undefined) return undefined;
    if (
      payload.contextHash !== entry.scope.contextHash ||
      payload.origin !== entry.scope.origin ||
      payload.sessionId !== entry.scope.sessionId ||
      payload.chainId !== entry.scope.chainId
    ) {
      conflict();
    }
    const child =
      evidenceCall.operationId === entry.first?.operationId
        ? entry.first
        : entry.second;
    if (child === undefined || child.requestHash !== payload.requestHash) {
      conflict();
    }
    return Object.freeze({ entry, call: evidenceCall });
  };

  const find = async (
    intent: LegacyBatchConsentIntent,
  ): Promise<Entry | undefined> => (await findEvidence(intent))?.entry;

  const authorizeRequestEntry = async (
    intent: LegacyBatchConsentIntent,
    entry: Entry | undefined,
  ): Promise<boolean> => {
    if (
      entry?.scope.request === undefined ||
      entry.first?.requestHash !== intent.facts.requestHash
    ) {
      return false;
    }
    await checkRequest(entry, true);
    const preview = intent.params.preview;
    if (
      intent.facts.operationKind !== "transaction" ||
      intent.facts.accountId !==
        `${entry.scope.chainId}:${entry.scope.request.spend.source}` ||
      intent.params.binding.payload.method !==
        (entry.scope.request.spend.method ?? "tbc_signTransaction") ||
      preview.operationKind !== "transaction" ||
      preview.transactionCount !==
        (entry.scope.request.spend.transactionCount ?? 1) ||
      typeof preview.totalFee !== "string" ||
      !/^[0-9]+$/u.test(preview.totalFee) ||
      BigInt(preview.totalFee) >
        BigInt(entry.scope.request.spend.feeCapAtomic)
    ) {
      conflict();
    }
    return true;
  };

  const authorizeRequest = async (
    intent: LegacyBatchConsentIntent,
  ): Promise<boolean> => authorizeRequestEntry(intent, await find(intent));

  const authorizeDependentEntry = async (
    intent: LegacyBatchConsentIntent,
    entry: Entry | undefined,
    evidenceCall: EvidenceCall | undefined,
  ): Promise<boolean> => {
    if (
      entry === undefined ||
      entry.first?.requestHash === intent.facts.requestHash
    ) {
      return false;
    }
    if (entry.scope.request !== undefined) await checkRequest(entry, true);
    if (
      intent.facts.operationKind !== "message" ||
      entry.root === undefined ||
      entry.first === undefined ||
      entry.second === undefined
    ) {
      conflict();
    }
    const rootBinding = entry.root as NonNullable<Entry["root"]>;
    const firstBinding = entry.first as NonNullable<Entry["first"]>;
    const root = await options.journal.readIntent(rootBinding.intentId);
    if (
      root === null ||
      root.decision?.status !== "approved" ||
      root.decision.approvalId === undefined ||
      root.facts.operationKind !== "transaction" ||
      root.params.binding.bindingHash !== rootBinding.bindingHash ||
      root.facts.accountId !== rootBinding.accountId ||
      root.facts.requestHash !== firstBinding.requestHash ||
      root.facts.contextHash !== entry.scope.contextHash ||
      root.facts.chainId !== entry.scope.chainId ||
      intent.facts.accountId !== rootBinding.accountId ||
      rootBinding.scopeHash !== hashCanonical(entry.scope) ||
      Date.parse(rootBinding.expiresAt) <= now() ||
      root.facts.expiresAt !== rootBinding.expiresAt
    ) {
      conflict();
    }
    const first = (await options.store.readDelivery(
      firstBinding.operationId,
    )) as EvidenceDelivery | null;
    if (
      first === null ||
      first.completion.delivery !== "respond" ||
      !("result" in first.completion.response)
    ) {
      conflict();
    }
    const rootIntent = root as LegacyBatchConsentIntent & {
      readonly decision: Readonly<{
        readonly status: "approved";
        readonly approvalId: string;
      }>;
      readonly facts: LegacyBatchConsentIntent["facts"] & {
        readonly accountId: string;
      };
    };
    const delivery = first as EvidenceDelivery;
    const result = delivery.completion.response.result as
      | Record<string, unknown>
      | undefined;
    if (
      result === undefined ||
      result.from !==
        rootIntent.facts.accountId.slice(
          rootIntent.facts.accountId.lastIndexOf(":") + 1,
        ) ||
      result.chainId !== rootIntent.facts.chainId ||
      result.approvalId !== rootIntent.decision.approvalId ||
      result.requestHash !== rootIntent.facts.requestHash ||
      !Array.isArray(result.transactions) ||
      result.transactions.length !== 1
    ) {
      conflict();
    }
    const validResult = result as Record<string, unknown> & {
      readonly transactions: readonly unknown[];
    };
    const transaction = validResult.transactions[0] as Record<string, unknown>;
    if (
      typeof transaction.txid !== "string" ||
      typeof transaction.rawTransaction !== "string" ||
      turingTransactionId(transaction.rawTransaction) !== transaction.txid
    ) {
      conflict();
    }
    const expected = withLegacyDependentTxids(
      { message: entry.scope.messageTemplate, encoding: "utf8" },
      [transaction.txid as string],
    );
    if (expected === undefined) conflict();
    const operation = (await options.store.readOperation(
      evidenceCall?.operationId ?? conflict(),
    )) as EvidenceOperation | null;
    const request = operation?.transition.checkpoint.payload.operation.params as
      | Record<string, unknown>
      | undefined;
    const message = request?.message as Record<string, unknown> | undefined;
    if (
      request === undefined ||
      request.version !== "1.0" ||
      request.chainId !== entry.scope.chainId ||
      `${entry.scope.chainId}:${String(request.from)}` !== rootBinding.accountId ||
      message === undefined ||
      message.encoding !== expected!.encoding ||
      message.data !== expected!.message ||
      hashCanonical(request) !== intent.facts.requestHash
    ) {
      conflict();
    }
    return true;
  };

  const authorizeDependent = async (
    intent: LegacyBatchConsentIntent,
  ): Promise<boolean> => {
    const evidence = await findEvidence(intent);
    return authorizeDependentEntry(intent, evidence?.entry, evidence?.call);
  };

  const machine: LegacyBatchConsentMachine = {
    ...(options.presentRequest === undefined
      ? {}
      : {
          async requestApproval(
            navigation: TbcKitWebViewVerifiedNavigation,
            requestId: string,
            chainId: string,
            template: unknown,
            source: string | undefined,
            transaction: unknown,
            onVisible?: () => void,
          ): Promise<boolean> {
            const activeSource = await options.readAccount?.(navigation);
            if (
              (activeSource === null && source === undefined) ||
              (activeSource !== undefined &&
                activeSource !== null &&
                source !== undefined &&
                activeSource !== source)
            ) {
              conflict();
            }
            const boundSource = source ?? activeSource;
            if (boundSource === undefined || boundSource === null) conflict();
            const spend = createLegacyBatchRequestScope(
              transaction,
              boundSource as string,
            );
            const single =
              spend.poolIntent !== undefined || spend.createIntent !== undefined;
            if (
              (template === null) !== single ||
              (single &&
                Reflect.get(transaction as object, "chainId") !== chainId)
            ) {
              conflict();
            }
            await machine.prepare(navigation, requestId, chainId, template);
            const batchId = identity({
              contextHash: contextHash(navigation),
              requestId,
            });
            await update(batchId, (entry) => {
              if (entry.scope.request !== undefined) {
                if (
                  canonicalize(entry.scope.request.spend) !== canonicalize(spend)
                ) {
                  conflict();
                }
              } else {
                if (
                  entry.first !== undefined ||
                  entry.second !== undefined ||
                  entry.root !== undefined
                ) {
                  conflict();
                }
                entry.scope = {
                  ...entry.scope,
                  request: {
                    spend,
                    navigation,
                    expiresAt: new Date(now() + REQUEST_TTL_MS).toISOString(),
                  },
                };
              }
            });
            const intentId = `${REQUEST_PREFIX}${batchId}`;
            let entry = entries.get(batchId);
            if (entry === undefined) conflict();
            const activeEntry = entry as Entry;
            checkRequestBinding(activeEntry);
            if (activeEntry.requestDecision === undefined) {
              try {
                await options.presentRequest?.(intentId, onVisible);
              } catch {
                await machine
                  .decideRequest(intentId, "rejected")
                  .catch(() => undefined);
              }
              entry = await readRequest(intentId);
            }
            if (entry?.requestDecision?.status !== "approved") return false;
            checkRequestBinding(entry, true);
            return true;
          },
        }),

    async loadRequestReview(intentId) {
      const entry = await readRequest(intentId);
      if (entry?.scope.request === undefined) return undefined;
      return Object.freeze({
        operationKind: "request-batch" as const,
        intentId,
        verifiedOrigin: entry.scope.origin,
        chainId: entry.scope.chainId,
        expiresAt: entry.scope.request.expiresAt,
        ...entry.scope.request.spend,
        batch: Object.freeze({
          batchId: entry.batchId,
          scopeHash: hashCanonical(entry.scope),
          messageTemplate: entry.scope.messageTemplate,
          ...(entry.scope.singleRequest ? { singleRequest: true as const } : {}),
        }),
      });
    },

    async decideRequest(intentId, decision) {
      const entry = await readRequest(intentId);
      if (entry === undefined) return false;
      await update(entry.batchId, (current) => {
        const scopeHash = hashCanonical(current.scope);
        if (current.requestDecision !== undefined) {
          if (
            current.requestDecision.status !== decision ||
            current.requestDecision.scopeHash !== scopeHash
          ) {
            conflict();
          }
          return;
        }
        current.requestDecision = {
          status: decision,
          scopeHash,
          decidedAt: new Date(now()).toISOString(),
        };
      });
      return true;
    },

    authorizeRequest,

    async prepare(navigation, requestId, chainId, template) {
      const normalized = (
        template === null
          ? { message: "" }
          : withLegacyDependentTxids(template, [])
      ) as Readonly<{ readonly message: string }> | undefined;
      if (normalized === undefined || normalized.message.length > 16_384) {
        conflict();
      }
      const scope: Entry["scope"] = {
        requestId,
        contextHash: contextHash(navigation),
        origin: navigation.origin,
        sessionId: navigation.sessionId,
        chainId,
        messageTemplate: normalized!.message,
        ...(template === null ? { singleRequest: true as const } : {}),
      };
      const batchId = identity(scope);
      const previous = entries.get(batchId)?.scope;
      if (previous !== undefined) {
        if (
          canonicalize(previous) !==
          canonicalize({
            ...scope,
            ...(previous.request === undefined
              ? {}
              : { request: previous.request }),
          })
        ) {
          conflict();
        }
        return;
      }
      if (entries.size >= MAX_LIVE_BATCHES) conflict();
      entries.set(batchId, { batchId, scope });
    },

    async register(navigation, requestId, request, ftDecimals) {
      const hash = contextHash(navigation);
      const operationId = deriveOperationId({
        releaseFingerprint,
        contextHash: hash,
        requestId: request.id,
        operation: { method: request.method, params: request.params ?? [] },
      });
      const child = {
        operationId,
        requestHash: hashCanonical(request.params),
      };
      const first =
        typeof request.id === "string" &&
        request.id.startsWith(`${requestId}:batch:1:`) &&
        (request.method === "tbc_signTransaction" ||
          request.method === "tbc_sendTransaction");
      const second =
        typeof request.id === "string" &&
        request.id === `${requestId}:batch:2:2` &&
        request.method === "tbc_signMessage";
      if (!first && !second) conflict();
      await update(identity({ contextHash: hash, requestId }), (entry) => {
        if (
          entry.scope.singleRequest &&
          (second || entry.scope.request === undefined)
        ) {
          conflict();
        }
        const key = first ? "first" : "second";
        if (
          entry[key] !== undefined &&
          canonicalize(entry[key]) !== canonicalize(child)
        ) {
          conflict();
        }
        if (first) {
          const params = request.params as Record<string, unknown>;
          const intent = params.intent as Record<string, unknown> | undefined;
          if (
            request.method !==
              (entry.scope.request?.spend.method ?? "tbc_signTransaction") ||
            params.chainId !== entry.scope.chainId ||
            !(
              entry.scope.singleRequest
                ? [
                    "tbc.pool.liquidity.add",
                    "tbc.pool.liquidity.remove",
                    "tbc.pool.create",
                    "tbc.ft.create",
                  ]
                : ["tbc.transfer", "tbc.ft.transfer"]
            ).includes(String(intent?.type))
          ) {
            conflict();
          }
          if (entry.scope.request !== undefined) {
            if (
              entry.requestDecision?.status !== "approved" ||
              entry.requestDecision.scopeHash !== hashCanonical(entry.scope) ||
              Date.parse(entry.scope.request.expiresAt) <= now() ||
              !matchesLegacyBatchRequest(
                entry.scope.request.spend,
                params,
                ftDecimals,
              )
            ) {
              conflict();
            }
          }
        }
        entry[key] = child;
      });
    },

    async review(intent) {
      const entry = await find(intent);
      if (
        entry === undefined ||
        entry.first?.requestHash !== intent.facts.requestHash
      ) {
        return undefined;
      }
      if (
        intent.facts.operationKind !== "transaction" ||
        intent.params.binding.payload.method !==
          (entry.scope.request?.spend.method ?? "tbc_signTransaction")
      ) {
        conflict();
      }
      return Object.freeze({
        batchId: entry.batchId,
        scopeHash: hashCanonical(entry.scope),
        messageTemplate: entry.scope.messageTemplate,
        ...(entry.scope.singleRequest ? { singleRequest: true as const } : {}),
      });
    },

    async bindRoot(intent) {
      const entry = await find(intent);
      if (
        entry === undefined ||
        entry.first?.requestHash !== intent.facts.requestHash
      ) {
        return;
      }
      if (
        intent.facts.operationKind !== "transaction" ||
        intent.facts.accountId === undefined
      ) {
        conflict();
      }
      if (
        entry.scope.request !== undefined &&
        !(await authorizeRequestEntry(intent, entry))
      ) {
        conflict();
      }
      const accountId = intent.facts.accountId as string;
      const root = {
        intentId: intent.intentId,
        bindingHash: intent.params.binding.bindingHash,
        accountId,
        expiresAt: intent.facts.expiresAt,
        scopeHash: hashCanonical(entry.scope),
      };
      await update(entry.batchId, (current) => {
        if (
          current.root !== undefined &&
          canonicalize(current.root) !== canonicalize(root)
        ) {
          conflict();
        }
        current.root = root;
      });
    },

    authorizeDependent,

    async verifyDependency(intent) {
      const evidence = await findEvidence(intent);
      const entry = evidence?.entry;
      if (
        entry?.scope.request !== undefined &&
        entry.first?.requestHash === intent.facts.requestHash &&
        !(await authorizeRequestEntry(intent, entry))
      ) {
        conflict();
      }
      if (
        entry?.second?.requestHash === intent.facts.requestHash &&
        !(await authorizeDependentEntry(intent, entry, evidence?.call))
      ) {
        conflict();
      }
    },
  };

  return Object.freeze(machine);
}
