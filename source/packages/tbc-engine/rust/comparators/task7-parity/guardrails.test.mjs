import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rustRoot = fileURLToPath(new URL("../..", import.meta.url));
const runner = fileURLToPath(
  new URL("../../scripts/compare-task7-source.sh", import.meta.url),
);
const pin = "923497e8b2473c0e179fa0b86dbb32a2f188d25a";

const scenarios = Object.freeze([
  "create-standard-plan-1",
  "create-standard-plan-2",
  "create-standard-plan-3",
  "create-standard-plan-4",
  "create-standard-plan-5",
  "create-standard-plan-6",
  "create-locked-plan-1",
  "add-standard",
  "add-locked",
  "remove-standard",
  "remove-locked",
  "close-standard",
  "close-locked",
  "swap-tbc-for-token-standard",
  "swap-tbc-for-token-locked",
  "swap-token-for-tbc-standard",
  "swap-token-for-tbc-locked",
  "pool-ft-no-merge-threshold",
  "ftlp-no-merge-threshold",
  "pool-ft-merge",
  "ftlp-merge-standard",
  "ftlp-merge-locked",
  "pool-ft-multi-round",
  "ftlp-multi-round",
  "simultaneous-pool-ft-and-ftlp-maintenance",
]);

const comparedFields = Object.freeze([
  "header",
  "version",
  "lock-time",
  "input-outpoints-order-sequences",
  "output-amounts-scripts-order",
  "pool-state",
  "reserve-and-value-deltas",
  "fee-and-change",
  "dependency-graph",
  "stage-and-role",
  "signing-association",
  "digest-and-sighash",
  "finalized-covenant-suffix",
  "finalized-parent-txid-child-outpoint",
]);

const guards = Object.freeze([
  "process-a-missing",
  "wrong-pin",
  "process-a-imports-production-core",
  "process-b-imports-source-harness",
  "process-b-receives-source-expected-values",
  "comparator-starts-before-producers-exit",
  "mutate-input-outpoint",
  "mutate-input-sequence",
  "mutate-output-script",
  "mutate-output-amount",
  "mutate-pool-tape-field",
  "mutate-fee-change",
  "mutate-dependency",
  "mutate-signing-association",
  "mutate-pool-unlock-suffix",
  "mutate-ft-swap-index-tag",
  "mutate-ft-coin-flag",
  "mutate-ftlp-lock-field",
  "reorder-maintenance",
  "reorder-auxiliary-parent",
  "missing-primary",
  "extra-public-maintenance-operation",
  "unregistered-normalization",
  "shared-manifest",
  "shared-output-file",
  "shared-process-state",
  "producer-input-hash",
  "producer-output-hash",
  "provenance-source-hash",
  "provenance-target-symbol",
  "declaration-shaped-decoy",
  "self-comparison",
  "unclassified-vendor-file",
]);

function run(...args) {
  return spawnSync("bash", [runner, ...args], {
    cwd: rustRoot,
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
    },
  });
}

test("declares the complete immutable Task 7 parity matrix", () => {
  const result = run("--describe-matrix");
  assert.equal(result.status, 0, result.stderr);
  const description = JSON.parse(result.stdout);
  assert.equal(description.pin, pin);
  assert.deepEqual(description.scenarios, scenarios);
  assert.deepEqual(description.comparedFields, comparedFields);
  assert.equal(description.normalization, "ecdsa-signature-pushes-only");
  assert.deepEqual(description.processes, [
    "pinned-source-producer",
    "production-core-producer",
    "independent-raw-comparator",
  ]);
  assert.equal(description.guardCount, guards.length);
});

for (const guard of guards) {
  test(`rejects ${guard} for its intended reason`, () => {
    const result = run("--guard", guard);
    assert.equal(result.status, 0, `${guard}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), `TASK7_GUARD_OK ${guard}`);
  });
}
