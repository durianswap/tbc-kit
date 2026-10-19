import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  completeAssociatedFromWalletSigner,
  createSharedLegacyDefaults,
  createStandardLegacyDefaults,
} from "../examples/legacy-associated-metadata/wallet.mjs";
import { createTbcNetworkContext } from "@tbc/kit/wallet";

test("associated/metadata example is directly importable and exposes no secret input", async () => {
  assert.equal(typeof createSharedLegacyDefaults, "function");
  assert.equal(typeof completeAssociatedFromWalletSigner, "function");
  const source = await readFile(
    new URL("../examples/legacy-associated-metadata/wallet.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /privateKeyHex|private_key|scalar/u);
});

test("current legacy example forwards standalone signing to Standard Reviewed with no journal or fetch", async () => {
  const network = createTbcNetworkContext({ network: "testnet" });
  const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
  const script = "76a914751e76e8199196d454941c45d1b3a323f1433bd688ac";
  const raw = ["0a000000", "01", "00".repeat(32), "00000000", "00", "ffffffff", "01", "0100000000000000", "19", script, "00000000"].join("");
  const context = { origin: "https://dapp.example", chainId: network.chainId, sessionId: "example-session", navigationId: "example-navigation" };
  const calls = [];
  const shared = createStandardLegacyDefaults({
    network,
    fetch: async () => { throw new Error("Unexpected fetch"); },
    standard: {
      context,
      readAccount: async () => ({ address, accountId: `${network.chainId}:${address}` }),
      resolveSendTransaction: async () => { throw new Error("Unexpected business mapping"); },
      executeWorkflow: async () => { throw new Error("Unexpected workflow wrapping"); },
      executeAction: async (request) => {
        calls.push(request.method);
        return { deliveryId: "44".repeat(32), response: { jsonrpc: "2.0", id: request.id, result: { detachedSignatures: [["aa"]] } }, events: [] };
      },
    },
  });
  assert.equal("associatedTransactions" in shared, false);
  const outcome = await shared.genericBatch.execute({
    requestId: "example-raw", context,
    requests: [{ method: "signTransaction", params: { txraws: [raw], utxos_satoshis: [[1000]], script_pubkeys: [[script]] } }],
  });
  assert.deepEqual(calls, ["tbc_signReviewedTransaction"]);
  assert.deepEqual(outcome.results, [{ sigs: [["aa"]] }]);
});
