import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const built = await build({
  stdin: { contents: 'export * from "./packages/kit/src/default-chain-data.ts"; export { inspectTbcTransaction } from "./packages/kit/src/testnet-validation.ts";', resolveDir: root, loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
  alias: { "@tbc-wallet/core": `${root}packages/core/src/index.ts` },
});
const { createDefaultTbcChainDataResolver, inspectTbc20AncestryReferences, inspectTbcTransaction } =
  await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`);
const fixture = JSON.parse(await readFile(new URL("../../tbc-engine/rust/fixtures/tbc20-standard-transfer.json", import.meta.url), "utf8"));
const genesis = fixture.stages[1];
const account = {
  chainId: "tbc:testnet", address: fixture.request.ownerAddress,
  accountId: `tbc:testnet:${fixture.request.ownerAddress}`, publicKey: fixture.request.publicKeyHex,
};
function setup(stageIndex = 1, minimum = "0") {
  const trace = [];
  const stage = fixture.stages[stageIndex];
  const raw = new Map(fixture.stages.map((item) => [item.txid, item.signedRaw]));
  let candidates = stage.tokenOutputs.map((token) => ({ txid: stage.txid, vout: token.codeVout, satoshis: "500", ftAmount: token.amount, height: "99" }));
  const funding = stage.outputs.at(-1);
  const native = { txid: stage.txid, vout: funding.vout, satoshis: funding.value, height: "99" };
  let nativeCandidates = [native];
  let releaseIndex;
  let delayIndex = false;
  const client = {
    getUtxos: async () => { trace.push("native"); return { tip: { height: "100", hash: "aa".repeat(32) }, utxos: nativeCandidates }; },
    getFtUtxos: async () => {
      trace.push("ft-index");
      if (delayIndex) await new Promise((resolve) => { releaseIndex = resolve; });
      return candidates;
    },
    getRawTransactionBytes: async (txid) => {
      trace.push(`raw:${txid}`); assert.ok(raw.has(txid), "only exact required ancestors may be queried"); return raw.get(txid);
    },
    getRawTransaction: async (txid) => {
      trace.push(`decoded:${txid}`);
      const bytes = raw.get(txid); assert.ok(bytes);
      const parsed = inspectTbcTransaction(bytes).transaction;
      return { txid, rawTransaction: bytes, confirmations: "2", inputs: parsed.inputs,
        outputs: parsed.outputs.map((output, vout) => ({ vout, satoshis: output.satoshis.toString(), scriptPubKey: Buffer.from(output.scriptPubKey).toString("hex") })) };
    },
    getFtInfo: async () => { trace.push("ft-info"); return {contractId: genesis.txid, codeScript: genesis.outputs[0].scriptHex,
      tapeScript: genesis.outputs[1].scriptHex, totalSupply: fixture.request.mintAmount}; },
  };
  const resolver = createDefaultTbcChainDataResolver({ accounts: { current: async () => [account] }, client,
    now: () => Date.parse("2026-09-28T12:00:00Z"), snapshotId: () => "snapshot-tbc20-test",
    confirmationPolicy: { minConfirmations: minimum } });
  return { trace, resolver, native, setCandidates: (value) => { candidates = value; }, candidates: () => candidates,
    setNativeCandidates: (value) => { nativeCandidates = value; },
    delay: () => { delayIndex = true; }, release: () => releaseIndex() };
}
function request(type, inputOutpoints) {
  const create = type === "tbc20-standard-create";
  return { version: "1.0", accountId: account.accountId, chainId: account.chainId, requirement: {
    intentType: type, includeAncestry: !create,
    assets: create ? [{ kind: "native" }] : [{ kind: "native" }, { kind: "ft", contractId: genesis.txid,
      ...(type === "tbc20-standard-transfer" ? { minimumAmount: "40000" } : {}) }],
    ...(create ? {} : { contractIds: [genesis.txid] }), ...(inputOutpoints ? { inputOutpoints } : {}),
  } };
}

test("new creation is parent-free; transfer deduplicates origin/ancestry and retains raw only", async () => {
  const { resolver, trace } = setup();
  const created = await resolver.resolve(request("tbc20-standard-create"), account);
  assert.ok(created.snapshotHash); assert.deepEqual(trace, ["native"]);
  trace.length = 0;
  const first = await resolver.resolve(request("tbc20-standard-transfer"), account);
  assert.ok(first.snapshotHash, JSON.stringify(first));
  assert.equal(first.payload.contracts[0].standardId, "tbc20-standard");
  assert.deepEqual(first.payload.contracts[0].genesisOutpoint, { txid: genesis.txid, vout: 0 });
  assert.equal(first.payload.parents.length, 2);
  assert.equal(trace.filter((item) => item.startsWith("raw:")).length, 2);
  assert.equal(new Set(trace).size, trace.length);
  trace.length = 0;
  assert.ok((await resolver.resolve(request("tbc20-standard-transfer"), account)).snapshotHash);
  assert.deepEqual([...trace].sort(), ["ft-index", "ft-info", "native"]);
});

test("merge reuses previous finalized raw; trusted metadata replaces historical source audit", async () => {
  const { resolver, trace } = setup(2);
  for (const stage of fixture.stages.slice(0, 3)) resolver.rememberFinalizedTransaction({ txid: stage.txid, rawTransaction: stage.signedRaw });
  const result = await resolver.resolve(request("tbc20-standard-merge"), account);
  assert.ok(result.snapshotHash, JSON.stringify(result));
  assert.equal(result.payload.utxos.filter((item) => item.classification === "ft").length, 2);
  assert.equal(result.payload.parents.length, 2);
  assert.deepEqual([...trace].sort(), ["ft-index", "ft-info", "native"]);
});

test("trusted metadata starts beside the FT index without fetching historical origin", async () => {
  const run = setup(); run.delay();
  const pending = run.resolver.resolve(request("tbc20-standard-transfer"), account);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(run.trace.includes("ft-info"));
  assert.equal(run.trace.some(p => p.startsWith('raw:')), false);
  run.release(); assert.ok((await pending).snapshotHash);
});

test("positive confirmations do not come from retained immutable Genesis bytes", async () => {
  const run = setup(1, "1");
  run.setCandidates(run.candidates().map(({ height, ...item }) => item));
  run.resolver.rememberFinalizedTransaction({ txid: genesis.txid, rawTransaction: genesis.signedRaw });
  const result = await run.resolver.resolve(request("tbc20-standard-transfer"), account);
  assert.ok(result.snapshotHash, JSON.stringify(result));
  assert.equal(run.trace.filter((item) => item === `decoded:${genesis.txid}`).length, 1);
  assert.equal(result.payload.utxos.find((item) => item.classification === "ft").confirmations, "2");
});

test("confirmed selection skips an earlier sufficient mempool asset before applying input budget", async () => {
  const run = setup(2, "1");
  run.setCandidates(run.candidates().map((item, index) => ({ ...item, height: index === 0 ? "0" : "99" })));
  const result = await run.resolver.resolve(request("tbc20-standard-transfer"), account);
  assert.ok(result.snapshotHash, JSON.stringify(result));
  assert.deepEqual(result.payload.utxos.filter((item) => item.classification === "ft").map((item) => item.vout), [2]);
  assert.equal(run.trace.filter((item) => item.startsWith("decoded:")).length, 0);
});

test("precise requested inputs and bounded new Tape dependencies reject missing material", async () => {
  const run = setup();
  const exact = [{ txid: genesis.txid, vout: 0 }, { txid: run.native.txid, vout: run.native.vout }];
  assert.ok((await run.resolver.resolve(request("tbc20-standard-transfer", exact), account)).snapshotHash);
  const tokenOnly = await run.resolver.resolve(request("tbc20-standard-transfer", exact.slice(0, 1)), account);
  assert.ok(tokenOnly.snapshotHash, "Rust, not the data loader, checks whether Code value covers the fee");
  assert.ok(tokenOnly.payload.utxos.every((item) => item.classification === "ft"));
  const parent = inspectTbcTransaction(genesis.signedRaw).transaction;
  assert.deepEqual(inspectTbc20AncestryReferences(parent, 0), [{ txid: fixture.stages[0].txid, outputIndex: 0, inputIndex: 0 }]);
  const tampered = { ...parent, outputs: parent.outputs.map((output) => ({ ...output, scriptPubKey: Uint8Array.from(output.scriptPubKey) })) };
  tampered.outputs[1].scriptPubKey[3 + 5 * 8] = 1;
  assert.throws(() => inspectTbc20AncestryReferences(tampered, 0), /missing input/);
});

test("TBC20 may prepare token-only merge material without inventing native funding", async () => {
  const run = setup(2); run.setNativeCandidates([]);
  const merged = await run.resolver.resolve(request("tbc20-standard-merge"), account);
  assert.ok(merged.snapshotHash, JSON.stringify(merged));
  assert.equal(merged.payload.utxos.length, 2);
  assert.ok(merged.payload.utxos.every((item) => item.classification === "ft"));
  assert.equal(new Set(run.trace).size, run.trace.length);
  const create = await run.resolver.resolve(request("tbc20-standard-create"), account);
  assert.equal(create.portError.name, "CONFLICT", "creation still needs native funding");
});

const zero = { txid: "00".repeat(32), vout: 2, satoshis: "500", ftAmount: "0" };
test("zero holder outputs never block transfer/merge or add parent/confirmation reads", async () => {
  for (const kind of ["tbc20-standard-transfer", "tbc20-standard-merge"]) for (const floor of ["0", "1"]) {
    const baseline = setup(2, floor), withZero = setup(2, floor);
    withZero.setCandidates([zero, ...withZero.candidates(), { ...zero, txid: "ff".repeat(32) }]);
    const expected = await baseline.resolver.resolve(request(kind), account);
    const actual = await withZero.resolver.resolve(request(kind), account);
    assert.ok(actual.snapshotHash, JSON.stringify(actual));
    assert.deepEqual(actual, expected);
    assert.deepEqual(withZero.trace, baseline.trace, "zero rows must not add GETs or alter read ordering");
  }
});

test("explicit zero inputs fail clearly even after sufficient positive inputs; no zero parent read", async () => {
  for (const kind of ["tbc20-standard-transfer", "tbc20-standard-merge"]) {
    const run = setup(2), point = { ...zero, txid: "ff".repeat(32) };
    const positives = run.candidates(); run.setCandidates([...positives, point]);
    const result = await run.resolver.resolve(request(kind, [...positives, point, run.native].map(({ txid, vout }) => ({ txid, vout }))), account);
    assert.equal(result.portError?.name, "INVALID_INPUT");
    assert.equal(result.portError?.details?.reason, "SELECTED_ZERO_BALANCE_INPUT");
    assert.equal(run.trace.some(t => t.includes(point.txid)), false);
  }
});

test("all-zero, malformed and duplicate index rows do not authorize a spend", async () => {
  for (const rows of [[zero], [zero, zero], [{ ...zero, ftAmount: "-1" }], [{ ...zero, ftAmount: "00" }]]) {
    const run = setup(2); run.setCandidates(rows);
    const result = await run.resolver.resolve(request("tbc20-standard-transfer"), account);
    assert.ok(result.portError);
    assert.equal(run.trace.some(t => t.startsWith("raw:") || t.startsWith("decoded:")), false);
  }
});
