# rc.22 distribution promotion

The selected JS package is `0.1.0-rc.22`, paired with unchanged Native SDK `0.1.0-rc.19.native.2`. Source/tag: `1603d14e957c20acd7e227d59e63f486ba1986d6` / `v0.1.0-rc.22`.

- [Release and downloads](https://github.com/durianswap/tbc-kit/releases/tag/v0.1.0-rc.22)
- [Installation and pairing](../docs/installation.md)
- [Accepted candidate report](candidates/zero-balance-rc22/REPORT.md)
- [Immutable delivery lock](candidates/zero-balance-rc22/delivery-lock.json)

The original candidate report and archive retain the pre-publication checkpoint. Promotion changes the default repository manifest and public installation guide, not accepted package bytes or the original evidence. Native and Flutter archives keep their existing versioned download URLs and hashes. Flutter/Dart orchestration does not automatically inherit the JS zero-balance selection fix.

## Publication checks

- Repository tests: 21/21 passed.
- Integrity: 4 archives, 1,152 expanded package files, 2,221 runtime source files and 181 Flutter inventory files checked.
- Public docs: 56 files and 171 local links checked before this record was added.
- Clean install: rc.22, 8 ESM and 8 CommonJS entrypoints, 2 offline examples passed.
- All 174 protected partner-delivery files match the pre-existing baseline.
- Accepted JS SHA256 remains `10bb0cf19f8c0e25000fa286d587ae15ba623edd0826856111e64000439c00b3` (5,544,408 bytes).
- GitHub Release has 9 uploaded attachments; each server digest and size matches its local frozen file. All 9 public download URLs were then fetched and their complete bytes hashed independently, with identical results.
- Source/tag and the default `main` promotion were pushed through SSH without force-pushing or rewriting history. Promotion commit: `ce779eceb1c094143f1de07862d96ff197f691f4`.

No package rebuild, Native code change, real signing/broadcast or repetition of prior successful transactions was part of this publication. Original controlled business results are recorded in the candidate report and are not relabeled as device or chain acceptance.
