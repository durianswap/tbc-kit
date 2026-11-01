import {
  assertApprovalBinding,
  createApprovalBinding,
} from "../bindings.js";
import { canonicalize } from "../canonical-json.js";
import type { OperationCheckpoint } from "../checkpoint.js";
import {
  TwsEngineError,
  TwsStateError,
} from "../errors.js";
import { hashCanonical } from "../hash.js";
import { deriveProviderCommitId } from "../identifiers.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
import {
  commitTransition,
  completeTransition,
  waitingTransition,
} from "../transitions.js";
import { readApprovalDecision } from "./approval.js";
import { prepareApprovalWithMemory } from "./approval.js";
import {
  assertPermissionApprovalArtifacts,
  disconnectCommitFromLoads,
  permissionCommitFromProposal,
} from "./permissions.js";
import {
  advance,
  completeError,
  completeSuccess,
  earliestExpiry,
  makeCalls,
  nextRevision,
  operationOf,
} from "./shared.js";

interface PermissionRecord {
  readonly id: string;
  readonly parentCapability: string;
  readonly invoker: string;
  readonly date: number;
  readonly caveats: readonly { readonly type: string; readonly value: unknown }[];
}

interface PermissionLoadArtifact {
  readonly scope: { readonly origin: string; readonly chainId: string };
  readonly result: {
    readonly revision: string;
    readonly permissions: readonly PermissionRecord[];
  };
}

interface ProviderSessionSnapshot {
  readonly scope: { readonly walletProfile: string; readonly sessionId: string };
  readonly state: {
    readonly version: "1.0";
    readonly sessionId: string;
    readonly revision: string;
    readonly connected: boolean;
    readonly activeChainId: string;
    readonly activeAccountIds: readonly string[];
  };
}

interface ChainSwitchProposal {
  readonly payload: {
    readonly version: "1.0";
    readonly fromChainId: string;
    readonly toChainId: string;
    readonly expectedSessionRevision: string;
    readonly expiresAt: string;
  };
  readonly chainSwitchProposalHash: string;
}

interface ProviderSessionMutation {
  readonly payload: {
    readonly version: "1.0";
    readonly scope: ProviderSessionSnapshot["scope"];
    readonly expectedRevision: string;
    readonly target: ProviderSessionSnapshot["state"];
    readonly events: readonly { readonly name: string; readonly payload: unknown }[];
  };
  readonly commitId: string;
}

function addWholeSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1000)
    .toISOString();
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function caveat(permission: PermissionRecord, type: string): unknown {
  return permission.caveats.find((candidate) => candidate.type === type)?.value;
}

function rejection(checkpoint: OperationCheckpoint): CoreTransition {
  const completion = Object.freeze({
    delivery: "respond",
    response: {
      jsonrpc: "2.0",
      id: checkpoint.payload.requestId,
      error: { code: 4001, message: "User rejected the request" },
    },
    events: [],
  });
  const next = advance(checkpoint, {
    state: "rejected",
    pendingCalls: [],
    data: { cancellationReason: "USER_REJECTED" },
  });
  return completeTransition(next, completion);
}

function authorizedSwitchAccountIds(
  checkpoint: OperationCheckpoint,
  toChainId: string,
  trustedTime: string = String(checkpoint.payload.memory.trustedTime),
  loads: readonly PermissionLoadArtifact[] =
    checkpoint.payload.memory.permissionLoads as readonly PermissionLoadArtifact[],
): readonly string[] {
  const context = checkpoint.payload.context as { readonly origin: string };
  const accountIds = loads
    .filter(
      ({ scope }) =>
        scope.origin === context.origin && scope.chainId === toChainId,
    )
    .flatMap(({ scope, result }) =>
      result.permissions.filter((permission) => {
        const chains = caveat(permission, "restrictChains");
        const accounts = caveat(permission, "restrictAccounts");
        const methods = caveat(permission, "restrictMethods");
        const expiresAt = caveat(permission, "expiresAt");
        return (
          permission.parentCapability === "tbc_switchChain" &&
          permission.invoker === scope.origin &&
          Array.isArray(chains) &&
          chains.length === 1 &&
          chains[0] === toChainId &&
          Array.isArray(accounts) &&
          accounts.length > 0 &&
          accounts.every(
            (accountId) =>
              typeof accountId === "string" &&
              accountId.startsWith(`${toChainId}:`),
          ) &&
          Array.isArray(methods) &&
          methods.includes("tbc_switchChain") &&
          (typeof expiresAt !== "string" ||
            Date.parse(expiresAt) > Date.parse(trustedTime))
        );
      }),
    )
    .flatMap(
      (permission) =>
        caveat(permission, "restrictAccounts") as readonly string[],
    );
  return Object.freeze([...new Set(accountIds)].sort());
}

function chainSwitchPreview(fromChainId: string, toChainId: string) {
  return Object.freeze({
    operationKind: "switchChain",
    fromChainId,
    toChainId,
    network: Object.freeze({
      name:
        toChainId === "tbc:mainnet"
          ? "TBC Mainnet"
          : "TBC Testnet",
      nativeCurrencySymbol: "TBC",
    }),
    warnings: Object.freeze(["CHAIN_SWITCH"]),
  });
}

export function assertChainSwitchApprovalArtifacts(
  checkpoint: OperationCheckpoint,
): ChainSwitchProposal {
  const proposal = checkpoint.payload.memory.chainSwitchProposal as
    | ChainSwitchProposal
    | undefined;
  if (
    proposal === undefined ||
    hashCanonical(proposal.payload) !== proposal.chainSwitchProposalHash
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "chain switch proposal hash does not match its payload",
    );
  }
  const operation = operationOf(checkpoint);
  const params = operation.params as { readonly chainId?: string };
  const session = checkpoint.payload.session as ProviderSessionSnapshot;
  const context = checkpoint.payload.context as {
    readonly origin: string;
    readonly sessionId: string;
  };
  const requestHash = hashCanonical(operation.params);
  if (
    operation.method !== "tbc_switchChain" ||
    params.chainId !== proposal.payload.toChainId ||
    proposal.payload.fromChainId !== session.state.activeChainId ||
    proposal.payload.expectedSessionRevision !== session.state.revision ||
    checkpoint.payload.memory.requestHash !== requestHash
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "chain switch proposal differs from the current operation",
    );
  }
  if (
    !sameJson(
      checkpoint.payload.memory.approvalPreview,
      chainSwitchPreview(proposal.payload.fromChainId, proposal.payload.toChainId),
    )
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "chain switch preview differs from the proposal",
    );
  }
  const expectedBinding = createApprovalBinding({
    version: "1.0",
    method: operation.method,
    operationKind: "switchChain",
    contextHash: checkpoint.payload.contextHash,
    origin: context.origin,
    sessionId: context.sessionId,
    chainId: proposal.payload.toChainId,
    requestHash,
    operationHash: proposal.chainSwitchProposalHash,
    expiresAt: proposal.payload.expiresAt,
  });
  assertApprovalBinding(
    checkpoint.payload.memory.approvalBinding as typeof expectedBinding,
    expectedBinding.payload,
  );
  return proposal;
}

function deriveSwitchMutation(
  checkpoint: OperationCheckpoint,
  checkpointRevision: string,
  trustedTime: string = String(checkpoint.payload.memory.trustedTime),
): ProviderSessionMutation {
  const proposal = assertChainSwitchApprovalArtifacts(checkpoint);
  const session = checkpoint.payload.session as ProviderSessionSnapshot;
  const activeAccountIds = authorizedSwitchAccountIds(
    checkpoint,
    proposal.payload.toChainId,
    trustedTime,
  );
  if (activeAccountIds.length === 0) {
    throw new TwsStateError(
      "STATE_MISMATCH",
      "chain switch lost its authorized target account",
    );
  }
  const target = Object.freeze({
    ...session.state,
    revision: String(BigInt(session.state.revision) + 1n),
    activeChainId: proposal.payload.toChainId,
    activeAccountIds,
  });
  const payload = Object.freeze({
    version: "1.0" as const,
    scope: session.scope,
    expectedRevision: proposal.payload.expectedSessionRevision,
    target,
    events: Object.freeze([
      { name: "chainChanged", payload: proposal.payload.toChainId },
    ]),
  });
  return Object.freeze({
    payload,
    commitId: deriveProviderCommitId({
      operationId: checkpoint.payload.operationId,
      checkpointRevision,
      mutationPayload: payload,
    }),
  });
}

export function beginChainSwitch(
  checkpoint: OperationCheckpoint,
  toChainId: string,
  loads: readonly PermissionLoadArtifact[],
  authorizedAccountIds: readonly string[],
): CoreTransition {
  const session = checkpoint.payload.session as ProviderSessionSnapshot;
  if (toChainId === session.state.activeChainId) {
    return completeSuccess(checkpoint, null);
  }
  const trustedTime = String(checkpoint.payload.memory.trustedTime);
  if (
    !sameJson(
      authorizedSwitchAccountIds(checkpoint, toChainId, trustedTime, loads),
      authorizedAccountIds,
    )
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "chain switch authorization result is not reproducible",
    );
  }
  const expiresAt = earliestExpiry(
    checkpoint.payload.expiresAt,
    addWholeSeconds(trustedTime, 2 * 60),
  );
  const payload = Object.freeze({
    version: "1.0" as const,
    fromChainId: session.state.activeChainId,
    toChainId,
    expectedSessionRevision: session.state.revision,
    expiresAt,
  });
  const proposal = Object.freeze({
    payload,
    chainSwitchProposalHash: hashCanonical(payload),
  });
  const operation = operationOf(checkpoint);
  const context = checkpoint.payload.context as {
    readonly origin: string;
    readonly sessionId: string;
  };
  const requestHash = hashCanonical(operation.params);
  const binding = createApprovalBinding({
    version: "1.0",
    method: operation.method,
    operationKind: "switchChain",
    contextHash: checkpoint.payload.contextHash,
    origin: context.origin,
    sessionId: context.sessionId,
    chainId: toChainId,
    requestHash,
    operationHash: proposal.chainSwitchProposalHash,
    expiresAt,
  });
  const preview = chainSwitchPreview(session.state.activeChainId, toChainId);
  return prepareApprovalWithMemory(checkpoint, binding, preview, {
    requestHash,
    chainSwitchProposal: proposal,
    permissionLoads: loads,
    accountResolutions: checkpoint.payload.memory.accountResolutions ?? [],
  });
}

export function reduceSwitchApproval(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  assertChainSwitchApprovalArtifacts(checkpoint);
  const decision = readApprovalDecision(checkpoint, call, resultValue);
  if (decision.status === "rejected") return rejection(checkpoint);
  const providerSessionMutation = deriveSwitchMutation(
    checkpoint,
    String(BigInt(checkpoint.payload.revision) + 2n),
  );
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "clock.now", params: { version: "1.0" } },
  ]);
  const next = advance(checkpoint, {
    state: "committing",
    expiresAt: decision.receipt.expiresAt,
    pendingCalls: calls,
    memory: { ...checkpoint.payload.memory, providerSessionMutation },
    data: { kind: "provider-session", providerSessionMutation },
  });
  return waitingTransition(next);
}

function expectedPermissionCommit(checkpoint: OperationCheckpoint) {
  const operation = operationOf(checkpoint);
  if (operation.method === "tbc_disconnect") {
    return disconnectCommitFromLoads(
      checkpoint,
      checkpoint.payload.memory.permissionLoads as readonly PermissionLoadArtifact[],
    );
  }
  return permissionCommitFromProposal(assertPermissionApprovalArtifacts(checkpoint));
}

function assertStoredPermissionCommit(checkpoint: OperationCheckpoint) {
  const expected = expectedPermissionCommit(checkpoint);
  const stored = checkpoint.payload.memory.permissionCommit;
  const data = checkpoint.payload.data as {
    readonly kind?: unknown;
    readonly permissionCommit?: unknown;
  };
  if (
    data.kind !== "permission-store" ||
    !sameJson(stored, expected) ||
    !sameJson(data.permissionCommit, expected)
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "permission commit differs from its approved or disconnect source",
    );
  }
  return expected;
}

export function assertProviderSessionMutation(
  checkpoint: OperationCheckpoint,
): ProviderSessionMutation {
  const expected = deriveSwitchMutation(
    checkpoint,
    checkpoint.payload.revision,
  );
  const stored = checkpoint.payload.memory.providerSessionMutation;
  const data = checkpoint.payload.data as {
    readonly kind?: unknown;
    readonly providerSessionMutation?: unknown;
  };
  if (
    data.kind !== "provider-session" ||
    !sameJson(stored, expected) ||
    !sameJson(data.providerSessionMutation, expected)
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "Provider Session mutation differs from the approved proposal",
    );
  }
  return expected;
}

export function reduceCommitClock(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  if (checkpoint.payload.state !== "committing" || call.operation !== "clock.now") {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "commit freshness check requires committing clock.now",
    );
  }
  const result = resultValue as { readonly now: string };
  if (Date.parse(result.now) >= Date.parse(String(checkpoint.payload.expiresAt))) {
    return completeError(checkpoint, 4100, "Approval expired before commit", checkpoint.payload.memory,
      { reason: "RECEIPT_EXPIRED", stage: "commit", operationId: checkpoint.payload.operationId });
  }
  const kind = (checkpoint.payload.data as { readonly kind?: unknown }).kind;
  if (kind === "permission-store") {
    const permissionCommit = assertStoredPermissionCommit(checkpoint);
    const revision = nextRevision(checkpoint);
    const calls = makeCalls(checkpoint, revision, [
      { operation: "permissionStore.commit", params: permissionCommit.params },
    ]);
    const next = advance(checkpoint, {
      state: "committing",
      updatedAt: result.now,
      pendingCalls: calls,
      memory: { ...checkpoint.payload.memory, trustedTime: result.now },
      data: { kind: "permission-store", permissionCommit },
    });
    return waitingTransition(next);
  }
  if (kind !== "provider-session") {
    throw new TwsStateError("STATE_MISMATCH", "committing kind is invalid");
  }
  const expected = deriveSwitchMutation(
    checkpoint,
    nextRevision(checkpoint),
    result.now,
  );
  const stored = checkpoint.payload.memory.providerSessionMutation;
  const data = checkpoint.payload.data as {
    readonly providerSessionMutation?: unknown;
  };
  if (!sameJson(stored, expected) || !sameJson(data.providerSessionMutation, expected)) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "Provider Session mutation changed after approval",
    );
  }
  const next = advance(checkpoint, {
    state: "committing",
    updatedAt: result.now,
    pendingCalls: [],
    memory: { ...checkpoint.payload.memory, trustedTime: result.now },
    data: { kind: "provider-session", providerSessionMutation: expected },
  });
  return commitTransition(
    next,
    expected as unknown as Readonly<Record<string, unknown>>,
  );
}

export function reducePermissionCommit(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  if (call.operation !== "permissionStore.commit") {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "permission committing reducer requires permissionStore.commit",
    );
  }
  const expected = assertStoredPermissionCommit(checkpoint);
  if (!sameJson(call.params, expected.params)) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "permission commit call differs from the bound commit artifact",
    );
  }
  const params = call.params as {
    readonly changes: readonly {
      readonly scope: unknown;
      readonly expectedRevision: string;
      readonly permissions: readonly PermissionRecord[];
    }[];
  };
  const result = resultValue as {
    readonly revisions: readonly {
      readonly scope: unknown;
      readonly revision: string;
    }[];
  };
  if (
    result.revisions.length !== params.changes.length ||
    result.revisions.some((revision, index) => {
      const change = params.changes[index];
      return (
        change === undefined ||
        !sameJson(revision.scope, change.scope) ||
        revision.revision !== String(BigInt(change.expectedRevision) + 1n)
      );
    })
  ) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "permission commit result does not match the atomic CAS batch",
    );
  }
  const permissionCommit = Object.freeze({ params: call.params, result: resultValue });
  const memory = { ...checkpoint.payload.memory, permissionCommit };
  const operation = operationOf(checkpoint);
  if (operation.method === "tbc_disconnect") {
    return completeSuccess(
      checkpoint,
      null,
      memory,
      Object.freeze([
        Object.freeze({ name: "permissionsChanged", payload: Object.freeze([]) }),
        Object.freeze({ name: "accountsChanged", payload: Object.freeze([]) }),
      ]),
    );
  }
  const proposal = assertPermissionApprovalArtifacts(checkpoint);
  const requestedCapabilities = new Set(Object.keys(proposal.payload.requested[0]));
  const permissions = params.changes
    .flatMap((change) => change.permissions)
    .filter((permission) => requestedCapabilities.has(permission.parentCapability));
  if (operation.method === "tbc_requestAccounts") {
    const addresses = [...new Set(
      permissions.flatMap((permission) =>
        ((caveat(permission, "restrictAccounts") as readonly string[]) ?? [])
          .map((accountId) => accountId.slice(accountId.lastIndexOf(":") + 1)),
      ),
    )].sort();
    return completeSuccess(checkpoint, addresses, memory);
  }
  return completeSuccess(checkpoint, permissions, memory);
}
