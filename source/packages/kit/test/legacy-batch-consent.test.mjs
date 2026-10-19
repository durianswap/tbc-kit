import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveOperationId,
  hashCanonical,
  TWS_RELEASE_FINGERPRINT,
} from "@tbc-wallet/core";

import { turingTransactionId } from "../dist/esm/api.js";
import {
  createLegacyBatchConsentMachine,
  LegacyBatchConsentConflictError,
} from "../dist/esm/wallet.js";

test("batch consent is exported from the wallet entry", () => {
  assert.equal(typeof createLegacyBatchConsentMachine, "function");
});

const chainId = "tbc:testnet";
const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const navigation = Object.freeze({
  sessionId: "batch-session",
  navigationId: "batch-navigation",
  origin: "https://dev.durianswap.org",
  topOrigin: "https://dev.durianswap.org",
  frame: "top",
  createdAt: "2026-09-02T00:00:00Z",
});

test("request-list consent is session-only, account-bound and non-replaying", async () => {
  let account = address;
  let presentations = 0;
  let now = Date.parse(navigation.createdAt);
  let machine;
  const options = {
    store: {},
    journal: {},
    now: () => now,
    readAccount: async () => account,
    presentRequest: async (intentId, onVisible) => {
      presentations += 1;
      onVisible?.();
      const review = await machine.loadRequestReview(intentId);
      assert.equal(review.operationKind, "request-batch");
      assert.equal(review.verifiedOrigin, navigation.origin);
      assert.equal(review.kind, "native");
      assert.equal(review.amount, "1000");
      assert.equal(review.feeCapAtomic, "1000");
      assert.equal(await machine.decideRequest(intentId, "approved"), true);
    },
  };
  machine = createLegacyBatchConsentMachine(options);
  const args = [
    navigation,
    "request",
    chainId,
    { message: "{}", encoding: "utf8" },
    address,
    {
      flag: "P2PKH",
      address,
      satoshis: "1000",
      broadcastEnabled: false,
    },
  ];
  let visible = 0;
  assert.equal(
    await machine.requestApproval(...args, () => {
      visible += 1;
    }),
    true,
  );
  assert.equal(await machine.requestApproval(...args), true);
  assert.equal(presentations, 1);
  assert.equal(visible, 1);

  await assert.rejects(
    machine.requestApproval(...args.slice(0, 5), {
      ...args[5],
      satoshis: "1001",
    }),
    LegacyBatchConsentConflictError,
  );
  account = null;
  await assert.rejects(
    machine.requestApproval(...args.slice(0, 4), undefined, args[5]),
    /binding mismatch/u,
  );
  account = address;

  const original = machine;
  const restarted = createLegacyBatchConsentMachine(options);
  machine = restarted;
  assert.equal(await restarted.requestApproval(...args), true);
  assert.equal(presentations, 2);
  now += 5 * 60_000;
  await assert.rejects(original.requestApproval(...args), /binding mismatch/u);
});

test("request approval authorizes only its exact canonical spend and fee cap", async () => {
  const contextHash = hashCanonical({ ...navigation, transport: "webview" });
  let operationId = "";
  let account = address;
  let fee = "500";
  let machine;
  const options = {
    store: {
      readCall: async () => ({
        operation: "approval.request",
        operationId,
        call: { params: { binding: { bindingHash: "bound" } } },
      }),
    },
    journal: {},
    now: () => Date.parse("2026-09-02T00:00:10Z"),
    readAccount: async () => account,
    presentRequest: async (intentId) => {
      await machine.decideRequest(intentId, "approved");
    },
  };
  machine = createLegacyBatchConsentMachine(options);
  const legacy = {
    flag: "P2PKH",
    address,
    satoshis: "1000",
    broadcastEnabled: false,
  };
  const template = { message: "{}", encoding: "utf8" };
  assert.equal(
    await machine.requestApproval(
      navigation,
      "request",
      chainId,
      template,
      address,
      legacy,
    ),
    true,
  );
  const canonical = {
    version: "1.0",
    chainId,
    from: address,
    intent: {
      version: "1.0",
      type: "tbc.transfer",
      to: address,
      amount: "1000",
    },
  };
  const request = {
    jsonrpc: "2.0",
    id: "request:batch:1:3",
    method: "tbc_signTransaction",
    params: canonical,
  };
  await assert.rejects(
    machine.register(navigation, "request", {
      ...request,
      params: {
        ...canonical,
        intent: { ...canonical.intent, amount: "1001" },
      },
    }),
  );
  await machine.register(navigation, "request", request);
  operationId = deriveOperationId({
    releaseFingerprint: TWS_RELEASE_FINGERPRINT,
    contextHash,
    requestId: request.id,
    operation: { method: request.method, params: canonical },
  });
  const intent = () => ({
    intentId: "first",
    callId: "first",
    params: {
      binding: {
        bindingHash: "bound",
        payload: {
          contextHash,
          origin: navigation.origin,
          sessionId: navigation.sessionId,
          chainId,
          method: "tbc_signTransaction",
          requestHash: hashCanonical(canonical),
        },
      },
      preview: {
        operationKind: "transaction",
        transactionCount: 1,
        totalFee: fee,
      },
    },
    facts: {
      operationKind: "transaction",
      accountId: `${chainId}:${address}`,
      chainId,
      contextHash,
      requestHash: hashCanonical(canonical),
      expiresAt: "2026-09-02T00:05:00Z",
    },
  });
  assert.equal(await machine.authorizeRequest(intent()), true);
  fee = "1001";
  await assert.rejects(machine.authorizeRequest(intent()));
  fee = "500";
  account = null;
  await assert.rejects(machine.authorizeRequest(intent()));
  account = address;
  assert.equal(
    await createLegacyBatchConsentMachine(options).authorizeRequest(intent()),
    false,
  );
});

test("presentation failure becomes one in-session rejection", async () => {
  let presentations = 0;
  const machine = createLegacyBatchConsentMachine({
    store: {},
    journal: {},
    readAccount: async () => address,
    presentRequest: async () => {
      presentations += 1;
      throw new Error("presentation closed");
    },
  });
  const args = [
    navigation,
    "rejected",
    chainId,
    { message: "{}", encoding: "utf8" },
    address,
    {
      flag: "P2PKH",
      address,
      satoshis: "1000",
      broadcastEnabled: false,
    },
  ];
  assert.equal(await machine.requestApproval(...args), false);
  assert.equal(await machine.requestApproval(...args), false);
  assert.equal(presentations, 1);
});

test("dependent consent binds Host delivery, raw txid, message and live alias", async () => {
  const contextHash = hashCanonical({ ...navigation, transport: "webview" });
  const firstParams = {
    version: "1.0",
    chainId,
    from: address,
    intent: {
      version: "1.0",
      type: "tbc.transfer",
      to: address,
      amount: "1000",
    },
  };
  const firstRequest = {
    jsonrpc: "2.0",
    id: "batch-1:batch:1:3",
    method: "tbc_signTransaction",
    params: firstParams,
  };
  const raw = `0a00000001${"11".repeat(32)}000000000151ffffffff012823000000000000015101000000`;
  const txid = turingTransactionId(raw);
  const template = {
    message: JSON.stringify({ payloadHash: "ab".repeat(32) }),
    encoding: "utf8",
  };
  const secondParams = {
    version: "1.0",
    chainId,
    from: address,
    clientRequestId: "legacy-bitcoin:test",
    message: {
      encoding: "utf8",
      data: JSON.stringify({ payloadHash: "ab".repeat(32), txids: [txid] }),
    },
  };
  const secondRequest = {
    jsonrpc: "2.0",
    id: "batch-1:batch:2:2",
    method: "tbc_signMessage",
    params: secondParams,
  };
  const operationId = (request) =>
    deriveOperationId({
      releaseFingerprint: TWS_RELEASE_FINGERPRINT,
      contextHash,
      requestId: request.id,
      operation: { method: request.method, params: request.params },
    });
  const firstOperationId = operationId(firstRequest);
  const secondOperationId = operationId(secondRequest);
  const intent = (role) => ({
    intentId: role,
    callId: role,
    params: {
      binding: {
        bindingHash: role,
        payload: {
          origin: navigation.origin,
          sessionId: navigation.sessionId,
          contextHash,
          chainId,
          accountId: `${chainId}:${address}`,
          requestHash: hashCanonical(
            role === "first" ? firstParams : secondParams,
          ),
          method:
            role === "first" ? "tbc_signTransaction" : "tbc_signMessage",
        },
      },
      preview: {
        operationKind: role === "first" ? "transaction" : "message",
      },
    },
    facts: {
      operationKind: role === "first" ? "transaction" : "message",
      accountId: `${chainId}:${address}`,
      chainId,
      contextHash,
      requestHash: hashCanonical(
        role === "first" ? firstParams : secondParams,
      ),
      expiresAt: "2026-09-02T00:05:00Z",
    },
  });
  const root = {
    ...intent("first"),
    decision: undefined,
  };
  let now = Date.parse("2026-09-02T00:00:10Z");
  let returnedTxid = txid;
  let alias;
  let readCallCount = 0;
  const store = {
    readCall: async (id) => {
      readCallCount += 1;
      return {
        operation: "approval.request",
        operationId:
          id === "first" ? firstOperationId : (alias ?? secondOperationId),
        call: { params: { binding: { bindingHash: id } } },
      };
    },
    readOperation: async () => ({
      transition: {
        checkpoint: { payload: { operation: { params: secondParams } } },
      },
    }),
    readDelivery: async () => ({
      completion: {
        delivery: "respond",
        response: {
          result: {
            chainId,
            from: address,
            approvalId: "root-approved",
            requestHash: hashCanonical(firstParams),
            transactions: [{ txid: returnedTxid, rawTransaction: raw }],
          },
        },
      },
    }),
  };
  const options = {
    store,
    journal: { readIntent: async () => root },
    now: () => now,
  };
  const machine = createLegacyBatchConsentMachine(options);
  await machine.prepare(navigation, "batch-1", chainId, template);
  await machine.register(navigation, "batch-1", firstRequest);
  await machine.register(navigation, "batch-1", secondRequest);
  assert.match(
    (await machine.review(root)).messageTemplate,
    /"txids":\[\]/u,
  );
  await machine.bindRoot(root);
  await assert.rejects(machine.authorizeDependent(intent("second")));
  root.decision = { status: "approved", approvalId: "root-approved" };
  assert.equal(
    await createLegacyBatchConsentMachine(options).authorizeDependent(
      intent("second"),
    ),
    false,
  );
  assert.equal(await machine.authorizeDependent(intent("second")), true);

  alias = "R".repeat(43);
  assert.equal(await machine.authorizeDependent(intent("second")), true);
  readCallCount = 0;
  await machine.verifyDependency(intent("second"));
  assert.equal(
    readCallCount,
    1,
    "one dependency verification reuses its already-bound Host evidence entry",
  );
  alias = "S".repeat(43);
  await assert.rejects(machine.authorizeDependent(intent("second")));
  alias = "R".repeat(43);
  returnedTxid = "22".repeat(32);
  await assert.rejects(machine.authorizeDependent(intent("second")));
  returnedTxid = txid;
  secondParams.message.data = JSON.stringify({
    payloadHash: "ff".repeat(32),
    txids: [txid],
  });
  await assert.rejects(machine.authorizeDependent(intent("second")));
  secondParams.message.data = JSON.stringify({
    payloadHash: "ab".repeat(32),
    txids: [txid],
  });
  now = Date.parse("2026-09-02T00:05:00Z");
  await assert.rejects(machine.authorizeDependent(intent("second")));
});

test("wallet can preserve its own conflict error identity", async () => {
  class WalletConflict extends Error {}
  const machine = createLegacyBatchConsentMachine({
    store: {},
    journal: {},
    createConflictError: (message) => new WalletConflict(message),
  });
  await assert.rejects(
    machine.prepare(
      { ...navigation, frame: "child" },
      "request",
      chainId,
      { message: "{}", encoding: "utf8" },
    ),
    WalletConflict,
  );
});
