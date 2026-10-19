import type { OperationCheckpoint } from "../checkpoint.js";
import { hashCanonical } from "../hash.js";
import { TwsMethodError } from "../errors.js";
import { assertMethodParams, getTwsMethod } from "../methods.js";
import type { CoreTransition } from "../transitions.js";
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
import { waitingTransition } from "../transitions.js";
import { disabledHistoricalIssuance } from "../issuance-policy.js";

interface PreparedProposal {
  readonly payload: Readonly<{ createdAt: string; expiresAt: string }>;
  readonly proposalHash: string;
}

function preparedProposals(
  methodName: string,
  params: unknown,
): readonly PreparedProposal[] {
  return methodName === "tbc_signPreparedTransaction" ||
      methodName === "tbc_sendPreparedTransaction"
    ? [(params as { readonly proposal: PreparedProposal }).proposal]
    : methodName === "tbc_signPreparedWorkflow" ||
        methodName === "tbc_sendPreparedWorkflow"
      ? (params as {
          readonly steps: readonly Readonly<{
            readonly kind: string;
            readonly proposal?: PreparedProposal;
          }>[];
        }).steps.flatMap((step) =>
          step.kind === "preparedTransaction" && step.proposal !== undefined
            ? [step.proposal]
            : []
        )
      : [];
}

function permissionChains(
  checkpoint: OperationCheckpoint,
  methodName: string,
  params: unknown,
): readonly string[] {
  const session = checkpoint.payload.session as ProviderSessionView;
  if (methodName === "wallet_getPermissions" || methodName === "tbc_disconnect") {
    return TWS_CHAIN_IDS;
  }
  if (methodName === "wallet_requestPermissions") {
    const requested = (params as readonly [Readonly<Record<string, unknown>>])[0];
    const chains = new Set<string>();
    for (const value of Object.values(requested ?? {})) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const chainId of (value as { chains?: unknown }).chains as readonly string[] ?? []) {
          chains.add(chainId);
        }
      }
    }
    return Object.freeze([...chains].sort());
  }
  if (methodName === "tbc_getCapabilities") {
    const requested = params as { readonly chainId?: string };
    return Object.freeze([requested.chainId ?? session.state.activeChainId]);
  }
  if (methodName === "tbc_switchChain") {
    return Object.freeze([
      (params as { readonly chainId: string }).chainId,
    ]);
  }
  return Object.freeze([session.state.activeChainId]);
}

export function reduceValidating(
  checkpoint: OperationCheckpoint,
): CoreTransition {
  const operation = operationOf(checkpoint);
  let definition;
  try {
    definition = getTwsMethod(operation.method);
    assertMethodParams(definition, operation.params);
  } catch (error) {
    if (error instanceof TwsMethodError) {
      return completeError(
        checkpoint,
        error.code === "UNSUPPORTED_METHOD" ? 4200 : -32602,
        error.message,
      );
    }
    throw error;
  }
  const disabledIssuance = disabledHistoricalIssuance(definition.name, operation.params);
  if (disabledIssuance !== undefined) {
    return completeError(checkpoint, 4200, `Historical asset issuance is disabled: ${disabledIssuance}`);
  }
  const proposals = preparedProposals(definition.name, operation.params);
  if (proposals.some(proposal => hashCanonical(proposal.payload) !== proposal.proposalHash)) {
    return completeError(
      checkpoint,
      -32602,
      "Prepared proposal hash does not match its payload",
    );
  }
  if (proposals.some(proposal => Date.parse(proposal.payload.createdAt) > Date.parse(proposal.payload.expiresAt))) {
    return completeError(checkpoint, -32602, "Prepared proposal timestamps are invalid");
  }
  const proposalExpiry = proposals.length === 0 ? undefined
    : earliestExpiry(...proposals.map(proposal => proposal.payload.expiresAt));
  if (proposalExpiry !== undefined && Date.parse(proposalExpiry) <= Date.parse(checkpoint.payload.createdAt!)) {
    return completeError(checkpoint, 4100, "Prepared proposal has expired");
  }

  const session = checkpoint.payload.session as ProviderSessionView;
  if (!session.state.connected) {
    return completeError(checkpoint, 4900, "TBC Provider is disconnected");
  }
  if (definition.path === "session-read") {
    return completeSuccess(checkpoint, session.state.activeChainId);
  }

  const context = checkpoint.payload.context as TrustedContextView;
  const chains = permissionChains(checkpoint, definition.name, operation.params);
  if (chains.some((chainId) => !TWS_CHAIN_IDS.includes(chainId as typeof TWS_CHAIN_IDS[number]))) {
    return completeError(checkpoint, 4901, "The requested TBC chain is not supported");
  }
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(
    checkpoint,
    revision,
    chains.map((chainId) => ({
      operation: "permissionStore.load",
      params: {
        version: "1.0",
        scope: { origin: context.origin, chainId },
      },
    })),
  );
  const next = advance(checkpoint, {
    state: "authorizing",
    ...(proposalExpiry === undefined ? {} : { expiresAt: earliestExpiry(checkpoint.payload.expiresAt, proposalExpiry) }),
    pendingCalls: calls,
    memory: { ...checkpoint.payload.memory, permissionLoads: [] },
    data: { permissionSnapshot: [] },
  });
  return waitingTransition(next);
}
