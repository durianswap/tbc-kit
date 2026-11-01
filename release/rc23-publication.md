# rc.23 distribution promotion

Selected pair: JS/TS `0.1.0-rc.23`, Native SDK `0.1.0-rc.23.native.2`.
Frozen source/tag: `ba2bf386ddd8b34d4409cdb5d25e7b90164b8abc` / `v0.1.0-rc.23`.

- [Downloads](https://github.com/durianswap/tbc-kit/releases/tag/v0.1.0-rc.23)
- [Installation and upgrade](../docs/installation.md)
- [Capacity and typed errors](../packages/kit/docs/transaction-capacity.md)
- [Original test report](candidates/unexpected-rejections-rc23/REPORT.md)
- [Immutable candidate lock](candidates/unexpected-rejections-rc23/delivery-lock.json)

Promotion copies the sealed files; it does not rebuild JS, WASM or Native. Rust AMM controller normalization changed, so the new Native SDK is required even though the protocol fingerprint is unchanged. Native `kitTarSha256` identifies its bootstrap input; the final JS archive also includes the paired SDK lock and is verified separately.

## Local distribution checks

- Four selected archives, 1,155 expanded package files and 2,214 runtime source inventory entries verified.
- Repository tests: 21/21 passed after advancing the pinned-release assertions to rc.23.
- Clean install: 8 ESM entrypoints, 8 CommonJS entrypoints and 2 offline examples passed.
- All 174 protected partner-delivery files match their original hashes; Flutter archive and its 181-entry package inventory remain unchanged.
- Accepted JS SHA256: `14fa77b6af1248edb5fc89c3dd7104d525c0c07a1529dc3dc0f6d6527d62b88b`.

The original candidate reports and manifests remain unchanged, including red-test evidence and pre-promotion status. No real signing, broadcasting or repeated chain transactions were performed during publication. Native compilation/vector tests are not represented as new device or chain acceptance.
