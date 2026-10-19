# Independent backend Node example

Run this from an installed `@tbc/kit` package:

```sh
node node_modules/@tbc/kit/examples/backend-node/run.mjs
```

The example imports only public `@tbc/kit/engine` and `@tbc/kit/wallet`
entrypoints. Its default run is deterministic and offline: it performs one
keyless Prepared construction, serializes the result as if handing it to a user
wallet, and then demonstrates an independently injected service authorization
callback and test-only external Signer. It performs no POST or broadcast.

The send path is a separate, explicit invocation:

```sh
node node_modules/@tbc/kit/examples/backend-node/run.mjs --send
```

That controlled example injects both `broadcastSubmit` and
`broadcastReconcile`, then selects `action: "send"`. Its submit simulates a
lost response after acceptance and reconciliation returns local fixture status,
proving the path does not submit again; it makes zero external POSTs. Omitting `--send` remains
sign-only and does not even install broadcast capabilities. Applications must
not turn this opt-in flag into an implicit send after signing.

The scalar-1 key is public fixture material and must never protect funds. A real
backend injects a Vault, HSM, MPC service or another audited Signer capability;
private keys do not enter Kit. Sending also requires explicitly injected
broadcast and reconciliation capabilities. A custom broadcast adapter owns its
durable submit journal and status-only recovery contract; the facade can verify
that submit/reconcile functions exist, but it cannot prove that an arbitrary
adapter persists them. The built-in default broadcast adapter requires a
durable journal. Exact Prepared send identity is stable across recreation of
the same `serviceId`, so a compliant durable adapter can return a completed
result or reconcile an uncertain result without another POST. Importing or
constructing the service starts no network request, filesystem write, timer,
worker or automatic broadcast.

`createTbcBackendService` is a single-trusted-account facade. Its `account`
does not implicitly include a separate Coin administrator or Pool controller.
Keyless preparation can be handed to a wallet that independently supplies and
authorizes those roles. For service-owned execution with several trusted
accounts, compose `createTbcWallet` with an `accounts.current` adapter returning
those accounts, explicit grants, a service authorization adapter in place of
approval UI, and a Signer that selects custody by the bound account/role. This
uses the same Core/Host path, not another transaction builder. Never trust a
remote request to add an administrator or select another account's key. This
small example demonstrates the single-account path only.

Node uses the package-local WASM loader. Browser bundlers have a different
asset boundary: they must emit the packaged WASM and pass a resolvable URL to
`createTbcEngine({ wasm: { url } })` when the default relative URL is not
preserved. An HTML response at that URL is an asset-configuration failure, not
a transaction or Engine-plan failure.
