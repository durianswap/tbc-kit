import assert from "node:assert/strict";
import test from "node:test";
import { assertValidTws } from "@tbc-wallet/core";
import { runMergeMaintenance } from "../examples/merge-maintenance/run.mjs";
import { burnFtlp } from "../examples/ftlp-burn/run.mjs";

const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const ftContractId = "11".repeat(32), poolContractId = "22".repeat(32);
function fixture(types) {
  const calls = [];
  const provider = {
    async request(request) {
      if (request.method === "tbc_requestAccounts") return [address];
      assert.equal(request.method, "tbc_sendTransaction");
      assertValidTws("transactionRequest", request.params);
      assert.equal(request.params.intent.type, types[calls.length]);
      calls.push(request.params.intent);
      return { transactions: [{ role: "primary", status: "submitted", txid: "33".repeat(32) }] };
    },
    on() {}, removeListener() {}, destroy() {},
  };
  return { provider, calls };
}

test("merge example uses unified native, token, pool and LP maintenance intents", async () => {
  const { provider, calls } = fixture(["tbc.maintenance.merge", "tbc20.merge", "amm.mergeToken", "tbc20Lp.merge"]);
  const result = await runMergeMaintenance(provider, { ftContractId, poolContractId });
  assert.deepEqual(Object.keys(result), ["tbc", "ft", "poolFt", "ftlp"]);
  assert.deepEqual(calls.map(({ type, version, ...input }) => input), [
    {}, { contractId: ftContractId }, { poolContractId }, { poolContractId },
  ]);
});

test("burn example uses shared LP maintenance without inventing an amount or receiver", async () => {
  const { provider, calls } = fixture(["tbc20Lp.burn"]);
  await burnFtlp(provider, poolContractId);
  assert.deepEqual(calls, [{ type: "tbc20Lp.burn", version: "1.0", poolContractId }]);
});
