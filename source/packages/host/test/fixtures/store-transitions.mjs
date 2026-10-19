import { readFile } from "node:fs/promises";
import * as tws from "@tbc-wallet/core";

const provider = JSON.parse(
  await readFile(
    new URL("../../../../test-vectors/provider.json", import.meta.url),
    "utf8",
  ),
);

const context = provider.trustedContexts[0].context;
const session = provider.providerSessions.sessionA;
const testnet = "tbc:testnet";
const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";

function switchPermission(chainId) {
  return {
    id: `switch-${chainId.slice(-8)}`,
    parentCapability: "tbc_switchChain",
    invoker: context.origin,
    date: Date.parse("2026-08-31T11:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [chainId] },
      { type: "restrictAccounts", value: [`${chainId}:${address}`] },
      { type: "restrictMethods", value: ["tbc_switchChain"] },
    ],
  };
}

function responseFor(call, clocks) {
  if (call.operation === "clock.now") return { now: clocks.shift() };
  if (call.operation === "permissionStore.load") {
    return { revision: "0", permissions: [switchPermission(testnet)] };
  }
  if (call.operation === "approval.request") {
    return {
      status: "approved",
      approvalId: "host-store-approval-1",
      approvalToken: "host-store-approval-token-1",
      bindingHash: call.params.binding.bindingHash,
      approvedAt: "2026-08-31T12:00:10Z",
      expiresAt: call.params.binding.payload.expiresAt,
    };
  }
  throw new Error(`unexpected store fixture operation: ${call.operation}`);
}

export async function createStoreTransitionFlow(id = "host-store-flow-1") {
  const core = tws.createTwsCore();
  const clocks = [
    "2026-08-31T12:00:00Z",
    "2026-08-31T12:00:05Z",
    "2026-08-31T12:00:11Z",
  ];
  const transitions = [];
  let transition = await core.start({
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id,
      method: "tbc_switchChain",
      params: { chainId: testnet },
    },
    currentContext: context,
    currentSession: session,
  });

  for (let steps = 0; steps < 24; steps += 1) {
    transitions.push(structuredClone(transition));
    if (transition.kind === "commit") break;
    if (transition.kind === "continue") {
      transition = await core.resume({
        version: "1.0",
        checkpoint: transition.checkpoint,
        currentContext: context,
        currentSession: session,
      });
      continue;
    }
    if (transition.kind !== "waiting") {
      throw new Error(`unexpected store fixture transition: ${transition.kind}`);
    }
    const call = transition.calls[0];
    transition = await core.resume({
      version: "1.0",
      checkpoint: transition.checkpoint,
      response: {
        version: "1.0",
        callId: call.callId,
        result: responseFor(call, clocks),
      },
      currentContext: context,
      currentSession: session,
    });
  }

  if (transition.kind !== "commit") {
    throw new Error("store fixture did not reach a Provider Session commit");
  }
  const mutation = transition.mutation;
  const acknowledgment = {
    version: "1.0",
    commitId: mutation.commitId,
    status: "committed",
    revision: mutation.payload.target.revision,
  };
  const authority = {
    currentContext: structuredClone(context),
    currentSession: {
      ...structuredClone(session),
      state: structuredClone(mutation.payload.target),
    },
  };
  const complete = await core.acknowledgeCommit({
    version: "1.0",
    checkpoint: transition.checkpoint,
    acknowledgment,
    ...authority,
  });
  transitions.push(structuredClone(complete));

  return Object.freeze({
    transitions: Object.freeze(transitions),
    operationId: transition.checkpoint.payload.operationId,
    releaseFingerprint: transition.checkpoint.payload.releaseFingerprint,
    mutation: structuredClone(mutation),
    acknowledgment: structuredClone(acknowledgment),
    authority: structuredClone(authority),
  });
}

export async function createCancelledTransitionFlow(
  id = "host-store-cancelled-flow-1",
) {
  const core = tws.createTwsCore();
  const initial = await core.start({
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id,
      method: "tbc_switchChain",
      params: { chainId: testnet },
    },
    currentContext: context,
    currentSession: session,
  });
  const cancelled = await core.cancel({
    version: "1.0",
    checkpoint: initial.checkpoint,
    reason: "REQUEST_ABORTED",
  });
  return Object.freeze({
    initial: structuredClone(initial),
    cancelled: structuredClone(cancelled),
    authority: {
      currentContext: structuredClone(context),
      currentSession: structuredClone(session),
    },
  });
}
