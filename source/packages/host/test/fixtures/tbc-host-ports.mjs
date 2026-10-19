import { readFile } from "node:fs/promises";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { canonicalize } from "@tbc-wallet/core";

const permissions = JSON.parse(
  await readFile(
    new URL("../../../../test-vectors/permissions.json", import.meta.url),
    "utf8",
  ),
);
const PRIVATE_KEY = "01".padStart(64, "0");

function clone(value) {
  return structuredClone(value);
}

function permissionFor(fixture, context, capability) {
  const chainId = fixture.request.chainId;
  const accountId = `${chainId}:${fixture.request.from}`;
  const base = permissions.result[0];
  return {
    ...clone(base),
    id: `real-host-${capability.replaceAll("_", "-")}-${fixture.requestHash.slice(0, 8)}`,
    parentCapability: capability,
    invoker: context.origin,
    caveats: base.caveats.map((caveat) => {
      if (caveat.type === "restrictChains") return { ...caveat, value: [chainId] };
      if (caveat.type === "restrictAccounts") return { ...caveat, value: [accountId] };
      if (caveat.type === "restrictMethods") return { ...caveat, value: [capability] };
      return clone(caveat);
    }),
  };
}

function signTask(task) {
  return {
    taskId: task.taskId,
    signatureEncoding: "compact64",
    signature: secp256k1
      .sign(task.digest, PRIVATE_KEY, { prehash: false, lowS: true })
      .toCompactHex(),
  };
}

function same(left, right) {
  return canonicalize(left) === canonicalize(right);
}

export function createTbcHostPorts({
  fixture,
  authority: initialAuthority,
  trace,
  approvalId,
  now = "2026-08-31T12:00:10Z",
}) {
  let authority = clone(initialAuthority);
  const journal = new Map();
  const calls = [];
  const attemptsByOperation = new Map();
  const effectsByOperation = new Map();
  let approvedBindingHash;

  const increment = (map, operation) => {
    map.set(operation, (map.get(operation) ?? 0) + 1);
  };

  const resultFor = (call) => {
    switch (call.operation) {
      case "clock.now":
        return { now };
      case "permissionStore.load":
        return {
          revision: "0",
          permissions: [
            permissionFor(fixture, authority.currentContext, "tbc_accounts"),
            permissionFor(
              fixture,
              authority.currentContext,
              "tbc_sendTransaction",
            ),
          ],
        };
      case "permissionStore.commit":
        return {
          revisions: call.params.changes.map(({ scope, expectedRevision }) => ({
            scope,
            revision: String(BigInt(expectedRevision) + 1n),
          })),
        };
      case "accounts.resolve":
        return { accounts: [clone(fixture.snapshot.payload.account)] };
      case "chainData.resolve":
        return clone(fixture.snapshot);
      case "policy.resolve":
        return clone(fixture.policy);
      case "approval.request":
        approvedBindingHash = call.params.binding.bindingHash;
        return {
          status: "approved",
          approvalId,
          approvalToken: `token-${approvalId}`,
          bindingHash: approvedBindingHash,
          approvedAt: now,
          expiresAt: call.params.binding.payload.expiresAt,
        };
      case "signer.sign":
        if (
          approvedBindingHash === undefined ||
          call.params.approval.bindingHash !== approvedBindingHash
        ) {
          throw new Error("signer received no matching approval binding");
        }
        return signTask(call.params.task);
      case "broadcast.submit":
        return {
          txid: call.params.transaction.txid,
          status: "accepted",
        };
      case "broadcast.reconcile":
        return {
          txid: call.params.txid,
          status: "accepted",
        };
      case "entropy.randomBytes":
        return { bytes: "AAECAwQFBgcICQoLDA0ODw" };
      default:
        throw new Error(`unsupported real Host Port operation: ${call.operation}`);
    }
  };

  const invoke = async (call) => {
    increment(attemptsByOperation, call.operation);
    calls.push(clone(call));
    if (call.operation === "approval.request") {
      trace.push(`approval.binding:${call.params.binding.bindingHash}`);
    }
    trace.push(`port.${call.operation}`);
    const existing = journal.get(call.callId);
    const identity = { operation: call.operation, params: call.params };
    if (existing !== undefined) {
      if (!same(existing.identity, identity)) {
        throw new Error("real Host Port callId collision");
      }
      return clone(existing.result);
    }
    const result = resultFor(call);
    increment(effectsByOperation, call.operation);
    journal.set(call.callId, { identity: clone(identity), result: clone(result) });
    return clone(result);
  };

  const ports = Object.freeze({
    accounts: invoke,
    chainData: invoke,
    policy: invoke,
    permissionStore: invoke,
    approval: invoke,
    signer: invoke,
    broadcast: invoke,
    clock: invoke,
    entropy: invoke,
  });

  const authoritySource = Object.freeze({
    read: async () => clone(authority),
    compareAndSwapSession: async (input) => {
      if (!same(input.expected, authority)) {
        throw new Error("real Host Authority compare-and-swap is stale");
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
  });

  return Object.freeze({
    ports,
    authority: authoritySource,
    calls,
    snapshotHash: fixture.snapshot.snapshotHash,
    policyHash: fixture.policy.policyHash,
    attempts: (operation) => attemptsByOperation.get(operation) ?? 0,
    effects: (operation) => effectsByOperation.get(operation) ?? 0,
  });
}
