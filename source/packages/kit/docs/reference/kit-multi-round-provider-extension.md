# Kit multi-round Provider extension decision

`tbc_runMultiRoundMerge` is an intentional Kit orchestration extension. It is
not a temporary bypass and it is not a new canonical Core transaction method.

The bounded run spans multiple independently finalized and submitted
transactions, wallet-private index snapshots, one finite native consent,
per-step formal credentials, index refresh and uncertain-submit
reconciliation. Those are wallet/session orchestration concerns. Adding the
whole run to Core would incorrectly present a non-atomic sequence as one Core
operation and would expand the frozen method/schema/Port fingerprint.

The wallet transport therefore handles the extension after Provider request
identity/deduplication and before Core method validation. It validates the
page-visible authority and finite limits, then reuses Core's
`wallet_getPermissions` path for `tbc_accounts` and `tbc_sendTransaction`.
Only one multi-round run may be active in a wallet session; a conflicting run
fails before permission reads, private index reads or approval UI, and its
request cancellation cannot affect the active run. The guard remains held
until the active orchestrator Promise fully settles; only then may a later run
enter.

Every executable step still enters the ordinary Core/Host transaction path.
The Kit adapter constructs the exact canonical `tbc_sendTransaction` request
and calls the shared wallet `startWalletOperation`; Core then performs Chain
Data, planning, exact formal approval, Signer, finalization and broadcast.
Unknown submission results retain the same durable identity and use
status-only reconciliation; they are never re-executed.

The DApp receives an immutable terminal trace and an explicitly non-atomic
result. Live progress UI, indexes, the wallet session, approval journal and
recovery state remain wallet-private. The extension adds no Legacy mapping,
stablecoin capability, reusable merge permission, Core schema, Host Port or
Engine method.

## Mobile no-broadcast smoke gate

For a new immutable Kit tarball, Mobile can validate the integration without
signing or POST:

1. Pin the exact tarball SHA and resolve root with the `react-native`
   condition plus the trusted `/wallet`, `/engine` and `/sqlite` entries.
2. Send an invalid bounded request and require `-32602` before network, UI,
   Signer or POST.
3. Send a valid request without `tbc_sendTransaction` permission and require
   `4100` before the private index and bounded approval UI.
4. With controlled two-row index data, hold the first bounded approval. A
   second request must fail with the standard Provider internal-error code and
   the exact active-run message before a second index/UI call; cancelling that
   already-rejected second request must leave the first held. Do not abort the
   second request before asserting the busy error.
5. Reject the first bounded approval and require `stopped / approval-rejected`
   with zero formal-credential, Signer and POST calls, then require a third run
   to enter normally after the first has settled.

This is a package/wiring smoke gate only. It is not device signing, broadcast,
node acceptance, confirmation or real-fund evidence.
