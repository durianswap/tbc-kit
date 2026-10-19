import { readFileSync } from "node:fs";

const [expectedPath, actualPath] = process.argv.slice(2);
if (!expectedPath || !actualPath) {
  throw new Error("usage: compare-wallet-output.mjs EXPECTED ACTUAL");
}

const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
const actual = JSON.parse(readFileSync(actualPath, "utf8"));
if (!actual.executed || actual.entrypoint !== "hooks/use-ft-transaction.tsx#buildNativeAssetTransfer") {
  throw new Error("source derivation did not execute the pinned public selector");
}
if (!Array.isArray(actual.chain) || actual.chain.length !== 2) {
  throw new Error("source derivation did not return maintenance plus primary transactions");
}

const outpoints = (transaction) => transaction.inputs.map(({ txid, vout }) => ({ txid, vout }));
const sequences = (transaction) => transaction.inputs.map(({ sequence }) => sequence);
const outputAmounts = (transaction) => transaction.outputs.map(({ satoshis }) => satoshis);
const outputScripts = (transaction) => transaction.outputs.map(({ script }) => script);
const outputOrder = (transaction) => transaction.outputs.map(({ satoshis, script }) => ({ satoshis, script }));
const tapeSlots = (transaction) => {
  const script = Buffer.from(transaction.outputs[1].script, "hex");
  if (script.length < 51) throw new Error("FT Tape output is shorter than six amount slots");
  const amountBytes = script.subarray(3, 51);
  return Array.from({ length: 6 }, (_, index) => amountBytes.readBigUInt64LE(index * 8).toString());
};
const internalParent = (chain, index) => {
  if (index === 0) return null;
  const parentTxid = chain[index - 1].txid;
  const inputIndex = chain[index].inputs.findIndex(({ txid }) => txid === parentTxid);
  if (inputIndex < 0) return null;
  const input = chain[index].inputs[inputIndex];
  return { inputIndex, txid: input.txid, vout: input.vout };
};
const topology = (chain, index) => ({
  inputCount: chain[index].inputs.length,
  outputCount: chain[index].outputs.length,
  internalParentCount: index === 0 ? 0 : Number(internalParent(chain, index) !== null),
});
const tokenOutputs = (transaction) => {
  const balances = [];
  for (let index = 1; index < transaction.outputs.length; index += 2) {
    const script = transaction.outputs[index].script;
    if (script.startsWith("76a914") && script.endsWith("88ac")) break;
    const slots = tapeSlots({ outputs: [transaction.outputs[index - 1], transaction.outputs[index]] });
    balances.push(slots.reduce((sum, value) => sum + BigInt(value), 0n).toString());
  }
  return balances;
};
const nativeOutputs = (transaction) => transaction.outputs
  .filter(({ script }) => script.startsWith("76a914") && script.endsWith("88ac"))
  .map(({ satoshis, script }) => ({ satoshis, script }));

const fieldDefinitions = [
  ["inputOutpoints", (chain, index) => outpoints(chain[index])],
  ["inputOrder", (chain, index) => outpoints(chain[index])],
  ["sequences", (chain, index) => sequences(chain[index])],
  ["outputAmounts", (chain, index) => outputAmounts(chain[index])],
  ["outputScripts", (chain, index) => outputScripts(chain[index])],
  ["outputOrder", (chain, index) => outputOrder(chain[index])],
  ["tapeSlots", (chain, index) => tapeSlots(chain[index])],
  ["fee", (chain, index) => chain[index].fee],
  ["sighashes", (chain, index) => chain[index].digests],
  ["signatures", (chain, index) => chain[index].signatures],
  ["unsignedRaw", (chain, index) => chain[index].unsignedTransaction],
  ["raw", (chain, index) => chain[index].rawTransaction],
  ["txid", (chain, index) => chain[index].txid],
  ["downstreamParentOutpoint", internalParent],
  ["topology", topology],
  ["finalTokenOutputs", (chain, index) => tokenOutputs(chain[index])],
  ["finalNativeOutputs", (chain, index) => nativeOutputs(chain[index])],
];

const sdkChain = expected.transferChain;
if (!Array.isArray(sdkChain) || sdkChain.length !== 2) throw new Error("SDK transfer chain is missing");
const transactions = actual.chain.map((_, transactionIndex) => {
  const equalFields = [];
  const differingFields = [];
  const values = {};
  for (const [name, read] of fieldDefinitions) {
    const wallet = read(actual.chain, transactionIndex);
    const sdk = read(sdkChain, transactionIndex);
    values[name] = { wallet, sdk };
    (JSON.stringify(wallet) === JSON.stringify(sdk) ? equalFields : differingFields).push(name);
  }
  return {
    transactionIndex,
    cause: transactionIndex === 0
      ? "wallet merge fee selection changes native change, signatures, raw bytes, and txid"
      : "wallet singleton-first Tape ordering plus the changed maintenance txid propagate through parent outpoints, outputs, sighashes, signatures, raw bytes, and txid",
    equalFields,
    differingFields,
    values,
  };
});

process.stdout.write(`${JSON.stringify({
  ...expected,
  walletHighLevelExecution: actual,
  processIsolation: {
    sourceReceivedInputsOnly: true,
    expectedRawInjectionRejected: true,
    comparisonStartedAfterSourceExit: true,
  },
  walletSdkDivergence: {
    source: "walletHighLevelExecution.chain",
    topology: {
      walletTransactionCount: actual.chain.length,
      sdkTransactionCount: sdkChain.length,
      sameDependencyShape: topology(actual.chain, 1).internalParentCount === topology(sdkChain, 1).internalParentCount,
    },
    transactions,
  },
})}\n`);
