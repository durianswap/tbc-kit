#!/usr/bin/env bash
set -euo pipefail

RUST_ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROTOCOL="$RUST_ROOT/comparators/task7-parity/protocol.mjs"
GUARD_RUNNER="$RUST_ROOT/comparators/task7-parity/run-guard.mjs"

case "${1:-}" in
  --describe-matrix)
    node --input-type=module -e \
      'const { pathToFileURL } = await import("node:url"); const protocol = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(JSON.stringify(protocol.describeContract()) + "\n");' \
      "$PROTOCOL"
    ;;
  --guard)
    test -n "${2:-}" || { printf '%s\n' 'TASK7_GUARD_REQUIRED' >&2; exit 2; }
    exec node "$GUARD_RUNNER" "$2"
    ;;
  "")
    printf '%s\n' 'TASK7_IMPLEMENTATION_INCOMPLETE pinned-source-producer production-core-producer independent-raw-comparator' >&2
    exit 2
    ;;
  *)
    printf 'TASK7_UNKNOWN_ARGUMENT %s\n' "$1" >&2
    exit 2
    ;;
esac
