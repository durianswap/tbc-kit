import assert from "node:assert/strict";
import test from "node:test";

import { createTbcApiClient, createTestnetClient } from "../dist/esm/api.js";
import { createTbcRpcClient } from "../dist/esm/rpc.js";

const FT_ID = "cd".repeat(32);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("idempotent API GET retries transient network, 429 and retryable 5xx failures", async () => {
  const steps = [
    () => { throw new TypeError("controlled disconnect"); },
    () => json({ error: "slow down" }, 429, { "retry-after": "0" }),
    () => json({ error: "temporary" }, 503, { "retry-after": "0" }),
    () => json({ ok: true }),
  ];
  let calls = 0;
  const api = createTbcApiClient({
    baseUrl: "https://retry.example/",
    fetch: async () => {
      const step = steps[calls++];
      if (step === undefined) throw new Error("unexpected retry");
      return step();
    },
  });
  assert.deepEqual(await api.getJson("resource"), { ok: true });
  assert.equal(calls, 4);
});

test("same-request single-flight shares one bounded retry sequence", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const api = createTbcApiClient({
    baseUrl: "https://single-flight.example/",
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        await firstGate;
        return json({ error: "temporary" }, 503, { "retry-after": "0" });
      }
      return json({ ok: true });
    },
  });
  const first = api.getJson("resource");
  const second = api.getJson("resource");
  assert.equal(calls, 1);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  assert.equal(calls, 2);
});

test("API parsing, ordinary 4xx and POST failures are never retried", async () => {
  for (const response of [
    () => new Response("not-json", { status: 200 }),
    () => json({ error: "rejected" }, 400),
  ]) {
    let calls = 0;
    const api = createTbcApiClient({
      baseUrl: "https://no-retry.example/",
      fetch: async () => { calls += 1; return response(); },
    });
    await assert.rejects(api.getJson("resource"));
    assert.equal(calls, 1);
  }

  let posts = 0;
  const api = createTbcApiClient({
    baseUrl: "https://post.example/",
    fetch: async () => { posts += 1; return json({ error: "temporary" }, 503); },
  });
  await assert.rejects(api.postJson("broadcast", { raw: "00" }));
  assert.equal(posts, 1);
});

test("idempotent RPC transport retries transient HTTP but not RPC errors", async () => {
  let calls = 0;
  const rpc = createTbcRpcClient({
    url: "https://rpc-retry.example/",
    fetch: async (_input, init) => {
      calls += 1;
      if (calls === 1) return json({ error: "temporary" }, 502, { "retry-after": "0" });
      const request = JSON.parse(init.body);
      return json({ jsonrpc: "2.0", id: request.id, result: "ok" });
    },
  });
  assert.equal(await rpc.call("getblockcount", [], { retry: "idempotent-read" }), "ok");
  assert.equal(calls, 2);

  let businessCalls = 0;
  const rejected = createTbcRpcClient({
    url: "https://rpc-business.example/",
    fetch: async (_input, init) => {
      businessCalls += 1;
      const request = JSON.parse(init.body);
      return json({ jsonrpc: "2.0", id: request.id, error: { code: -8 } });
    },
  });
  await assert.rejects(
    rejected.call("getblockcount", [], { retry: "idempotent-read" }),
    /returned an error/u,
  );
  assert.equal(businessCalls, 1);

  let mutationCalls = 0;
  const mutation = createTbcRpcClient({
    url: "https://rpc-mutation.example/",
    fetch: async () => {
      mutationCalls += 1;
      return json({ error: "temporary" }, 503);
    },
  });
  await assert.rejects(mutation.call("sendrawtransaction", ["00"]), /HTTP 503/u);
  assert.equal(mutationCalls, 1);
});

test("Testnet GET retries transient HTTP while response-source mismatch fails once", async () => {
  let calls = 0;
  const client = createTestnetClient({
    baseUrl: "https://api.tbcdev.org",
    fetch: async () => {
      calls += 1;
      if (calls === 1) return json({ code: "503", data: {} }, 503, { "retry-after": "0" });
      return json({
        code: "200",
        data: {
          code_script: "01",
          tape_script: "02",
          amount: "1000000",
          decimal: 6,
          name: "Retry Token",
          symbol: "RT",
        },
      });
    },
  });
  assert.deepEqual(await client.getFtInfo(FT_ID), {
    contractId: FT_ID,
    codeScript: "01",
    tapeScript: "02",
    totalSupply: "1000000",
    decimals: 6,
    name: "Retry Token",
    symbol: "RT",
  });
  assert.equal(calls, 2);

  let mismatchCalls = 0;
  const mismatched = createTestnetClient({
    baseUrl: "https://api.tbcdev.org",
    fetch: async () => {
      mismatchCalls += 1;
      return Object.defineProperty(
        json({ code: "200", data: {} }),
        "url",
        { value: `https://wrong.example/api/tbc/ft/info/contract/${FT_ID}` },
      );
    },
  });
  await assert.rejects(mismatched.getFtInfo(FT_ID), /unauthorized origin/u);
  assert.equal(mismatchCalls, 1);
});
