# Multi-wallet discovery example

Run from an installed `@tbc/kit` package:

```sh
node node_modules/@tbc/kit/examples/multi-wallet/run.mjs
```

The example configures a DApp wallet catalog, registers two Wallet Standard
wallets with the same display name, merges configured and discovered choices,
and connects by the exact discovered descriptor. The third configured wallet
remains `not-detected`; that status does not prove that the wallet is not
installed.

`productId`, name, icon, and catalog URLs are presentation/discovery metadata.
They do not authenticate a wallet, grant permission, or replace the selected
Provider instance. Kit returns HTTPS install/homepage URLs for the DApp to show;
it never opens, fetches, or executes them.

The example explicitly creates controlled platform-authority sessions before
calling `runtime.register(session)`. Its fixed origin is test data, not a
production source of authority. Production wallets must use their verified
extension/native transport and close the session on navigation or revocation.

This example covers injected Wallet Standard wallets only. Mobile deep links,
QR pairing, WalletConnect, and cloud transports are not implemented by this
flow.
