import type { OperationCheckpoint } from "../checkpoint.js";
import { isWalletAction, beginWalletAction, reduceWalletActionReview } from "./wallet-actions.js";
import type {
  LegacyBitcoinMessageDigest,
  TransactionEngine,
  TwsCapabilityConfiguration,
} from "../engine.js";
import { TwsEngineError } from "../errors.js";
import { hashCanonical } from "../hash.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
import { continueTransition, waitingTransition } from "../transitions.js";
import { capabilities } from "./authorizing.js";
import {
  beginMessageApproval,
} from "./messages.js";
import {
  beginWorkflowResolution,
  reduceWorkflowResolvingResponse,
} from "./workflows.js";
import { reducePermissionResolution } from "./permissions.js";
import {
  advance,
  completeError,
  completeSuccess,
  earliestExpiry,
  makeCalls,
  nextRevision,
  operationOf,
} from "./shared.js";
import { chainDataRequirement } from "./chain-data-requirements.js";
import { resolveTransactionSigningAccounts, assertTransactionSigningSnapshot, type TransactionRoleRequest, type TransactionRoleAccount } from "../transaction-signing-roles.js";

interface AccountIdentity {
  readonly address: string;
  readonly accountId: string;
  readonly chainId: string;
  readonly publicKey: string;
  readonly label?: string;
}

function isTransactionMethod(method: string): boolean {
  return method === "tbc_signTransaction" ||
    method === "tbc_signPreparedTransaction" ||
    method === "tbc_sendTransaction" ||
    method === "tbc_sendPreparedTransaction";
}

function accountFromMemory(checkpoint: OperationCheckpoint): AccountIdentity {
  const artifacts = checkpoint.payload.memory.accountResolutions as readonly {
    readonly result: { readonly accounts: readonly AccountIdentity[] };
  }[];
  const request = (checkpoint.payload.memory.normalizedTransaction as {
    readonly request: { readonly chainId: string; readonly from: string };
  }).request;
  const account = artifacts[artifacts.length - 1]
    ?.result.accounts.find(
      (candidate) =>
        candidate.chainId === request.chainId && candidate.address === request.from,
    );
  if (account === undefined) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "transaction account resolution is missing",
    );
  }
  return account;
}

function waitFor(
  checkpoint: OperationCheckpoint,
  operation: string,
  params: unknown,
  memory: Readonly<Record<string, unknown>>,
  account: AccountIdentity,
  expiresAt: string | undefined = checkpoint.payload.expiresAt,
): CoreTransition {
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [{ operation, params }]);
  const next = advance(checkpoint, {
    state: "resolving",
    expiresAt,
    pendingCalls: calls,
    memory,
    data: { resolvedInputs: { account } },
  });
  return waitingTransition(next);
}

export function reduceResolvingResponse(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
  engine?: TransactionEngine,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
  capabilityConfiguration?: TwsCapabilityConfiguration,
): CoreTransition | Promise<CoreTransition> {
  const operation = operationOf(checkpoint);
  if (isWalletAction(operation.method) && call.operation !== "accounts.resolve") {
    return reduceWalletActionReview(checkpoint, call, resultValue);
  }
  if (
    (operation.method === "tbc_signWorkflow" ||
      operation.method === "tbc_signPreparedWorkflow" ||
      operation.method === "tbc_sendWorkflow" ||
      operation.method === "tbc_sendPreparedWorkflow") &&
    call.operation !== "accounts.resolve"
  ) {
    return reduceWorkflowResolvingResponse(
      checkpoint,
      call,
      resultValue,
      engine,
      legacyBitcoinMessageDigest,
    );
  }
  if (
    (operation.method === "tbc_requestAccounts" ||
      operation.method === "wallet_requestPermissions") &&
    call.operation === "accounts.resolve"
  ) {
    return reducePermissionResolution(checkpoint, call, resultValue);
  }
  if (isTransactionMethod(operation.method) && call.operation === "chainData.resolve") {
    const snapshot = resultValue as {
      readonly payload: { readonly expiresAt: string };
      readonly snapshotHash: string;
    };
    if (hashCanonical(snapshot.payload) !== snapshot.snapshotHash) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "chain snapshot hash does not match its payload",
      );
    }
    const normalized = checkpoint.payload.memory.normalizedTransaction as {
      readonly request: TransactionRoleRequest;
      readonly requestHash: string;
    };
    if (normalized.request.signingRoles !== undefined) {
      const resolutions = checkpoint.payload.memory.accountResolutions as readonly { readonly result: { readonly accounts: readonly TransactionRoleAccount[] } }[];
      assertTransactionSigningSnapshot(normalized.request, resolutions.at(-1)!.result.accounts,
        snapshot.payload as unknown as Parameters<typeof assertTransactionSigningSnapshot>[2]);
    } else if (Reflect.has(snapshot.payload, "signingAccounts")) {
      throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "Chain Data added unrequested signing accounts");
    }
    const params = {
      version: "1.0",
      requestHash: normalized.requestHash,
      request: normalized.request,
      snapshotHash: snapshot.snapshotHash,
    };
    return waitFor(
      checkpoint,
      "policy.resolve",
      params,
      { ...checkpoint.payload.memory, chainSnapshot: snapshot },
      accountFromMemory(checkpoint),
      earliestExpiry(checkpoint.payload.expiresAt, snapshot.payload.expiresAt),
    );
  }
  if (isTransactionMethod(operation.method) && call.operation === "policy.resolve") {
    const policy = resultValue as {
      readonly payload: { readonly expiresAt: string };
      readonly policyHash: string;
    };
    if (hashCanonical(policy.payload) !== policy.policyHash) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "execution policy hash does not match its payload",
      );
    }
    const next = advance(checkpoint, {
      state: "planning",
      expiresAt: earliestExpiry(
        checkpoint.payload.expiresAt,
        policy.payload.expiresAt,
      ),
      pendingCalls: [],
      memory: { ...checkpoint.payload.memory, executionPolicy: policy },
      data: { requestHash: checkpoint.payload.memory.requestHash },
    });
    return continueTransition(next);
  }
  if (call.operation !== "accounts.resolve") {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      `unexpected resolving operation: ${call.operation}`,
    );
  }
  const result = resultValue as { readonly accounts: readonly AccountIdentity[] };
  const params = call.params as {
    readonly chainId: string;
    readonly accountIds: readonly string[];
  };
  const byId = new Map(
    result.accounts
      .filter(
        (account) =>
          account.chainId === params.chainId && params.accountIds.includes(account.accountId),
      )
      .map((account) => [account.accountId, account]),
  );
  const accounts = params.accountIds.flatMap((accountId) => {
    const account = byId.get(accountId);
    return account === undefined ? [] : [account];
  });
  if (accounts.length === 0) {
    return operation.method === "tbc_accounts"
      ? completeSuccess(checkpoint, [])
      : completeError(checkpoint, 4100, "The requested account is not available");
  }

  const artifact = Object.freeze({ params: call.params, result });
  const accountResolutions = Object.freeze([
    ...((checkpoint.payload.memory.accountResolutions ?? []) as readonly unknown[]),
    artifact,
  ]);
  const memory = { ...checkpoint.payload.memory, accountResolutions };
  if (isWalletAction(operation.method)) {
    const request = operation.params as { readonly chainId: string; readonly from: string };
    const account = accounts.find(candidate => candidate.chainId === request.chainId && candidate.address === request.from);
    if (account === undefined) throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", "resolved wallet action account differs from request");
    return beginWalletAction(checkpoint, account, memory);
  }

  if (
    operation.method === "tbc_signMessage" ||
    operation.method === "tbc_signTypedData"
  ) {
    const account = accounts.find(
      (candidate) =>
        candidate.chainId === (operation.params as { readonly chainId: string }).chainId &&
        candidate.address === (operation.params as { readonly from: string }).from,
    );
    if (account === undefined) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "resolved message account differs from the request",
      );
    }
    return beginMessageApproval(
      checkpoint,
      account,
      memory,
      legacyBitcoinMessageDigest,
    );
  }

  if (
    operation.method === "tbc_signWorkflow" ||
    operation.method === "tbc_signPreparedWorkflow" ||
    operation.method === "tbc_sendWorkflow" ||
    operation.method === "tbc_sendPreparedWorkflow"
  ) {
    const request = operation.params as {
      readonly chainId: string;
      readonly from: string;
    };
    const account = accounts.find(
      (candidate) =>
        candidate.chainId === request.chainId &&
        candidate.address === request.from,
    );
    if (account === undefined) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "resolved workflow account differs from the request",
      );
    }
    return beginWorkflowResolution(
      checkpoint,
      account,
      memory,
      legacyBitcoinMessageDigest,
    );
  }

  if (isTransactionMethod(operation.method)) {
    const normalized = checkpoint.payload.memory.normalizedTransaction as {
      readonly request: {
        readonly chainId: string;
        readonly from: string;
        readonly intent: { readonly type: string; readonly amount?: string };
        readonly signingRoles?: TransactionRoleRequest["signingRoles"];
      };
    };
    const account = accounts.find(
      (candidate) =>
        candidate.chainId === normalized.request.chainId &&
        candidate.address === normalized.request.from,
    );
    if (account === undefined) {
      throw new TwsEngineError(
        "ENGINE_ARTIFACT_MISMATCH",
        "resolved account differs from the normalized transaction",
      );
    }
    const params = {
      version: "1.0",
      chainId: account.chainId,
      accountId: account.accountId,
      requirement: chainDataRequirement(normalized.request),
      ...(normalized.request.signingRoles === undefined ? {} : (() => {
        const selected = resolveTransactionSigningAccounts(normalized.request, result.accounts);
        return { signingRoles: normalized.request.signingRoles,
          ...(selected.additional.length === 0 ? {} : { signingAccounts: selected.additional }) };
      })()),
    };
    return waitFor(
      checkpoint,
      "chainData.resolve",
      params,
      memory,
      account,
    );
  }

  if (operation.method === "tbc_accounts") {
    return completeSuccess(
      checkpoint,
      accounts.map((account) => account.address),
      memory,
    );
  }
  if (operation.method === "tbc_getAccount") {
    const account = accounts[0];
    return completeSuccess(
      checkpoint,
      { ...account, features: ["tbc:provider"] },
      memory,
    );
  }
  if (operation.method === "tbc_getCapabilities") {
    return completeSuccess(
      checkpoint,
      capabilities(
        checkpoint,
        params.chainId,
        accounts[0]?.accountId,
        capabilityConfiguration,
      ),
      memory,
    );
  }
  throw new Error(`resolving reducer not implemented for ${operation.method}`);
}
