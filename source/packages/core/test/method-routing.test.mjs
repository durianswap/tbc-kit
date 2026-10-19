import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as tws from "../dist/esm/index.js";

const registry = JSON.parse(
  await readFile(new URL("../../../registry/methods.json", import.meta.url), "utf8"),
);

const expectedPaths = {
  tbc_chainId: "session-read",
  tbc_accounts: "account-read",
  tbc_requestAccounts: "permission-request",
  tbc_getAccount: "account-read",
  tbc_getCapabilities: "account-read",
  tbc_switchChain: "switch-chain",
  tbc_signMessage: "message-signing",
  tbc_signTypedData: "message-signing",
  tbc_signTransaction: "sign-transaction",
  tbc_signPreparedTransaction: "sign-transaction",
  tbc_sendTransaction: "send-transaction",
  tbc_sendPreparedTransaction: "send-transaction",
  tbc_signWorkflow: "sign-workflow",
  tbc_signReviewedTransaction: "wallet-action",
  tbc_encrypt: "wallet-action",
  tbc_decrypt: "wallet-action",
  tbc_signPreparedWorkflow: "sign-workflow",
  tbc_sendWorkflow: "send-workflow",
  tbc_sendPreparedWorkflow: "send-workflow",
  wallet_getPermissions: "permission-read",
  wallet_requestPermissions: "permission-request",
  tbc_disconnect: "disconnect",
};

test("method routing is an exact executable projection of the frozen registry", () => {
  assert.equal(registry.methods.length, 22);
  assert.deepEqual(
    tws.TWS_METHOD_DEFINITIONS.map(({ name }) => name),
    registry.methods.map(({ name }) => name),
  );

  for (const registered of registry.methods) {
    const method = tws.getTwsMethod(registered.name);
    assert.equal(method.path, expectedPaths[registered.name]);
    assert.equal(method.version, registered.version);
    assert.equal(method.profile, registered.profile);
    assert.equal(method.authorizationMode, registered.authorization.mode);
    assert.deepEqual(method.permissions, registered.authorization.permissions);
    assert.equal(method.approval, registered.approval);
    assert.equal(method.operationKind, registered.operationKind);
    assert.equal(method.effect, registered.effect);
    assert.equal(method.paramsKind, registered.params.kind);
    assert.equal(
      method.category,
      [
        "tbc_signTransaction",
        "tbc_signPreparedTransaction",
        "tbc_sendTransaction",
        "tbc_sendPreparedTransaction",
      ].includes(registered.name)
        ? "transaction"
        : "non-transaction",
    );
  }

  assert.throws(
    () => tws.getTwsMethod("eth_sendTransaction"),
    (error) => error instanceof tws.TwsMethodError && error.code === "UNSUPPORTED_METHOD",
  );
});

async function reduceToValidation(method, params) {
  const provider = JSON.parse(
    await readFile(new URL("../../../test-vectors/provider.json", import.meta.url), "utf8"),
  );
  const currentContext = provider.trustedContexts[0].context;
  const currentSession = provider.providerSessions.sessionA;
  const core = tws.createTwsCore();
  const waiting = await core.start({
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id: `invalid-${method}`,
      method,
      ...(params === undefined ? {} : { params }),
    },
    currentContext,
    currentSession,
  });
  const validating = await core.resume({
    version: "1.0",
    checkpoint: waiting.checkpoint,
    response: {
      version: "1.0",
      callId: waiting.calls[0].callId,
      result: { now: "2026-09-01T08:00:00Z" },
    },
    currentContext,
    currentSession,
  });
  return core.resume({
    version: "1.0",
    checkpoint: validating.checkpoint,
    currentContext,
    currentSession,
  });
}

test("method routing returns stable Provider errors for unknown methods and invalid exact params", async () => {
  const unsupported = await reduceToValidation("eth_sendTransaction", []);
  assert.equal(unsupported.kind, "complete");
  assert.equal(unsupported.completion.response.error.code, 4200);

  for (const [method, params] of [
    ["tbc_switchChain", {}],
    ["wallet_requestPermissions", [{}]],
    ["tbc_signMessage", {}],
    ["tbc_signTransaction", {}],
    ["tbc_signWorkflow", {}],
  ]) {
    const invalid = await reduceToValidation(method, params);
    assert.equal(invalid.kind, "complete", method);
    assert.equal(invalid.completion.response.error.code, -32602, method);
  }
});
