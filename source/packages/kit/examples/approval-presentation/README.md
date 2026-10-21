# Unified approval presentation

Run from an installed candidate:

```sh
node node_modules/@tbc/kit/examples/approval-presentation/run.mjs
```

The example uses only public `@tbc/kit/wallet` exports and controlled data. It
shows the two deliberately different phases. `run.mjs` constructs controlled
evidence only to demonstrate the pure projector; it is not the integration
pattern and must not be copied to fabricate a Host envelope:

- `projectTbcApprovalPreparation(...)` renders the exact early intent scope
  without waiting for Chain Data or planning. It is explicitly non-authorizing
  and lists requested steps and risk notices. Actual fee, asset flows and
  signing count remain unknown; requested step count is already known.
- `projectTbcApprovalPresentation(...)` consumes the exact formal Host evidence
  returned by `createApprovalHostEvidenceReader(...).read(callId, bindingHash)`.
  It verifies Core binding, request, plan and preview hashes before returning a
  renderable model, including the exact hash-bound business intent. Prepared
  proposals and resolved dynamic execution material are not exposed as terms.

Both functions are synchronous pure projections. They perform no API request,
parent transaction read, Engine planning, persistence, approval, signing or
broadcast. Atomic values are never silently treated as display values: when
precision is absent from bound evidence it remains explicitly `unknown`.

Use `createApprovalCallback(...)` from `host-reader-callback.mjs` as the wallet
integration pattern. Pass the exact same session Host store to
`openSession({ execution: { hostStore } })` and to the callback factory. The
callback reads by the real `call.callId` and bound `bindingHash`, then projects
and renders the verified envelope. Its `show` payload includes both the generic
`presentation` and `specializedEvidence` from that same validated Host read, so
mixed workflows can render their actual message, typed-data, binding and raw
transaction details without another read. `renderer.mjs` renders workflow
ownership from `steps[]`; its top-level `summaryAssets` is intentionally only
an aggregate.

Render each step's `warnings` rather than only the batch warning list. The
reviewed-transaction step includes its own bound outputs; it must not disappear
from a mixed batch's asset summary. Use scrollable details for all recipients
and full asset identifiers, without silently truncating the last steps.

Render `transactions` within each transaction step (or at the root for a single
transaction request). These are chain-transaction rows, not workflow steps:
show the ID, role, dependencies, network fee and template commitment. A template
commitment is **not a txid**. `transactionsStatus` distinguishes not-yet-bound,
available, unavailable and non-transaction operations.

The Engine's aggregate `assetFlows` remain `assetsStatus = step-summary-only`
for a multi-transaction step. Separate `outputs` now disclose each transaction's
output groups, balances, destination references, locks and warnings. These
include change, intermediate funding and pool reserves: do not sum them as user
debits. `outputsStatus = partial` means some script details remain unknown;
retain that warning and the known native value. Never repeat step totals on
every transaction or pretend unfamiliar scripts are fully classified.
Keep the step asset summary and specialized review visible. Single-transaction
steps can attribute that summary to their one transaction. For known AMM/Pool
operations, a missing send destination retains `pool:<poolContractId>` from the
verified bound request; explicit destinations and network-fee rows are unchanged.
The pool reference is not an address. These projections add no API reads.

The unified model does not replace specialized permission, message,
typed-data, dynamic-binding, reviewed-raw-transaction, associated-input or
crypto detail views. Those details are not present in the current presentation
model and must stay visible in their existing dedicated approval UI. The
callback therefore requires `requestSpecializedApproval` for every non-
transaction/workflow operation instead of allowing it to skip directly to a
decision.

## Explicit contract signing roles

An AMM request may select a `pool-controller` separately from the fee/asset
account. Render `presentation.signingRoles` beside `accountId` in both the early
intent view and the formal view; do not collapse it into the primary account.
The early field is intent-bounded, while the formal field is checked against
Host-resolved accounts and the hash-bound Engine preview. This renderer retains
the field. Existing single-account presentations omit it entirely.

Only after the wallet's UI handles this field, declare
`approval.supportedSigningRoles: ["pool-controller"]` next to its `request`
callback. Kit refuses a role-bearing formal approval before calling a UI that
has not declared support. The declaration is not a grant: every selected
account still needs its own current-session permissions. A matching contract
controller key does not authorize an unrelated wallet account.

The Signer must route each task by its exact `accountId` and `publicKey`, not by
the primary account alone. One approval can cover the planned roles across
parent-dependent signing stages, but no private key belongs in the request,
Prepared proposal, material loader or Engine. This is current source support;
installed candidates and platform UIs need separate verification.
