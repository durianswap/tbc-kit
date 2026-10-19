import type { OperationCheckpoint } from "../checkpoint.js";
import {
  invokeTransactionEngine,
  type TransactionEngine,
  type TwsCapabilityConfiguration,
  type TwsCapabilityScope,
} from "../engine.js";
import { TwsEngineError } from "../errors.js";
import { hashCanonical } from "../hash.js";
import { canonicalize } from "../canonical-json.js";
import { transactionSigningAccountIds, type TransactionRoleRequest } from "../transaction-signing-roles.js";
import { workflowSigningAccountIds, type WorkflowRoleRequest } from "../workflow-signing-roles.js";
import { TWS_METHOD_DEFINITIONS, getTwsMethod } from "../methods.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
import { waitingTransition } from "../transitions.js";
import { beginChainSwitch } from "./committing.js";
import {
  beginDisconnect,
  beginPermissionRequest,
} from "./permissions.js";
import {
  TWS_CHAIN_IDS,
  advance,
  completeError,
  completeSuccess,
  earliestExpiry,
  makeCalls,
  nextRevision,
  operationOf,
  type ProviderSessionView,
  type TrustedContextView,
} from "./shared.js";

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
  readonly scope: { readonly origin: string; readonly chainId: string };
  readonly result: {
    readonly revision: string;
    readonly permissions: readonly PermissionRecord[];
  };
}

function caveat(permission: PermissionRecord, type: string): unknown {
  return permission.caveats.find((item) => item.type === type)?.value;
}

function isValidPermission(
  permission: PermissionRecord,
  scope: PermissionLoadArtifact["scope"],
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
    accounts.every(
      (accountId) =>
        typeof accountId === "string" && accountId.startsWith(`${scope.chainId}:`),
    ) &&
    Array.isArray(methods) &&
    methods.includes(permission.parentCapability) &&
    (typeof expiresAt !== "string" || Date.parse(expiresAt) > Date.parse(trustedTime))
  );
}

function permissionsFrom(
  loads: readonly PermissionLoadArtifact[],
  trustedTime: string,
): readonly PermissionRecord[] {
  const unique = new Map<string, PermissionRecord>();
  for (const load of loads) {
    for (const permission of load.result.permissions) {
      if (isValidPermission(permission, load.scope, trustedTime) && !unique.has(permission.id)) {
        unique.set(permission.id, permission);
      }
    }
  }
  const compareText = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  return Object.freeze(
    [...unique.values()].sort((left, right) => {
      const leftChain = String((caveat(left, "restrictChains") as readonly unknown[])[0]);
      const rightChain = String((caveat(right, "restrictChains") as readonly unknown[])[0]);
      return (
        compareText(left.parentCapability, right.parentCapability) ||
        compareText(leftChain, rightChain) ||
        compareText(left.id, right.id)
      );
    }),
  );
}

function accountIdsFor(
  permissions: readonly PermissionRecord[],
  requiredPermissions: readonly string[],
  chainId: string,
): readonly string[] {
  let intersection: Set<string> | undefined;
  for (const required of requiredPermissions) {
    const matching = permissions.filter(
      (permission) =>
        permission.parentCapability === required &&
        (caveat(permission, "restrictChains") as readonly unknown[])[0] === chainId,
    );
    const ids = new Set(
      matching.flatMap((permission) =>
        (caveat(permission, "restrictAccounts") as readonly string[]) ?? [],
      ),
    );
    intersection =
      intersection === undefined
        ? ids
        : new Set([...intersection].filter((accountId) => ids.has(accountId)));
  }
  return Object.freeze([...(intersection ?? new Set<string>())].sort());
}

function requiredPermissionsFor(
  operation: Readonly<{ method: string; params: unknown }>,
  base: readonly string[],
): readonly string[] {
  if (
    operation.method !== "tbc_signWorkflow" &&
    operation.method !== "tbc_signPreparedWorkflow" &&
    operation.method !== "tbc_sendWorkflow" &&
    operation.method !== "tbc_sendPreparedWorkflow"
  ) return base;
  const params = operation.params as { readonly steps?: readonly Readonly<{ readonly kind?: string }>[] };
  const required = new Set(base);
  for (const step of params.steps ?? []) {
    if (
      step.kind === "transaction" ||
      step.kind === "preparedTransaction" ||
      step.kind === "reviewedTransaction"
    ) {
      required.add("tbc_signTransaction");
    } else if (step.kind === "message") {
      required.add("tbc_signMessage");
    } else if (step.kind === "typedData") {
      required.add("tbc_signTypedData");
    } else if (step.kind === "encrypt" || step.kind === "decrypt") {
      required.add("tbc_crypto");
    }
  }
  return Object.freeze([...required]);
}

function capabilities(
  checkpoint: OperationCheckpoint,
  chainId: string,
  accountId: string | undefined,
  configuration: TwsCapabilityConfiguration | undefined,
): Readonly<Record<string, unknown>> {
  const context = checkpoint.payload.context as TrustedContextView;
  const chainDefault = configuration?.scopes.find(
    (scope) => scope.chainId === chainId && scope.accountId === undefined,
  );
  const configured = accountId === undefined
    ? chainDefault
    : configuration?.scopes.find(
        (scope) => scope.chainId === chainId && scope.accountId === accountId,
      ) ?? chainDefault;
  const selected: TwsCapabilityScope = configured ?? Object.freeze({
    chainId,
    intents: Object.freeze(["tbc.transfer"] as const),
    profiles: Object.freeze(["core"] as const),
    limits: Object.freeze({ workflowSteps: 5, transactionBundleSize: 32 }),
  });
  return Object.freeze({
    standard: "1.0.0",
    provider: "1.0.0",
    chainId,
    methods: Object.fromEntries(
      TWS_METHOD_DEFINITIONS.map((definition) => [
        definition.name,
        definition.version,
      ]),
    ),
    intents: Object.freeze(Object.fromEntries(
      selected.intents.map((intent) => [intent, Object.freeze(["1.0"])]),
    )),
    limits: selected.limits,
    profiles: Object.freeze([
      ...selected.profiles,
      `transport:${context.transport}`,
    ]),
  });
}

function enterResolving(
  checkpoint: OperationCheckpoint,
  accountIds: readonly string[],
  chainId: string,
  loads: readonly PermissionLoadArtifact[],
  additionalMemory: Readonly<Record<string, unknown>> = {},
  expiresAt: string | undefined = checkpoint.payload.expiresAt,
): CoreTransition {
  const revision = nextRevision(checkpoint);
  const params = {
    version: "1.0",
    chainId,
    mode: "by-id",
    accountIds,
  };
  const calls = makeCalls(checkpoint, revision, [
    { operation: "accounts.resolve", params },
  ]);
  const next = advance(checkpoint, {
    state: "resolving",
    expiresAt,
    pendingCalls: calls,
    memory: {
      ...checkpoint.payload.memory,
      permissionLoads: loads,
      accountResolutions: [],
      ...additionalMemory,
    },
    data: { resolvedInputs: {} },
  });
  return waitingTransition(next);
}

export async function reduceAuthorizingResponse(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  result: unknown,
  transactionEngine?: TransactionEngine,
  capabilityConfiguration?: TwsCapabilityConfiguration,
): Promise<CoreTransition> {
  const previousLoads = (checkpoint.payload.memory.permissionLoads ?? []) as
    readonly PermissionLoadArtifact[];
  const load = Object.freeze({
    scope: (call.params as { scope: PermissionLoadArtifact["scope"] }).scope,
    result: result as PermissionLoadArtifact["result"],
  });
  const loads = Object.freeze([...previousLoads, load]);
  const trustedTime = String(checkpoint.payload.memory.trustedTime);
  const permissions = permissionsFrom(loads, trustedTime);
  const remaining = checkpoint.payload.pendingCalls.filter(
    (candidate) => candidate.callId !== call.callId,
  ) as readonly PortCall[];
  if (remaining.length > 0) {
    const next = advance(checkpoint, {
      state: "authorizing",
      pendingCalls: remaining,
      memory: { ...checkpoint.payload.memory, permissionLoads: loads },
      data: { permissionSnapshot: permissions },
    });
    return waitingTransition(next);
  }

  const operation = operationOf(checkpoint);
  const definition = getTwsMethod(operation.method);
  if (definition.path === "permission-read") {
    return completeSuccess(
      checkpoint,
      permissions,
      { ...checkpoint.payload.memory, permissionLoads: loads },
    );
  }

  const session = checkpoint.payload.session as ProviderSessionView;
  const requested = operation.params as {
    readonly address?: string;
    readonly from?: string;
    readonly chainId?: string;
    readonly signingRoles?: TransactionRoleRequest["signingRoles"];
  };
  const chainId = requested.chainId ?? session.state.activeChainId;
  if (!TWS_CHAIN_IDS.includes(chainId as typeof TWS_CHAIN_IDS[number])) {
    return completeError(checkpoint, 4901, "The requested TBC chain is not supported");
  }
  if (operation.method === "tbc_getCapabilities" && requested.address === undefined) {
    return completeSuccess(
      checkpoint,
      capabilities(checkpoint, chainId, undefined, capabilityConfiguration),
      { ...checkpoint.payload.memory, permissionLoads: loads },
    );
  }
  if (definition.path === "permission-request") {
    return beginPermissionRequest(checkpoint, loads);
  }
  if (definition.path === "disconnect") {
    return beginDisconnect(checkpoint, loads);
  }
  if (definition.path === "switch-chain") {
    const accountIds = accountIdsFor(permissions, definition.permissions, chainId);
    if (accountIds.length === 0) {
      return completeError(
        checkpoint,
        4100,
        "The requested chain switch is not authorized",
        { ...checkpoint.payload.memory, permissionLoads: loads },
      );
    }
    return beginChainSwitch(checkpoint, chainId, loads, accountIds);
  }
  if (
    definition.path !== "account-read" &&
    definition.path !== "message-signing" &&
    definition.path !== "sign-workflow" &&
    definition.path !== "send-workflow" &&
    definition.path !== "wallet-action" &&
    definition.path !== "sign-transaction" &&
    definition.path !== "send-transaction"
  ) {
    throw new Error(`authorizing reducer not implemented for ${definition.path}`);
  }

  const requiredPermissions = requiredPermissionsFor(operation, definition.permissions);
  let accountIds = accountIdsFor(permissions, requiredPermissions, chainId);
  if (chainId === session.state.activeChainId) {
    accountIds = Object.freeze(
      session.state.activeAccountIds.filter((accountId) => accountIds.includes(accountId)),
    );
  }
  if (requested.address !== undefined) {
    accountIds = Object.freeze(
      accountIds.filter((accountId) => accountId === `${chainId}:${requested.address}`),
    );
  }
  if (requested.from !== undefined) {
    if ((definition.path === "sign-workflow" || definition.path === "send-workflow") &&
        (operation.params as WorkflowRoleRequest).steps.some(step => step.signingRoles !== undefined)) {
      const required = workflowSigningAccountIds(operation.params as WorkflowRoleRequest);
      const controllerIds = accountIdsFor(permissions,
        [...new Set([...definition.permissions, "tbc_signTransaction"])], chainId);
      // Only the primary account needs message/crypto permissions for other
      // steps. Controllers need the batch and transaction signing grants, not
      // permission to sign unrelated messages on behalf of the primary.
      const rolesAuthorized = required.slice(1).every(id => controllerIds.includes(id) &&
        session.state.activeAccountIds.includes(id));
      accountIds = accountIds.includes(required[0]!) && rolesAuthorized ? required : Object.freeze([]);
    } else {
      const required = transactionSigningAccountIds({ chainId, from: requested.from, signingRoles: requested.signingRoles });
      accountIds = required.every(accountId => accountIds.includes(accountId)) ? required : Object.freeze([]);
    }
  }
  if (accountIds.length === 0) {
    return operation.method === "tbc_accounts"
      ? completeSuccess(
          checkpoint,
          [],
          { ...checkpoint.payload.memory, permissionLoads: loads },
        )
      : completeError(
          checkpoint,
          4100,
          "The requested account is not authorized",
          { ...checkpoint.payload.memory, permissionLoads: loads },
        );
  }
  if (
    definition.path === "sign-transaction" ||
    definition.path === "send-transaction"
  ) {
    const prepared = operation.method === "tbc_signPreparedTransaction" ||
      operation.method === "tbc_sendPreparedTransaction";
    const engineRequest = prepared
      ? (({ proposal: _proposal, ...request }) => request)(
          operation.params as Readonly<Record<string, unknown>> & { readonly proposal: unknown },
        )
      : operation.params;
    const normalized = (await invokeTransactionEngine(
      transactionEngine,
      "normalizeRequest",
      "normalizeRequestParams",
      "normalizeRequestResult",
      { version: "1.0", request: engineRequest },
    )) as {
      readonly request: unknown;
      readonly requestHash: string;
    };
    if (hashCanonical(normalized.request) !== normalized.requestHash) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "normalized transaction request hash does not match its request",
      );
    }
    const normalizedRequest = normalized.request as {
      readonly chainId: string;
      readonly from: string;
      readonly constraints?: { readonly expiresAt?: string };
      readonly signingRoles?: TransactionRoleRequest["signingRoles"];
    };
    if (
      normalizedRequest.chainId !== chainId ||
      normalizedRequest.from !== requested.from ||
      !accountIds.includes(`${chainId}:${normalizedRequest.from}`) ||
      canonicalize(normalizedRequest.signingRoles ?? []) !== canonicalize(requested.signingRoles ?? [])
    ) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "normalized transaction changed the authorized chain or account",
      );
    }
    return enterResolving(checkpoint, accountIds, chainId, loads, {
      normalizedTransaction: normalized,
      requestHash: normalized.requestHash,
      ...(prepared ? {
        preparedTransaction: operation.params,
      } : {}),
    }, earliestExpiry(
      checkpoint.payload.expiresAt,
      normalizedRequest.constraints?.expiresAt,
    ));
  }
  return enterResolving(
    checkpoint,
    accountIds,
    chainId,
    loads,
    definition.path === "message-signing" || definition.path === "sign-workflow" || definition.path === "send-workflow" || definition.path === "wallet-action"
      ? { requestHash: hashCanonical(operation.params) }
      : {},
    earliestExpiry(
      checkpoint.payload.expiresAt,
      (operation.params as { readonly expiresAt?: string }).expiresAt,
    ),
  );
}

export { capabilities };
