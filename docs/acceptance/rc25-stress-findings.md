# rc.25 expanded stress findings

## Confirmed runtime defect

The installed rc.24 package correctly stopped an expired permission request or
network switch, but `reduceCommitClock` threw a `TwsApprovalError`. The outer
Host/Provider path converted this into a generic `-32603` response. That is an
error-classification defect, not evidence that an expired approval committed.

Evidence: `evidence/rc24-extreme-red/`. The test invokes the installed Provider,
not just the reducer. The isolated rc.25 fix returns the existing terminal
`4100 / RECEIPT_EXPIRED` contract with `stage: commit` and the operation ID.
Negative controls assert zero permission writes and no chain switch; positive
controls ensure nonexpired operations still work. No transaction I/O is used.

Source change: `source/packages/core/src/reducers/committing.ts`. This is the
only additional runtime fix after the sealed rc.24 NFT batch candidate. The
Native/WASM compute libraries, signature algorithms and protocol are unchanged.

## Test findings that were not runtime defects

- Source-only exports do not include every workspace's generated `dist`. Build
  those outputs in an isolated test workspace, not into frozen distribution files.
- A recovery-count test instrumented the workspace copy of `@noble/curves` while
  the installed package used its own dependency instance. Instrument the selected
  package's instance; ESM and CJS each still require exactly one key recovery.
- An FT comparison assumed the baseline lacked a contract ID. The newer baseline
  includes it. Verify both asset identities before comparing the compatible
  preview fields; retain exact transaction/signing-digest comparisons.
- A session-expiry assertion expected a generic failure. The typed expiry result
  is the intended contract. The test still requires no additional signer calls.
- Raw heap growth before garbage collection was not sufficient evidence of a
  leak. Repeat independent sessions with explicit GC and report retained heap;
  this is not proof against all possible long-running leaks.

These changes correct test setup/expectations. None raises business limits,
extends approval expiry or removes transaction validation.

## Stress scope and interpretation

The new matrix combines actual Provider/Host/Core/WASM execution with synthetic
chain data and submission: 40 seeded fault positions, 500 competing requests,
160 invalid requests, cancellation at batch boundaries, unknown/reconciled
submission, long UTF-8 metadata and 30 complete independent sessions. Existing
adjacent Kit/Core/Host/Provider and Rust contract suites extend asset coverage.

Timing under concurrent compilation is retained separately and is not used to
claim production regression. Paired timing after the test/compile workload ends
has its own evidence. Neither local timing set represents iOS/Android bridge,
human approval or live API latency.

Final candidate results and exact artifact hashes are recorded in
`release/candidates/kit-stress-rc25/REPORT.md` and `delivery-lock.json`.
The published package, sealed rc.24 candidate and Flutter partner delivery are
not replaced. No successful real transaction is resent.
