import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Exercise source without writing package artifacts or replacing other agents' dist.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const built = await build({
  stdin: { contents: `
    export { createDefaultTbcNetwork } from './packages/kit/src/default-network.ts';
    export { createTbcNetworkContext } from './packages/kit/src/network-context.ts';
    export { createTestnetClient } from './packages/kit/src/testnet-client.ts';
    export { hashCanonical, assertValidTws } from '@tbc-wallet/core';
  `, resolveDir: root, loader: "ts" },
  alias: { "@tbc-wallet/core": `${root}packages/core/src/index.ts` },
  bundle: true, format: "esm", platform: "node", target: "node22", write: false,
});
const { createDefaultTbcNetwork, createTbcNetworkContext, createTestnetClient, hashCanonical, assertValidTws } =
  await import(`data:text/javascript;base64,${Buffer.from(`${built.outputFiles[0].text}\n//# sourceURL=tbc20-network-profile-source.js`).toString("base64")}`);
const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const contractId = "11".repeat(32);
const maxSlot = (1n << 63n) - 1n;
const intents = [
  { type: "tbc20-standard-create", version: "1.0", name: "Token", symbol: "TOK", decimals: 6, initialSupply: "1", to: address },
  { type: "tbc20-standard-transfer", version: "1.0", contractId, to: address, amount: "1" },
  { type: "tbc20-standard-merge", version: "1.0", contractId },
];
function params(intent, chainId) {
  const request = { version: "1.0", chainId, from: address, intent };
  return { version: "1.0", request, requestHash: hashCanonical(request), snapshotHash: "aa".repeat(32) };
}
function network(name) {
  return createDefaultTbcNetwork({
    network: createTbcNetworkContext({ network: name }),
    accounts: { current: async () => [] },
    poolMaterial: { async resolveLiquidityAdd() { throw new Error("unrelated Pool path"); } },
    fetch: async () => { throw new Error("policy must not query the API"); },
    now: () => 1_800_000_000_000,
  });
}

test("new TBC20 policy is exact, schema-valid, read-free and isolated on both networks", async () => {
  for (const name of ["mainnet", "testnet"]) {
    const configured = network(name);
    for (const intent of intents) {
      const result = await configured.resolvePolicy(params(intent, configured.network.chainId));
      assert.equal(result.portError, undefined, JSON.stringify(result));
      assertValidTws("policyResolveResult", result);
      assert.equal(result.payload.chainId, `tbc:${name}`);
      assert.equal(result.payload.feeRateSatPerKb, "80");
      assert.equal(result.payload.dustThreshold, "42");
      assert.equal(result.payload.sighashType, 65);
      assert.deepEqual(result.payload.contractPolicies, [{ family: "ft", allowedVersions: ["tbc20"], createVersion: "tbc20" }]);
      assert.deepEqual(result.payload.amountLimits.filter((limit) => limit.protocolVersion === "tbc20"), [
        { scope: "ft-total", protocolVersion: "tbc20", maximum: (36n * maxSlot).toString() },
        { scope: "ft-slot", protocolVersion: "tbc20", maximum: maxSlot.toString() },
      ]);
      assert.equal(result.policyHash, hashCanonical(result.payload));
    }
    const old = await configured.resolvePolicy(params({ type: "tbc.ft.transfer", version: "1.0", contractId, to: address, amount: "1" }, configured.network.chainId));
    assert.equal(old.payload.dustThreshold, "24");
    assert.deepEqual(old.payload.contractPolicies, []);
    assert.equal(old.payload.amountLimits.length, 1);
  }
});

test("TBC20 policy rejects wrong chain, recipients, unknown operations and request hashes", async () => {
  const configured = network("testnet");
  assert.equal((await configured.resolvePolicy(params(intents[0], "tbc:mainnet"))).portError.name, "UNAUTHORIZED");
  for (const intent of intents.slice(0, 2)) {
    assert.ok((await configured.resolvePolicy(params({ ...intent, to: "not-an-address" }, "tbc:testnet"))).portError);
    assert.ok((await configured.resolvePolicy(params({ ...intent, to: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn" }, "tbc:testnet"))).portError);
  }
  const wrongAccount = params(intents[0], "tbc:testnet");
  wrongAccount.request.from = "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn";
  wrongAccount.requestHash = hashCanonical(wrongAccount.request);
  assert.ok((await configured.resolvePolicy(wrongAccount)).portError);
  assert.ok((await configured.resolvePolicy(params({ ...intents[0], type: "tbc20-standard-mystery" }, "tbc:testnet"))).portError);
  assert.ok((await configured.resolvePolicy({ ...params(intents[0], "tbc:testnet"), requestHash: "00".repeat(32) })).portError);
});

const standard = { standard: "tbc20-standard" };
function metadataClient(metadata) {
  const calls = [];
  return {
    calls,
    client: createTestnetClient({
      baseUrl: "https://controlled.example",
      allowedOrigins: ["https://controlled.example"],
      fetch: async (input, init) => {
        calls.push(String(input));
        assert.equal(init?.method, "GET");
        assert.equal(new URL(String(input)).pathname, `/api/tbc/ft/info/contract/${contractId}`);
        return new Response(JSON.stringify({ code: "200", data: {
          code_script: "51", tape_script: "006a", amount: "100", decimal: 6,
          name: "Token", symbol: "TOK", ...metadata,
        } }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  };
}

test("explicit metadata profile accepts long symbols and exact UTF-8 bounds without weakening legacy defaults", async () => {
  for (const metadata of [
    { name: "A", symbol: "X".repeat(52) },
    { name: "中".repeat(17), symbol: "XX" },
    { name: "Café", symbol: "TOK" },
  ]) {
    const { client, calls } = metadataClient(metadata);
    const result = await client.getFtInfo(contractId, standard);
    assert.equal(result.name, metadata.name);
    assert.equal(result.symbol, metadata.symbol);
    assert.equal(calls.length, 1, "one named API read, no proof or extra metadata fetch");
  }
  await assert.rejects(metadataClient({ symbol: "X".repeat(17) }).client.getFtInfo(contractId), { code: "NODE_RESPONSE_INVALID" });
  assert.equal((await metadataClient({ name: "x".repeat(64) }).client.getFtInfo(contractId)).name.length, 64);
});

test("TBC20 metadata rejects invalid Unicode, oversized fields, supply and malformed scripts", async () => {
  for (const metadata of [
    { name: "中".repeat(18), symbol: "X" }, { name: "Cafe\u0301" }, { name: "\ud800" },
    { symbol: "has space" }, { symbol: "币" }, { name: "" }, { symbol: "" },
    { decimal: 19 }, { amount: "0" }, { amount: (maxSlot + 1n).toString() },
    { code_script: "zz" }, { tape_script: "" },
  ]) {
    await assert.rejects(metadataClient(metadata).client.getFtInfo(contractId, standard), { code: "NODE_RESPONSE_INVALID" });
  }
  const { client, calls } = metadataClient({});
  await assert.rejects(client.getFtInfo(contractId, { standard: "unknown" }), { code: "INVALID_INPUT" });
  assert.equal(calls.length, 0);
});

test("local metadata resolver receives normalized Code once and reuses the same API response", async () => {
  const { client, calls } = metadataClient({ name: "A", symbol: "X".repeat(52), code_script: "ABCD" });
  const inspected = [];
  const value = await client.getFtInfo(contractId, { resolveStandard: async (code) => {
    inspected.push(code);
    return "tbc20-standard";
  } });
  assert.deepEqual(inspected, ["abcd"]);
  assert.equal(value.codeScript, "abcd");
  assert.equal(value.symbol.length, 52);
  assert.equal(calls.length, 1);
  const historical = metadataClient({ name: "x".repeat(64) });
  assert.equal((await historical.client.getFtInfo(contractId, { resolveStandard: () => undefined })).name.length, 64);
  assert.equal(historical.calls.length, 1);
  await assert.rejects(metadataClient({ symbol: "X".repeat(17) }).client.getFtInfo(contractId, {
    resolveStandard: async () => undefined,
  }), { code: "NODE_RESPONSE_INVALID" });
});

test("metadata resolver failures never silently fall back or trigger another read", async () => {
  for (const metadata of [{ name: "Cafe\u0301" }, { symbol: "has space" }, { amount: "0" }]) {
    const { client, calls } = metadataClient(metadata);
    await assert.rejects(client.getFtInfo(contractId, { resolveStandard: () => "tbc20-standard" }), { code: "NODE_RESPONSE_INVALID" });
    assert.equal(calls.length, 1);
  }
  const malformed = metadataClient({ code_script: "not-hex" });
  let inspected = 0;
  await assert.rejects(malformed.client.getFtInfo(contractId, { resolveStandard: () => {
    inspected++;
    return "tbc20-standard";
  } }), { code: "NODE_RESPONSE_INVALID" });
  assert.equal(inspected, 0);
  assert.equal(malformed.calls.length, 1);
  const unknown = metadataClient({});
  await assert.rejects(unknown.client.getFtInfo(contractId, { resolveStandard: () => "tbc721-standard" }), { code: "INVALID_INPUT" });
  assert.equal(unknown.calls.length, 1);
  const failed = metadataClient({});
  const failure = new Error("local template inspection failed");
  await assert.rejects(failed.client.getFtInfo(contractId, { resolveStandard: async () => { throw failure; } }), (error) => error === failure);
  assert.equal(failed.calls.length, 1);
  const ambiguous = metadataClient({});
  await assert.rejects(ambiguous.client.getFtInfo(contractId, { standard: "tbc20-standard", resolveStandard: () => undefined }), { code: "INVALID_INPUT" });
  assert.equal(ambiguous.calls.length, 0);
});
