import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

const ancestry = read("rust/crates/tbc-engine-core/src/ancestry.rs");
const integration = read("rust/crates/tbc-engine-core/tests/nft_stablecoin.rs");
const source = read("rust/comparators/task6-source-harness/src/main.rs");
const runner = read("rust/comparators/task6-production-core/src/main.rs");
const compare = read("rust/comparators/task6-source-harness/compare.mjs");

assert.match(ancestry, /const MAX_STABLECOIN_SUPPLY_RAW: u128 = 1_000_000_000_000_000_000;/);
assert.match(ancestry, /expected_stablecoin_mint_tape/);
assert.match(ancestry, /minted Tape lock time must be zero/);
assert.match(ancestry, /StableCoin name changed across mint lineage/);
assert.match(ancestry, /StableCoin symbol changed across mint lineage/);

for (const name of [
  "stablecoin_mint_supply_limit_is_exact",
  "stablecoin_mint_rejects_exact_tape_and_metadata_mutations",
  "stablecoin_authenticates_multiple_mint_transitions",
  "public_family_specific_signature_negatives_cover_v0_v1_and_second_stage",
  "public_rejects_cross_operation_and_cross_family_continuations",
  "public_second_stage_distinguishes_artifact_from_approval_mismatch",
]) {
  assert.match(ancestry + integration, new RegExp(`fn ${name}\\b`), name);
}

assert.match(source, /nftTransferV0/);
assert.match(source, /nftV0Recipient/);
assert.match(runner, /nftTransferV0/);
assert.match(runner, /canonicalSignatureNeutralRaw/);
assert.match(runner, /covenantSuffix/);

assert.doesNotMatch(compare, /if \(name === "stablecoinMerge"[^}]*continue/s);
for (const token of [
  "assertNftOperation",
  "assertStableRound2",
  "canonicalSignatureNeutralRaw",
  "publicKey",
  "sighashType",
  "digest",
  "inputIndex",
  "planDependencies",
  "allowedDivergences",
]) {
  assert.match(compare, new RegExp(token), token);
}

console.log("task6 round2 guardrails: ok");
