# Platform integration

Install one JavaScript package and import the modules your application needs.

| Application | Entry |
| --- | --- |
| Web DApp | `@tbc/kit` |
| Browser extension or JS wallet | `@tbc/kit/wallet` |
| Node.js service | `@tbc/kit/api`, `/rpc`, `/engine`, `/wallet` |
| React Native | JavaScript package plus paired native SDK |
| Swift / Kotlin | Platform calculation SDK and wallet-owned host integration |
| Flutter | Flutter plugin, including Dart and native resources |

The optional `/sqlite`, `/testing` and `/multisig` entries are part of the
same JavaScript package. Use public exports rather than deep-importing
`dist/`; export conditions select browser, React Native and Node loaders.

## Engine loading

Browser and Node consumers use the packaged WASM resources. Browser bundlers
must serve the resources at the URLs supplied to the loader. Node loads local
resources lazily. Importing a DApp client does not initialize the Engine.

React Native injects a native Engine backend. The [RN example](../../examples/react-native-engine/README.md)
installs the platform bridge and verifies the paired SDK. Rebuild the native
App after changing its native dependencies.

## Wallet integration

The wallet provides its account, trusted page origin, approval UI, Signer/Vault
and platform lifecycle. Kit supplies transaction preparation and validation;
private keys never enter the page or the public transaction builder.

## Service integration

The [backend example](../../examples/backend-node/README.md) uses
`createTbcBackendService` for keyless preparation, or explicit service
authorization and an external signer. Sending requires submit and
reconciliation adapters; construction alone never broadcasts.

## Downloads

See the [platform guide](https://github.com/durianswap/tbc-kit/blob/main/docs/native.md)
and [resource selection](platform-resource-delivery.md). Native archives are
selected per platform; their total size is not the application's download increment.
