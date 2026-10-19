import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARDS, PIN, ProtocolError, validateRunState } from "./protocol.mjs";
import { ComparisonError, compareEvidence } from "./raw-comparator.mjs";
import { fixturePair, transaction, editRaw, flipOutput, ftPreTx } from "./locator-fixtures.mjs";

const guard = process.argv[2];
if (!GUARDS.includes(guard)) {
  process.stderr.write(`TASK7_UNKNOWN_GUARD ${guard ?? ""}\n`);
  process.exit(2);
}

const implemented = new Map([
  ["process-a-missing", "PROCESS_A_MISSING"],
  ["wrong-pin", "WRONG_PIN"],
  ["process-a-imports-production-core", "PROCESS_A_IMPORTS_PRODUCTION_CORE"],
  ["process-b-imports-source-harness", "PROCESS_B_IMPORTS_SOURCE_HARNESS"],
  ["process-b-receives-source-expected-values", "PROCESS_B_SOURCE_EXPECTED_VALUES"],
  ["comparator-starts-before-producers-exit", "START_ORDER"],
  ["mutate-input-outpoint", "INPUT_OUTPOINT"],
  ["mutate-input-sequence", "INPUT_SEQUENCE"],
  ["mutate-output-script", "OUTPUT_SCRIPT"],
  ["mutate-output-amount", "OUTPUT_AMOUNT"],
  ["mutate-pool-tape-field", "POOL_TAPE_FIELD"],
  ["mutate-fee-change", "FEE_CHANGE"],
  ["mutate-dependency", "DEPENDENCY"],
  ["mutate-signing-association", "SIGNING_ASSOCIATION"],
  ["mutate-pool-unlock-suffix", "POOL_UNLOCK_SUFFIX"],
  ["mutate-ft-swap-index-tag", "FT_SWAP_INDEX_TAG"],
  ["mutate-ft-coin-flag", "FT_COIN_FLAG"],
  ["mutate-ftlp-lock-field", "FTLP_LOCK_FIELD"],
  ["reorder-maintenance", "MAINTENANCE_ORDER"],
  ["reorder-auxiliary-parent", "AUXILIARY_PARENT_ORDER"],
  ["missing-primary", "MISSING_PRIMARY"],
  ["extra-public-maintenance-operation", "EXTRA_PUBLIC_MAINTENANCE"],
  ["unregistered-normalization", "UNREGISTERED_NORMALIZATION"],
  ["shared-manifest", "SHARED_MANIFEST"],
  ["shared-output-file", "SHARED_OUTPUT_FILE"],
  ["shared-process-state", "SHARED_PROCESS_STATE"],
  ["producer-input-hash", "INPUT_HASH"],
  ["producer-output-hash", "OUTPUT_HASH"],
  ["provenance-source-hash", "PROVENANCE_SOURCE_HASH"],
  ["provenance-target-symbol", "PROVENANCE_TARGET_SYMBOL"],
  ["declaration-shaped-decoy", "PROVENANCE_TARGET_SYMBOL"],
  ["self-comparison", "SELF_COMPARISON"],
  ["unclassified-vendor-file", "UNCLASSIFIED_VENDOR_FILE"],
]);

if (!implemented.has(guard)) {
  process.stderr.write(`TASK7_GUARD_NOT_IMPLEMENTED ${guard}\n`);
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "tbc-task7-protocol-"));
const aRoot = join(root, "source-a");
const bRoot = join(root, "production-b");
mkdirSync(aRoot);
mkdirSync(bRoot);
const file = (path, contents) => { writeFileSync(path, contents); return path; };
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function evidence(producer) {
  const value = fixturePair({ coin: true })[producer === "pinned-source" ? 0 : 1];
  for (const scenario of value.scenarios) for (const tx of scenario.transactions) delete tx.fieldLocators;
  return value;
}

function flipByte(raw, offset) {
  const bytes = Buffer.from(raw, "hex");
  bytes[offset] ^= 1;
  return bytes.toString("hex");
}

function scenarioWithCapability(output, capability) {
  const scenario = output.scenarios.find(({ capabilities }) => capabilities.includes(capability));
  assert.ok(scenario, `Task 7 guard fixture requires scenario capability ${capability}`);
  return scenario;
}

try {
  const a = {
    pin: PIN,
    executable: file(join(aRoot, "producer-a"), "isolated source executable\n"),
    manifest: file(join(aRoot, "Cargo.toml"), '[package]\nname="task7-source-producer"\n[dependencies]\ntbc-sdk={path="../vendor/tbc-sdk"}\n'),
    source: file(join(aRoot, "main.rs"), "fn main() {}\n"),
    input: file(join(aRoot, "input.json"), '{"fixtureSeed":"source-only"}\n'),
    output: file(join(aRoot, "output.json"), `${JSON.stringify(evidence("pinned-source"))}\n`),
    stateNonce: "source-a-state",
    status: "exited",
    exitedAt: 20,
  };
  const b = {
    pin: PIN,
    executable: file(join(bRoot, "producer-b"), "production core executable\n"),
    manifest: file(join(bRoot, "Cargo.toml"), '[package]\nname="task7-production-core"\n[dependencies]\ntbc-engine-core={path="../../crates/tbc-engine-core"}\n'),
    source: file(join(bRoot, "main.rs"), "fn main() {}\n"),
    input: file(join(bRoot, "input.json"), '{"intentSeed":"production-only"}\n'),
    output: file(join(bRoot, "output.json"), `${JSON.stringify(evidence("production-core"))}\n`),
    stateNonce: "production-b-state",
    status: "exited",
    exitedAt: 30,
  };
  a.inputSha256 = digest(a.input);
  a.outputSha256 = digest(a.output);
  b.inputSha256 = digest(b.input);
  b.outputSha256 = digest(b.output);
  const state = {
    schemaVersion: 1,
    pin: PIN,
    processA: a,
    processB: b,
    comparator: { startedAt: 31 },
    normalizations: ["ecdsa-signature-pushes"],
  };
  const provenanceRoot = join(root, "provenance");
  const vendorRoot = join(provenanceRoot, "vendor");
  mkdirSync(provenanceRoot);
  mkdirSync(vendorRoot);
  const sourcePath = file(join(provenanceRoot, "source.rs"), "pub fn released_pool_builder() {}\n");
  const targetPath = file(join(provenanceRoot, "target.rs"), "pub(crate) fn keyless_pool_builder() {}\n");
  const classifiedVendor = file(join(vendorRoot, "pool.rs"), "pub fn vendored_pool_math() {}\n");
  state.provenance = {
    sourcePath,
    sourceSha256: digest(sourcePath),
    sourceSymbol: "released_pool_builder",
    targetPath,
    targetSymbol: "keyless_pool_builder",
    vendorRoot,
    classifiedVendorPaths: ["pool.rs"],
  };

  if (guard === "process-a-missing") state.processA.executable = join(aRoot, "missing");
  else if (guard === "wrong-pin") state.processA.pin = "0".repeat(40);
  else if (guard === "process-a-imports-production-core") writeFileSync(a.manifest, readFileSync(a.manifest, "utf8") + 'tbc-engine-core={path="elsewhere"}\n');
  else if (guard === "process-b-imports-source-harness") writeFileSync(b.source, "use task7_source_harness::expected;\nfn main() {}\n");
  else if (guard === "process-b-receives-source-expected-values") writeFileSync(b.input, '{"sourceExpected":{"raw":"00"}}\n');
  else if (guard === "comparator-starts-before-producers-exit") state.comparator.startedAt = 30;
  else if (guard === "mutate-input-outpoint") {
    const changed = JSON.parse(readFileSync(b.output)); changed.scenarios[0].transactions[0].unsignedRaw = flipByte(changed.scenarios[0].transactions[0].unsignedRaw, 5); writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "mutate-input-sequence") {
    const changed = JSON.parse(readFileSync(b.output)); changed.scenarios[0].transactions[0].unsignedRaw = flipByte(changed.scenarios[0].transactions[0].unsignedRaw, 42); writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "mutate-output-script") {
    const changed = JSON.parse(readFileSync(b.output));
    flipOutput(changed.scenarios[0].transactions[0], 0, 0);
    writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "mutate-output-amount") {
    const changed = JSON.parse(readFileSync(b.output));
    editRaw(changed.scenarios[0].transactions[0], (tx) => { tx.outputs[0].satoshis = String(BigInt(tx.outputs[0].satoshis) ^ 1n); });
    writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "mutate-pool-tape-field") {
    const changed = JSON.parse(readFileSync(b.output));
    flipOutput(transaction(changed, "create-standard-plan-1"), 1, 68);
    writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "mutate-fee-change") {
    const changed = JSON.parse(readFileSync(b.output));
    const t = changed.scenarios[0].transactions[0]; editRaw(t, (tx) => { tx.outputs[t.changeIndex].satoshis = String(BigInt(tx.outputs[t.changeIndex].satoshis) ^ 1n); });
    writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "mutate-dependency") {
    const changed = JSON.parse(readFileSync(b.output)); changed.scenarios[0].transactions.at(-1).dependencies.push("missing-parent"); writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "mutate-signing-association") {
    const changed = JSON.parse(readFileSync(b.output)); changed.scenarios[0].transactions[0].signingRequests[0].digest = "00".repeat(32); writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "mutate-pool-unlock-suffix") {
    const changed = JSON.parse(readFileSync(b.output));
    editRaw(transaction(changed, "create-standard-plan-1"), (tx) => { const b = Buffer.from(tx.inputs[0].script, "hex"); b[b.length - 1] ^= 1; tx.inputs[0].script = b.toString("hex"); }, "finalizedRaw");
    writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "mutate-ft-swap-index-tag") {
    const changed = JSON.parse(readFileSync(b.output));
    editRaw(transaction(changed, "swap-tbc-for-token-standard"), (tx) => { const b = Buffer.from(tx.inputs[2].script, "hex"); b[b.length - ftPreTx(true).length - 2] = 0x51; tx.inputs[2].script = b.toString("hex"); }, "finalizedRaw");
    writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "mutate-ft-coin-flag") {
    const changed = JSON.parse(readFileSync(b.output));
    editRaw(transaction(changed, "swap-tbc-for-token-standard"), (tx) => { const b = Buffer.from(tx.inputs[2].script, "hex"); b[b.length - ftPreTx(true).length - 1] ^= 1; tx.inputs[2].script = b.toString("hex"); }, "finalizedRaw");
    writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "mutate-ftlp-lock-field") {
    const changed = JSON.parse(readFileSync(b.output));
    flipOutput(transaction(changed, "create-locked-plan-1"), 5, 52);
    writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "reorder-maintenance") {
    const changed = JSON.parse(readFileSync(b.output));
    const scenario = scenarioWithCapability(changed, "multiple-maintenance");
    const maintenance = scenario.transactions
      .map((transaction, index) => ({ transaction, index }))
      .filter(({ transaction }) => transaction.role === "maintenance");
    assert.ok(maintenance.length >= 2, "maintenance-order fixture requires at least two maintenance transactions");
    assert.equal(scenario.transactions.at(-1)?.role, "primary", "maintenance-order fixture must preserve final primary");
    const [first, second] = maintenance;
    [scenario.transactions[first.index], scenario.transactions[second.index]] = [second.transaction, first.transaction];
    assert.equal(scenario.transactions.at(-1)?.role, "primary", "maintenance-order mutation must preserve final primary");
    writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "reorder-auxiliary-parent") {
    const changed = JSON.parse(readFileSync(b.output));
    const scenario = scenarioWithCapability(changed, "ordered-auxiliary-parents");
    const primary = scenario.transactions.find(({ role }) => role === "primary");
    assert.ok(primary, "auxiliary-parent fixture requires a primary transaction");
    assert.ok(primary.auxiliaryParents.length >= 2, "auxiliary-parent fixture requires at least two ordered parents");
    const membership = [...primary.auxiliaryParents].sort();
    primary.auxiliaryParents.reverse();
    assert.deepEqual([...primary.auxiliaryParents].sort(), membership, "auxiliary-parent mutation must preserve membership");
    writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "missing-primary") {
    const changed = JSON.parse(readFileSync(b.output)); changed.scenarios[0].transactions.pop(); writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "extra-public-maintenance-operation") {
    const changed = JSON.parse(readFileSync(b.output));
    const scenario = scenarioWithCapability(changed, "multiple-maintenance");
    const transactionCount = scenario.transactions.length;
    const maintenance = scenario.transactions.find(({ role }) => role === "maintenance");
    assert.ok(maintenance, "public-maintenance fixture requires a maintenance transaction");
    maintenance.publicIntent = "tbc.pool.merge";
    assert.equal(maintenance.role, "maintenance", "public-maintenance mutation must preserve maintenance identity");
    assert.equal(scenario.transactions.length, transactionCount, "public-maintenance mutation must preserve topology");
    writeFileSync(b.output, `${JSON.stringify(changed)}\n`); b.outputSha256 = digest(b.output);
  }
  else if (guard === "unregistered-normalization") state.normalizations.push("fee-and-change");
  else if (guard === "shared-manifest") state.processB.manifest = state.processA.manifest;
  else if (guard === "shared-output-file") state.processB.output = state.processA.output;
  else if (guard === "shared-process-state") state.processB.stateNonce = state.processA.stateNonce;
  else if (guard === "producer-input-hash") writeFileSync(a.input, '{"fixtureSeed":"mutated"}\n');
  else if (guard === "producer-output-hash") writeFileSync(b.output, '{"producer":"production-core","artifacts":["mutated"]}\n');
  else if (guard === "provenance-source-hash") writeFileSync(sourcePath, "pub fn changed_pool_builder() {}\n");
  else if (guard === "provenance-target-symbol") state.provenance.targetSymbol = "missing_target_symbol";
  else if (guard === "declaration-shaped-decoy") writeFileSync(targetPath, "// pub(crate) fn keyless_pool_builder() {}\n");
  else if (guard === "self-comparison") {
    writeFileSync(b.output, readFileSync(a.output));
    b.outputSha256 = digest(b.output);
  }
  else if (guard === "unclassified-vendor-file") file(join(vendorRoot, "unclassified.rs"), "pub fn new_vendor_code() {}\n");

  try {
    validateRunState(state);
    compareEvidence(JSON.parse(readFileSync(a.output)), JSON.parse(readFileSync(b.output)));
    process.stderr.write(`TASK7_GUARD_FALSE_NEGATIVE ${guard}\n`);
    process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof ProtocolError || error instanceof ComparisonError) || error.code !== implemented.get(guard)) {
      process.stderr.write(`TASK7_GUARD_WRONG_REASON ${guard} ${error.code ?? error.name}: ${error.message}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`TASK7_GUARD_OK ${guard}\n`);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
