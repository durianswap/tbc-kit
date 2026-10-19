import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ProviderRpcError } from "@tbc-wallet/provider";
import { connectAndSendTbc } from "../dist/esm/dapp.js";
import {
  createTransferFixture,
  MAINNET_CHAIN_ID,
  TESTNET_CHAIN_ID,
} from "../dist/esm/fixtures.js";
import {
  createMinimalThirdPartyWallet as createWalletWithBackend,
} from "../dist/esm/wallet.js";
import { testEngineBackend } from "./node-wasm-backend.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const PRIVATE_KEY_HEX = "01".padStart(64, "0");

function createMinimalThirdPartyWallet(options) {
  return createWalletWithBackend({ ...options, engineBackend: testEngineBackend });
}

function signDigest(task) {
  return {
    taskId: task.taskId,
    signatureEncoding: "compact64",
    signature: secp256k1
      .sign(task.digest, PRIVATE_KEY_HEX, { prehash: false, lowS: true })
      .toCompactHex(),
  };
}

function traceIndex(trace, label, after = -1) {
  const index = trace.findIndex(
    (entry, candidate) => candidate > after && entry === label,
  );
  assert.notEqual(index, -1, `missing ${label}: ${JSON.stringify(trace)}`);
  return index;
}

function assertTransferPipeline(trace) {
  const normalize = traceIndex(trace, "engine.normalizeRequest");
  const plan = traceIndex(trace, "engine.plan", normalize);
  const binding = trace.findIndex(
    (entry, index) => index > plan && entry.startsWith("approval.binding:"),
  );
  assert.notEqual(binding, -1);
  const approval = traceIndex(trace, "port.approval.request", binding - 1);
  const signer = traceIndex(trace, "port.signer.sign", approval);
  const finalize = traceIndex(trace, "engine.finalize", signer);
  const broadcast = traceIndex(trace, "port.broadcast.submit", finalize);
  assert.ok(
    normalize < plan &&
      plan < binding &&
      binding <= approval &&
      approval < signer &&
      signer < finalize &&
      finalize < broadcast,
  );
}

function readVarInt(bytes, offset) {
  const value = bytes[offset];
  assert.notEqual(value, undefined);
  assert.ok(value < 0xfd, "fixture parser only accepts compact one-byte varints");
  return { value, next: offset + 1 };
}

function readUint64Le(bytes, offset) {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

function transactionOutputAmounts(rawTransaction) {
  const bytes = Uint8Array.from(
    rawTransaction.match(/../g).map((byte) => Number.parseInt(byte, 16)),
  );
  let cursor = 4;
  const inputs = readVarInt(bytes, cursor);
  cursor = inputs.next;
  for (let index = 0; index < inputs.value; index += 1) {
    cursor += 36;
    const script = readVarInt(bytes, cursor);
    cursor = script.next + script.value + 4;
  }
  const outputs = readVarInt(bytes, cursor);
  cursor = outputs.next;
  const amounts = [];
  for (let index = 0; index < outputs.value; index += 1) {
    amounts.push(readUint64Le(bytes, cursor));
    cursor += 8;
    const script = readVarInt(bytes, cursor);
    cursor = script.next + script.value;
  }
  return amounts;
}

function finalizedBundle(wallet) {
  return wallet.engineCalls.find(({ operation }) => operation === "finalize")
    .result.bundle;
}

test("DApp requests an account then sends arbitrary TBC through the public pipeline", async () => {
  const fixture = createTransferFixture({
    chainId: MAINNET_CHAIN_ID,
    amount: "1000",
    clientRequestId: "dapp-arbitrary-1000",
    utxos: "single",
  });
  const wallet = createMinimalThirdPartyWallet({ fixture, signDigest });
  const result = await connectAndSendTbc(wallet.provider, fixture.request);

  assert.deepEqual(result.accounts, [fixture.account.address]);
  assert.equal(result.submitted.chainId, MAINNET_CHAIN_ID);
  assert.equal(result.submitted.from, fixture.account.address);
  assert.equal(result.submitted.transactions.length, 1);
  assert.equal(result.submitted.transactions[0].status, "submitted");
  assertTransferPipeline(wallet.trace);
  assert.deepEqual(
    transactionOutputAmounts(
      finalizedBundle(wallet).transactions[0].rawTransaction,
    ),
    [1000n, 120n],
  );
});

test("covers mainnet/testnet, multi-input, exact spend, and change", async () => {
  const cases = [
    {
      name: "mainnet-exact",
      fixture: createTransferFixture({
        chainId: MAINNET_CHAIN_ID,
        amount: "1120",
        clientRequestId: "mainnet-exact",
        utxos: "single",
      }),
      outputs: [1120n],
    },
    {
      name: "mainnet-change",
      fixture: createTransferFixture({
        chainId: MAINNET_CHAIN_ID,
        amount: "1000",
        clientRequestId: "mainnet-change",
        utxos: "single",
      }),
      outputs: [1000n, 120n],
    },
    {
      name: "testnet-multi-input",
      fixture: createTransferFixture({
        chainId: TESTNET_CHAIN_ID,
        amount: "1500",
        clientRequestId: "testnet-multi-input",
        utxos: "multi",
      }),
      outputs: [1500n, 320n],
    },
  ];
  const txids = new Set();
  for (const item of cases) {
    const wallet = createMinimalThirdPartyWallet({
      fixture: item.fixture,
      signDigest,
      preauthorizeAccounts: true,
    });
    const submitted = await wallet.provider.request({
      method: "tbc_sendTransaction",
      params: item.fixture.request,
    });
    const bundle = finalizedBundle(wallet);
    assert.deepEqual(
      transactionOutputAmounts(bundle.transactions[0].rawTransaction),
      item.outputs,
      item.name,
    );
    assert.equal(bundle.totalFee, "80", item.name);
    assert.equal(submitted.chainId, item.fixture.request.chainId, item.name);
    txids.add(bundle.transactions[0].txid);
    assertTransferPipeline(wallet.trace);
  }
  assert.equal(txids.size, cases.length);
});

test("correlates concurrent sends and keeps sign-only free of broadcast", async () => {
  const fixture = createTransferFixture({
    chainId: MAINNET_CHAIN_ID,
    amount: "1000",
    clientRequestId: "concurrent-base",
    utxos: "multi",
  });
  const wallet = createMinimalThirdPartyWallet({
    fixture,
    signDigest,
    preauthorizeAccounts: true,
  });
  const [first, second] = await Promise.all([
    wallet.provider.request({
      method: "tbc_sendTransaction",
      params: {
        ...fixture.request,
        clientRequestId: "concurrent-first",
        intent: { ...fixture.request.intent, amount: "1400" },
      },
    }),
    wallet.provider.request({
      method: "tbc_sendTransaction",
      params: {
        ...fixture.request,
        clientRequestId: "concurrent-second",
        intent: { ...fixture.request.intent, amount: "1500" },
      },
    }),
  ]);
  assert.notEqual(first.transactions[0].txid, second.transactions[0].txid);

  const signFixture = createTransferFixture({
    chainId: TESTNET_CHAIN_ID,
    amount: "1500",
    clientRequestId: "sign-only",
    utxos: "multi",
  });
  const signWallet = createMinimalThirdPartyWallet({
    fixture: signFixture,
    signDigest,
    preauthorizeAccounts: true,
  });
  const signed = await signWallet.provider.request({
    method: "tbc_signTransaction",
    params: signFixture.request,
  });
  assert.match(signed.transactions[0].txid, /^[0-9a-f]{64}$/);
  assert.equal(
    signWallet.trace.some((entry) => entry.startsWith("port.broadcast.")),
    false,
  );
});

test("handles close, abort, and durable replay without leaking late events", async () => {
  let releaseApproval;
  let reachedApproval;
  const approvalReached = new Promise((resolve) => {
    reachedApproval = resolve;
  });
  const approvalRelease = new Promise((resolve) => {
    releaseApproval = resolve;
  });
  const fixture = createTransferFixture({
    chainId: MAINNET_CHAIN_ID,
    amount: "1000",
    clientRequestId: "abort-transfer",
    utxos: "single",
  });
  const abortWallet = createMinimalThirdPartyWallet({
    fixture,
    signDigest,
    preauthorizeAccounts: true,
    async beforePort(operation) {
      if (operation !== "approval.request") return;
      reachedApproval();
      await approvalRelease;
    },
  });
  const abortSession = abortWallet.openProviderSession({
    requestIdFactory: () => "abort-request-id",
  });
  const controller = new AbortController();
  const lateEvents = [];
  abortSession.provider.on("accountsChanged", (event) => lateEvents.push(event));
  const aborted = abortSession.provider.request(
    { method: "tbc_sendTransaction", params: fixture.request },
    { signal: controller.signal },
  );
  await approvalReached;
  controller.abort();
  await assert.rejects(
    aborted,
    (error) => error instanceof ProviderRpcError && error.code === -32603,
  );
  assert.equal(
    abortWallet.trace.some((entry) => entry.startsWith("adapter.cancel:")),
    true,
  );
  const cancelled = Promise.resolve(
    abortSession.controller.transport.cancel?.(
      "abort-request-id",
      "REQUEST_ABORTED",
    ),
  );
  releaseApproval();
  await cancelled;
  assert.deepEqual(lateEvents, []);
  assert.equal(abortWallet.trace.includes("port.signer.sign"), false);
  assert.equal(abortWallet.trace.includes("port.broadcast.submit"), false);
  assert.equal(
    abortWallet.trace.some((entry) => entry.startsWith("adapter.cancelled:")),
    true,
  );

  const closed = createMinimalThirdPartyWallet({
    fixture,
    signDigest,
    preauthorizeAccounts: true,
  });
  closed.controller.close();
  await assert.rejects(
    closed.provider.request({ method: "tbc_chainId" }),
    (error) => error instanceof ProviderRpcError && error.code === 4900,
  );

  const replayWallet = createMinimalThirdPartyWallet({
    fixture,
    signDigest,
    preauthorizeAccounts: true,
  });
  const firstSession = replayWallet.openProviderSession({
    requestIdFactory: () => "durable-replay-id",
  });
  const first = await firstSession.provider.request({
    method: "tbc_sendTransaction",
    params: fixture.request,
  });
  await firstSession.provider.destroy();
  const secondSession = replayWallet.openProviderSession({
    requestIdFactory: () => "durable-replay-id",
  });
  const replayed = await secondSession.provider.request({
    method: "tbc_sendTransaction",
    params: fixture.request,
  });
  assert.deepEqual(replayed, first);
  const deliveryIds = replayWallet.trace
    .filter((entry) => entry.startsWith("adapter.delivery:"))
    .map((entry) => entry.slice("adapter.delivery:".length));
  assert.equal(deliveryIds.length, 2);
  assert.equal(deliveryIds[0], deliveryIds[1]);
});

test("scopes duplicate JSON-RPC IDs to their authenticated Provider session", async () => {
  let approvals = 0;
  let approvalsReached;
  let releaseApprovals;
  const bothApprovalsReached = new Promise((resolve) => {
    approvalsReached = resolve;
  });
  const approvalRelease = new Promise((resolve) => {
    releaseApprovals = resolve;
  });
  const fixture = createTransferFixture({
    chainId: MAINNET_CHAIN_ID,
    amount: "1000",
    clientRequestId: "session-isolation-base",
    utxos: "multi",
  });
  const wallet = createMinimalThirdPartyWallet({
    fixture,
    signDigest,
    preauthorizeAccounts: true,
    async beforePort(operation) {
      if (operation !== "approval.request") return;
      approvals += 1;
      if (approvals === 2) approvalsReached();
      await approvalRelease;
    },
  });
  const first = wallet.openProviderSession({
    requestIdFactory: () => "same-session-local-id",
  });
  const second = wallet.openProviderSession({
    requestIdFactory: () => "same-session-local-id",
  });
  const abort = new AbortController();
  const firstRequest = first.provider.request(
    {
      method: "tbc_sendTransaction",
      params: {
        ...fixture.request,
        clientRequestId: "session-isolation-first",
        intent: { ...fixture.request.intent, amount: "1000" },
      },
    },
    { signal: abort.signal },
  );
  const secondRequest = second.provider.request({
    method: "tbc_sendTransaction",
    params: {
      ...fixture.request,
      clientRequestId: "session-isolation-second",
      intent: { ...fixture.request.intent, amount: "1050" },
    },
  });
  await bothApprovalsReached;
  abort.abort();
  const cancellation = Promise.resolve(
    first.controller.transport.cancel?.(
      "same-session-local-id",
      "REQUEST_ABORTED",
    ),
  );
  releaseApprovals();

  await assert.rejects(
    firstRequest,
    (error) => error instanceof ProviderRpcError && error.code === -32603,
  );
  await cancellation;
  const submitted = await secondRequest;
  assert.equal(submitted.transactions.length, 1);
  assert.equal(submitted.transactions[0].status, "submitted");
  assert.equal(
    wallet.trace.filter((entry) => entry === "port.broadcast.submit").length,
    1,
  );
});

test("pending Provider close cancels the Host before signing or broadcast", async () => {
  let approvalReached;
  let releaseApproval;
  const reachedApproval = new Promise((resolve) => {
    approvalReached = resolve;
  });
  const approvalRelease = new Promise((resolve) => {
    releaseApproval = resolve;
  });
  const fixture = createTransferFixture({
    chainId: MAINNET_CHAIN_ID,
    amount: "1000",
    clientRequestId: "pending-close",
    utxos: "single",
  });
  const wallet = createMinimalThirdPartyWallet({
    fixture,
    signDigest,
    preauthorizeAccounts: true,
    async beforePort(operation) {
      if (operation !== "approval.request") return;
      approvalReached();
      await approvalRelease;
    },
  });
  const session = wallet.openProviderSession({
    requestIdFactory: () => "pending-close-id",
  });
  const requested = session.provider.request({
    method: "tbc_sendTransaction",
    params: fixture.request,
  });
  await reachedApproval;
  const destroyed = session.provider.destroy();
  releaseApproval();

  await assert.rejects(
    requested,
    (error) => error instanceof ProviderRpcError && error.code === 4900,
  );
  await destroyed;
  assert.equal(wallet.trace.includes("port.signer.sign"), false);
  assert.equal(wallet.trace.includes("port.broadcast.submit"), false);
  assert.equal(
    wallet.trace.some((entry) => entry.startsWith("adapter.cancelled:")),
    true,
    JSON.stringify(wallet.trace),
  );
});

test("same-tick Provider destroy cancels before operation registration", async () => {
  const fixture = createTransferFixture({
    chainId: MAINNET_CHAIN_ID,
    amount: "1000",
    clientRequestId: "pre-registration-provider-close",
    utxos: "single",
  });
  const wallet = createMinimalThirdPartyWallet({
    fixture,
    signDigest,
    preauthorizeAccounts: true,
  });
  const session = wallet.openProviderSession({
    requestIdFactory: () => "pre-registration-provider-close-id",
  });
  const requested = session.provider.request({
    method: "tbc_sendTransaction",
    params: fixture.request,
  });
  const destroyed = session.provider.destroy();

  await assert.rejects(
    requested,
    (error) => error instanceof ProviderRpcError && error.code === 4900,
  );
  await destroyed;
  assert.equal(wallet.trace.includes("port.signer.sign"), false);
  assert.equal(wallet.trace.includes("port.broadcast.submit"), false);
  assert.equal(
    wallet.trace.some((entry) => entry.startsWith("adapter.cancelled:")),
    true,
  );
});

test("same-tick controller close cancels before operation registration", async () => {
  const fixture = createTransferFixture({
    chainId: MAINNET_CHAIN_ID,
    amount: "1000",
    clientRequestId: "pre-registration-controller-close",
    utxos: "single",
  });
  const wallet = createMinimalThirdPartyWallet({
    fixture,
    signDigest,
    preauthorizeAccounts: true,
  });
  const session = wallet.openProviderSession({
    requestIdFactory: () => "pre-registration-controller-close-id",
  });
  const requested = session.provider.request({
    method: "tbc_sendTransaction",
    params: fixture.request,
  });
  session.controller.close("NAVIGATION_CHANGED");
  const closed = Promise.resolve(session.controller.transport.close?.());

  await assert.rejects(
    requested,
    (error) => error instanceof ProviderRpcError && error.code === 4900,
  );
  await closed;
  assert.equal(wallet.trace.includes("port.signer.sign"), false);
  assert.equal(wallet.trace.includes("port.broadcast.submit"), false);
  assert.equal(
    wallet.trace.some((entry) => entry.startsWith("adapter.cancelled:")),
    true,
    JSON.stringify(wallet.trace),
  );
});

test("example source boundary permits only public package contracts", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts/check-example-boundary.mjs")],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
