import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [hookPath, inputsPath, typescriptPath, engineBinary] = process.argv.slice(2);
if (!hookPath || !inputsPath || !typescriptPath || !engineBinary) {
  throw new Error("usage: run-wallet-orchestration.mjs HOOK INPUTS TYPESCRIPT ENGINE_BINARY");
}

const PINNED_HOOK_SHA256 = "38181962d1df9b5cd5bc0b95f1bbffee2b126c2ce55ee809db0aaace745c13e3";
const hookSource = readFileSync(hookPath, "utf8");
const hookSha256 = createHash("sha256").update(hookSource).digest("hex");
if (hookSha256 !== PINNED_HOOK_SHA256) throw new Error(`pinned hook hash mismatch: ${hookSha256}`);

const fixture = JSON.parse(readFileSync(inputsPath, "utf8"));
const allowedInputKeys = ["schemaVersion", "key", "ownerAddress", "recipient", "contract", "sources", "feeUtxos", "amount"];
const unknownInputKeys = Object.keys(fixture).filter((key) => !allowedInputKeys.includes(key)).sort();
if (unknownInputKeys.length) throw new Error(`unknown input keys: ${unknownInputKeys.join(",")}`);
if (fixture.schemaVersion !== "1") throw new Error("wallet orchestration input schema must be 1");
if (!fixture || fixture.sources?.length !== 6 || fixture.feeUtxos?.length !== 1) {
  throw new Error("wallet orchestration inputs must contain six assets and one fee UTXO");
}

const ts = await import(pathToFileURL(typescriptPath).href);
const exportRoot = resolve(dirname(hookPath), "..");
const compileRoot = mkdtempSync(join(tmpdir(), "tbc-pinned-wallet-js-"));
writeFileSync(join(compileRoot, "package.json"), '{"type":"commonjs"}\n');
const compiled = new Set();

const resolveRelativeModule = (fromPath, specifier) => {
  const base = resolve(dirname(fromPath), specifier);
  const candidates = extname(base) ? [base] : [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(`cannot resolve pinned module ${specifier} from ${fromPath}`);
};

const compilePinnedModule = (absolutePath) => {
  const relativePath = relative(exportRoot, absolutePath);
  if (relativePath.startsWith("..")) throw new Error(`pinned module escaped export root: ${absolutePath}`);
  if (compiled.has(relativePath)) return;
  compiled.add(relativePath);
  const source = readFileSync(absolutePath, "utf8");
  for (const imported of ts.preProcessFile(source).importedFiles) {
    if (imported.fileName.startsWith(".")) compilePinnedModule(resolveRelativeModule(absolutePath, imported.fileName));
  }
  const outputPath = join(compileRoot, relativePath).replace(/\.tsx?$/, ".js");
  mkdirSync(dirname(outputPath), { recursive: true });
  const output = ts.transpileModule(source, {
    fileName: absolutePath,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  writeFileSync(outputPath, output);
};

const requireFromCompileRoot = createRequire(join(compileRoot, "entry.cjs"));
const loadPinnedModule = (relativePath) => {
  const sourcePath = join(exportRoot, relativePath);
  compilePinnedModule(sourcePath);
  return requireFromCompileRoot(join(compileRoot, relativePath).replace(/\.tsx?$/, ".js"));
};

const operations = loadPinnedModule("lib/tbc-engine/operations.ts");
const { executeAssetMergeDag } = loadPinnedModule("lib/tbc-engine/asset-merge.ts");
const { selectOptimalUtxoValues } = loadPinnedModule("lib/tbc-engine/tbc-selection.ts");
const { formatAssetRawAmount, planNativeAssetSendLimit } = loadPinnedModule("lib/tbc-engine/native-asset-send-limit.ts");

const findInitializer = (name) => {
  const sourceFile = ts.createSourceFile(hookPath, hookSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      initializer = node.initializer.getText(sourceFile);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!initializer) throw new Error(`pinned hook entrypoint not found: ${name}`);
  return initializer;
};

const evaluateInitializer = (name, dependencies) => {
  const javascript = ts.transpileModule(`const __value = ${findInitializer(name)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
  const scope = new Proxy(dependencies, {
    has: () => true,
    get: (target, property) => {
      if (property === Symbol.unscopables) return undefined;
      return property in target ? target[property] : globalThis[property];
    },
  });
  return new Function("scope", `with (scope) { ${javascript}; return __value; }`)(scope);
};

const readVarInt = (bytes, cursor) => {
  const prefix = bytes[cursor.offset++];
  if (prefix < 0xfd) return prefix;
  const width = { 0xfd: 2, 0xfe: 4, 0xff: 8 }[prefix];
  let value = 0n;
  for (let index = 0; index < width; index += 1) value |= BigInt(bytes[cursor.offset++]) << BigInt(index * 8);
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) throw new Error("transaction varint overflow");
  return numeric;
};
const readU32 = (bytes, cursor) => {
  const value = bytes.readUInt32LE(cursor.offset);
  cursor.offset += 4;
  return value;
};
const readU64 = (bytes, cursor) => {
  const numeric = Number(bytes.readBigUInt64LE(cursor.offset));
  cursor.offset += 8;
  if (!Number.isSafeInteger(numeric)) throw new Error("satoshi value overflow");
  return numeric;
};
const transactionId = (rawHex) => {
  const first = createHash("sha256").update(Buffer.from(rawHex, "hex")).digest();
  return Buffer.from(createHash("sha256").update(first).digest()).reverse().toString("hex");
};
const parseTransaction = (rawHex) => {
  const bytes = Buffer.from(rawHex, "hex");
  const cursor = { offset: 0 };
  const version = readU32(bytes, cursor);
  const inputs = Array.from({ length: readVarInt(bytes, cursor) }, () => {
    const txid = Buffer.from(bytes.subarray(cursor.offset, cursor.offset + 32)).reverse().toString("hex");
    cursor.offset += 32;
    const vout = readU32(bytes, cursor);
    const scriptLength = readVarInt(bytes, cursor);
    const signature = bytes.subarray(cursor.offset, cursor.offset + scriptLength).toString("hex");
    cursor.offset += scriptLength;
    return { txid, vout, sequence: readU32(bytes, cursor), signature };
  });
  const txid = transactionId(rawHex);
  const outputs = Array.from({ length: readVarInt(bytes, cursor) }, (_, vout) => {
    const satoshis = readU64(bytes, cursor);
    const scriptLength = readVarInt(bytes, cursor);
    const script = bytes.subarray(cursor.offset, cursor.offset + scriptLength).toString("hex");
    cursor.offset += scriptLength;
    return { txid, vout, satoshis, script };
  });
  const lockTime = readU32(bytes, cursor);
  if (cursor.offset !== bytes.length) throw new Error("trailing transaction bytes");
  return { txid, version, lockTime, inputs, outputs };
};

class PinnedTransactionView {
  constructor(rawHex) {
    const parsed = resultByRaw?.get(rawHex)?.parsed ?? parseTransaction(rawHex);
    this.hash = parsed.txid;
    this.inputs = parsed.inputs.map((input) => ({
      prevTxId: { toString: (encoding) => {
        if (encoding !== "hex") throw new Error("pinned transaction shim only supports hex txids");
        return input.txid;
      } },
      outputIndex: input.vout,
    }));
    this.outputs = parsed.outputs.map((output) => ({
      satoshis: output.satoshis,
      script: { toBuffer: () => Buffer.from(output.script, "hex") },
    }));
  }
}
globalThis.__tbcLibShim = {
  Transaction: PinnedTransactionView,
  Script: {
    buildPublicKeyHashOut(address) {
      if (address !== fixture.ownerAddress) throw new Error(`unexpected source address ${address}`);
      return { toBuffer: () => Buffer.from(fixture.feeUtxos[0].script, "hex") };
    },
  },
};
mkdirSync(join(compileRoot, "node_modules", "tbc-lib-js"), { recursive: true });
writeFileSync(
  join(compileRoot, "node_modules", "tbc-lib-js", "index.js"),
  "module.exports = globalThis.__tbcLibShim;\n",
);
const fragmentCleanup = loadPinnedModule("lib/tbc-engine/tbc-fragment-cleanup.ts");

const outpointKey = ({ txid, txId, vout, outputIndex }) => `${txid ?? txId}:${vout ?? outputIndex}`;
const initialKnownOutputs = new Map();
for (const source of fixture.sources) initialKnownOutputs.set(outpointKey(source.utxo), {
  satoshis: Number(source.utxo.satoshis), script: source.utxo.script,
});
for (const feeUtxo of fixture.feeUtxos) initialKnownOutputs.set(outpointKey(feeUtxo), {
  satoshis: Number(feeUtxo.satoshis), script: feeUtxo.script,
});
let knownOutputs;
let resultByRaw;
let maintenanceTransactions;
let counters;
let trace;

const resetRunState = () => {
  knownOutputs = new Map(initialKnownOutputs);
  resultByRaw = new Map();
  maintenanceTransactions = [];
  trace = [];
  counters = {
    mergeBuilder: 0,
    mergeDag: 0,
    mergeFundingPlanner: 0,
    finalFundingResolver: 0,
    transferBuilder: 0,
    transferFundingPlanner: 0,
  };
};

const registerTransactions = (result) => {
  if (!result || !Array.isArray(result.transactions)) throw new Error("pinned engine returned an invalid transaction result");
  for (const transaction of result.transactions) {
    if (typeof transaction.txraw !== "string") throw new Error("pinned engine omitted transaction raw bytes");
    const parsed = parseTransaction(transaction.txraw);
    if (!transaction.txid) throw new Error("pinned engine omitted the protocol txid");
    parsed.rawDoubleSha256 = parsed.txid;
    parsed.txid = transaction.txid;
    for (const output of parsed.outputs) output.txid = transaction.txid;
    let inputSat = 0;
    for (const input of parsed.inputs) {
      const value = knownOutputs.get(outpointKey(input));
      if (value === undefined) throw new Error(`unknown derived input ${outpointKey(input)}`);
      inputSat += value.satoshis;
    }
    const outputSat = parsed.outputs.reduce((sum, output) => sum + output.satoshis, 0);
    const feeSat = inputSat - outputSat;
    if (feeSat < 0) throw new Error("derived transaction has a negative fee");
    if (transaction.feeSat !== undefined && transaction.feeSat !== feeSat) throw new Error("pinned engine fee does not match parsed transaction");
    for (const output of parsed.outputs) knownOutputs.set(outpointKey(output), {
      satoshis: output.satoshis, script: output.script,
    });
    transaction.txid = parsed.txid;
    transaction.feeSat = feeSat;
    resultByRaw.set(transaction.txraw, { ...transaction, parsed });
  }
  return result;
};

const parseDispatchOutput = (stdout, operation) => {
  let value;
  try {
    value = JSON.parse(stdout);
    if (typeof value === "string") value = JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid ${operation} dispatcher JSON: ${error.message}`);
  }
  if (value?.error) throw new Error(`${operation} failed: ${JSON.stringify(value.error)}`);
  return value;
};
const dispatch = (operation, payload) => {
  if (!payload || typeof payload.requestJson !== "string") throw new Error(`${operation} wrapper supplied an invalid engine payload`);
  const child = spawnSync(engineBinary, ["--dispatch", operation], {
    input: payload.requestJson,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(`${operation} dispatcher failed: ${child.error?.message || child.stderr || child.stdout}`);
  }
  return parseDispatchOutput(child.stdout, operation);
};

const describeRaw = (rawTransaction) => {
  const parsed = resultByRaw.get(rawTransaction)?.parsed ?? parseTransaction(rawTransaction);
  const previousOutputs = parsed.inputs.map((input) => {
    const output = knownOutputs.get(outpointKey(input));
    if (!output) throw new Error(`missing authoritative previous output ${outpointKey(input)}`);
    return output;
  });
  const child = spawnSync(engineBinary, ["--describe"], {
    input: JSON.stringify({ rawTransaction, previousOutputs }),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(`transaction description failed: ${child.error?.message || child.stderr || child.stdout}`);
  const descriptor = JSON.parse(child.stdout);
  if (descriptor.rawTransaction !== rawTransaction) throw new Error("transaction descriptor changed raw bytes");
  return descriptor;
};

const tapeSlots = (transaction) => {
  const script = Buffer.from(transaction.outputs[1].script, "hex");
  if (script.length < 51) throw new Error("FT Tape output is shorter than six amount slots");
  const slots = script.subarray(3, 51);
  return Array.from({ length: 6 }, (_, index) => slots.readBigUInt64LE(index * 8).toString());
};

const nativeAssetTransactionEngine = {
  async buildMerge(payload) {
    counters.mergeBuilder += 1;
    const result = dispatch("buildMerge", payload);
    return registerTransactions(Array.isArray(result) ? { transactions: result } : result);
  },
  async buildFt(payload) {
    counters.transferBuilder += 1;
    const result = dispatch("buildFt", payload);
    return registerTransactions(Array.isArray(result) ? { transactions: result } : result);
  },
  async planFunding(payload) {
    const envelope = JSON.parse(payload.requestJson);
    if (envelope?.request?.operation === "merge") counters.mergeFundingPlanner += 1;
    else counters.transferFundingPlanner += 1;
    return dispatch("planFunding", payload);
  },
};

const sourceByOutpoint = new Map(fixture.sources.map((source) => [outpointKey(source.utxo), source]));
const executeNativeAssetMerge = async (request) => {
  trace.push({ call: "executeNativeAssetMerge" });
  if (request.kind !== "ft" || request.contract.contractTxid !== fixture.contract.contractTxid || request.threshold !== 5 || request.assetUtxos.length !== 6) {
    throw new Error("unexpected pinned high-level merge arguments");
  }
  const sources = request.assetUtxos.map((utxo) => {
    const source = sourceByOutpoint.get(outpointKey(utxo));
    if (!source) throw new Error(`unknown high-level asset ${outpointKey(utxo)}`);
    return {
      ...source,
      utxo: {
        ...source.utxo,
        txId: source.utxo.txid,
        ftBalance: source.utxo.ftBalanceRaw,
      },
    };
  });
  const mergeFundingPlan = await operations.planAssetMergeFunding({
    kind: "ft",
    engine: nativeAssetTransactionEngine,
    ...request.keySource,
    asset: request.contract,
    assetUtxos: sources.slice(0, 5).map(({ utxo }) => utxo),
    preTxs: sources.slice(0, 5).map(({ preTxRaw }) => preTxRaw),
    prePreTxData: sources.slice(0, 5).map(({ prePreTxData }) => prePreTxData),
  });
  if (mergeFundingPlan.requiredFundingSat > fixture.feeUtxos[0].satoshis) {
    throw new Error("pinned merge funding plan exceeds supplied fee UTXO");
  }
  const execution = await executeAssetMergeDag({
    kind: "ft",
    engine: nativeAssetTransactionEngine,
    ...request.keySource,
    asset: request.contract,
    sources,
    feeUtxos: fixture.feeUtxos.map((utxo) => ({ ...utxo, txId: utxo.txid })),
    threshold: request.threshold,
    deriveOutput(node, built, inputs) {
      if (!built.assetOutput || !built.prePreTxData) throw new Error(`merge node ${node.id} omitted derived ancestry`);
      const parsed = resultByRaw.get(built.txraw)?.parsed;
      const output = parsed?.outputs[built.assetOutput.outputIndex];
      if (!parsed || !output || built.assetOutput.txid !== parsed.txid || built.assetOutput.satoshis !== output.satoshis || built.assetOutput.script !== output.script) {
        throw new Error(`merge node ${node.id} asset output mismatch`);
      }
      const balance = inputs.reduce((sum, input) => sum + BigInt(input.utxo.ftBalanceRaw ?? input.utxo.ftBalance ?? 0), 0n);
      if (built.assetOutput.ftBalanceRaw !== balance.toString()) throw new Error(`merge node ${node.id} balance mismatch`);
      return {
        utxo: { txId: parsed.txid, outputIndex: built.assetOutput.outputIndex, satoshis: output.satoshis, script: output.script, ftBalanceRaw: balance.toString(), ftBalance: balance.toString() },
        preTxRaw: built.txraw,
        prePreTxData: built.prePreTxData,
      };
    },
    async broadcastLevel(transactions) {
      for (const transaction of transactions) {
        if (!resultByRaw.has(transaction.txraw)) throw new Error(`merge node ${transaction.id} was not built by pinned engine`);
        maintenanceTransactions.push(transaction);
      }
      return transactions.map((transaction) => ({ id: transaction.id, status: "accepted", txid: resultByRaw.get(transaction.txraw).parsed.txid }));
    },
  });
  if (execution.failed.length || execution.blocked.length || execution.accepted.length !== 1) {
    throw new Error(`pinned merge DAG did not complete its threshold-five node: ${JSON.stringify(execution)}`);
  }
  counters.mergeDag += 1;
  const terminal = maintenanceTransactions.at(-1);
  const terminalParsed = resultByRaw.get(terminal.txraw).parsed;
  const terminalFunding = {
    ...terminalParsed.outputs[2],
    txId: terminalParsed.outputs[2]?.txid,
    outputIndex: terminalParsed.outputs[2]?.vout,
  };
  if (!terminalFunding) throw new Error("merge transaction omitted terminal fee output 2");
  return {
    sources: execution.spendableValues,
    terminalFundingCandidates: [terminalFunding],
    acceptedFundingTransactions: maintenanceTransactions.map(({ txraw }) => ({ txraw })),
    hasOperationFunding: true,
    initialSourceCount: sources.length,
    remainingSourceCount: execution.spendableValues.length,
    acceptedTransactionCount: execution.accepted.length,
    timings: {
      ancestryMs: 0,
      transactionFetchCount: sources.length,
      rawResponseBytes: sources.reduce((sum, source) => sum + source.preTxRaw.length / 2, 0),
      peakRawInFlight: sources.length,
      parentFetchMs: 0,
      inspectMs: 0,
      grandparentFetchMs: 0,
      proveMs: 0,
      feePoolMs: 0,
      dagMs: 0,
    },
  };
};

const resolveNativeAssetOperationFunding = async (request) => {
  trace.push({ call: "resolveNativeAssetOperationFunding" });
  const result = await fragmentCleanup.resolveOperationTbcFunding({
    candidates: request.candidates,
    acceptedTransactions: request.acceptedTransactions,
    requiredSatoshis: request.requiredFundingSat,
    consolidate: (candidates) => fragmentCleanup.consolidateTbcFundingCandidates({
      address: request.address,
      utxos: candidates,
      requiredSatoshis: request.requiredFundingSat,
      build: async () => { throw new Error("single terminal funding candidate unexpectedly required consolidation"); },
      broadcast: async () => { throw new Error("single terminal funding candidate unexpectedly required broadcast"); },
    }),
    selectFresh: async () => { throw new Error("public transfer unexpectedly requested fresh funding"); },
  });
  counters.finalFundingResolver += 1;
  return { feeUtxo: result.funding, operationLocal: result.operationLocal };
};

const getOptimalFtUtxos = evaluateInitializer("getOptimalFtUtxos", {
  UTXO_LIMITS: { tbcSend: 1000, tbcMerge: 5000, tbcMergeFanIn: 1000, tokenSend: 100, tokenMerge: 500 },
  selectOptimalUtxoValues,
});
const parseDecimalToBigInt = (value, decimals) => {
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error(`invalid decimal amount ${text}`);
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error("amount exceeds decimal precision");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
};

const runOnce = async (amount) => {
  resetRunState();
  const dependencies = {
    calculateFee(txHex) {
      const raws = Array.isArray(txHex) ? txHex.map(({ txraw }) => txraw) : [txHex];
      return raws.reduce((sum, raw) => {
        const built = resultByRaw.get(raw);
        if (!built) throw new Error("fee requested for a non-derived transaction");
        return sum + built.feeSat;
      }, 0);
    },
    cleanupNativeAssetWalletFunding: async () => undefined,
    executeNativeAssetMerge,
    formatAssetRawAmount,
    getDomain: () => "https://pinned.invalid",
    getFundingUTXO: async () => { throw new Error("unexpected external funding lookup"); },
    getOptimalFtUtxos: (...args) => {
      trace.push({ call: "getOptimalFtUtxos" });
      return getOptimalFtUtxos(...args);
    },
    getUrl: (value) => value,
    loadNativeAsset: async (kind, contractId, address) => {
      if (kind !== "ft" || contractId !== fixture.contract.contractTxid || address !== fixture.ownerAddress) throw new Error("unexpected pinned asset load arguments");
      return {
        contract: {
          ...fixture.contract,
          totalSupply: fixture.contract.totalSupplyRaw,
        },
        utxos: fixture.sources.map(({ utxo }) => ({
          ...utxo,
          txId: utxo.txid,
          ftBalance: utxo.ftBalanceRaw,
        })),
      };
    },
    nativeAssetTransactionEngine,
    nativeKeySourceForAddress: (keySource, address) => {
      if (address !== fixture.ownerAddress || keySource.privateKey !== fixture.key) throw new Error("unexpected pinned key source");
      return keySource;
    },
    parseDecimalToBigInt,
    planFtBatchTransferFunding: operations.planFtBatchTransferFunding,
    planFtTransferFunding: async (...args) => {
      trace.push({ call: "planFtTransferFunding" });
      return operations.planFtTransferFunding(...args);
    },
    planNativeAssetSendLimit,
    planStableCoinBatchTransferFunding: async () => { throw new Error("stablecoin path is out of comparator scope"); },
    planStableCoinTransferFunding: async () => { throw new Error("stablecoin path is out of comparator scope"); },
    reportNativeAssetMergePerformance: () => undefined,
    resolveNativeAssetOperationFunding,
    runWithTbcFundingRecovery: async ({ initialCandidates, run }) => {
      if (initialCandidates.length !== 1) throw new Error("pinned high-level path did not expose terminal funding");
      return run(() => undefined);
    },
    selectOptimalUtxoValues: (...args) => {
      trace.push({ call: "selectOptimalUtxoValues" });
      return selectOptimalUtxoValues(...args);
    },
    t: (key) => key,
    buildFtBatchTransfer: operations.buildFtBatchTransfer,
    buildFtTransfer: async (...args) => {
      trace.push({ call: "buildFtTransfer" });
      return operations.buildFtTransfer(...args);
    },
    buildStableCoinBatchTransfer: async () => { throw new Error("stablecoin path is out of comparator scope"); },
    buildStableCoinTransfer: async () => { throw new Error("stablecoin path is out of comparator scope"); },
  };
  const buildNativeAssetTransfer = evaluateInitializer("buildNativeAssetTransfer", dependencies);
  const result = await buildNativeAssetTransfer({
    kind: "ft",
    contractId: fixture.contract.contractTxid,
    addressFrom: fixture.ownerAddress,
    keySource: { privateKey: fixture.key },
    recipient: fixture.recipient,
    amount,
  });
  const primaryRaw = typeof result.txHex === "string" ? result.txHex : undefined;
  if (!primaryRaw || maintenanceTransactions.length !== 1) throw new Error("pinned public transfer did not derive maintenance plus primary raws");
  const chain = [maintenanceTransactions[0].txraw, primaryRaw].map(describeRaw);
  return {
    result,
    maintenanceRaw: maintenanceTransactions[0].txraw,
    primaryRaw,
    chain,
    counters: { ...counters },
    trace: [...trace],
  };
};

const baseline = await runOnce(fixture.amount);
const mutatedAmount = (BigInt(fixture.amount) - 1n).toString();
const mutated = await runOnce(mutatedAmount);
const differingPrimarySighashIndexes = baseline.chain[1].digests
  .map((digest, index) => digest !== mutated.chain[1].digests[index] ? index : undefined)
  .filter((index) => index !== undefined);
const mutation = {
  success: true,
  fromAmount: fixture.amount,
  toAmount: mutatedAmount,
  maintenanceRawChanged: baseline.maintenanceRaw !== mutated.maintenanceRaw,
  primaryRawChanged: baseline.primaryRaw !== mutated.primaryRaw,
  primaryTapeSlotsBefore: tapeSlots(baseline.chain[1]),
  primaryTapeSlotsAfter: tapeSlots(mutated.chain[1]),
  differingPrimarySighashIndexes,
};
if (mutation.maintenanceRawChanged || !mutation.primaryRawChanged || differingPrimarySighashIndexes.length === 0) {
  throw new Error(`600-to-599 mutation did not produce the expected causal differences: ${JSON.stringify(mutation)}`);
}

const wrapperExecuted = Object.fromEntries(Object.entries(baseline.counters).map(([name, count]) => [name, count > 0]));
if (Object.values(wrapperExecuted).some((value) => !value)) throw new Error(`not all pinned wrappers executed: ${JSON.stringify(baseline.counters)}`);
process.stdout.write(`${JSON.stringify({
  hookSha256,
  sourceSha256: hookSha256,
  executed: true,
  entrypoint: "hooks/use-ft-transaction.tsx#buildNativeAssetTransfer",
  inputSchemaVersion: fixture.schemaVersion,
  selectedInputCount: fixture.sources.length,
  mergeRequested: true,
  maintenanceRaw: baseline.maintenanceRaw,
  primaryRaw: baseline.primaryRaw,
  chain: baseline.chain,
  fee: baseline.result.fee,
  wrapperExecuted,
  trace: baseline.trace,
  mutation,
})}\n`);
