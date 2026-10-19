import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
// Optional exact installed Kit wallet entry for focused packaging parity checks.
const tws = await import(process.env.TBC_PERMISSION_CORE_MODULE ?? "../dist/esm/index.js");

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
const firstAddress = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const secondAddress = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
const publicKey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const sortedChains = [mainnet, testnet].sort();

function account(chainId, address) {
  return { address, accountId: `${chainId}:${address}`, chainId, publicKey };
}

function existingPermission(chainId) {
  return {
    id: `existing-sign-message-${chainId.slice(-8)}`,
    parentCapability: "tbc_signMessage",
    invoker: context.origin,
    date: Date.parse("2026-08-31T11:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [chainId] },
      { type: "restrictAccounts", value: [`${chainId}:${firstAddress}`] },
      { type: "restrictMethods", value: ["tbc_signMessage"] },
    ],
  };
}

function startInput(method, params = []) {
  return {
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: { jsonrpc: "2.0", id: `permissions-${method}`, method, params },
    currentContext: context,
    currentSession: session,
  };
}

function permissionRequest() {
  return [{
    tbc_accounts: { chains: [mainnet, testnet], maxAccounts: 1 },
    tbc_signTransaction: { chains: [mainnet, testnet] },
  }];
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

async function drive(method, params, options = {}) {
  const core = tws.createTwsCore();
  const ports = [];
  const checkpoints = [];
  const clocks = [
    "2026-08-31T12:00:00Z",
    "2026-08-31T12:00:05Z",
    options.commitClock ?? "2026-08-31T12:00:11Z",
  ];
  let transition = await core.start(startInput(method, params));
  for (let steps = 0; transition.kind !== "complete"; steps += 1) {
    assert.ok(steps < 30, "permission lifecycle did not terminate");
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
      const chainId = call.params.scope.chainId;
      result = {
        revision: chainId === mainnet ? "2" : "5",
        permissions: options.emptyLoads ? [] : [existingPermission(chainId)],
      };
    } else if (call.operation === "accounts.resolve") {
      result = {
        accounts: [
          account(call.params.chainId, firstAddress),
          account(call.params.chainId, secondAddress),
        ],
      };
    } else if (call.operation === "approval.request") {
      result = options.reject
        ? {
            status: "rejected",
            bindingHash: call.params.binding.bindingHash,
            rejectedAt: "2026-08-31T12:00:10Z",
          }
        : {
            status: "approved",
            approvalId: "permission-approval-1",
            approvalToken: "permission-approval-token-1",
            bindingHash: call.params.binding.bindingHash,
            approvedAt: "2026-08-31T12:00:10Z",
            expiresAt: call.params.binding.payload.expiresAt,
          };
    } else if (call.operation === "permissionStore.commit") {
      if (options.commitConflict) {
        result = {
          portError: {
            name: "CONFLICT",
            message: "Permission revision changed",
            retryable: true,
          },
        };
      } else {
        result = {
          revisions: call.params.changes.map(({ scope, expectedRevision }) => ({
            scope,
            revision: options.commitMismatch
              ? expectedRevision
              : String(BigInt(expectedRevision) + 1n),
          })),
        };
      }
    } else {
      throw new Error(`unexpected operation ${call.operation}`);
    }
    const checkpoint =
      options.tamperCheckpoint?.(transition.checkpoint, call) ??
      transition.checkpoint;
    transition = await core.resume({
      version: "1.0",
      checkpoint,
      response: {
        version: "1.0",
        callId: call.callId,
        ...(result.portError === undefined
          ? { result }
          : { error: result.portError }),
      },
      currentContext: context,
      currentSession: session,
    });
  }
  checkpoints.push(transition.checkpoint);
  return { transition, ports, checkpoints };
}

test("wallet_requestPermissions safely narrows and atomically commits exact multi-chain grants", async () => {
  const result = await drive("wallet_requestPermissions", permissionRequest());
  assertRuntimeClosure(result.checkpoints);
  const proposalCheckpoint = result.checkpoints.find(
    ({ payload }) => payload.memory.permissionProposal !== undefined,
  );
  assert.ok(proposalCheckpoint);
  const proposal = proposalCheckpoint.payload.memory.permissionProposal;
  assert.equal(
    proposal.permissionProposalHash,
    tws.hashCanonical(proposal.payload),
  );
  assert.deepEqual(
    proposal.payload.changes.map(({ scope }) => scope.chainId),
    sortedChains,
  );
  assert.deepEqual(proposal.payload.decisions, [
    {
      capability: "tbc_accounts",
      status: "narrowed",
      reason: "ONE_ACCOUNT_PER_CHAIN",
    },
    {
      capability: "tbc_signTransaction",
      status: "narrowed",
      reason: "ONE_ACCOUNT_PER_CHAIN",
    },
  ]);

  const commit = result.ports.find(
    ({ operation }) => operation === "permissionStore.commit",
  );
  assert.ok(commit);
  const approvalIndex = result.ports.findIndex(
    ({ operation }) => operation === "approval.request",
  );
  assert.deepEqual(
    result.ports.slice(approvalIndex).map(({ operation }) => operation),
    ["approval.request", "clock.now", "permissionStore.commit"],
  );
  assert.equal(
    result.checkpoints.some(
      ({ payload }) =>
        payload.state === "resolving" && payload.pendingCalls.length === 0,
    ),
    false,
  );
  const commitClock = result.checkpoints.find(
    ({ payload }) =>
      payload.state === "committing" &&
      payload.pendingCalls[0]?.operation === "clock.now",
  );
  assert.ok(commitClock);
  assert.equal(commitClock.payload.memory.permissionCommit !== undefined, true);
  assert.equal(
    result.checkpoints.some(
      ({ payload }) =>
        payload.state === "approval" &&
        payload.memory.permissionCommit !== undefined,
    ),
    false,
  );
  assert.deepEqual(
    commit.params.changes.map(({ expectedRevision }) => expectedRevision),
    ["2", "5"],
  );
  for (const [chainOrdinal, change] of commit.params.changes.entries()) {
    const chainId = sortedChains[chainOrdinal];
    assert.equal(
      change.permissions.some(({ id }) => id === existingPermission(chainId).id),
      true,
    );
    for (const [capabilityOrdinal, capability] of [
      "tbc_accounts",
      "tbc_signTransaction",
    ].entries()) {
      const permission = change.permissions.find(
        (candidate) => candidate.parentCapability === capability,
      );
      assert.equal(
        permission.id,
        tws.derivePermissionId({
          operationId: result.transition.checkpoint.payload.operationId,
          chainId,
          parentCapability: capability,
          ordinal: capabilityOrdinal,
        }),
      );
      assert.deepEqual(permission.caveats[0].value, [chainId]);
      assert.deepEqual(permission.caveats[1].value, [`${chainId}:${firstAddress}`]);
    }
  }
  assert.equal(result.transition.checkpoint.payload.state, "completed");
  assert.equal(result.transition.completion.response.result.length, 4);
});

test("tbc_requestAccounts uses the current chain and returns only approved addresses", async () => {
  const result = await drive("tbc_requestAccounts", [], { emptyLoads: true });
  assert.deepEqual(result.transition.completion.response.result, [firstAddress]);
  assert.deepEqual(
    result.ports
      .filter(({ operation }) => operation === "permissionStore.load")
      .map(({ params }) => params.scope.chainId),
    [mainnet],
  );
});

test("explicit multi-account consent grants both role accounts without broadening other chains or capabilities", async () => {
  const params = [{
    tbc_accounts: { chains: [testnet], maxAccounts: 2 },
    tbc_sendTransaction: { chains: [testnet] },
    tbc_signTransaction: { chains: [mainnet] },
  }];
  const result = await drive("wallet_requestPermissions", params);
  const approval = result.ports.find(p => p.operation === "approval.request");
  const commit = result.ports.find(p => p.operation === "permissionStore.commit");
  assert.ok(approval); assert.ok(commit);
  for (const change of commit.params.changes) {
    for (const grant of change.permissions.filter(p => p.parentCapability !== "tbc_signMessage")) {
      assert.deepEqual(grant.caveats.find(c => c.type === "restrictAccounts").value,
        (change.scope.chainId === testnet ? [firstAddress, secondAddress] : [firstAddress]).map(a => `${change.scope.chainId}:${a}`));
    }
    assert.deepEqual(change.permissions.find(p => p.parentCapability === "tbc_signMessage").caveats,
      existingPermission(change.scope.chainId).caveats, "Unrequested permission must not inherit second account");
  }
  assert.equal(result.ports.filter(p => p.operation === "accounts.resolve").length, 2);
  assert.equal(result.ports.filter(p => p.operation === "approval.request").length, 1);
  const rejected = await drive("wallet_requestPermissions", params, { reject: true });
  assert.equal(rejected.ports.some(p => p.operation === "permissionStore.commit"), false);
});

test("omitted account count remains single-account and explicit maximum never adds unknown accounts", async () => {
  for (const maxAccounts of [undefined, 1, 2, 16]) {
    const result = await drive("wallet_requestPermissions", [{
      tbc_accounts: { chains: [testnet], ...(maxAccounts === undefined ? {} : { maxAccounts }) },
      tbc_sendTransaction: { chains: [testnet] },
    }]);
    const change = result.ports.find(p => p.operation === "permissionStore.commit").params.changes[0];
    const expected = (maxAccounts > 1 ? [firstAddress, secondAddress] : [firstAddress]).map(a => `${testnet}:${a}`);
    for (const permission of change.permissions.filter(p => p.parentCapability !== "tbc_signMessage"))
      assert.deepEqual(permission.caveats.find(c => c.type === "restrictAccounts").value, expected);
  }
});

test("permission rejection and atomic CAS conflict fail without a second commit", async () => {
  const rejected = await drive(
    "wallet_requestPermissions",
    permissionRequest(),
    { reject: true },
  );
  assert.equal(rejected.transition.checkpoint.payload.state, "rejected");
  assert.equal(
    rejected.ports.some(({ operation }) => operation === "permissionStore.commit"),
    false,
  );

  const conflict = await drive(
    "wallet_requestPermissions",
    permissionRequest(),
    { commitConflict: true },
  );
  assert.equal(conflict.transition.checkpoint.payload.state, "failed");
  assert.equal(
    conflict.ports.filter(({ operation }) => operation === "permissionStore.commit").length,
    1,
  );
});

test("permission commit rejects expiry and a mismatched CAS result", async () => {
  await assert.rejects(
    drive("wallet_requestPermissions", permissionRequest(), {
      commitClock: "2026-08-31T12:02:00Z",
    }),
    (error) =>
      error instanceof tws.TwsApprovalError && error.code === "RECEIPT_EXPIRED",
  );
  await assert.rejects(
    drive("wallet_requestPermissions", permissionRequest(), {
      commitMismatch: true,
    }),
    (error) =>
      error instanceof tws.TwsStateError && error.code === "PORT_RESULT_INVALID",
  );
});

test("permission commit rebinds both the Proposal and derived effect before Clock", async () => {
  await assert.rejects(
    drive("wallet_requestPermissions", permissionRequest(), {
      tamperCheckpoint(checkpoint, call) {
        if (
          checkpoint.payload.state !== "committing" ||
          call.operation !== "clock.now"
        ) return checkpoint;
        const tampered = structuredClone(checkpoint);
        tampered.payload.memory.permissionProposal.payload.changes[0]
          .expectedRevision = "99";
        tampered.payload.memory.permissionProposal.permissionProposalHash =
          tws.hashCanonical(
            tampered.payload.memory.permissionProposal.payload,
          );
        tampered.checkpointHash = tws.hashCanonical(tampered.payload);
        return tampered;
      },
    }),
    (error) =>
      error instanceof tws.TwsEngineError &&
      error.code === "ENGINE_ARTIFACT_MISMATCH",
  );

  await assert.rejects(
    drive("wallet_requestPermissions", permissionRequest(), {
      tamperCheckpoint(checkpoint, call) {
        if (
          checkpoint.payload.state !== "committing" ||
          call.operation !== "clock.now"
        ) return checkpoint;
        const tampered = structuredClone(checkpoint);
        tampered.payload.memory.permissionCommit.params.changes[0]
          .expectedRevision = "99";
        tampered.payload.data.permissionCommit = structuredClone(
          tampered.payload.memory.permissionCommit,
        );
        tampered.checkpointHash = tws.hashCanonical(tampered.payload);
        return tampered;
      },
    }),
    (error) =>
      error instanceof tws.TwsEngineError &&
      error.code === "ENGINE_ARTIFACT_MISMATCH",
  );

  await assert.rejects(
    drive("wallet_requestPermissions", permissionRequest(), {
      tamperCheckpoint(checkpoint, call) {
        if (
          checkpoint.payload.state !== "committing" ||
          call.operation !== "clock.now"
        ) return checkpoint;
        const tampered = structuredClone(checkpoint);
        tampered.payload.memory.approvalBinding.payload.operationHash =
          "a".repeat(64);
        tampered.payload.memory.approvalBinding.bindingHash = tws.hashCanonical(
          tampered.payload.memory.approvalBinding.payload,
        );
        tampered.checkpointHash = tws.hashCanonical(tampered.payload);
        return tampered;
      },
    }),
    (error) =>
      error instanceof tws.TwsApprovalError &&
      error.code === "BINDING_EXPECTATION_MISMATCH",
  );
});

test("tbc_disconnect revokes only the current Origin through one atomic batch", async () => {
  const result = await drive("tbc_disconnect", []);
  const commit = result.ports.find(
    ({ operation }) => operation === "permissionStore.commit",
  );
  assert.ok(commit);
  const commitIndex = result.ports.findIndex(
    ({ operation }) => operation === "permissionStore.commit",
  );
  assert.equal(result.ports[commitIndex - 1]?.operation, "clock.now");
  assert.deepEqual(
    commit.params.changes.map(({ scope, permissions }) => ({ scope, permissions })),
    sortedChains.map((chainId) => ({
      scope: { origin: context.origin, chainId },
      permissions: [],
    })),
  );
  assert.equal(result.transition.completion.response.result, null);
  assert.deepEqual(result.transition.completion.events, [
    { name: "permissionsChanged", payload: [] },
    { name: "accountsChanged", payload: [] },
  ]);
  assert.equal(
    result.transition.completion.events.some(({ name }) => name === "disconnect"),
    false,
  );
});
