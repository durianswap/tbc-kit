# Native resources

The JavaScript archive contains JavaScript, TypeScript declarations and WASM.
Native resources are distributed separately so browser and Node applications
do not download mobile libraries.

| Consumer | Required files |
| --- | --- |
| Web / MV3 / Node | `tbc-kit.tgz` |
| React Native | `tbc-kit.tgz` and the selected iOS/Android SDK |
| Swift | iOS SDK |
| Kotlin | Android SDK |
| Flutter | `tbc-kit-flutter.tgz` |
| Custom native bridge | The corresponding raw resource archive |

The Flutter plugin already includes its paired Engine and Signer. Do not add
the independent JS/RN SDK to the Flutter plugin.

Choose downloads from the [native guide](https://github.com/durianswap/tbc-kit/blob/main/docs/native.md).
The repository's `release/current.json`, each SDK's identity and the RN
installer lock record the required pairing. Check these identities when
upgrading rather than inferring compatibility from filenames.

For React Native, extract the SDK into a directory and run:

```sh
node node_modules/@tbc/kit/examples/react-native-engine/install.mjs \
  /path/to/wallet /path/to/sdk --platform all
```

Use `--platform ios` or `--platform android` for a single-platform project.
Follow the [RN guide](../../examples/react-native-engine/README.md) to rebuild
the application. No postinstall download or runtime network fallback is required.
