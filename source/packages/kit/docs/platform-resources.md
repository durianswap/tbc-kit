# Choose platform resources

Install the JavaScript package once:

```sh
npm install ./tbc-kit.tgz
```

| Target | Required files | Execution |
| --- | --- | --- |
| Web / browser extension | `tbc-kit.tgz` | Bundled WASM, loaded on first use |
| Node.js | `tbc-kit.tgz` | Local WASM by default; no HTTP download |
| React Native iOS | JS package + paired `ios-sdk.tgz` | Explicit native bridge |
| React Native Android | JS package + paired `android-sdk.tgz` | Explicit native bridge |
| Swift / Kotlin | SDK archive for that platform | Native SDK, no npm package required |
| Flutter | Separate Flutter plugin and its matching resources | Dart/native integration; not this JS candidate |

The JavaScript archive does not contain iOS static libraries, Android shared
libraries or macOS dylibs. It retains WASM for existing browser/Node behavior.
Querying the API or constructing a client does not instantiate the Engine.
There is no install hook, background download, automatic native selection or
silent native-to-WASM fallback.

For this distribution candidate, pair **JS 0.1.0-rc.20** with the unchanged
**Native SDK 0.1.0-rc.19.native.2**. Match the catalog, protocol fingerprint and
SDK lock, not just a version number. The paired SDK and runtime binaries are
byte-identical to rc.19. The Flutter/partner delivery remains a separate frozen
artifact; this candidate does not claim to update it.

Extract only the SDK you need, then use the existing React Native installer:

```sh
node node_modules/@tbc/kit/examples/react-native-engine/install.mjs \
  /absolute/path/to/app /absolute/path/to/extracted-ios-sdk --platform ios
```

For Android, pass the extracted Android SDK and `--platform android` instead.
The installer verifies hashes before copying. Never edit the SDK lock to accept
an unrelated archive. Follow [React Native setup](../examples/react-native-engine/README.md)
for linking and supplying the backend.

Low-level FFI integrations may use the optional `tbc-kit-native-resources-<platform>.tgz`
sidecars. They contain original libraries/headers under `resources/artifacts/`;
they are **not** substitutes for the Swift/Kotlin SDK. `platform-resources.json`
binds their files and archive hashes. Ordinary DApps and mobile SDK consumers
do not need these sidecars.

## Dependency boundary

`tbc-contract`, `tbc-tx-parser` and `tbc-lib-js` are build/reference dependencies,
not application runtime dependencies. The generated parser is included privately.
Its existing `elliptic`, `hash.js` and `bs58` dependencies are retained; removing
them without replacing their actual use would break parsing. This packaging
change does not replace cryptographic algorithms or reduce validation.
