#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
SOURCE_REPO=${TBC_SOURCE_WALLET_REPO:-/Users/alex/Documents/Codex/2026-08-29/k/turing-wallet}
PIN=923497e8b2473c0e179fa0b86dbb32a2f188d25a
HARNESS="$ROOT/packages/tbc-engine/rust/comparators/task6-source-harness"
CORE_RUNNER="$ROOT/packages/tbc-engine/rust/comparators/task6-production-core/Cargo.toml"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/tbc-task6-source.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

git -C "$SOURCE_REPO" cat-file -e "$PIN^{commit}"
git -C "$SOURCE_REPO" archive "$PIN" | tar -x -C "$TMP"
EXPORTED="$TMP/modules/tbc-transaction-engine/rust"
cp -R "$HARNESS" "$EXPORTED/task6-source-harness"
cat > "$TMP/inputs.json" <<'JSON'
{"ownerScalar":1,"recipientScalar":2,"adminScalar":3}
JSON
# Process A receives inputs only and executes code exported from the pinned Git object.
(cd "$EXPORTED" && cargo run --offline --quiet --manifest-path task6-source-harness/Cargo.toml < "$TMP/inputs.json") > "$TMP/source.json"
# The production-core runner is physically separate and executes the actual current core crate.
cargo run --offline --quiet --manifest-path "$CORE_RUNNER" < "$TMP/source.json" > "$TMP/core.json"
# Process B starts only after both derivation processes exit successfully.
node "$EXPORTED/task6-source-harness/compare.mjs" "$TMP/source.json" "$TMP/core.json"
for mutation in signer-key signer-digest signer-role signer-stage dependency duplicate-signer duplicate-dependency v0-recipient fee-change-field signer-suffix v0-recipient-unrelated; do
  node "$EXPORTED/task6-source-harness/compare.mjs" "$TMP/source.json" "$TMP/core.json" --expect-reject "$mutation" >/dev/null
done
