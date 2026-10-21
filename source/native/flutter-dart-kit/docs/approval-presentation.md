# Native approval presentation

The shared Swift/Kotlin `NativeCustody` supplies display data to the wallet's
`NativeApprovalPresenter`. The wallet owns its visual design and authentication;
it does not need to reimplement TBC intent parsing or fetch approval data.

## Render the complete operation

Keep `origin`, `chainId`, `accountAddress`, `title` and `description` visible.
`description` remains the complete text fallback, including specialized message,
typed data, lock conditions, order terms, AMM fee configuration and signing roles.
For a structured view, also render every `steps` entry:

| Field | Meaning |
| --- | --- |
| `id`, `kind`, `description` | Step identity, method and its complete bounded terms/dependencies |
| `assets` | Asset label/identifier, atomic amount, amount rule, recipient and direction |
| `warnings` | Step-specific risks, plus validated Engine warnings when available |
| `actualFeeAtomic` | Bound actual network fee; absent until known |
| `transactions`, `transactionsStatus` | Chain transaction IDs, roles, dependencies, template commitments and fees after binding; not workflow steps |

Do not replace the specialized `description` with only the asset rows. Some
operations, such as an empty AMM creation, have configuration rather than an
asset transfer. A missing asset row does not mean a harmless signature.
Use scrollable text/details, full addresses and contract IDs. Never combine
different assets because their symbols happen to match. `pool:<id>` denotes
a pool reference, not a token contract ID or a recipient address.

Amounts are decimal integer strings in atomic units. Keep large values exact.
`amountRule` distinguishes `exact-intent`, `budget`, `minimum`,
`maximum-or-unknown`, `selected-balance`, `collection-capacity` and `bound-plan`.
Missing amounts are unknown, not zero. Unknown decimal precision must not be
guessed; showing clearly labelled atomic units is valid.

For a multi-transaction step, `assetsStatus` remains `step-summary-only`; do not
repeat those aggregate amounts in each transaction. The matching Engine now
supplies separate `outputs` with the exact output indices, asset identity,
atomic balance, destination, native value and lock/warnings. Render these as
**output balances**, including change/intermediate/pool outputs, not user debits.
`outputsStatus` is `available`, `partial` (unknown scripts remain explicit), or
`not-available` for older plans. Never hide an unrecognized output or label its
native value as the token balance. Code/Tape and Code/Hold/Tape form one row.
`code-identity:` is not an API contract ID; script/controller references are not
ordinary recipient addresses. No extra metadata/API reads are required.
`templateHash` identifies the bound template, not a broadcast txid. Reviewed/raw
transactions keep their specialized output view when generic rows are unavailable.

For known AMM/Pool send flows lacking `to`, the bound request's `poolContractId`
retains the pool destination through the formal update. Explicit recipients,
incoming flows and network-fee rows are never overwritten by that fallback.
Risk identifiers for destruction, locks, message authority and HTLC preimage
disclosure match the JS presentation. Order creation retains factual order terms
without adding a generic escrow/future-fill notice.

## One approval, two phases

1. `present(review, complete)` receives `phase = intent-bounded`. Show the
   operation scope, all recipients/amount bounds and risks immediately while
   the existing parallel preparation continues. Approve once for the whole
   bounded batch; reject/close returns false once.
2. After the existing formal checks succeed, `update(review)` receives the
   same operation ID with `phase = binding-verified`. This contains actual
   Engine asset flows/fees where available. Refresh the existing details or
   progress view. **Do not open another approval or call `complete` again.**

`update` has a default no-op to preserve existing integrations. Implement it
to surface the new actual-flow details after early consent; an older wallet
that only implements `present` still has the complete bounded text fallback,
but does not automatically gain this new UI. Examples of the adapter body:

```swift
func update(_ review: NativeReview) {
    // Replace existing display state for review.operationId on MainActor.
    // Do not approve, sign, query the network or create a second modal.
    approvalDetails.replace(review)
}
```

```kotlin
override fun update(review: NativeReview) {
    // Same custody executor; enqueue rendering without blocking on I/O.
    approvalDetails.replace(review)
}
```

The installation package includes compilable adapters in
`example/ios/PartnerApprovalPresenter.swift` and
`example/android/PartnerApprovalPresenter.kt`. Supply `show` and `refresh`
callbacks that render the full review. `show` returns a handle that closes
only the decision controls; retain a progress/details area for `refresh`.
Call `finish(operationId:)` / `finish(operationId)` when the wallet observes
completion, cancellation, account lock or session termination. A close/reject
gesture must answer false, never approve implicitly. The adapter does no
network I/O and ignores duplicate or stale decision callbacks.

`approvalDetails` is wallet-owned UI state, not a Kit API. Wallet renderers must
not mutate the transaction request based on the display model. The signer
continues to recheck the current account/session immediately before key use.
Cancellation or account changes during a display update still invalidate the
operation. Updates are ephemeral and do not add a database write.

No chain lookup, metadata lookup, new Engine plan or second approval is required
by this presentation. Keep binding/task checks, parallel preparation and
transaction execution unchanged. Preserve original specialized evidence for
unknown scripts; a warning is not a full anti-phishing or simulation verdict.

The test-only `ApprovalDisplayDevice` harness exercises the same native classes
with public signature replay on iOS/Android. It does not provide test keys,
network access or real broadcast, and is not included in installation packages.
