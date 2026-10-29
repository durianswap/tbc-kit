# Independent wallet integration example

Run this from a clean installation of the final `@tbc/kit` tarball:

```sh
node node_modules/@tbc/kit/examples/independent-wallet/run.mjs
```

The example identifies itself as `org.example.independent-wallet` and imports
only public `@tbc/kit`, `@tbc/kit/api`, `@tbc/kit/engine`, and `@tbc/kit/wallet` entry points.
It proves the following controlled path without Mobile/Turing source imports,
private workspace packages, live network I/O, POST, or broadcast:

1. Kit's default Testnet network resolves chain data and policy.
2. `createTbcEngine()` loads the package-local WASM file in Node without a
   caller-supplied backend.
3. `wallet.walletBuild.signWorkflow(composeTbcWorkflow(...))` submits a TBC
   transaction and its dependent message as one Standard request. The workflow
   has one bound approval and two signing calculations, in addition to the
   separate initial connection approval. `legacy: false` is explicit.
4. The shared workflow derives signed transaction IDs and binds them into the
   message's JSON `settlement` field. The example recomputes each txid, checks
   the final message data, reconstructs its digest and verifies the signature.
   It does not use a private associated journal or separate dependent coordinator.
5. One shared metadata resolver supplies FT transfer and a historical Pool swap;
   the already-loaded FT metadata is reused by the Pool path.

`controlled-platform.mjs` is deliberately an offline test driver. Its scalar-1
signer is public fixture material and is never suitable for funds. A production
wallet replaces that entire signer closure with its Vault, Secure Enclave,
hardware wallet, or audited native module. Kit passes only the approved digest
and task identity to the private signer and never accepts a private key through
the DApp request or public transaction builder.

The transaction/message workflow performs one controlled UTXO read. This
ordinary transfer does not need a chain-height query. The
separate legacy metadata mapping check performs two more reads, reusing FT
metadata; it does not construct or sign a Pool swap. No old Pool creation is
demonstrated. Both paths reject unexpected HTTP requests in the fixture.

The retained `createMemoryAssociatedJournal` fixture export is historical and
unused by this example. New wallets should not add it to this sign-only path.
Production adapters still own durable permission storage and, when broadcasting
is explicitly enabled, the submit journal and unknown-result reconciliation.
This example neither configures nor exercises a real broadcaster. Do not use
its in-memory permissions, automatic approval or public test signer for funds.
