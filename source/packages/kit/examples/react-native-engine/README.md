# React Native / Expo keyless Engine bridge

The local-module template adapts the standalone Swift/Kotlin Engine SDK
to the existing `@tbc/kit/engine` facade. It contains only Expo glue, not a second
C-ABI/JNI or buffer implementation. The SDK owns concurrent execution and returns
the intact envelope, avoiding duplicate JSON parsing. No Rust compiler, hidden
download or postinstall hook is required. Expo Modules supplies autolinking.
Plain React Native apps must first install/configure Expo Modules; pure native
Swift/Kotlin apps and Expo Go are not covered by this template.

## Install in an Expo app

Install and lock the selected Kit candidate and Expo dependencies first. Obtain the matching
local native SDK delivery matching the installed candidate (unpublished).
Its identity and exact source/AAR hashes are pinned in `module/native-sdk-lock.json`.
The repository's `native/engine/README.md` describes generating this SDK;
SPM/Maven remote coordinates are not yet published. From
the application root (not this repository):

```sh
node node_modules/@tbc/kit/examples/react-native-engine/install.mjs . /absolute/path/to/native-sdk
node modules/tbc-kit-engine/scripts/sync-native.mjs --check
npx expo run:ios
# or: npx expo run:android
```

The installer creates `modules/tbc-kit-engine` and refuses to overwrite it.
The default prepares both platforms, as before. For a single-platform build,
obtain only `apple-sdk.tgz` (iOS) or `maven-repository.tgz` (Android), plus
`sdk-metadata.tgz`, from the matching verified delivery. Extract the selected
archives into one new SDK directory, then select that platform explicitly:

```sh
node node_modules/@tbc/kit/examples/react-native-engine/install.mjs . /absolute/path/to/native-sdk --platform android
# For iOS, use --platform ios; for a dual-platform app, omit the option.
```

Every selected file is checked against the original complete SDK lock. The
platform choice does not change its identity, ABI, binaries or public methods.
Build-time checks reject attempting iOS with an Android-only module and vice
versa. Use a fresh module if changing the selection; the installer never deletes
existing platform files. This saves developer downloads and staging disk space,
not additional bytes from an App that already links only its own platform.

For Hermes, merge `{ unstable_transformImportMeta: true }` into the
`babel-preset-expo` options in your Babel configuration. A new-app example is
[`babel.config.js.example`](babel.config.js.example); copy it as `babel.config.js`
(Expo 54's Metro loader does not discover `.cjs` configurations). Kit's shared exports
contain lazy WASM `import.meta` syntax even when you inject Native; without
this transform Metro rejects the bundle. Keep existing plugins/configuration.
For a minimal controlled check, copy `SmokeApp.tsx` to your new app's `App.tsx`.
Expo's default local-module directory discovers this module. If your app has a
custom `expo.autolinking.nativeModulesDir`, place the module there and pass an
explicit app root when calling the exported `syncNative` function. Do not add
an alternative public package or expose this module to a WebView.

```ts
import { createExpoTbcEngine, createExpoTbcKeylessEngine } from './modules/tbc-kit-engine/src';

const engine = createExpoTbcEngine();
const nativeEngine = createExpoTbcKeylessEngine();
// Inject engine into your existing Kit wallet/backend composition.
// The same Engine supports keyless construction and external signing workflows.
// Inject nativeEngine where the shared composition requires the Keyless companion.
// Do not implement contract recognition or Reviewed transaction logic in the app.
```

Your wallet still supplies its account, native approval UI and secure Signer.
For a wallet-owned Hermes VM, also follow the [private runtime performance
guide](../../docs/reference/private-runtime-performance.md). Engine bridging alone
does not install the optional native SHA-256 backend used by Core bindings.
The main Engine bridge has `normalizeRequest`, `plan`, `validate`, `finalize`.
The separate Keyless adapter exposes the shared `protocolInfo`/`execute` interface
and only the SDK's approved computation operations: Pool preparation, ancestry,
receipt/material inspection and Reviewed-stage preparation/finalization. The
native `callKeyless` method checks the SDK enum as well as the shared Kit allowlist.
It is not a signing function; finalization consumes external signatures.
It does NOT provide a Vault, digest signer, wallet-private crypto ABI, old
wallet `execute` routines, Pool material service, chain-data fetcher, database,
broadcast or automatic retry. It is a reusable Engine bridge, not a claim that
all wallet-native capabilities are now a one-line installation.

## Upgrade and identity checks

After installing a new Kit version:

```sh
node modules/tbc-kit-engine/scripts/sync-native.mjs --sdk-root /absolute/path/to/native-sdk
node modules/tbc-kit-engine/scripts/sync-native.mjs --check
# Rebuild the native app after any native/header/protocol identity change.
```

The explicit preparation step verifies SDK protocol/native hashes against the
installed Kit and checks every SDK source/AAR/POM file against the template lock
before copying. iOS compiles the same standalone SDK Swift sources and links both
Engine and Keyless XCFrameworks; Android resolves its pinned AAR and dependency metadata from the
copied local Maven directory. Both expose the SDK's compiled identity directly.
The Expo Gradle template registers that directory for all consuming projects,
exclusively for `io.tbc.local`; it never resolves this SDK group from a remote
namesake. For custom Gradle settings that forbid project repositories, configure
the same exclusive local repository in `dependencyResolutionManagement` instead
of using this default Expo project-repository setup.
CocoaPods and Gradle run the read-only check before building. Commit the bridge
source, native-sdk-lock and package lock; regenerate
ignored artifacts/identity in CI before the build. Run `--check` before any
OTA/JS bundle export as well: a JS-only update does not run native build hooks.

Startup compares the generated JS identity to the constant in the actual
native module. A mismatch fails early, rather than surfacing during signing.
An unchanged native/header/protocol identity can be reused across document-only
Kit updates; a new identity requires rebuilding. This detects accidental
mix-ups; it is not remote attestation or proof against a malicious app/package.
Package registry integrity and release-provenance review remain necessary.

For migration from an older generated module, update the glue intentionally and
remove its old `TbcKitEngineBridge.swift`, C++/CMake bridge, JNI keep rule and native
identity constants only after verifying they have no other consumers. Do not run
the installer over an existing directory.

## Runtime and platform boundaries

- Async native calls; no added global serialization, API reads or persistence.
- Preserve canonical JSON and Engine result envelopes without reimplementing
  serialization or business validation in Swift/Kotlin.
- iOS frees Rust buffers with `defer`; JNI uses RAII on normal and error paths.
- Native methods are restricted to the keyless facade. JNI uses UTF-8 byte
  arrays (not modified-UTF-8 string APIs); Kotlin rejects invalid output UTF-8.
- iOS libraries: arm64 device and arm64 simulator. No x86 simulator library.
  For command-line simulator Release builds, pass `ARCHS=arm64 ONLY_ACTIVE_ARCH=YES`
  to `xcodebuild`; this is not an Intel simulator delivery.
  The React Native template requires iOS 15.1 or later. Keep the app deployment
  target compatible with all linked native libraries.
- Android: arm64-v8a, armeabi-v7a, x86_64; minimum API 24. This module consumes
  a prebuilt SDK AAR and does not compile its own JNI with NDK/CMake.
- Never link a second copy of `libtbc_engine_native` into an existing wallet.
  When adopting this module, replace the old Engine binding or arrange one
  shared native dependency. Do not blindly add it beside an older bridge.
- Signer/native-private migrations are separate work; do not remove an
existing wallet bridge while those methods still have consumers.

The Keyless helper requires the updated template, not just a JS package change.
Older installed modules without `callKeyless` fail clearly and require rebuilding;
they never silently fall back to WASM or wallet-private execution. Frozen older
candidates remain unchanged; consult the selected candidate's delivery evidence.

## Verification

The repository's focused gate is:
`node --test packages/kit/test/react-native-engine-template.test.mjs`.
It checks setup/identity corruption, fail-closed startup, concurrent request
correlation, UTF-8 transport, unchanged errors and no retry. Native compiler,
autolinking and actual device evidence are recorded separately in the handoff;
these controlled tests are not live transactions or device acceptance.

References: [Expo module API](https://docs.expo.dev/modules/module-api/),
[Expo autolinking](https://docs.expo.dev/modules/autolinking/),
[EMURGO CSL bridge](https://github.com/Emurgo/csl-mobile-bridge).
