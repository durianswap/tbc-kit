# Current Engine acceptance

`npm run test:tbc-engine` is a required gate for the current Rust-backed Engine:

1. Build the public TS facade and run **all** current `*.test.mjs` files: package/export boundaries, async injected WASM portability, current protocol plan identity, native envelope errors, iOS deployment, provenance and repository invariants.
2. Run the complete `tbc-engine-core` Rust suite offline with the lockfile frozen. This is mandatory, not a fallback or skipped platform check.
3. Execute the existing real Native/WASM artifact runner, including Core/Host approval, signing, rejection and controlled broadcast/recovery paths. No live chain transaction is sent by this gate.

## Retired implementation tests and replacement coverage

The source TS implementations (`bytes.ts`, `p2pkh.ts`, `transaction.ts`, `signature.ts`, `validate.ts`, etc.) were already removed during the Rust migration. Their tests still attempted to import those files and call an async Engine synchronously. Restoring that second transaction implementation would violate the current architecture.

The seven former tests are preserved verbatim, apart from an archival comment, in `retired-ts/*.reference`; they are not runnable current tests and are not included in package files. They have been replaced, not counted as passing or silently skipped:

| Former TS test | Required current coverage |
| --- | --- |
| bytes/address, transaction codec | Rust wire/signing and transfer malformed material, previous-output and consensus-byte cases; Native/WASM frozen vectors |
| crypto vectors, finalize | Rust signing and `tbc_transfer_*signature*`, exact task set, wrong key/digest/high-S rejection; Native/WASM four methods |
| normalize/plan | Rust `tbc_transfer_planning_is_deterministic_and_canonically_orders_inputs`, explicit inputs, fee/change/dust/funding boundaries |
| semantic validation | Rust `tbc_transfer_validation_*`, expiry/cardinality/approval/chain safety tests; frozen plan comparisons |
| Core integration | `check-rust-runtime-artifacts.mjs`: actual artifact → Core → Host, external signing, approval rejection and controlled submission/recovery |

Do not reintroduce deleted TS implementation helpers just to make historical tests run. Do not remove the Rust or artifact steps from the required command. Frozen historical evidence must keep its original identities; current known answers bind readable Chain IDs.
