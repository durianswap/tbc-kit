# Public merge maintenance example

`run.mjs` uses only the public `@tbc/kit` API:

1. `wallet.tbc.merge()`
2. `wallet.tbc20.merge({ contractId })`
3. `wallet.amm.mergeToken({ poolContractId })`
4. `wallet.tbc20Lp.merge({ poolContractId })`

These are the recommended shared business entries. Each operation is available
only for supported templates: pool-token merge requires an eligible historical
Pool2, not a current AMM pool. Shared naming does not add unsupported contract
operations or fall back after an execution failure.

The DApp does not provide raw UTXOs, outpoints, amounts, fee inputs, or ancestry.
The wallet resolves a bounded deterministic candidate set and treats each call as
one independent primary transaction. Calls are intentionally sequential in this
example so the wallet never presents four concurrent approvals; applications
should normally invoke only the maintenance action chosen by the user.

Read-only index and proof requests may use bounded retry and same-request
single-flight. Approval, signing, and broadcast are never retried implicitly.
