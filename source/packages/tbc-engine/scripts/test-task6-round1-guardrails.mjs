import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("Task 6 round 1 production guardrails", () => {
  const nft = read("rust/crates/tbc-engine-core/src/families/nft.rs");
  const ancestry = read("rust/crates/tbc-engine-core/src/ancestry.rs");
  const signing = read("rust/crates/tbc-engine-core/src/signing.rs");

  assert.doesNotMatch(nft, /code_version\s*==\s*NftVersion::V0/);
  assert.match(nft, /validate_collection_origin/);
  assert.match(ancestry, /authenticate_stablecoin_mint_lineage/);
  assert.doesNotMatch(ancestry, /lock_time\.unwrap_or_default\(\)/);
  assert.match(signing, /legacy_current_tx_data/);
  assert.match(signing, /legacy_pre_pre_tx_data/);
  assert.match(signing, /legacy_pre_tx_data/);

  const comparator = read("rust/comparators/task6-production-core/src/main.rs");
  assert.match(comparator, /tbc_engine_core/);
  assert.match(comparator, /normalize/);
  assert.match(comparator, /validate/);
  assert.match(comparator, /plan/);
});
