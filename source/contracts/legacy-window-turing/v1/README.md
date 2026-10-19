# TBC Legacy contract

The `window.Turing` facade maps historical TBC DApp requests into the shared
wallet execution path. It exposes TBC methods only; other chain providers are
registered separately by the host wallet.

The contract version is `1.0.5`. Consumers pin `manifest.json` and its
bundle hash. Changing the method surface requires updating the contract,
transport types, page bootstrap and native controller together.

Baseline A describes connection, identity, errors and events. Baseline B stores
historical wire-format examples, including deprecated creation requests;
their presence does not enable those operations in the current wallet.
Supported asset operations are determined by the active TBC capability policy.

Messages retain the `pubkey` and `pubKey` aliases. Existing TBC transaction,
message, permission, approval and session semantics are unchanged by the
removal of unused cross-chain namespaces.

Run `node scripts/check-legacy-contract.mjs` from `source/` to check the
schema, method surface, vectors and bundle hash.
