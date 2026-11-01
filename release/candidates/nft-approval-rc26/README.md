# TBC Kit rc.26 candidate

This candidate fixes NFT job approval-expiry classification and documents the
existing private Android SHA-256 integration validated in this round. It does
not replace the current release or the Flutter partner delivery.

## Install and pairing

```sh
shasum -a 256 -c DOWNLOADS.SHA256
npm install ./tbc-kit.tgz
```

- JS/TS: `@tbc/kit@0.1.0-rc.26`.
- Native SDK: `0.1.0-rc.23.native.2`, unchanged Engine/Signer/ABI.
- Exact platform archive URLs and SHA-256 values: [delivery-lock.json](delivery-lock.json).
- Native identity/protocol lock: [native-sdk-lock.json](native-sdk-lock.json).
- Source and integration helpers: `tbc-kit-source.tgz`.
- Results, timing conditions and limitations: [REPORT.md](REPORT.md).
- Machine-readable evidence: `validation-evidence.tgz`.

Use the paired iOS/Android archives in the lock; there is no newly rebuilt
Native engine in rc.26. Do not substitute another Native version based only on
its filename. The protocol fingerprint remains
`8c2a5a935335463ecedef622011c187c645a9130df1b18610b0fba1262504ce9`.

## Integration changes

1. Update the JS package. If the native approval fence rejects after the NFT
   job's original deadline, the trusted clock is refreshed and the caller gets
   `status: "stopped", reason: "expired"`, not a generic `-32603`.
2. Handle `partial` results and their original transaction IDs; never resubmit
   an already accepted prefix. Approval lifetime is not extended.
3. An Android wallet using its own Hermes VM should install the existing
   `source/native/runtime-support/sha256-jsi.hpp` primitive and wrap it with
   `native-sha256.mjs` before constructing Kit. The npm archive alone cannot
   install a native VM hook. The implementation belongs in the wallet's private
   runtime, never in an untrusted DApp page.
4. Follow the packaged `docs/reference/approval-expiry.md` and
   `docs/reference/private-runtime-performance.md`; retain startup vectors,
   binding checks, original approval UI, prefetch and storage policy.

No signing algorithm, fee policy, expiry duration, transaction selection,
network endpoint or current partner package was changed.
