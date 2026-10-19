#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
SOURCE_REPO=${TBC_SOURCE_WALLET_REPO:-/Users/alex/Documents/Codex/2026-08-29/k/turing-wallet}
PIN=923497e8b2473c0e179fa0b86dbb32a2f188d25a
HARNESS="$ROOT/packages/tbc-engine/rust/comparators/ft-source-harness"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/tbc-ft-source.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

git -C "$SOURCE_REPO" cat-file -e "$PIN^{commit}"
git -C "$SOURCE_REPO" archive "$PIN" | tar -x -C "$TMP"
EXPORTED="$TMP/modules/tbc-transaction-engine/rust"
test -f "$EXPORTED/vendor/tbc-sdk/src/contracts/ft/builder.rs"
test -f "$EXPORTED/src/lib.rs"
cp -R "$HARNESS" "$EXPORTED/ft-source-harness"

(cd "$EXPORTED" && cargo run --offline --quiet --manifest-path ft-source-harness/Cargo.toml) \
  > "$TMP/pinned-ft-vector.json"
test "$(jq -r .pin "$TMP/pinned-ft-vector.json")" = "$PIN"
jq '{
  schemaVersion: "1",
  key: .walletOrchestrationInputs.key,
  ownerAddress: .owner.address,
  recipient: .recipient,
  contract: .walletOrchestrationInputs.contract,
  sources: .walletOrchestrationInputs.sources,
  feeUtxos: .walletOrchestrationInputs.feeUtxos,
  amount: .walletOrchestrationInputs.amount
}' "$TMP/pinned-ft-vector.json" > "$TMP/wallet-orchestration-inputs.json"
jq '. + {expectedRaw: "00"}' "$TMP/wallet-orchestration-inputs.json" \
  > "$TMP/wallet-orchestration-forbidden.json"
if env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  node "$EXPORTED/ft-source-harness/run-wallet-orchestration.mjs" \
  "$TMP/hooks/use-ft-transaction.tsx" \
  "$TMP/wallet-orchestration-forbidden.json" \
  "$ROOT/node_modules/typescript/lib/typescript.js" \
  "$EXPORTED/ft-source-harness/target/debug/ft-source-harness" \
  > "$TMP/forbidden-output.json" 2> "$TMP/forbidden-error.txt"; then
  echo "expected-raw input injection unexpectedly succeeded" >&2
  exit 1
fi
grep -F "unknown input keys: expectedRaw" "$TMP/forbidden-error.txt" >/dev/null

# Process A: pinned source derivation. This process receives no expectation path or bytes.
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  node "$EXPORTED/ft-source-harness/run-wallet-orchestration.mjs" \
  "$TMP/hooks/use-ft-transaction.tsx" \
  "$TMP/wallet-orchestration-inputs.json" \
  "$ROOT/node_modules/typescript/lib/typescript.js" \
  "$EXPORTED/ft-source-harness/target/debug/ft-source-harness" \
  > "$TMP/wallet-high-level.json"

# Process B starts only after process A exits and is the first process to read both files.
node "$EXPORTED/ft-source-harness/compare-wallet-output.mjs" \
  "$TMP/pinned-ft-vector.json" \
  "$TMP/wallet-high-level.json" \
  > "$TMP/pinned-ft-vector-with-wallet.json"
mv "$TMP/pinned-ft-vector-with-wallet.json" "$TMP/pinned-ft-vector.json"
if [[ -n "${TBC_FT_COMPARATOR_OUTPUT:-}" ]]; then
  cp "$TMP/pinned-ft-vector.json" "$TBC_FT_COMPARATOR_OUTPUT"
fi

TBC_PINNED_FT_VECTOR="$TMP/pinned-ft-vector.json" \
  cargo test --offline --manifest-path "$ROOT/packages/tbc-engine/rust/Cargo.toml" \
  -p tbc-engine-core --test ft pinned_source_comparator -- --ignored --exact
