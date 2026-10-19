# @tbc-wallet/wallet-standard

Thin discovery adapter between TBC Provider wallets and the official Wallet Standard
global registry.

```ts
import {
  getTbcWallets,
  subscribeTbcWallets,
} from "@tbc-wallet/wallet-standard";

const wallets = getTbcWallets();
const unsubscribe = subscribeTbcWallets(({ type, wallets: changed }) => {
  console.log(type, changed.map(({ name }) => name));
});
```

Wallet implementations expose a compatible `tbc:provider` feature and call
`registerTbcWallet`. The adapter accepts canonical semantic versions with major `1`.

The package uses `@wallet-standard/core` for the registry and window event handshake. It
does not copy that registry, auto-select a wallet, persist an identifier, assign wallet
priority, inject `window.Turing`, or participate in EIP-6963. Import is safe during SSR;
registration is a browser-side operation.
