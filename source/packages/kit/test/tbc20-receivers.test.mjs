import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { build } from "esbuild";
import Ajv2020 from "ajv/dist/2020.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const built = await build({ stdin: { contents: `
  export { createTbcClient } from './packages/kit/src/client.ts';
  export { preparedChainDataRequirement } from './packages/kit/src/prepared-chain-data.ts';
  export { chainDataRequirement } from './packages/core/src/reducers/chain-data-requirements.ts';
  export { createDefaultTbcNetwork } from './packages/kit/src/default-network.ts';
  export { createTbcNetworkContext } from './packages/kit/src/network-context.ts';
  export { projectTbcApprovalPresentation } from './packages/kit/src/approval-presentation.ts';
  export { hashCanonical } from '@tbc-wallet/core';
`, resolveDir: root, loader: "ts" }, alias: { "@tbc-wallet/core": `${root}packages/core/src/index.ts` },
  bundle: true, write: false, platform: "node", format: "esm", target: "node22" });
const virtualUrl = new URL("../src/.tbc20-receivers-test.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === virtualUrl ? { url: virtualUrl, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === virtualUrl ? { source: built.outputFiles[0].text, format: "module", shortCircuit: true } : next(url, context);
  },
});
const kit = await import(virtualUrl);
hooks.deregister();
const schemas = readdirSync(`${root}schemas`).filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(`${root}schemas/${name}`, "utf8")));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addFormat("uri", /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]*$/u);
ajv.addFormat("date-time", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u);
for (const schema of schemas) ajv.addSchema(schema);
const schema = schemas.find((schema) => schema.$id.endsWith("/transaction-request.schema.json"));
const valid = ajv.getSchema(`${schema.$id}#/$defs/tbc20StandardTransferIntent`);
const A = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const B = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
const ID = "11".repeat(32);
const head = { type: "tbc20-standard-transfer", version: "1.0", contractId: ID };
const recipients = [{ to: B, amount: "2" }, { to: A, amount: "3" }, { to: B, amount: "4" }];
const multi = { ...head, receivers: recipients };
const request = (intent) => ({ version: "1.0", chainId: "tbc:testnet", from: A, intent });
const max = 36n * ((1n << 63n) - 1n);

test("official schema accepts exactly one recipient form and preserves ordered duplicates", () => {
  for (const intent of [{ ...head, to: A, amount: "1" }, multi,
    { ...head, receivers: Array.from({ length: 8 }, () => ({ to: A, amount: "1" })) }]) assert.equal(valid(intent), true);
  for (const intent of [head, { ...head, to: A }, { ...head, amount: "1" }, { ...multi, to: A },
    { ...multi, amount: "1" }, { ...multi, to: A, amount: "1" }, { ...head, receivers: [] },
    { ...head, receivers: Array.from({ length: 9 }, () => ({ to: A, amount: "1" })) },
    ...["0", "01", "-1", "1.5", 1].map((amount) => ({ ...head, receivers: [{ to: A, amount }] })),
    { ...head, receivers: [{ amount: "1" }] }, { ...head, receivers: [{ to: A, amount: "1", extra: true }] }]) {
    assert.equal(valid(intent), false, JSON.stringify(intent));
  }
});

test("Core and Prepared project one total asset requirement without reordering receivers", () => {
  const points = [{ txid: ID, vout: 2 }];
  const input = { ...request(multi), constraints: { inputOutpoints: points } };
  const before = JSON.stringify(input);
  const normal = kit.chainDataRequirement(input);
  const prepared = kit.preparedChainDataRequirement(input);
  assert.deepEqual(normal, prepared);
  assert.deepEqual(normal.assets, [{ kind: "native" }, { kind: "ft", contractId: ID, minimumAmount: "9" }]);
  assert.deepEqual(normal.inputOutpoints, points);
  assert.equal(JSON.stringify(input), before);
  for (const project of [kit.chainDataRequirement, kit.preparedChainDataRequirement]) {
    assert.equal(project(request({ ...head, receivers: [{ to: A, amount: max.toString() }] })).assets[1].minimumAmount, max.toString());
    for (const intent of [{ ...head, receivers: [{ to: A, amount: max.toString() }, { to: B, amount: "1" }] },
      { ...head, receivers: [] }, { ...multi, amount: "1" }, { ...head, receivers: [{ to: A, amount: "0" }] }]) {
      assert.throws(() => project(request(intent)));
    }
    const single = project(request({ ...head, to: A, amount: "9" }));
    assert.deepEqual(single.assets, normal.assets);
  }
});

test("existing client method preserves both shapes; policy checks every address without reads", async () => {
  const calls = [];
  const wallet = await kit.createTbcClient({ network: "testnet", provider: {
    async request(call) { calls.push(call); return call.method === "tbc_requestAccounts" ? [A] : {}; },
    on() {}, removeListener() {}, destroy() {},
  } }).connect();
  await wallet.transferTbc20({ contractId: ID, to: A, amount: "9" });
  await wallet.transferTbc20({ contractId: ID, receivers: recipients });
  assert.deepEqual(calls[1].params.intent, { ...head, to: A, amount: "9" });
  assert.deepEqual(calls[2].params.intent, multi);
  assert.equal(calls[2].method, "tbc_sendTransaction");
  for (const name of ["mainnet", "testnet"]) {
    const network = kit.createDefaultTbcNetwork({ network: kit.createTbcNetworkContext({ network: name }),
      accounts: { current: async () => [] }, fetch: async () => { throw new Error("unexpected policy fetch"); },
      poolMaterial: { async resolveLiquidityAdd() { throw new Error("unrelated Pool"); } }, now: () => Date.parse("2026-09-28T00:00:00Z") });
    for (const [intent, accepted] of [[multi, true], [{ ...head, receivers: [{ to: A, amount: "2" },
      { to: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", amount: "1" }] }, false]]) {
      const tx = { ...request(intent), chainId: `tbc:${name}` };
      const result = await network.resolvePolicy({ version: "1.0", request: tx, requestHash: kit.hashCanonical(tx), snapshotHash: "aa".repeat(32) });
      assert.equal(result.portError === undefined, accepted);
    }
  }
});

test("approval renders every bound Engine recipient flow, including duplicate addresses", () => {
  const tx = request(multi), requestHash = kit.hashCanonical(tx);
  const assetFlows = recipients.map(({ to, amount }) => ({ kind: "ft", direction: "send", contractId: ID, from: A, to, amount }));
  const preview = { operationKind: "transaction", assetFlows, totalFee: "80", transactionCount: 1, warnings: [], irreversible: false };
  const payload = { requestHash, preview, transactions: [{ id: "transfer" }], signingTasks: [] };
  const planHash = kit.hashCanonical(payload);
  const bindingPayload = { version: "1.0", method: "tbc_signTransaction", operationKind: "transaction", contextHash: "22".repeat(32),
    origin: "https://wallet.example", sessionId: "receiver-test", chainId: "tbc:testnet", accountId: `tbc:testnet:${A}`,
    requestHash, operationHash: planHash, expiresAt: "2026-09-28T00:05:00Z" };
  const binding = { payload: bindingPayload, bindingHash: kit.hashCanonical(bindingPayload) };
  const params = { version: "1.0", binding, requester: { transport: "remote", origin: "https://wallet.example", topOrigin: "https://wallet.example", frame: "top" }, preview };
  const model = kit.projectTbcApprovalPresentation({ callId: "call", operationId: "operation", releaseFingerprint: "08".repeat(32), params,
    call: { callId: "call", operation: "approval.request", params }, payload: { operationId: "operation", operation: { method: "tbc_signTransaction", params: tx } },
    memory: { requestHash, approvalBinding: binding, approvalPreview: preview, normalizedTransaction: { request: tx, requestHash }, executionPlan: { payload, planHash } } });
  assert.deepEqual(model.assets.map((asset) => ({ to: asset.to.value, amount: asset.amount.atomic })), recipients);
  assert.ok(model.assets.every((asset) => asset.source === "engine-preview"));
});
