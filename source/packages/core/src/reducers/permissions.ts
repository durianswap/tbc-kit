import {
  assertApprovalBinding,
  createApprovalBinding,
} from "../bindings.js";
import { canonicalize } from "../canonical-json.js";
import type { OperationCheckpoint } from "../checkpoint.js";
import { TwsEngineError, TwsStateError } from "../errors.js";
import { hashCanonical } from "../hash.js";
import { derivePermissionId } from "../identifiers.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
import { completeTransition, waitingTransition } from "../transitions.js";
import { readApprovalDecision } from "./approval.js";
import { prepareApprovalWithMemory } from "./approval.js";
import {
  advance,
  completeError,
  earliestExpiry,
  makeCalls,
  nextRevision,
  operationOf,
  type ProviderSessionView,
} from "./shared.js";

interface PermissionScope {
  readonly origin: string;
  readonly chainId: string;
}

interface PermissionRecord {
  readonly id: string;
  readonly parentCapability: string;
  readonly invoker: string;
  readonly date: number;
  readonly caveats: readonly {
    readonly type: string;
    readonly value: unknown;
  }[];
}

interface PermissionLoadArtifact {
  readonly scope: PermissionScope;
  readonly result: {
    readonly revision: string;
    readonly permissions: readonly PermissionRecord[];
  };
}

interface AccountIdentity {
  readonly address: string;
  readonly accountId: string;
  readonly chainId: string;
  readonly publicKey: string;
}

interface AccountResolutionArtifact {
  readonly params: { readonly chainId: string; readonly mode: string };
  readonly result: { readonly accounts: readonly AccountIdentity[] };
}

interface RequestedCapability {
  readonly chains: readonly string[];
  readonly maxAccounts?: number;
}

type RequestedPermissions = readonly [
  Readonly<Record<string, RequestedCapability>>,
];

function addWholeSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1000)
    .toISOString();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function caveat(permission: PermissionRecord, type: string): unknown {
  return permission.caveats.find((candidate) => candidate.type === type)?.value;
}

function isScopedPermission(
  permission: PermissionRecord,
  scope: PermissionScope,
  trustedTime: string,
): boolean {
  const chains = caveat(permission, "restrictChains");
  const accounts = caveat(permission, "restrictAccounts");
  const methods = caveat(permission, "restrictMethods");
  const expiresAt = caveat(permission, "expiresAt");
  return (
    permission.invoker === scope.origin &&
    Array.isArray(chains) &&
    chains.length === 1 &&
    chains[0] === scope.chainId &&
    Array.isArray(accounts) &&
    accounts.length > 0 &&
    accounts.every(
      (accountId) =>
        typeof accountId === "string" &&
        accountId.startsWith(`${scope.chainId}:`),
    ) &&
    Array.isArray(methods) &&
    methods.includes(permission.parentCapability) &&
    (typeof expiresAt !== "string" ||
      Date.parse(expiresAt) > Date.parse(trustedTime))
  );
}

function rejectionCompletion(checkpoint: OperationCheckpoint) {
  return Object.freeze({
    delivery: "respond",
    response: {
      jsonrpc: "2.0",
      id: checkpoint.payload.requestId,
      error: { code: 4001, message: "User rejected the request" },
    },
    events: [],
  });
}

function normalizePermissionRequest(
  checkpoint: OperationCheckpoint,
): RequestedPermissions {
  const operation = operationOf(checkpoint);
  if (operation.method === "tbc_requestAccounts") {
    const session = checkpoint.payload.session as ProviderSessionView;
    return Object.freeze([
      Object.freeze({
        tbc_accounts: Object.freeze({
          chains: Object.freeze([session.state.activeChainId]),
          maxAccounts: 1,
        }),
      }),
    ]) as RequestedPermissions;
  }
  return operation.params as RequestedPermissions;
}

function requestedChains(requested: RequestedPermissions): readonly string[] {
  return Object.freeze(
    [...new Set(
      Object.values(requested[0]).flatMap(({ chains }) => chains),
    )].sort(compareText),
  );
}

export function beginPermissionRequest(
  checkpoint: OperationCheckpoint,
  loads: readonly PermissionLoadArtifact[],
): CoreTransition {
  const requested = normalizePermissionRequest(checkpoint);
  const chains = requestedChains(requested);
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(
    checkpoint,
    revision,
    chains.map((chainId) => ({
      operation: "accounts.resolve",
      params: { version: "1.0", chainId, mode: "available" },
    })),
  );
  const requestHash = hashCanonical(requested);
  const next = advance(checkpoint, {
    state: "resolving",
    pendingCalls: calls,
    memory: {
      ...checkpoint.payload.memory,
      permissionLoads: loads,
      accountResolutions: [],
      requestHash,
    },
    data: { resolvedInputs: {} },
  });
  return waitingTransition(next);
}

export function reducePermissionResolution(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  if (call.operation !== "accounts.resolve") {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "permission resolution requires accounts.resolve",
    );
  }
  const params = call.params as { readonly chainId: string; readonly mode: string };
  if (params.mode !== "available") {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "permission grants require available account resolution",
    );
  }
  const result = resultValue as { readonly accounts: readonly AccountIdentity[] };
  if (
    result.accounts.some(
      (account) =>
        account.chainId !== params.chainId ||
        account.accountId !== `${account.chainId}:${account.address}`,
    )
  ) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "permission account result escaped its exact chain scope",
    );
  }
  const artifact = Object.freeze({ params: call.params, result });
  const accountResolutions = Object.freeze([
    ...((checkpoint.payload.memory.accountResolutions ?? []) as readonly unknown[]),
    artifact,
  ]);
  const remaining = checkpoint.payload.pendingCalls.filter(
    (candidate) => candidate.callId !== call.callId,
  );
  const memory = { ...checkpoint.payload.memory, accountResolutions };
  if (remaining.length === 0) {
    return planPermissionRequest(checkpoint, memory);
  }
  const next = advance(checkpoint, {
    state: "resolving",
    pendingCalls: remaining,
    memory,
    data: { resolvedInputs: {} },
  });
  return waitingTransition(next);
}

function proposalArtifacts(
  checkpoint: OperationCheckpoint,
  memory: Readonly<Record<string, unknown>> = checkpoint.payload.memory,
  options: Readonly<{
    readonly trustedTime?: string;
    readonly expiryCeiling?: string;
  }> = {},
) {
  const requested = normalizePermissionRequest(checkpoint);
  const capabilities = Object.keys(requested[0]).sort();
  const chains = requestedChains(requested);
  const context = checkpoint.payload.context as { readonly origin: string };
  const loads = memory.permissionLoads as readonly PermissionLoadArtifact[];
  const resolutions = memory.accountResolutions as readonly AccountResolutionArtifact[];
  const trustedTime = options.trustedTime ?? String(memory.trustedTime);
  const granted: Record<string, unknown>[] = [];
  const changes = chains.map((chainId) => {
    const load = loads.find((candidate) => candidate.scope.chainId === chainId);
    if (load === undefined || load.scope.origin !== context.origin) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "permission scope is missing its exact loaded revision",
      );
    }
    const accounts = (resolutions.find(
      (candidate) => candidate.params.chainId === chainId,
    )?.result.accounts ?? [])
      .filter((account) => account.chainId === chainId)
      .sort((left, right) => compareText(left.accountId, right.accountId));
    // The existing explicit accounts request bounds this chain's proposal.
    // Default and tbc_requestAccounts stay single-account. Never carry an
    // increased bound to another chain or an unrequested capability.
    const accountRequest = requested[0].tbc_accounts;
    const maximum = accountRequest?.chains.includes(chainId)
      ? (accountRequest.maxAccounts ?? 1) : 1;
    const selected = accounts.slice(0, maximum).map(({ accountId }) => accountId);
    const requestedForChain = capabilities.filter((capability) =>
      requested[0][capability]!.chains.includes(chainId),
    );
    const replacement = requestedForChain.flatMap((capability) => {
      if (selected.length === 0) return [];
      const permission = Object.freeze({
        id: derivePermissionId({
          operationId: checkpoint.payload.operationId,
          chainId,
          parentCapability: capability,
          ordinal: capabilities.indexOf(capability),
        }),
        parentCapability: capability,
        invoker: context.origin,
        date: Date.parse(trustedTime),
        caveats: Object.freeze([
          { type: "restrictChains", value: Object.freeze([chainId]) },
          { type: "restrictAccounts", value: Object.freeze(selected) },
          { type: "restrictMethods", value: Object.freeze([capability]) },
        ]),
      });
      granted.push({
        capability,
        chainId,
        accountIds: selected,
        methods: [capability],
      });
      return [permission];
    });
    const replacedCapabilities = new Set(
      selected.length === 0 ? [] : requestedForChain,
    );
    const preserved = load.result.permissions.filter(
      (permission) =>
        isScopedPermission(permission, load.scope, trustedTime) &&
        !replacedCapabilities.has(permission.parentCapability),
    );
    const permissions = Object.freeze(
      [...preserved, ...replacement].sort((left, right) =>
        compareText(left.parentCapability, right.parentCapability) ||
        compareText(left.id, right.id),
      ),
    );
    return Object.freeze({
      scope: load.scope,
      expectedRevision: load.result.revision,
      permissions,
    });
  });
  if (granted.length === 0) {
    return undefined;
  }
  const permissionIds = changes.flatMap(({ permissions }) =>
    permissions.map(({ id }) => id),
  );
  if (new Set(permissionIds).size !== permissionIds.length) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "permission proposal contains a duplicate permission id",
    );
  }
  const decisions = capabilities.map((capability) => {
    const capabilityChains = requested[0][capability]!.chains;
    const grants = granted.filter(
      (item) =>
        item.capability === capability && capabilityChains.includes(String(item.chainId)),
    );
    if (grants.length === 0) {
      return { capability, status: "rejected", reason: "NO_AVAILABLE_ACCOUNT" };
    }
    if (grants.some(item => (item.accountIds as readonly string[]).length > 1)) {
      return { capability, status: "narrowed", reason: "EXPLICIT_AVAILABLE_ACCOUNT_LIMIT" };
    }
    return {
      capability,
      status: "narrowed",
      reason: "ONE_ACCOUNT_PER_CHAIN",
    };
  });
  const warnings = Object.freeze([
    ...(decisions.some(({ status }) => status === "narrowed")
      ? ["PERMISSION_NARROWED"]
      : []),
    ...(decisions.some(({ status }) => status === "rejected")
      ? ["PERMISSION_REJECTED"]
      : []),
  ]);
  const expiresAt = earliestExpiry(
    options.expiryCeiling ?? checkpoint.payload.expiresAt,
    addWholeSeconds(trustedTime, 2 * 60),
  );
  const payload = Object.freeze({
    version: "1.0",
    origin: context.origin,
    requested,
    changes: Object.freeze(changes),
    decisions: Object.freeze(decisions),
    createdAt: trustedTime,
    expiresAt,
  });
  const proposal = Object.freeze({
    payload,
    permissionProposalHash: hashCanonical(payload),
  });
  const preview = Object.freeze({
    operationKind: "permission",
    requested,
    granted: Object.freeze(granted),
    decisions: Object.freeze(decisions),
    warnings,
  });
  return { proposal, preview, chains, expiresAt };
}

export function planPermissionRequest(
  checkpoint: OperationCheckpoint,
  memory: Readonly<Record<string, unknown>> = checkpoint.payload.memory,
): CoreTransition {
  const artifacts = proposalArtifacts(checkpoint, memory);
  if (artifacts === undefined) {
    return completeError(checkpoint, 4100, "No requested account is available");
  }
  const operation = operationOf(checkpoint);
  const context = checkpoint.payload.context as {
    readonly origin: string;
    readonly sessionId: string;
  };
  const binding = createApprovalBinding({
    version: "1.0",
    method: operation.method,
    operationKind: "permission",
    contextHash: checkpoint.payload.contextHash,
    origin: context.origin,
    sessionId: context.sessionId,
    chainIds: artifacts.chains,
    requestHash: String(memory.requestHash),
    operationHash: artifacts.proposal.permissionProposalHash,
    expiresAt: artifacts.expiresAt,
  });
  return prepareApprovalWithMemory(
    checkpoint,
    binding,
    artifacts.preview,
    { ...memory, permissionProposal: artifacts.proposal },
  );
}

interface PermissionProposal {
  readonly payload: {
    readonly origin: string;
    readonly requested: RequestedPermissions;
    readonly changes: readonly unknown[];
    readonly createdAt: string;
    readonly expiresAt: string;
  };
  readonly permissionProposalHash: string;
}

export function assertPermissionApprovalArtifacts(
  checkpoint: OperationCheckpoint,
): PermissionProposal {
  const proposal = checkpoint.payload.memory.permissionProposal as
    | PermissionProposal
    | undefined;
  if (
    proposal === undefined ||
    hashCanonical(proposal.payload) !== proposal.permissionProposalHash
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "permission proposal hash does not match its payload",
    );
  }
  const operation = operationOf(checkpoint);
  const requested = normalizePermissionRequest(checkpoint);
  const requestHash = hashCanonical(requested);
  const context = checkpoint.payload.context as {
    readonly origin: string;
    readonly sessionId: string;
  };
  if (
    proposal.payload.origin !== context.origin ||
    hashCanonical(proposal.payload.requested) !== requestHash ||
    checkpoint.payload.memory.requestHash !== requestHash
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "permission proposal differs from the current operation",
    );
  }
  const reconstructed = proposalArtifacts(checkpoint, checkpoint.payload.memory, {
    trustedTime: proposal.payload.createdAt,
    expiryCeiling: proposal.payload.expiresAt,
  });
  if (
    reconstructed === undefined ||
    !sameJson(reconstructed.proposal, proposal) ||
    !sameJson(
      reconstructed.preview,
      checkpoint.payload.memory.approvalPreview,
    )
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "permission proposal or preview is not derivable from resolved inputs",
    );
  }
  const expectedBinding = createApprovalBinding({
    version: "1.0",
    method: operation.method,
    operationKind: "permission",
    contextHash: checkpoint.payload.contextHash,
    origin: context.origin,
    sessionId: context.sessionId,
    chainIds: requestedChains(requested),
    requestHash,
    operationHash: proposal.permissionProposalHash,
    expiresAt: proposal.payload.expiresAt,
  });
  assertApprovalBinding(
    checkpoint.payload.memory.approvalBinding as typeof expectedBinding,
    expectedBinding.payload,
  );
  return proposal;
}

export function permissionCommitFromProposal(
  proposal: PermissionProposal,
): Readonly<{ readonly params: Readonly<Record<string, unknown>> }> {
  return Object.freeze({
    params: Object.freeze({
      version: "1.0",
      changes: proposal.payload.changes,
    }),
  });
}

export function reducePermissionApproval(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  const proposal = assertPermissionApprovalArtifacts(checkpoint);
  const decision = readApprovalDecision(checkpoint, call, resultValue);
  if (decision.status === "rejected") {
    const next = advance(checkpoint, {
      state: "rejected",
      pendingCalls: [],
      data: { cancellationReason: "USER_REJECTED" },
    });
    return completeTransition(next, rejectionCompletion(checkpoint));
  }
  const permissionCommit = permissionCommitFromProposal(proposal);
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "clock.now", params: { version: "1.0" } },
  ]);
  const next = advance(checkpoint, {
    state: "committing",
    expiresAt: decision.receipt.expiresAt,
    pendingCalls: calls,
    memory: { ...checkpoint.payload.memory, permissionCommit },
    data: { kind: "permission-store", permissionCommit },
  });
  return waitingTransition(next);
}

export function disconnectCommitFromLoads(
  checkpoint: OperationCheckpoint,
  loads: readonly PermissionLoadArtifact[],
): Readonly<{ readonly params: Readonly<Record<string, unknown>> }> {
  const context = checkpoint.payload.context as { readonly origin: string };
  if (loads.some(({ scope }) => scope.origin !== context.origin)) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "disconnect permission scope differs from the current origin",
    );
  }
  const changes = Object.freeze(
    [...loads]
      .sort((left, right) => compareText(left.scope.chainId, right.scope.chainId))
      .map((load) => Object.freeze({
        scope: load.scope,
        expectedRevision: load.result.revision,
        permissions: Object.freeze([]),
      })),
  );
  return Object.freeze({
    params: Object.freeze({ version: "1.0", changes }),
  });
}

export function beginDisconnect(
  checkpoint: OperationCheckpoint,
  loads: readonly PermissionLoadArtifact[],
): CoreTransition {
  const permissionCommit = disconnectCommitFromLoads(checkpoint, loads);
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "clock.now", params: { version: "1.0" } },
  ]);
  const next = advance(checkpoint, {
    state: "committing",
    pendingCalls: calls,
    memory: {
      ...checkpoint.payload.memory,
      permissionLoads: loads,
      permissionCommit,
    },
    data: { kind: "permission-store", permissionCommit },
  });
  return waitingTransition(next);
}
