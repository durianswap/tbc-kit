import { readFile } from "node:fs/promises";
import * as tws from "@tbc-wallet/core";
import { createTbcTransferEngine } from "../../../core/test/fixtures/tbc-transfer-engine.mjs";

const integration = JSON.parse(
  await readFile(
    new URL("../../../../test-vectors/integration.json", import.meta.url),
    "utf8",
  ),
);
const permissions = JSON.parse(
  await readFile(
    new URL("../../../../test-vectors/permissions.json", import.meta.url),
    "utf8",
  ),
);
const provider = JSON.parse(
  await readFile(
    new URL("../../../../test-vectors/provider.json", import.meta.url),
    "utf8",
  ),
);
const signing = JSON.parse(
  await readFile(
    new URL("../../../../test-vectors/signing.json", import.meta.url),
    "utf8",
  ),
);

const canonical = integration.canonicalTransfer;
const baseContext = provider.trustedContexts[0].context;
const session = provider.providerSessions.sessionA;
const mainnet = "tbc:mainnet";
const testnet = "tbc:testnet";
const firstAddress = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const secondAddress = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
const publicKey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

function clone(value) {
  return structuredClone(value);
}

function response(call, outcome) {
  return {
    version: "1.0",
    callId: call.callId,
    ...(outcome.portError === undefined
      ? { result: outcome }
      : { error: outcome.portError }),
  };
}

async function captureScenario({ createCore, startInput, authority, resultForCall }) {
  const core = createCore();
  const transitions = [];
  let transition = await core.start({ ...clone(startInput), ...clone(authority) });
  for (let steps = 0; steps < 80; steps += 1) {
    transitions.push(clone(transition));
    if (transition.kind === "complete") {
      return Object.freeze({
        createCore,
        startInput: clone(startInput),
        authority: clone(authority),
        resultForCall,
        transitions: Object.freeze(transitions),
      });
    }
    if (transition.kind === "commit") {
      throw new Error("Port crash scenario unexpectedly requires an authority commit");
    }
    if (transition.kind === "continue") {
      transition = await core.resume({
        version: "1.0",
        checkpoint: transition.checkpoint,
        ...clone(authority),
      });
      continue;
    }
    const call = transition.calls[0];
    const outcome = resultForCall(call);
    transition = await core.resume({
      version: "1.0",
      checkpoint: transition.checkpoint,
      response: response(call, outcome),
      ...clone(authority),
    });
  }
  throw new Error("Port crash scenario exceeded its transition bound");
}

function transactionPermission(capability) {
  const base = permissions.result[0];
  const accountId = `${canonical.request.chainId}:${canonical.request.from}`;
  return {
    ...clone(base),
    id: `crash-${capability.replaceAll("_", "-")}`,
    parentCapability: capability,
    caveats: base.caveats.map((caveat) => {
      if (caveat.type === "restrictChains") {
        return { ...caveat, value: [canonical.request.chainId] };
      }
      if (caveat.type === "restrictAccounts") {
        return { ...caveat, value: [accountId] };
      }
      if (caveat.type === "restrictMethods") {
        return { ...caveat, value: [capability] };
      }
      return caveat;
    }),
  };
}

function transactionResult(call) {
  switch (call.operation) {
    case "clock.now":
      return { now: "2026-08-31T12:00:30Z" };
    case "permissionStore.load":
      return {
        revision: "0",
        permissions: [
          transactionPermission("tbc_accounts"),
          transactionPermission("tbc_sendTransaction"),
        ],
      };
    case "accounts.resolve":
      return clone(integration.portData.accountsResult);
    case "chainData.resolve":
      return clone(canonical.snapshot);
    case "policy.resolve":
      return clone(canonical.policy);
    case "approval.request":
      return {
        ...clone(canonical.approval),
        bindingHash: call.params.binding.bindingHash,
        approvedAt: "2026-08-31T12:00:30Z",
      };
    case "signer.sign":
      return clone(canonical.signature);
    case "broadcast.submit":
      return {
        portError: {
          name: "UNAVAILABLE",
          message: "The deterministic test submission outcome is unknown.",
          retryable: true,
        },
      };
    case "broadcast.reconcile":
      return clone(integration.portData.broadcastReconcileResult);
    default:
      throw new Error(`unexpected transaction scenario Port: ${call.operation}`);
  }
}

function account(chainId, address) {
  return {
    address,
    accountId: `${chainId}:${address}`,
    chainId,
    publicKey,
  };
}

function existingPermission(chainId) {
  return {
    id: `existing-sign-message-${chainId.slice(-8)}`,
    parentCapability: "tbc_signMessage",
    invoker: baseContext.origin,
    date: Date.parse("2026-08-31T11:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [chainId] },
      { type: "restrictAccounts", value: [`${chainId}:${firstAddress}`] },
      { type: "restrictMethods", value: ["tbc_signMessage"] },
    ],
  };
}

function permissionResult(call) {
  switch (call.operation) {
    case "clock.now":
      return { now: "2026-08-31T12:00:30Z" };
    case "permissionStore.load":
      return {
        revision: call.params.scope.chainId === mainnet ? "2" : "5",
        permissions: [existingPermission(call.params.scope.chainId)],
      };
    case "accounts.resolve":
      return {
        accounts: [
          account(call.params.chainId, firstAddress),
          account(call.params.chainId, secondAddress),
        ],
      };
    case "approval.request":
      return {
        status: "approved",
        approvalId: "crash-permission-approval-1",
        approvalToken: "crash-permission-approval-token-1",
        bindingHash: call.params.binding.bindingHash,
        approvedAt: "2026-08-31T12:00:30Z",
        expiresAt: call.params.binding.payload.expiresAt,
      };
    case "permissionStore.commit":
      return {
        revisions: call.params.changes.map(({ scope, expectedRevision }) => ({
          scope,
          revision: String(BigInt(expectedRevision) + 1n),
        })),
      };
    default:
      throw new Error(`unexpected permission scenario Port: ${call.operation}`);
  }
}

function requestForMessage(vector) {
  const envelope = vector.result.envelope;
  return {
    version: "1.0",
    chainId: mainnet,
    from: vector.result.address,
    message: envelope.message,
  };
}

function messagePermission(name, vector) {
  const chainId = mainnet;
  return {
    id: `crash-permission-${name}`,
    parentCapability: name,
    invoker: baseContext.origin,
    date: Date.parse("2026-08-31T11:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [chainId] },
      { type: "restrictAccounts", value: [vector.result.accountId] },
      { type: "restrictMethods", value: [name] },
    ],
  };
}

function messageResult(vector, call) {
  switch (call.operation) {
    case "clock.now":
      return { now: "2026-08-31T12:00:30Z" };
    case "permissionStore.load":
      return {
        revision: "0",
        permissions: [
          messagePermission("tbc_accounts", vector),
          messagePermission(vector.method, vector),
        ],
      };
    case "accounts.resolve":
      return {
        accounts: [{
          address: vector.result.address,
          accountId: vector.result.accountId,
          chainId: mainnet,
          publicKey: vector.result.publicKey,
        }],
      };
    case "approval.request":
      return {
        status: "approved",
        approvalId: `crash-approval-${vector.id}`,
        approvalToken: `crash-approval-token-${vector.id}`,
        bindingHash: call.params.binding.bindingHash,
        approvedAt: "2026-08-31T12:00:30Z",
        expiresAt: call.params.binding.payload.expiresAt,
      };
    case "signer.sign":
      return {
        portError: {
          name: "SIGNATURE_FAILED",
          message: "The deterministic entropy crash fixture stops after signing.",
          retryable: false,
        },
      };
    default:
      throw new Error(`unexpected message scenario Port: ${call.operation}`);
  }
}

export async function createPortCrashScenarios() {
  const authority = {
    currentContext: clone(baseContext),
    currentSession: clone(session),
  };
  const transaction = await captureScenario({
    createCore: () =>
      tws.createTwsCore({
        transactionEngine: createTbcTransferEngine(integration).engine,
      }),
    startInput: {
      version: "1.0",
      release: tws.TWS_RELEASE,
      request: {
        jsonrpc: "2.0",
        id: "crash-transaction-scenario",
        method: "tbc_sendTransaction",
        params: canonical.request,
      },
    },
    authority,
    resultForCall: transactionResult,
  });
  const permission = await captureScenario({
    createCore: () => tws.createTwsCore(),
    startInput: {
      version: "1.0",
      release: tws.TWS_RELEASE,
      request: {
        jsonrpc: "2.0",
        id: "crash-permission-scenario",
        method: "wallet_requestPermissions",
        params: [{
          tbc_accounts: { chains: [mainnet, testnet], maxAccounts: 2 },
          tbc_signTransaction: { chains: [mainnet, testnet] },
        }],
      },
    },
    authority,
    resultForCall: permissionResult,
  });
  const vector = signing.vectors.find(({ method }) => method === "tbc_signMessage");
  const messageAuthority = {
    currentContext: {
      ...clone(baseContext),
      origin: baseContext.origin,
      topOrigin: baseContext.origin,
    },
    currentSession: clone(session),
  };
  const message = await captureScenario({
    createCore: () => tws.createTwsCore(),
    startInput: {
      version: "1.0",
      release: tws.TWS_RELEASE,
      request: {
        jsonrpc: "2.0",
        id: "crash-message-scenario",
        method: vector.method,
        params: requestForMessage(vector),
      },
    },
    authority: messageAuthority,
    resultForCall: (call) => messageResult(vector, call),
  });

  return Object.freeze({ transaction, permission, message });
}
