import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export const PIN = "923497e8b2473c0e179fa0b86dbb32a2f188d25a";
export const NORMALIZATION = "ecdsa-signature-pushes-only";

export const SCENARIOS = Object.freeze([
  "create-standard-plan-1", "create-standard-plan-2", "create-standard-plan-3",
  "create-standard-plan-4", "create-standard-plan-5", "create-standard-plan-6",
  "create-locked-plan-1", "add-standard", "add-locked", "remove-standard",
  "remove-locked", "close-standard", "close-locked",
  "swap-tbc-for-token-standard", "swap-tbc-for-token-locked",
  "swap-token-for-tbc-standard", "swap-token-for-tbc-locked",
  "pool-ft-no-merge-threshold", "ftlp-no-merge-threshold", "pool-ft-merge",
  "ftlp-merge-standard", "ftlp-merge-locked", "pool-ft-multi-round",
  "ftlp-multi-round", "simultaneous-pool-ft-and-ftlp-maintenance",
]);

export const COMPARED_FIELDS = Object.freeze([
  "header", "version", "lock-time", "input-outpoints-order-sequences",
  "output-amounts-scripts-order", "pool-state", "reserve-and-value-deltas",
  "fee-and-change", "dependency-graph", "stage-and-role",
  "signing-association", "digest-and-sighash", "finalized-covenant-suffix",
  "finalized-parent-txid-child-outpoint",
]);

export const GUARDS = Object.freeze([
  "process-a-missing", "wrong-pin", "process-a-imports-production-core",
  "process-b-imports-source-harness", "process-b-receives-source-expected-values",
  "comparator-starts-before-producers-exit", "mutate-input-outpoint",
  "mutate-input-sequence", "mutate-output-script", "mutate-output-amount",
  "mutate-pool-tape-field", "mutate-fee-change", "mutate-dependency",
  "mutate-signing-association", "mutate-pool-unlock-suffix",
  "mutate-ft-swap-index-tag", "mutate-ft-coin-flag", "mutate-ftlp-lock-field",
  "reorder-maintenance", "reorder-auxiliary-parent", "missing-primary",
  "extra-public-maintenance-operation", "unregistered-normalization",
  "shared-manifest", "shared-output-file", "shared-process-state",
  "producer-input-hash", "producer-output-hash", "provenance-source-hash",
  "provenance-target-symbol", "declaration-shaped-decoy", "self-comparison",
  "unclassified-vendor-file",
]);

export class ProtocolError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ProtocolError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new ProtocolError(code, message); };
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const canonical = (path) => realpathSync(path);
const text = (path) => readFileSync(path, "utf8");
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function requireRegularFile(path, code) {
  try {
    if (!statSync(path).isFile()) fail(code, `${path} is not a regular file`);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    fail(code, `${path} is missing`);
  }
}

function assertNoForbiddenImport(path, pattern, code) {
  if (pattern.test(text(path))) fail(code, `${path} contains a forbidden cross-process import`);
}

function containsForbiddenExpectedValue(value, key = "") {
  if (/^(sourceExpected|sourceOutput|expectedFromSource|processAOutput)$/i.test(key)) return true;
  if (Array.isArray(value)) return value.some((item) => containsForbiddenExpectedValue(item));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([childKey, child]) =>
      containsForbiddenExpectedValue(child, childKey));
  }
  return false;
}

function exactFunctionDeclaration(source, symbol) {
  const escaped = escapeRegExp(symbol);
  return new RegExp(
    `^(?:\\s*#\\[[^\\n]+\\]\\s*\\n)*\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:unsafe\\s+)?fn\\s+${escaped}\\s*(?:<[^\\n{]*>)?\\s*\\(`,
    "m",
  ).test(source);
}

function filesBelow(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(root, path) : [relative(root, path)];
  });
}

function validateProvenance(provenance) {
  for (const field of ["sourcePath", "targetPath"]) {
    requireRegularFile(provenance?.[field], "PROVENANCE_MISSING_FILE");
  }
  if (sha256(provenance.sourcePath) !== provenance.sourceSha256) {
    fail("PROVENANCE_SOURCE_HASH", "pinned source bytes differ from the recorded hash");
  }
  if (!exactFunctionDeclaration(text(provenance.sourcePath), provenance.sourceSymbol)) {
    fail("PROVENANCE_SOURCE_SYMBOL", "exact source function declaration is absent");
  }
  if (!exactFunctionDeclaration(text(provenance.targetPath), provenance.targetSymbol)) {
    fail("PROVENANCE_TARGET_SYMBOL", "exact target function declaration is absent");
  }
  const classified = new Set(provenance.classifiedVendorPaths ?? []);
  const unclassified = filesBelow(provenance.vendorRoot).filter((path) => !classified.has(path));
  if (unclassified.length !== 0) {
    fail("UNCLASSIFIED_VENDOR_FILE", `unclassified vendored file: ${unclassified[0]}`);
  }
}

export function describeContract() {
  return {
    pin: PIN,
    scenarios: SCENARIOS,
    comparedFields: COMPARED_FIELDS,
    normalization: NORMALIZATION,
    processes: [
      "pinned-source-producer",
      "production-core-producer",
      "independent-raw-comparator",
    ],
    guardCount: GUARDS.length,
  };
}

export function validateRunState(state) {
  assert.equal(state.schemaVersion, 1, "Task 7 protocol schema");
  const a = state.processA;
  const b = state.processB;
  const comparator = state.comparator;
  if (!a?.executable) fail("PROCESS_A_MISSING", "Process A declaration is absent");
  requireRegularFile(a.executable, "PROCESS_A_MISSING");
  if (state.pin !== PIN || a.pin !== PIN || b?.pin !== PIN) {
    fail("WRONG_PIN", `all phases must use ${PIN}`);
  }
  for (const [producer, code] of [[a, "PROCESS_A_MISSING"], [b, "PROCESS_B_MISSING"]]) {
    for (const field of ["manifest", "source", "input", "output"]) {
      requireRegularFile(producer?.[field], code);
    }
  }

  if (canonical(a.manifest) === canonical(b.manifest)) {
    fail("SHARED_MANIFEST", "producers resolve to the same manifest");
  }
  if (canonical(a.output) === canonical(b.output)) {
    fail("SHARED_OUTPUT_FILE", "producers resolve to the same output file");
  }
  if (!a.stateNonce || a.stateNonce === b.stateNonce) {
    fail("SHARED_PROCESS_STATE", "producer state nonces must be distinct");
  }

  assertNoForbiddenImport(
    a.manifest,
    /tbc-engine-core|task7-production-core/i,
    "PROCESS_A_IMPORTS_PRODUCTION_CORE",
  );
  assertNoForbiddenImport(
    a.source,
    /tbc_engine_core|task7-production-core/i,
    "PROCESS_A_IMPORTS_PRODUCTION_CORE",
  );
  assertNoForbiddenImport(
    b.manifest,
    /task7-source-(?:producer|harness)|source-harness/i,
    "PROCESS_B_IMPORTS_SOURCE_HARNESS",
  );
  assertNoForbiddenImport(
    b.source,
    /task7_source_(?:producer|harness)|source-harness/i,
    "PROCESS_B_IMPORTS_SOURCE_HARNESS",
  );

  let processBInput;
  try {
    processBInput = JSON.parse(text(b.input));
  } catch {
    fail("PROCESS_B_INPUT", "Process B input is not JSON");
  }
  if (containsForbiddenExpectedValue(processBInput)) {
    fail("PROCESS_B_SOURCE_EXPECTED_VALUES", "Process B input contains source-derived expected values");
  }

  if (a.status !== "exited" || b.status !== "exited") {
    fail("START_ORDER", "both producers must exit before comparison");
  }
  if (!Number.isSafeInteger(a.exitedAt) || !Number.isSafeInteger(b.exitedAt)
      || !Number.isSafeInteger(comparator?.startedAt)
      || comparator.startedAt <= Math.max(a.exitedAt, b.exitedAt)) {
    fail("START_ORDER", "comparator start must be strictly after both producer exits");
  }

  for (const [producer, label] of [[a, "A"], [b, "B"]]) {
    if (sha256(producer.input) !== producer.inputSha256) {
      fail("INPUT_HASH", `Process ${label} input hash mismatch`);
    }
    if (sha256(producer.output) !== producer.outputSha256) {
      fail("OUTPUT_HASH", `Process ${label} output hash mismatch`);
    }
  }
  if (a.outputSha256 === b.outputSha256 || text(a.output) === text(b.output)) {
    fail("SELF_COMPARISON", "producer artifacts are identical");
  }
  if (!Array.isArray(state.normalizations)
      || state.normalizations.length !== 1
      || state.normalizations[0] !== "ecdsa-signature-pushes") {
    fail("UNREGISTERED_NORMALIZATION", "only ECDSA signature pushes may be normalized");
  }
  validateProvenance(state.provenance);
  return state;
}
