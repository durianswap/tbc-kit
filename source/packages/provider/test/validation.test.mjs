import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  TBC_PROVIDER_EVENTS,
  TBC_PROVIDER_MAX_MESSAGE_BYTES,
  TBC_PROVIDER_METHODS,
  TbcProviderValidationError,
  assertTbcProviderEvent,
  assertTbcProviderMethodParams,
  assertTbcProviderMethodResult,
  assertTbcProviderRequest,
  assertTbcProviderResponse,
  assertTbcTransportDelivery,
  canonicalTbcMessageBytes,
} from "../dist/esm/index.js";

const providerVectors = JSON.parse(
  await readFile(new URL("../../../test-vectors/provider.json", import.meta.url), "utf8"),
);
const permissionVectors = JSON.parse(
  await readFile(new URL("../../../test-vectors/permissions.json", import.meta.url), "utf8"),
);
const intentVectors = JSON.parse(
  await readFile(new URL("../../../test-vectors/intents.json", import.meta.url), "utf8"),
);
const workflowVectors = JSON.parse(
  await readFile(new URL("../../../test-vectors/workflow.json", import.meta.url), "utf8"),
);
const signingVectors = JSON.parse(
  await readFile(new URL("../../../test-vectors/signing.json", import.meta.url), "utf8"),
);

const chainId = providerVectors.providerSessions.chainA;
const address = providerVectors.account.address;

function validationFailure(invoke, kind) {
  assert.throws(invoke, (error) => {
    assert.equal(error instanceof TbcProviderValidationError, true);
    assert.equal(error.code, "TBC_PROVIDER_VALIDATION_FAILED");
    assert.equal(error.kind, kind);
    assert.equal(JSON.stringify(error).includes(address), false);
    return true;
  });
}

test("validates general JSON-RPC envelopes and exact registered params", () => {
  const request = { jsonrpc: "2.0", id: "request-1", method: "tbc_chainId" };
  assert.deepEqual(assertTbcProviderRequest(request), request);
  assert.deepEqual(assertTbcProviderMethodParams("tbc_chainId", undefined), []);
  assert.deepEqual(assertTbcProviderMethodParams("tbc_chainId", []), []);
  assert.deepEqual(
    assertTbcProviderMethodParams("tbc_switchChain", { chainId }),
    { chainId },
  );
  assert.deepEqual(
    assertTbcProviderMethodParams("tbc_getAccount", {}),
    {},
  );
  assert.deepEqual(
    assertTbcProviderMethodParams(
      "wallet_requestPermissions",
      permissionVectors.request,
    ),
    permissionVectors.request,
  );
  assert.deepEqual(
    assertTbcProviderMethodParams(
      "tbc_sendTransaction",
      intentVectors.vectors[0].request,
    ),
    intentVectors.vectors[0].request,
  );
  assert.deepEqual(
    assertTbcProviderMethodParams(
      "tbc_signWorkflow",
      workflowVectors.vectors[0].request,
    ),
    workflowVectors.vectors[0].request,
  );

  validationFailure(
    () => assertTbcProviderMethodParams("tbc_chainId", {}),
    "params",
  );
  validationFailure(
    () => assertTbcProviderMethodParams("tbc_switchChain", []),
    "params",
  );
  validationFailure(
    () => assertTbcProviderRequest({ ...request, jsonrpc: "1.0" }),
    "request",
  );
  validationFailure(
    () => assertTbcProviderRequest([{ ...request }]),
    "request",
  );
});

test("Reviewed raw role markers survive all public entrances without accepting page keys", () => {
  for (const method of ["tbc_signReviewedTransaction", "tbc_signWorkflow", "tbc_signPreparedWorkflow"]) {
    const request = { payload: { format: "raw", transactions: [{ rawTransaction: "00", inputs: [
      { satoshis: "500", scriptPubKey: "51", signingRole: "coin-admin" },
    ] }] } };
    const base = { version: "1.0", chainId, from: address };
    const params = method === "tbc_signReviewedTransaction" ? { ...base, request } : {
      ...base, steps: [{ id: "admin", kind: "reviewedTransaction", dependsOn: [], request }],
    };
    assert.deepEqual(assertTbcProviderMethodParams(method, params), params);
    request.payload.transactions[0].inputs[0].signingPublicKey = "02" + "11".repeat(32);
    validationFailure(() => assertTbcProviderMethodParams(method, params), "params");
  }
});

test("accepts staged Pool create requests used by the public Core and Engine", () => {
  const mint = {
    version: "1.0",
    chainId,
    from: address,
    clientRequestId: `provider-pool-mint:${"11".repeat(32)}`,
    intent: {
      version: "1.0",
      type: "tbc.pool.create",
      stage: "mint",
      ftContractId: "22".repeat(32),
      lpPlan: 2,
      serviceProviderTag: "durian",
      lock: {
        publicKeys: [
          "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        ],
        costRecipient: address,
        costAmount: "1000000",
      },
    },
  };
  const initialize = {
    version: "1.0",
    chainId,
    from: address,
    clientRequestId: `provider-pool-initialize:${"33".repeat(32)}`,
    intent: {
      version: "1.0",
      type: "tbc.pool.create",
      stage: "initialize",
      poolContractId: "44".repeat(32),
      initialLiquidity: {
        receiver: address,
        tbcAmount: "10000000",
        ftAmount: "2500000",
      },
    },
  };

  assert.deepEqual(assertTbcProviderMethodParams("tbc_signTransaction", mint), mint);
  assert.deepEqual(
    assertTbcProviderMethodParams("tbc_signTransaction", initialize),
    initialize,
  );
});

test("validates fixed and deferred v1 Prepared requests without blind extension fields", () => {
  const intent = {
    type: "tbc.transfer",
    version: "1.0",
    to: address,
    amount: "1000",
  };
  const proposal = {
    payload: {
      version: "1.0",
      engineProfile: "tbc-engine-rust12",
      createdAt: "2026-09-16T10:00:00Z",
      expiresAt: "2026-09-16T10:05:00Z",
      intentHash: "11".repeat(32),
      transactions: [
        {
          id: "parent",
          role: "primary",
          dependsOn: [],
          kind: "fixed",
          unsignedTransaction: "00",
          fee: "80",
        },
        {
          id: "child",
          role: "dependent",
          dependsOn: ["parent"],
          kind: "deferred",
          unsignedTransactionTemplate: "00",
          deferredInputs: [
            {
              inputIndex: 0,
              sourceTransactionId: "parent",
              sourceOutputIndex: 0,
            },
          ],
          fee: "80",
        },
      ],
      evidence: {
        observedAt: "2026-09-16T10:00:00Z",
        parentTransactions: [],
        contracts: [],
      },
      estimatedTotalFee: "160",
    },
    proposalHash: "22".repeat(32),
  };
  const prepared = { version: "1.0", chainId, from: address, intent, proposal };
  assert.deepEqual(
    assertTbcProviderMethodParams("tbc_signPreparedTransaction", prepared),
    prepared,
  );
  assert.deepEqual(
    assertTbcProviderMethodParams("tbc_sendPreparedTransaction", prepared),
    prepared,
  );
  const workflow = {
    version: "1.0",
    chainId,
    from: address,
    steps: [
      { id: "trade", kind: "preparedTransaction", dependsOn: [], intent, proposal },
    ],
  };
  assert.deepEqual(
    assertTbcProviderMethodParams("tbc_signPreparedWorkflow", workflow),
    workflow,
  );
  validationFailure(
    () => assertTbcProviderMethodParams("tbc_signPreparedTransaction", {
      ...prepared,
      trusted: true,
    }),
    "params",
  );
  validationFailure(
    () => assertTbcProviderMethodParams("tbc_signPreparedTransaction", {
      ...prepared,
      proposal: {
        ...proposal,
        payload: {
          ...proposal.payload,
          transactions: [{
            ...proposal.payload.transactions[1],
            byteOffset: 42,
          }],
        },
      },
    }),
    "params",
  );
});

test("routes every frozen method to a result Schema and validates known successes", () => {
  for (const method of TBC_PROVIDER_METHODS) {
    validationFailure(
      () => assertTbcProviderMethodResult(method, {}),
      "result",
    );
  }

  assert.equal(assertTbcProviderMethodResult("tbc_chainId", chainId), chainId);
  assert.deepEqual(assertTbcProviderMethodResult("tbc_accounts", [address]), [address]);
  assert.deepEqual(
    assertTbcProviderMethodResult("tbc_requestAccounts", [address]),
    [address],
  );
  assert.deepEqual(
    assertTbcProviderMethodResult("tbc_getAccount", providerVectors.account),
    providerVectors.account,
  );
  assert.deepEqual(
    assertTbcProviderMethodResult(
      "tbc_getCapabilities",
      providerVectors.capabilities,
    ),
    providerVectors.capabilities,
  );
  assert.equal(assertTbcProviderMethodResult("tbc_switchChain", null), null);
  assert.deepEqual(
    assertTbcProviderMethodResult(
      "tbc_signMessage",
      signingVectors.vectors[0].result,
    ),
    signingVectors.vectors[0].result,
  );
  assert.deepEqual(
    assertTbcProviderMethodResult(
      "tbc_signTypedData",
      signingVectors.vectors[1].result,
    ),
    signingVectors.vectors[1].result,
  );
  assert.deepEqual(
    assertTbcProviderMethodResult(
      "wallet_getPermissions",
      permissionVectors.result,
    ),
    permissionVectors.result,
  );
  assert.deepEqual(
    assertTbcProviderMethodResult(
      "wallet_requestPermissions",
      permissionVectors.result,
    ),
    permissionVectors.result,
  );
  assert.equal(assertTbcProviderMethodResult("tbc_disconnect", null), null);
});

test("public signing results reject the superseded versioned scheme labels", () => {
  const oldMessage = structuredClone(signingVectors.vectors[0].result);
  oldMessage.scheme = "tbc-message-v1";
  validationFailure(
    () => assertTbcProviderMethodResult("tbc_signMessage", oldMessage),
    "result",
  );

  const oldTypedData = structuredClone(signingVectors.vectors[1].result);
  oldTypedData.scheme = "tbc-typed-data-v1";
  validationFailure(
    () => assertTbcProviderMethodResult("tbc_signTypedData", oldTypedData),
    "result",
  );
});

test("validates all six event payloads through their exact registered Schemas", () => {
  const validEvents = [
    { name: "connect", payload: { chainId } },
    { name: "disconnect", payload: { code: 4900, message: "Disconnected" } },
    { name: "chainChanged", payload: chainId },
    { name: "accountsChanged", payload: [address] },
    { name: "permissionsChanged", payload: permissionVectors.result },
    { name: "capabilitiesChanged", payload: providerVectors.capabilities },
  ];
  assert.deepEqual(validEvents.map(assertTbcProviderEvent), validEvents);
  assert.deepEqual(validEvents.map(({ name }) => name), TBC_PROVIDER_EVENTS);

  for (const name of TBC_PROVIDER_EVENTS) {
    validationFailure(
      () => assertTbcProviderEvent({ name, payload: { invalid: address } }),
      "event",
    );
  }
});

test("rejects malformed responses and unregistered execution error pairs", () => {
  const success = { jsonrpc: "2.0", id: "request-1", result: chainId };
  assert.deepEqual(assertTbcProviderResponse(success, "tbc_chainId"), success);
  const unauthorized = {
    jsonrpc: "2.0",
    id: "request-1",
    error: { code: 4100, message: "Unauthorized" },
  };
  assert.deepEqual(assertTbcProviderResponse(unauthorized), unauthorized);

  validationFailure(
    () => assertTbcProviderResponse({ ...success, error: unauthorized.error }),
    "response",
  );
  validationFailure(
    () => assertTbcProviderResponse({
      jsonrpc: "2.0",
      id: "request-1",
      error: {
        code: -32000,
        message: "Execution failed",
        data: {
          name: "INSUFFICIENT_FUNDS",
          stage: "signing",
          retryable: false,
        },
      },
    }),
    "response",
  );
});

test("validates atomic deliveries and enforces the canonical 4 MiB ceiling", () => {
  const delivery = {
    deliveryId: "d".repeat(64),
    response: { jsonrpc: "2.0", id: "request-1", result: null },
    events: [{ name: "chainChanged", payload: chainId }],
  };
  assert.deepEqual(
    assertTbcTransportDelivery(delivery, "tbc_switchChain"),
    delivery,
  );
  validationFailure(
    () => assertTbcTransportDelivery({ ...delivery, deliveryId: "not-a-hash" }),
    "delivery",
  );
  validationFailure(
    () => assertTbcTransportDelivery({ ...delivery, hidden: address }),
    "delivery",
  );

  assert.equal(TBC_PROVIDER_MAX_MESSAGE_BYTES, 4 * 1024 * 1024);
  assert.equal(canonicalTbcMessageBytes({ value: "ok" }) > 0, true);
  validationFailure(
    () => canonicalTbcMessageBytes({ value: "x".repeat(TBC_PROVIDER_MAX_MESSAGE_BYTES) }),
    "size",
  );
  validationFailure(
    () => canonicalTbcMessageBytes({ value: 1n }),
    "json",
  );
});
