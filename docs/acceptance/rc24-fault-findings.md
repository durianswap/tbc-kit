# NFT task fault-injection findings

Controlled, offline investigation. No funds or real broadcasts were used.

The frozen rc.23 reproduction is preserved in `rc23-mint100-diagnosis.md` and
`evidence/rc23-mint100-repro`. Its completed 100-item normal lifecycle took
approximately 95 seconds in that Node/WASM fixture. Injecting expiry after the
33rd accepted submission produced a generic Provider error with no partial
result. This is not evidence of a 33-item contract ceiling.

## Additional failures found during the fix

1. At the exact end of a ten-item chunk, all ten submissions were accepted but
   `acceptValidatedBatch` rejected the now-expired observation. The outer result
   said `execution-failed`. Accounting for an already accepted result must remain
   possible; it is not permission to sign another batch. The next snapshot and
   all normal execution gates retain the original deadline.
2. The job wrapper validated a typed `{portError}` from submit as a successful
   submit result. This threw before Host/Core's existing reconciliation path;
   the fault test saw zero reconcile calls. The wrapper now forwards typed
   failures unchanged to Host, reuses the one existing reconcile call, and
   updates local outcomes from its validated result. Unknown stays unknown and
   is not re-sent.
3. Actual Engine fee exhaustion reports `FEE_CAP_EXCEEDED`. The orchestrator's
   mock-based fee-budget test passed, while the real Engine path returned
   `preparation-failed` (observed both before any effect and after a prior batch).
   The private adapter now maps only that exact typed Engine error to
   `fee-budget`. It does not enlarge the budget, resize to evade it, or reread.
4. Approval-clock and finalization-clock expiry threw generic reducer errors;
   signing-clock expiry already returned 4100 but lacked a machine-readable
   reason. The three gates now return terminal 4100 / `RECEIPT_EXPIRED` with
   stage and operation ID. Binding mismatch, clock rollback and mutation checks
   are retained.

## Test harness corrections, not product defects

- The first new fixture used dust 24 instead of the frozen TBC721 policy's 42;
  Engine correctly rejected it. The fixture was corrected, not the policy.
- Clean-install discovery tests initially registered wallets into the source
  checkout's separate Wallet Standard dependency instance. The test loader now
  resolves both registration and client discovery to the installed dependency.
- Three wider Core tests initially could not load omitted development dist
  entries. The in-memory source loader now supplies Host and release exports;
  no frozen dist files were edited to satisfy the test.
- A draft busy error used an invalid Provider payload; the real Provider test
  caught it. The final response uses the existing -32000 execution-error schema
  (`CONFLICT`, validation, non-retryable, `details.reason=NFT_JOB_BUSY`).

The final implementation also keeps the original monotonic job timer. A draft
refreshed the local clock after every sub-batch; that was removed before sealing
because a coarse/fixed clock must not reset elapsed time. Expired material now
reports a typed stop directly. No extra clock calls or network reads are needed.

Pre-seal build and regression logs are retained in the three
`release/candidates/nft-job-rc24-preseal-*` directories. They are NOT release
candidates to install. Only the sealed `nft-job-rc24` directory is the handoff.
