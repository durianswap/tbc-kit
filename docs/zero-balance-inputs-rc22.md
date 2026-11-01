# rc.22: zero-balance holder input selection

This record describes the rc.22 zero-balance fix, retained in later versions; use the [installation guide](installation.md) for the currently selected JS/Native pair. The original rc.22 archives and pre-publication candidate report are preserved as evidence. The Flutter partner delivery remains independently paired.

- JS/TS candidate: `@tbc/kit@0.1.0-rc.22`.
- Paired Native SDK: `0.1.0-rc.19.native.2`, reused byte-for-byte because no Rust, protocol, schema, template or signing algorithm changes are required.
- Protocol fingerprint: `8c2a5a935335463ecedef622011c187c645a9130df1b18610b0fba1262504ce9`.
- Candidate artifacts and evidence: `release/candidates/zero-balance-rc22/`.
- Caller behavior: [zero-balance input guide](../source/packages/kit/docs/zero-balance-inputs.md).

The fix is in the common Chain Data reader and a safe Core error mapping, not in an acceptance App. The public index client preserves valid zero balances; automatic holder selection filters them before parent or confirmation reads. Explicitly selected zero holders fail with a typed reason. Pool reserve/state zeros are not removed.

Verification uses controlled HTTP responses and public fixture keys through DApp client → Provider → Host → the frozen WASM Engine → approval → signing → finalize → mock submission. Compare positive-only and zero-polluted indexes: generated transactions, unique GETs and approval counts must match. Negative tests keep malformed/duplicate data, proof and explicit-input boundaries. No live account is signed, no real POST occurs, and successful historical transactions are not replayed.

This candidate is not a new Flutter distribution and does not claim iOS/Android device or live-chain acceptance. Native installation/identity checks are separate from device execution. Follow the delivery lock when pairing JS and Native resources.
