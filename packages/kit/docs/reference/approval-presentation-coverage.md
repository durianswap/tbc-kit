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
  `businessTerms`, `assets`, `actualFeeAtomic` and `signingTaskCount`.
  Top-level `assets` is flattened summary data and must not be used to infer
  step ownership.
- Preserve every `unknown` value as unknown. Never display it as zero, empty or
  verified, and never infer display precision from an unrelated token.

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
