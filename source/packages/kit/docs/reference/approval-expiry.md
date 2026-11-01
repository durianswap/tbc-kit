# Approval expiry and partial results

An expired approval does not authorize another signature, submission, permission
write or network switch. The wallet must not extend its deadline automatically.

For Provider operations, inspect `error.code === 4100` and
`error.data.reason === "RECEIPT_EXPIRED"`. `data.stage` may identify the stopping
boundary (such as `commit`); `operationId` identifies the original operation.
Display an expiry message, not an internal-wallet failure. A permissions or
network-switch expiry before commit leaves the previous permissions/session
unchanged. Tampered bindings and invalid acknowledgments remain invalid.

For transaction submission, retain any `submittedTransactionIds`,
`uncertainTransactionIds`, `rejectedTransactionIds` and
`notSubmittedTransactionIds` returned with the error. Accepted/known submission
does not mean block confirmation. Reconcile an uncertain original txid before
any new user action; never retry the whole original bundle automatically.

`tbc721.batchMint` returns a task result instead: inspect `status`, `reason`,
`minted` and `batches[].transactions`, including `recoveryId` when provided.
`partial / expired` preserves completed work; it is not a rollback. A newly
approved task may target only slots that are still available after reconciliation.
See [NFT tasks](../nft.md) for whole-task budgets and the one-approval adapter.

If a native approval fence rejects because the user waited past the whole-job
deadline, Kit refreshes the wallet-owned clock and returns `stopped / expired`,
with `minted: 0` and no signatures or submissions. It does not require the native
adapter to manufacture an approved receipt after expiry. A cancelled task returns
`stopped / cancelled`. Adapter failures before the deadline and invalid returned
consent bindings remain errors; they must not be disguised as normal expiry.
