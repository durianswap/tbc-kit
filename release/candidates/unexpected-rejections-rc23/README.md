# TBC Kit rc.23 candidate

Install `tbc-kit.tgz` for JS/TS. Native consumers must also use the paired
`0.1.0-rc.23.native.2` SDK, not the rc.19 Native SDK. This candidate changes
AMM controller normalization in Engine as well as shared Kit/Core behavior.

```sh
shasum -a 256 -c DOWNLOADS.SHA256
npm install ./tbc-kit.tgz
```

Choose platform resources only when needed:

- `ios-sdk.tgz`: Swift package / iOS Engine and keyless libraries.
- `android-sdk.tgz`: Kotlin/JNI library, local Maven repository and buildable sources.
- `tbc-kit-native-resources-*.tgz`: pinned platform resources for Kit's native loader.
- `tbc-kit-source.tgz`: matching source snapshot; excludes cached/prebuilt artifacts.

For React Native, unpack the corresponding SDK then use the Kit example installer:

```sh
node node_modules/@tbc/kit/examples/react-native-engine/install.mjs \
  /path/to/app /path/to/unpacked-sdk --platform ios
# For Android, pass its SDK path and --platform android.
```

The source snapshot is not an npm installation. Use the packed Kit and SDKs above;
source builders should follow `source/packages/kit/scripts/` and the candidate
build/check scripts. `source-manifest.json` records source files; `delivery-lock.json`
records every package, native resource and pairing. Native identity records the
bootstrap Kit used to assemble the native SDK; the final Kit additionally contains
the verified SDK lock and subsequent JS-only sibling fixes. The final installable
JS checksum is `delivery-lock.json.kit.sha256`, not the bootstrap checksum.

Protocol fingerprint (unchanged):

`8c2a5a935335463ecedef622011c187c645a9130df1b18610b0fba1262504ce9`

## Integration changes

- Pass 1–5 distinct AMM controller hash160 values in any order. Engine returns a
  canonical normalized request. Use that returned request/hash for Prepared flows;
  do not reorder it after approval. Other arrays retain their existing order.
- NFT and token LOP funding candidates no longer incorrectly consume the actual
  selected-input budget. Exact selections, fees, ownership and bounds remain enforced.
- Handle fixed `reason` codes in error data. For execution errors, they are under
  `error.data.details.reason`; parameter errors use `error.data.reason`. Unknown
  adapter messages are not forwarded.
- See the installed package's `docs/transaction-capacity.md` for output-group
  capacity, exact-input semantics and supported error reasons.

This is a local candidate, not a replacement for the accepted release or Flutter
partner package. The latter is unchanged. See `REPORT.md` for completed checks,
read-only chain evidence, timing scope and remaining acceptance boundaries.
