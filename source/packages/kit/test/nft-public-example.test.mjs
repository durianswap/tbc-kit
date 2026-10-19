import assert from "node:assert/strict";
import test from "node:test";
import { assertValidTws } from "@tbc-wallet/core";
import { runNftThreeStep } from "../examples/nft-three-step/run.mjs";

const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const ids = ["11", "22", "33"].map((byte) => byte.repeat(32));
const types = ["tbc721-standard-create-collection", "tbc721-standard-mint", "tbc721.transfer"];
const submitted = (txid) => ({ transactions: [{ role: "primary", status: "submitted", txid }] });

function fixture(replaceResult = (_index, result) => result) {
  const calls = [];
  const provider = {
    async request(request) {
      if (request.method === "tbc_requestAccounts") return [address];
      assert.equal(request.method, "tbc_sendTransaction");
      const index = calls.length;
      calls.push(request);
      assertValidTws("transactionRequest", request.params);
      assert.equal(request.params.intent.type, types[index]);
      assert.equal(request.params.chainId, "tbc:testnet");
      assert.equal(request.params.from, address);
      return replaceResult(index, submitted(ids[index]));
    },
    on() {}, removeListener() {}, destroy() {},
  };
  return { calls, provider };
}

test("public NFT example uses modern methods and carries submitted identities forward", async () => {
  const { provider, calls } = fixture();
  assert.deepEqual(await runNftThreeStep(provider), {
    collectionId: ids[0], contractId: ids[1], transferTxid: ids[2],
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].params.intent.supply, "1");
  assert.equal(calls[1].params.intent.collectionId, ids[0]);
  assert.equal(calls[1].params.intent.slot, 1);
  assert.equal(calls[2].params.intent.contractId, ids[1]);
  assert.equal(calls[2].params.intent.to, address);
});

test("public NFT example stops at incomplete or ambiguous submission without retry", async () => {
  const invalid = [
    undefined,
    { transactions: [] },
    { transactions: [{ role: "primary", status: "unknown", txid: ids[0] }] },
    { transactions: [{ role: "funding", status: "submitted", txid: ids[0] }] },
    { transactions: [{ role: "primary", status: "submitted", txid: "invalid" }] },
    { transactions: [...submitted(ids[0]).transactions, ...submitted(ids[1]).transactions] },
  ];
  for (const failedStep of [0, 1, 2]) {
    for (const result of invalid) {
      const { provider, calls } = fixture((index, normal) => index === failedStep ? result : normal);
      await assert.rejects(runNftThreeStep(provider), /did not return one submitted primary transaction/u);
      assert.equal(calls.length, failedStep + 1);
    }
  }
});

test("public NFT example propagates rejection without restarting earlier steps", async () => {
  for (const failedStep of [0, 1, 2]) {
    const error = new Error("controlled provider rejection");
    const { provider, calls } = fixture((index, normal) => {
      if (index === failedStep) throw error;
      return normal;
    });
    await assert.rejects(runNftThreeStep(provider), (caught) => caught === error);
    assert.equal(calls.length, failedStep + 1);
  }
});
