import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as tws from "../dist/esm/index.js";

const provider = JSON.parse(
  await readFile(new URL("../../../test-vectors/provider.json", import.meta.url), "utf8"),
);
const statePolicies = new Map(
  JSON.parse(
    await readFile(
      new URL("../../../registry/operation-states.json", import.meta.url),
      "utf8",
    ),
  ).states.map((state) => [state.name, state]),
);
const context = provider.trustedContexts[0].context;
const session = provider.providerSessions.sessionA;
const mainnet = "tbc:mainnet";
const testnet = "tbc:testnet";
const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const secondAddress = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";

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

function startInput(chainId, id = "switch-request-1") {
  return {
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id,
      method: "tbc_switchChain",
      params: { chainId },
    },
    currentContext: context,
    currentSession: session,
  };
}

async function driveToCommit(chainId, options = {}) {
  const core = tws.createTwsCore();
  const ports = [];
  const checkpoints = [];
  const clocks = [
    "2026-08-31T12:00:00Z",
    "2026-08-31T12:00:05Z",
    "2026-08-31T12:00:11Z",
  ];
  let transition = await core.start(startInput(chainId));
  for (let steps = 0; steps < 20 && transition.kind !== "commit" && transition.kind !== "complete"; steps += 1) {
    checkpoints.push(transition.checkpoint);
    if (transition.kind === "continue") {
      transition = await core.resume({
        version: "1.0",
        checkpoint: transition.checkpoint,
        currentContext: context,
        currentSession: session,
      });
      continue;
    }
    assert.equal(transition.kind, "waiting");
    const call = transition.calls[0];
    ports.push(structuredClone(call));
    let result;
    if (call.operation === "clock.now") {
      result = { now: clocks.shift() };
    } else if (call.operation === "permissionStore.load") {
      result = {
        revision: "0",
        permissions: options.permissions ?? [switchPermission(chainId)],
      };
    } else if (call.operation === "approval.request") {
      result = {
        status: "approved",
        approvalId: "switch-approval-1",
        approvalToken: "switch-approval-token-1",
        bindingHash: call.params.binding.bindingHash,
        approvedAt: "2026-08-31T12:00:10Z",
        expiresAt: call.params.binding.payload.expiresAt,
      };
    } else {
      throw new Error(`unexpected operation ${call.operation}`);
    }
    const checkpoint =
      options.tamperCheckpoint?.(transition.checkpoint, call) ??
      transition.checkpoint;
    transition = await core.resume({
      version: "1.0",
      checkpoint,
      response: { version: "1.0", callId: call.callId, result },
      currentContext: context,
      currentSession: session,
    });
  }
  checkpoints.push(transition.checkpoint);
  return { core, transition, ports, checkpoints };
}

function assertRuntimeClosure(checkpoints) {
  for (const checkpoint of checkpoints) {
    const policy = statePolicies.get(checkpoint.payload.state);
    assert.ok(policy, `missing policy for ${checkpoint.payload.state}`);
    for (const field of Object.keys(checkpoint.payload.memory)) {
      assert.ok(
        policy.memoryAllowed.includes(field),
        `${checkpoint.payload.state} cannot carry ${field}`,
      );
    }
    for (const operation of checkpoint.payload.pendingCalls.map(
      (call) => call.operation,
    )) {
      assert.ok(
        policy.allowedPortOperations.includes(operation),
        `${checkpoint.payload.state} cannot issue ${operation}`,
      );
    }
  }
}

test("a real chain switch binds one proposal and yields a replayable Provider Session commit", async () => {
  const result = await driveToCommit(testnet);
  assertRuntimeClosure(result.checkpoints);
  assert.equal(result.transition.kind, "commit");
  const proposal = result.transition.checkpoint.payload.memory.chainSwitchProposal;
  assert.equal(
    proposal.chainSwitchProposalHash,
    tws.hashCanonical(proposal.payload),
  );
  assert.deepEqual(proposal.payload, {
    version: "1.0",
    fromChainId: mainnet,
    toChainId: testnet,
    expectedSessionRevision: "0",
    expiresAt: "2026-08-31T12:02:00.000Z",
  });

  const mutation = result.transition.mutation;
  const approvalIndex = result.ports.findIndex(
    ({ operation }) => operation === "approval.request",
  );
  assert.deepEqual(
    result.ports.slice(approvalIndex).map(({ operation }) => operation),
    ["approval.request", "clock.now"],
  );
  assert.equal(result.transition.checkpoint.payload.state, "committing");
  assert.equal(
    result.transition.checkpoint.payload.memory.providerSessionMutation !== undefined,
    true,
  );
  assert.deepEqual(mutation.payload.target, {
    ...session.state,
    revision: "1",
    activeChainId: testnet,
    activeAccountIds: [`${testnet}:${address}`],
  });
  assert.deepEqual(mutation.payload.events, [
    { name: "chainChanged", payload: testnet },
  ]);
  assert.equal(
    mutation.commitId,
    tws.deriveProviderCommitId({
      operationId: result.transition.checkpoint.payload.operationId,
      checkpointRevision: result.transition.checkpoint.payload.revision,
      mutationPayload: mutation.payload,
    }),
  );

  const currentSession = {
    ...session,
    state: structuredClone(mutation.payload.target),
  };
  const acknowledgment = {
    version: "1.0",
    commitId: mutation.commitId,
    status: "committed",
    revision: mutation.payload.target.revision,
  };
  const first = await result.core.acknowledgeCommit({
    version: "1.0",
    checkpoint: result.transition.checkpoint,
    acknowledgment,
    currentContext: context,
    currentSession,
  });
  const replay = await result.core.acknowledgeCommit({
    version: "1.0",
    checkpoint: result.transition.checkpoint,
    acknowledgment,
    currentContext: context,
    currentSession,
  });
  assert.deepEqual(replay, first);
  assert.deepEqual(first.completion.response.result, null);
  assert.deepEqual(first.completion.events, mutation.payload.events);
});

test("chain switch excludes wrong-origin and expired accounts from the Session target", async () => {
  const wrongOrigin = {
    ...switchPermission(testnet),
    id: "switch-wrong-origin",
    invoker: "https://attacker.example",
    caveats: [
      { type: "restrictChains", value: [testnet] },
      { type: "restrictAccounts", value: [`${testnet}:${secondAddress}`] },
      { type: "restrictMethods", value: ["tbc_switchChain"] },
    ],
  };
  const expired = {
    ...switchPermission(testnet),
    id: "switch-expired",
    caveats: [
      { type: "restrictChains", value: [testnet] },
      { type: "restrictAccounts", value: [`${testnet}:${secondAddress}`] },
      { type: "restrictMethods", value: ["tbc_switchChain"] },
      { type: "expiresAt", value: "2026-08-31T11:59:59Z" },
    ],
  };
  const result = await driveToCommit(testnet, {
    permissions: [switchPermission(testnet), wrongOrigin, expired],
  });
  assert.deepEqual(result.transition.mutation.payload.target.activeAccountIds, [
    `${testnet}:${address}`,
  ]);
});

test("Provider Session commit rejects a wrong acknowledgment or target state", async () => {
  const result = await driveToCommit(testnet);
  const mutation = result.transition.mutation;
  const currentSession = {
    ...session,
    state: structuredClone(mutation.payload.target),
  };
  await assert.rejects(
    result.core.acknowledgeCommit({
      version: "1.0",
      checkpoint: result.transition.checkpoint,
      acknowledgment: {
        version: "1.0",
        commitId: mutation.commitId.replace(/^./, "A"),
        status: "committed",
        revision: "1",
      },
      currentContext: context,
      currentSession,
    }),
    (error) =>
      error instanceof tws.TwsAuthorityError && error.code === "COMMIT_ACK_MISMATCH",
  );
  await assert.rejects(
    result.core.acknowledgeCommit({
      version: "1.0",
      checkpoint: result.transition.checkpoint,
      acknowledgment: {
        version: "1.0",
        commitId: mutation.commitId,
        status: "committed",
        revision: "1",
      },
      currentContext: context,
      currentSession: session,
    }),
    (error) =>
      error instanceof tws.TwsAuthorityError &&
      error.code === "COMMIT_AUTHORITY_MISMATCH",
  );
});

test("Provider Session commit rebinds proposal, mutation target, and commitId", async () => {
  await assert.rejects(
    driveToCommit(testnet, {
      tamperCheckpoint(checkpoint, call) {
        if (
          checkpoint.payload.state !== "committing" ||
          call.operation !== "clock.now"
        ) return checkpoint;
        const tampered = structuredClone(checkpoint);
        const mutation = tampered.payload.memory.providerSessionMutation;
        mutation.payload.target.activeAccountIds = [`${testnet}:${secondAddress}`];
        mutation.commitId = tws.deriveProviderCommitId({
          operationId: tampered.payload.operationId,
          checkpointRevision: String(BigInt(tampered.payload.revision) + 1n),
          mutationPayload: mutation.payload,
        });
        tampered.payload.data.providerSessionMutation = structuredClone(mutation);
        tampered.checkpointHash = tws.hashCanonical(tampered.payload);
        return tampered;
      },
    }),
    (error) =>
      error instanceof tws.TwsEngineError &&
      error.code === "ENGINE_ARTIFACT_MISMATCH",
  );

  const result = await driveToCommit(testnet);
  const tampered = structuredClone(result.transition.checkpoint);
  tampered.payload.memory.providerSessionMutation.commitId =
    tampered.payload.memory.providerSessionMutation.commitId.replace(/^./, "A");
  tampered.payload.data.providerSessionMutation = structuredClone(
    tampered.payload.memory.providerSessionMutation,
  );
  tampered.checkpointHash = tws.hashCanonical(tampered.payload);
  const mutation = result.transition.mutation;
  await assert.rejects(
    result.core.acknowledgeCommit({
      version: "1.0",
      checkpoint: tampered,
      acknowledgment: {
        version: "1.0",
        commitId: tampered.payload.memory.providerSessionMutation.commitId,
        status: "committed",
        revision: mutation.payload.target.revision,
      },
      currentContext: context,
      currentSession: {
        ...session,
        state: structuredClone(mutation.payload.target),
      },
    }),
    (error) =>
      error instanceof tws.TwsEngineError &&
      error.code === "ENGINE_ARTIFACT_MISMATCH",
  );
});

test("switching to the active chain is a no-op without approval, commit, or event", async () => {
  const result = await driveToCommit(mainnet);
  assert.equal(result.transition.kind, "complete");
  assert.equal(result.transition.completion.response.result, null);
  assert.deepEqual(result.transition.completion.events, []);
  assert.equal(
    result.ports.some(({ operation }) => operation === "approval.request"),
    false,
  );
});
