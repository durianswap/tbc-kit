import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");
const ancestry = read("rust/crates/tbc-engine-core/src/ancestry.rs");
const source = read("rust/comparators/task6-source-harness/src/main.rs");
const runner = read("rust/comparators/task6-production-core/src/main.rs");
const compare = read("rust/comparators/task6-source-harness/compare.mjs");
const launcher = read("rust/scripts/compare-task6-source.sh");
const deferredStableCoinRound3 = true;

if (!deferredStableCoinRound3) {
  assert.match(ancestry, /fn expected_updated_coin_nft_tape\b/);
  assert.match(ancestry, /coin_nft_tape_script\(&expected\)/);
  assert.match(ancestry, /StableCoin updated coin-NFT Tape is not byte-canonical/);
  assert.match(ancestry, /fn stablecoin_mint_rejects_noncanonical_coin_nft_state_bytes\b/);
  for (const mutation of ["leading-zero", "reordered-fields", "unknown-field", "whitespace", "escaped", "same-length-substitution"]) assert.match(ancestry, new RegExp(mutation));
  assert.match(compare, /function assertStablecoinPrimary/);
  for (const mutation of ["primary-input", "primary-output"]) assert.match(launcher, new RegExp(mutation));
}

assert.match(source, /sourceSigningRecipes/);
assert.match(source, /forkid_sighash/);
assert.match(source, /actualDependencies/);
assert.match(source, /covenantSuffix/);
assert.match(source, /transactionAssociation/);
for (const variant of ["nftTransferV0", "nftTransferV1", "nftTransferV2"]) assert.match(source, new RegExp(variant));

assert.match(runner, /value\["signingRequests"\] = stage_tasks\[stage_index\]\.clone/);
assert.match(runner, /value\["planDependencies"\] = template\["dependsOn"\]\.clone/);
assert.doesNotMatch(runner, /"signerRole":template/);
assert.doesNotMatch(runner, /"stage":stage_index/);

assert.match(compare, /export function compareResults/);
assert.match(compare, /function assertNftV0Parity/);
assert.match(compare, /exact normalized neutral raw/);
assert.match(compare, /exact normalized ForkID digest/);
assert.match(compare, /exact normalized covenant suffix/);
assert.match(compare, /encoded change output/);
assert.doesNotMatch(compare, /label === "signer-role"\) v0\.role/);
assert.match(compare, /label === "signer-role"[\s\S]*covenantSuffixes/);
assert.doesNotMatch(compare, /topologyIdentical/);

for (const mutation of ["signer-key", "signer-digest", "signer-role", "signer-stage", "dependency", "duplicate-signer", "duplicate-dependency", "v0-recipient", "fee-change-field", "signer-suffix", "v0-recipient-unrelated"]) assert.match(launcher, new RegExp(mutation));

console.log("task6 round3 guardrails: ok");
