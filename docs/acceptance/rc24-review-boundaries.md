# rc.24 review boundaries

Follow-up: the permission/session commit-expiry finding below was subsequently
reproduced through the installed rc.24 Provider and fixed in the isolated rc.25
candidate. See `release/candidates/kit-stress-rc25/REPORT.md` for the new evidence.
The original rc.24 report and sealed artifacts remain unchanged.

This task fixes NFT batch entry selection, expiry/error propagation and partial
results. It uses the actual Client → Provider → wallet → Host → Core → WASM
Engine lifecycle with public synthetic signer material and a recording submit
adapter, not only mocked plans. It also runs the adjacent adversarial Core/Kit
tests. This is not an exhaustive real-chain test of every asset or platform.

## Additional source finding to track separately

`source/packages/core/src/reducers/committing.ts:reduceCommitClock` still throws
`TwsApprovalError(RECEIPT_EXPIRED)` before permission/session commit. Existing
`permissions.test.mjs` verifies refusal and no unauthorized commit, and passed
8/8 in this review. The same Host generic-error mapping may obscure the public
reason there. This is **not an NFT broadcast path**, was not changed here, and
has not been independently reproduced through an installed Provider in this
task. Do not count its public error classification as fixed or accepted.

Next bounded slice: inject expiry during connection/permission or network-switch
approval through the real Provider, preserve the zero-commit guarantee, and if
the public reason is lost, return the existing typed terminal error contract.
No fund movement, new material fetching or transaction resend is needed.

## Intentional boundaries

- No deadline extension, no automatic refresh/retry of expired task materials.
- No automatic continuation of an uncertain POST. Reconcile its original txid.
- Batch-job exact inputs/fee preferences are not silently adopted: they fail
  clearly unless represented by the supported whole-task contract.
- `accepted`/`known` means submission outcome, not block confirmation.
- Swift/Kotlin computation artifacts are byte-identical; this does not constitute
  new on-device UI, bridge or real-network acceptance.
- The Flutter partner delivery is intentionally unchanged, not silently synced.
- A passing finite stress suite cannot prove absence of all possible bugs.
