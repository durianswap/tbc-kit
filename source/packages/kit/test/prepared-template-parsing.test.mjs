import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const source = await build({ stdin: { contents: `
  export { parseTbcTransaction, parseTbcUnsignedTemplate } from './packages/kit/src/testnet-validation.ts';
  export { resolvePreparedInputDependencies } from './packages/core/src/prepared-dependencies.ts';
  export { preparedProposalTransactions } from './packages/core/src/reducers/planning.ts';
`, resolveDir: fileURLToPath(new URL("../../../", import.meta.url)), loader: "ts" },
bundle: true, write: false, platform: "node", format: "esm" });
const { parseTbcTransaction, parseTbcUnsignedTemplate, resolvePreparedInputDependencies, preparedProposalTransactions } =
  await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString("base64")}`);
const tx = (ids, script = "") => "0a000000" + ids.length.toString(16).padStart(2, "0") +
  ids.map(id => id + "00000000" + (script.length / 2).toString(16).padStart(2, "0") + script + "ffffffff").join("") +
  "010a00000000000000015100000000";
const zero = "00".repeat(32), real = "11".repeat(32);

test("zero template handles can share vout only when exact planned parents differ", () => {
  const raw = tx([zero, zero]);
  assert.throws(() => parseTbcTransaction(raw), /Duplicate/);
  const inputs = parseTbcUnsignedTemplate(raw).inputs.map((i, inputIndex) => ({ inputIndex, sourceOutputIndex: i.vout }));
  const parents = ["left", "right"], known = new Set(parents);
  assert.deepEqual(resolvePreparedInputDependencies(inputs, parents, known), [
    { inputIndex: 0, sourceOutputIndex: 0, sourceTransactionId: "left" },
    { inputIndex: 1, sourceOutputIndex: 0, sourceTransactionId: "right" },
  ]);
  assert.throws(() => resolvePreparedInputDependencies(inputs, ["left"], known));
  assert.throws(() => resolvePreparedInputDependencies(inputs, parents, known,
    inputs.map(i => ({ ...i, sourceTransactionId: "left" }))));
});

test("template parsing never admits duplicate real inputs or signed bytes", () => {
  assert.throws(() => parseTbcUnsignedTemplate(tx([real, real])), /Duplicate/);
  assert.throws(() => parseTbcTransaction(tx([real, real])), /Duplicate/);
  assert.throws(() => parseTbcUnsignedTemplate(tx([zero, zero], "51")), /unlocking script/);
  assert.throws(() => parseTbcUnsignedTemplate(tx([real], "51")), /unlocking script/);
  assert.deepEqual(parseTbcUnsignedTemplate(tx([real, zero])), parseTbcTransaction(tx([real, zero])));
});

const compact = n => {
  if (n < 253) return n.toString(16).padStart(2, '0');
  const b = Buffer.alloc(n <= 65535 ? 3 : 5); b[0] = n <= 65535 ? 253 : 254;
  if (b[0] === 253) b.writeUInt16LE(n, 1); else b.writeUInt32LE(n, 1);
  return b.toString('hex');
};
const mediaTx = (size, inputSize = 0, declaredSize = size) => `0a00000001${real}00000000${compact(inputSize)}${'51'.repeat(inputSize)}ffffffff010000000000000000${compact(declaredSize)}${'00'.repeat(size)}00000000`;

test('NFT-sized scripts use whole-transaction byte limits in API and Prepared parsers', () => {
  for (const size of [10_001, 65_535, 65_536, 1_000_000]) {
    const raw = mediaTx(size);
    assert.equal(parseTbcTransaction(raw).outputs[0].scriptPubKey.length, size);
    assert.equal(parseTbcUnsignedTemplate(raw).outputs[0].scriptPubKey.length, size);
    assert.equal(preparedProposalTransactions([{ id: 'nft', role: 'primary', dependsOn: [], fee: '80', unsignedTransaction: raw }]).length, 1);
  }
  assert.equal(parseTbcTransaction(mediaTx(1, 65_536)).inputs[0].scriptSig.length, 65_536);
  assert.throws(() => parseTbcUnsignedTemplate(mediaTx(1, 65_536)), /unlocking script/);
  for (const parse of [parseTbcTransaction, parseTbcUnsignedTemplate,
    raw => preparedProposalTransactions([{ id: 'nft', role: 'primary', dependsOn: [], fee: '80', unsignedTransaction: raw }])]) {
    assert.throws(() => parse(mediaTx(10, 0, 65_536)), /truncated/i);
    assert.throws(() => parse(mediaTx(2 * 1024 * 1024)), /transaction|budget/i);
  }
});
