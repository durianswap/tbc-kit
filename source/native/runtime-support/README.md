# Private runtime support

These primitives are wallet-owned integration code, not DApp APIs. They do not
hold keys, sign, fetch chain data, or change transaction validation rules.

## Hermes SHA-256

`sha256-jsi.hpp` installs the Android private-VM `__tbcNativeSha256` primitive.
It consumes an exact ArrayBuffer view synchronously and uses Android's standard
`MessageDigest("SHA-256")`. The byte-view boundary follows the existing Flutter
adapter. It avoids JSON byte-array round trips; it does not change the algorithm.

At private VM bootstrap, use `createNativeSha256Backend` from
`native-sha256.mjs`, then pass the resulting function to
`configureTbcKitSha256Backend` from `@tbc/kit/wallet`. If an external memory Host
store is supplied, pass the same backend to `createTbcKitMemoryHostStore({sha256})`.
Kit verifies independent portable startup vectors. A malformed or failing native
backend must abort startup, not silently bypass checks. Never expose its
configuration to the WebView or page-provided code.

`utf8-encoder.js` avoids native round trips for ASCII encoding in private VMs.
Non-ASCII keeps the existing codec; Core's strict Unicode validation is retained.

### Android large-payload codec

For a Hermes native wallet, include `ascii-jsi.hpp` and call
`installTbcAsciiEncoder(runtime)` before loading `utf8-encoder.js` and Kit.
The optional private primitive replaces the per-character JS ASCII loop with
an exact native copy into a fresh `Uint8Array`. Non-ASCII is explicitly declined
and goes through the wallet's existing Unicode codec. Core's canonical JSON,
strict Unicode checks, hash bindings and all Engine validation remain unchanged.
It performs no network request, permission decision or result caching. Do not
install this primitive or its configuration in the DApp WebView.

Also compile the private wallet bundle with the **same Hermes release** as the
embedded runtime: `hermesc -O -emit-binary -out wallet.hbc wallet.js`. Load the
result as bytes (`assets.open(...).readBytes()`), not as decoded text, into
`evaluateJavaScript`. Record the JS and HBC hashes and compiler/runtime pairing
in the wallet build manifest. HBC is a platform build artifact, not a portable
replacement for the JS/npm package; an incompatible bytecode version must fail
startup. Keep iOS/JSC and Web consumers on their existing bundle path.

These integrations do not change the Kit protocol or transaction algorithm.
The npm archive alone cannot install a wallet-owned native primitive. Run the
codec vectors in the actual private VM, then compare the full wallet route and
signed transaction bytes; a mock codec unit test is not native acceptance.

## Signing lifetime versus result delivery

Swift/Kotlin `NativeSessionFence` distinguishes `Ticket` (expiring authority to
perform work) from `DeliveryTicket` (one-use routing of a terminal/partial result).
Only `Ticket` may reach `startOnce` / `startBoundTaskOnce`. Signing deadlines,
navigation, account/network scope, permission revocation and duplicate-start
guards remain enforced. A terminal result can be delivered after a signing
deadline only to the same live, authorized document. This grants no new signing
time. Navigation, revocation, close and duplicate result delivery remain rejected.

## NFT jobs

The Kit wallet executor uses bounded internal working sets (currently at most
10 items per Core plan) under the original complete manifest consent. A caller's
`maxItemsPerBatch` is an upper bound, not a requirement to build an oversized plan.
All requested items still execute automatically. Authenticated initial data,
validated signed parents and exact change are reused. Material/approval expiry
is not extended; expired or uncertain work stops with partial results. After an
approval UI wait, the same trusted clock is sampled again, not the receipt edited.

Run `node --test native/runtime-support/*.test.mjs` and
`node native/runtime-support/check-fence.mjs` from `source/`.
Device acceptance and real-chain evidence are separate from these unit checks.
