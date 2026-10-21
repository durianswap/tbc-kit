# Approval presentation

This is the current source-backed boundary for the unified approval projector.
For every transaction intent below, `businessTerms` is the exact normalized
intent covered by the request hash. Asset flows, actual fee and transaction and
signing counts come only from the bound Engine preview/plan. Prepared methods
reuse the same checks; the proposal itself and resolved dynamic material are
not presented as business terms.


## Renderer contract

- For a transaction, render `businessType`, `businessTerms`, `assets`, actual
  and maximum fee, transaction/signing counts, warnings and binding provenance.
- For a workflow, render each `steps[]` entry with its own `businessType`,
  `businessTerms`, `assets`, `actualFeeAtomic`, `signingTaskCount` and `warnings`.
  Top-level `assets` is flattened summary data and must not be used to infer
  step ownership.
- Preserve every `unknown` value as unknown. Never display it as zero, empty or
  verified, and never infer display precision from an unrelated token.
- Render `transactions` and `transactionsStatus` at the root or within each
  step. Each chain transaction has its own ID, role, dependencies, template
  commitment (not a txid) and network fee. `outputs` contains Engine-bound output
  groups with output indices, asset identity, atomic balance, recipient/reference,
  native value, lock and warnings. Code/Tape and NFT Code/Hold/Tape are one group.
  These are output balances, including change, intermediate funding and pool
  reserves, **not net user debits**. Keep the step summary; never sum or duplicate
  its totals into the individual transaction rows.
  `assetsStatus: step-summary-only` still refers to the aggregate flows, not the
  separate `outputs`. `outputsStatus: partial` exposes unrecognized scripts with
  their native value and an explicit warning; it never invents a token amount.
  An older Engine without output metadata keeps `not-available` and the existing
  limitation warning. Do not claim unknown scripts are fully decoded.
- Missing AMM/Pool send destinations can use `pool:<poolContractId>` only from
  the bound request and a known Pool operation. Preserve explicit destinations;
  never assign network fees or incoming flows to the pool by this fallback.

## Early consent and completed material

`projectTbcApprovalPreparation` now lists the requested steps, dependency IDs,
bound intent terms and operation risks without waiting for chain data. The
requested amount, minimum received, maximum spent and selected-balance scope
are distinct terms: an estimate or minimum must never be labelled as an exact
transfer. The step count is known from the request; asset flows, actual fees
and signing count remain unknown until the existing bound plan is available.

The formal projector preserves each step's Engine asset flows, including
`reviewedTransactionPreview.assetFlows` for a reviewed raw transaction inside
a mixed workflow. It must not flatten away recipients or discard reviewed
outputs. Amounts remain decimal integer strings in atomic units.

Render each step's risks before consent, alongside all recipients and bounds.
Burning LP is not withdrawing reserves; locking assets restricts spending;
message signatures can authorize later actions; HTLC claims disclose their
preimage in signed bytes (never put the preimage in the approval model).
These warnings supplement, not replace, Engine warnings and specialized views.

Updating the same operation with verified plan details is informational, not
a new approval. Early consent is valid only inside its existing bound intent,
fee limits, roles and session. If those checks fail, stop; never update the
display and treat that as permission for a changed request. One batch approval
also does not imply atomic execution of multiple on-chain transactions.

## Deliberately outside the unified model

The current model does not contain permission scopes/caveats, message bytes and
domain/sign-in context, typed-data domain/types/message, dynamic-binding source
and target, reviewed raw transaction bytes and associated inputs/dependencies,
or crypto algorithm and payload policy. Wallets must retain those dedicated
views. Stablecoin input evidence and Pool construction material also remain in
their operation-specific validation/detail layers.

The projector is pure. Do not add API or parent reads, Engine planning,
persistence, approval, signing or broadcast to presentation. Production
integration must read the authoritative checkpoint with
`createApprovalHostEvidenceReader` from the same session Host store; consumers
must never construct an evidence envelope or binding themselves.

## Bound output identity

`code-identity:` is an owner-independent contract-code identity, not a genesis
contract ID returned by an indexer. `script-sha256:` and `contract-controller:`
are explicit script/controller references, not recipient addresses. Symbols
and decimal precision must not be inferred. No scripts, witnesses, keys or HTLC
preimages are copied into output rows.

The Engine derives output rows from the already constructed transaction, and
reproduces them during its existing validation. They are part of the plan hash
and approval binding. Editing a row or rehashing forged rows cannot substitute a
different transaction. This additional metadata changes plan hashes, not raw
transactions, signing digests or fees. Pair the updated schema/projector with
the matching Engine; do not mix artifacts or silently update frozen plans.
