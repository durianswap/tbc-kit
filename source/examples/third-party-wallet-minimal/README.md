# Minimal third-party TBC wallet

This private example proves that a wallet with no Turing Wallet source dependency can
complete a deterministic, arbitrary-amount TBC transfer lifecycle using only public
TWS packages. Its default run is fixture-backed and offline; it is not evidence of a
production wallet, a real network request, or chain acceptance.

This is a low-level single-transfer conformance example, not the recommended
full-feature integration starter. Use [Kit consumers](../kit-consumers/README.md)
for new integrations. Crypto, reviewed raw transactions and batch submission
are deliberately unsupported here and fail closed; the example never substitutes
multiple single POSTs for a batch API.

The boundary is deliberate:

- `src/dapp.ts` imports only `@tbc-wallet/provider` and can request accounts or send TBC.
- `src/wallet.ts` owns trusted context, Provider Session authority, durable Host, all nine
  Host Ports, approval binding verification, signing, and broadcast adaptation.
- Core always drives `normalize → plan → approval binding → signer.sign → finalize`.
- `src/fixtures.ts` contains public deterministic chain data only. The deterministic
  signing key exists only under `test/` and is not present in a publishable package.
- The in-memory Transport and Host store are conformance fixtures, not production
  persistence or an authenticated production bridge.
- Every Provider session owns its request-ID correlation map. Abort and pending close
  wait for Host cancellation through a request-start registration barrier, so even a
  same-tick close before operation-ID derivation cannot dispatch a later signer or
  broadcast Port, and a duplicate JSON-RPC ID in another session cannot be cancelled.
- Transport lifecycle reasons stay on the Provider signal. This minimal adapter maps
  every session-close cancellation to the authority-independent `TRANSPORT_CLOSED`
  Core reason; a production adapter may use `NAVIGATION_CHANGED`, `ORIGIN_CHANGED`, or
  `SESSION_REVOKED` only after committing the corresponding Authority change.

## Historical frozen Rust7 package set

The following archive identities describe the historical Rust7 acceptance only.
Current workspace tests compile against the installed workspace packages; these
archive hashes are preserved rather than relabelled as current delivery:

| Package | Version | Frozen archive SHA-256 |
| --- | --- | --- |
| Core | `1.0.0-draft.6.10` | `e43a310689badbc560f7e822ff5fe629cbb905ee5c6a67ddfecba77ef8d8b8f9` |
| Host | `1.0.0-draft.6.16` | `a63f821fcd2a52912cbfd89e5739abab6efc7b8fda5e2802085316d4356c3a9c` |
| Provider | `1.0.0-draft.6.11` | `02253536c28a132d4c05369061a1fd41e8fa9a8f64d22b36b0934a8d993afd96` |
| Engine | `1.0.0-draft.6.10.rust7` | `fa3294aabd84075e658effcc9d5a31c5f456fdc0949df977c731072536399e95` |
| Wallet Standard | `1.0.0-draft.6.11` | `c24296862f88c4333aebeb80795d2f796b19bbb560d293c101c14d93b5ebb503` |

The frozen bundled WASM SHA-256 is
`62da4b443a369eb74e30a183e4e4234705a9678c91dc72574881c27906d964e8`.
The wallet composition layer requires an explicit `TbcEngineBackend` and initializes
the Rust7 facade with `createTbcTransferEngine({ backend })`. The Node-only test helper
reads the installed package's fixed WASM bytes and passes them to the public
`createWasmTbcEngineBackend(bytes)` factory. Publishable DApp and wallet source does
not import `node:fs`, hide a remote fetch, or treat WASM bytes as secret material.
Network identity is bound by the public request, account, policy, and chain-data
contracts; the removed Draft `networks` option is not a compatibility API.

## What a production wallet still owns

This example supplies all nine Host Ports, but its implementations are deliberately
minimal. Before those Ports can run, each target platform must also load and verify one
native or WASM Engine artifact and inject its public backend. A production wallet must
therefore assemble one platform Engine backend plus exactly nine Host Ports. It must
replace the in-memory Host store and Transport,
authenticate trusted context and session authority, persist permissions with atomic
revision handling, resolve current accounts and complete chain ancestry, enforce
wallet policy, render and persist approval binding, protect keys and implement the
external signer, provide idempotent broadcast and reconciliation, use a trusted clock,
and provide secure entropy. It must also operate durable cancellation, restart, replay,
and delivery acknowledgement. The fixed test key under `test/`, fixture chain data,
and fixture broadcast callbacks are never production custody or network components.

The Node-only [`node-wasm-backend.mjs`](test/node-wasm-backend.mjs) demonstrates the
platform step without putting `node:fs` in publishable wallet code: it resolves the
public WASM adapter entry, reads the adjacent packaged artifact, creates a backend with
`createWasmTbcEngineBackend`, and injects that backend into the wallet composition.

Run from the repository root:

```sh
npm run test:example:minimal
```

The suite covers account authorization, mainnet and testnet profile fixtures, arbitrary amounts,
multi-input selection, exact spend, change, concurrent sends, sign-only, close, abort,
same-tick pre-registration close, durable replay, package boundaries, and the required
approval/signing sequence.

The opt-in [`testnet-adapter.ts`](src/testnet-adapter.ts) builds a live public snapshot,
performs sign-only verification first, and requires an exact preview fingerprint echo
before it installs the real broadcast callback. Its confirmed real-node evidence and
credential-free record format are documented in
[`docs/testing/testnet-acceptance.md`](../../docs/testing/testnet-acceptance.md).
Run `npm run check:testnet:preflight` for the separate read-only live API contract probe;
it rejects every non-GET request and does not count as transfer acceptance.

For a funded run, `npm run testnet:acceptance -- --adapter /absolute/path/adapter.mjs`
is dry-run by default. The adapter must stay outside the repository and expose only the
documented public input plus opaque Node/signer closures. Adding `--broadcast` still
requires the funds controller to paste the exact preview fingerprint in the same
process before broadcast authority exists. See the acceptance document for the exact
adapter contract, confirmation exit codes, and credential-free result format.
