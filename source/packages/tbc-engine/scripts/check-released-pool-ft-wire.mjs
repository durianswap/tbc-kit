import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [vectorsPath, oracleRoot, reportPath] = process.argv.slice(2);
assert.ok(vectorsPath && oracleRoot && reportPath, "pass vectors JSON, released wallet root, report path");
globalThis.fetch = () => { throw new Error("network is forbidden in this comparator"); };
const require = createRequire(import.meta.url);
const tbc = require(join(oracleRoot, "node_modules/tbc-lib-js"));
const released = require(join(oracleRoot, "node_modules/tbc-contract"));
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));
const results = [];
for (const name of ["removeLiquidity", "tokenSwap", "fragmentedRemove", "maintenanceRemove"]) {
  const vector = vectors.pool[name];
  if (!vector) continue;
  const parents = vector.planInput.snapshot.payload.parents.map(({ rawTransaction }) => new tbc.Transaction(rawTransaction));
  const signed = vector.complete.bundle.transactions.map(({ rawTransaction }) => new tbc.Transaction(rawTransaction));
  parents.push(...signed);
  const heldCodes = new Set(vector.planInput.snapshot.payload.utxos
    .filter(({ classification }) => classification === "pool-ft")
    .map(({ scriptPubKey }) => scriptPubKey));
  for (const tx of signed) {
    const contract = parents.find((candidate) => candidate.hash === tx.inputs[0].prevTxId.toString("hex"));
    for (const [index, input] of tx.inputs.entries()) {
      const parent = parents.find((candidate) => candidate.hash === input.prevTxId.toString("hex"));
      assert.ok(parent, "complete fixture ancestry is required");
      const output = parent.outputs[input.outputIndex];
      if (!heldCodes.has(output.script.toHex())) continue;
      assert.ok(contract, "authenticated Pool input parent is required");
      const signature = input.script.chunks.find(({ buf }) => buf && buf.length >= 70 && buf[0] === 0x30)?.buf;
      assert.ok(signature, "the existing isolated fixture signature must be reused");
      const args = [signature.toString("hex"), vector.planInput.snapshot.payload.account.publicKey,
        tx, parent, released.buildFtPrePreTxData(parent, input.outputIndex, parents),
        contract, index, input.outputIndex, 4, false];
      const expected = released.FT.getFTunlockSwap(...args, false).toBuffer();
      const contractTxs = released.FT.getFTunlockSwap(...args, true).toBuffer();
      const actual = input.script.toBuffer();
      results.push({ name, inputIndex: index, bytes: actual.length,
        releasedDefaultEqual: actual.equals(expected),
        contractTxsEqual: actual.equals(contractTxs),
        differingBytes: actual.length === expected.length
          ? [...actual].filter((byte, offset) => byte !== expected[offset]).length : null });
    }
  }
}
assert.ok(results.some(({ name, inputIndex }) => name === "removeLiquidity" && inputIndex === 2));
const report = { version: "1.0", oracle: "released getFTunlockSwap(..., isContractTXs=false)",
  oracleFtSourceSha256: createHash("sha256").update(readFileSync(join(oracleRoot, "node_modules/tbc-contract/lib/contract/ft.js"))).digest("hex"),
  results, networkRequests: 0, newSignatures: 0, broadcasts: 0,
  boundary: "Public isolated fixtures; byte oracle only, not real-chain or VM acceptance" };
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
assert.ok(results.every(({ releasedDefaultEqual }) => releasedDefaultEqual), "Pool-held FT wire must equal the released default branch");
