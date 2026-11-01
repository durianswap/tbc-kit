# TBC Kit rc.22 candidate

This is an isolated, locally verified candidate. Published rc.21 and the current Flutter partner delivery have not been replaced.

## Install

```sh
npm install ./tbc-kit.tgz
```

- JS/TS: `@tbc/kit@0.1.0-rc.22`.
- Native SDK: `0.1.0-rc.19.native.2` (unchanged).
- Protocol: `8c2a5a935335463ecedef622011c187c645a9130df1b18610b0fba1262504ce9`.
- JS SHA256: `10bb0cf19f8c0e25000fa286d587ae15ba623edd0826856111e64000439c00b3`.

For Native resources use the URLs and exact hashes in `delivery-lock.json` / `native-sdk-lock.json`:

- [iOS SDK](https://github.com/durianswap/tbc-kit/releases/download/v0.1.0-rc.20/ios-sdk.tgz)
- [Android SDK](https://github.com/durianswap/tbc-kit/releases/download/v0.1.0-rc.20/android-sdk.tgz)

No new Native binary or Flutter release is needed or included in this JS selection fix. Do not rename the Native SDK to rc.22: its identity and binaries have not changed. The candidate's iOS/Android adapter identity checks pair the new JS version with this unchanged SDK.

## Behavior

Automatic holder selection now skips valid zero-token outputs before parent/confirmation downloads. An explicitly selected zero-token output fails with `INVALID_INPUT` / `SELECTED_ZERO_BALANCE_INPUT`; it is not silently omitted or replaced. See the package's `docs/zero-balance-inputs.md`.

The package retains the existing one-approval flow, concurrent material reads, raw/identity checks and Engine validation. It does not add cleanup transactions or additional network queries.

See `REPORT.md` for evidence and limits; `DOWNLOADS.SHA256` for integrity; `tbc-kit-source.tgz` and `source-manifest.json` for the exact source snapshot. Native and current partner archives are referenced rather than duplicated.
