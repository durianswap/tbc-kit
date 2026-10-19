import assert from "node:assert/strict";
import test from "node:test";

import {
  TBC_TESTNET_API_ORIGIN,
  runTbcTestnetReadOnlyPreflight,
} from "../dist/esm/testnet-adapter.js";

const TIP_HASH = "11".repeat(32);
const TXID = "22".repeat(32);
const RAW_TRANSACTION = "0a000000";

function response(data) {
  return new Response(JSON.stringify({ code: "200", message: "OK", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createFetchFixture() {
  const requests = [];
  const fetcher = async (input, init = {}) => {
    const url = String(input);
    const method = String(init.method ?? "GET").toUpperCase();
    requests.push({ url, method });
    assert.equal(method, "GET", `read-only preflight attempted ${method}`);

    if (url.endsWith("/api/tbc/nodeinfo")) {
      return response({ blocks: 829059, bestblockhash: TIP_HASH });
    }
    if (url.includes("/api/tbc/utxo/address/")) {
      return response({ utxos: [] });
    }
    if (url.endsWith("/api/tbc/blockByHeight/height/829059")) {
      return response({ coinbasetxid: TXID, tx: [TXID] });
    }
    if (url.endsWith(`/api/tbc/txraw/txid/${TXID}`)) {
      return response({ txraw: RAW_TRANSACTION });
    }
    if (url.endsWith(`/api/tbc/decode/txid/${TXID}`)) {
      return response({
        txid: TXID,
        hex: RAW_TRANSACTION,
        confirmations: 1,
        vout: [
          {
            n: 0,
            scriptPubKey: { hex: "51", addresses: [] },
          },
        ],
      });
    }
    throw new Error(`unexpected test URL: ${url}`);
  };
  return { fetcher, requests };
}

test("probes the live REST contract without permitting a network write", async () => {
  const { fetcher, requests } = createFetchFixture();

  const result = await runTbcTestnetReadOnlyPreflight({ fetch: fetcher });

  assert.deepEqual(result, {
    version: "1.0",
    status: "pass",
    baseUrl: TBC_TESTNET_API_ORIGIN,
    tip: { height: "829059", hash: TIP_HASH },
    publicUtxoCount: 0,
    sampledTransaction: {
      txid: TXID,
      rawBytes: 4,
      outputs: 1,
      status: "confirmed",
      confirmations: "1",
    },
  });
  assert.ok(requests.length >= 6);
  assert.ok(requests.every(({ method }) => method === "GET"));
  assert.ok(requests.some(({ url }) =>
    url.endsWith(
      "/api/tbc/utxo/address/1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
    )
  ));
});

test("uses an injected Fetch without requiring a global Request constructor", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Request");
  const { fetcher } = createFetchFixture();
  try {
    Object.defineProperty(globalThis, "Request", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const result = await runTbcTestnetReadOnlyPreflight({ fetch: fetcher });
    assert.equal(result.status, "pass");
  } finally {
    if (descriptor === undefined) {
      delete globalThis.Request;
    } else {
      Object.defineProperty(globalThis, "Request", descriptor);
    }
  }
});

test("prints one credential-free JSON result from the preflight command", async () => {
  const { runTbcTestnetPreflightCommand } = await import(
    "../../../scripts/check-testnet-preflight.mjs"
  );
  const { fetcher } = createFetchFixture();
  let output = "";

  const result = await runTbcTestnetPreflightCommand({
    fetch: fetcher,
    write(chunk) {
      output += chunk;
    },
  });

  assert.deepEqual(JSON.parse(output), result);
  assert.equal(output.endsWith("\n"), true);
  assert.equal(output.includes(RAW_TRANSACTION), false);
});
