# @tbc-wallet/tbc-engine

Source-traceable, deterministic, keyless TBC transaction construction. This is
the internal source package, not the recommended separate installation for new
integrators. Use `@tbc/kit/engine` and the platform assets specified in the
[platform integration guide](../../../docs/native.md).
One Rust core powers iOS, Android, host-native and import-free WASM adapters.
TypeScript provides validation and transport. Frozen historical packages are
not overwritten when source or documentation changes.

## Public contract

The engine exposes exactly four methods: normalizeRequest, plan, validate, and
finalize. Do not confuse these four Engine methods, Kit's 33 recommended business
helpers, or the larger set of wire intent names and compatibility aliases.
Current library declarations and template limits are maintained in
[`business-capabilities.ts`](../kit/src/business-capabilities.ts); they do not
automatically authorize or advertise every capability in an individual wallet.

The historical builders remain in source for compatibility verification, not authorization. Old FT creation, old NFT Code
mint and old Pool creation are now rejected by public Engine execution. Shared
collection creation remains allowed; existing collections can mint current NFT
Code. Supported old transfers, maintenance and Pool/LP operations remain usable.
Historical `tbc.pool.liquidity.close` remains in source but is not an advertised
Kit wallet intent. Internal builder retention is not a fallback authorization.

`check:capabilities` checks retained dispatch families and
consistency of the current declaration. This is a source/declaration check, not
an execution, VM, device or chain proof. See the
[current execution evidence](../kit/src/business-capabilities.ts)
for the exact frozen Native/WASM policy scope.

## Create an engine

~~~ts
import { createTbcEngine, createWasmTbcEngineBackend } from "@tbc/kit/engine";

const backend = await createWasmTbcEngineBackend(wasmBytes);
const engine = createTbcEngine({ backend });

const normalized = await engine.normalizeRequest(request);
const plan = await engine.plan(planParams);
const validation = await engine.validate(validateParams);
const result = await engine.finalize(finalizeParams);
~~~

Calls can be asynchronous because native and WASM transport is asynchronous.
ESM browser builds may use the lazy bundled WASM default. CommonJS and React
Native integrations should inject a backend explicitly.

## Security boundary

The engine never owns secrets and never signs. It receives public account and
chain evidence, emits ordered signing requests, and verifies supplied low-S
signatures. It has no approval UI, account selection, network fetch, broadcast,
storage, recovery, or wallet API capability.

Kit's shared wallet/Host integration provides common orchestration, binding,
verification, broadcast and recovery boundaries. The wallet supplies platform
adapters for accounts, approval UI, secure Signer and storage; it should not
reimplement TBC transaction algorithms. Read the current Kit wallet integration
guide rather than treating this low-level Engine example as a complete wallet.

## Build and verify

~~~sh
npm --prefix packages/tbc-engine run build:rust:native
npm --prefix packages/tbc-engine run build:rust:mobile
npm --prefix packages/tbc-engine run build:rust:wasm
npm --prefix packages/tbc-engine run build:fixed-delivery
npm --prefix packages/tbc-engine run check:rust-delivery
~~~

`build:fixed-delivery` emits the iOS XCFramework, Android `jniLibs`, host dylib,
WASM, a reproducible npm tarball, and SHA-256 manifests. Provenance is pinned
under `rust/provenance`; scope and runtime evidence are under `evidence`.

These internal build commands alone do not establish downstream extension,
iOS/Android app, Testnet broadcast or recovery acceptance. Use the current
delivery manifest and its separately scoped evidence for those claims; historical
draft generator or package status is not the current Kit delivery status.
