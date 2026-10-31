# Wallet and contract compatibility

| Application | Wallet | Connection |
| --- | --- | --- |
| Kit / standard Provider DApp | Wallet Standard + TBC Provider wallet | Supported through wallet discovery |
| Existing `window.Turing` DApp | Kit wallet with Legacy enabled | Supported methods map to the same approval and execution path |
| Kit / standard Provider DApp | Old wallet exposing only `window.Turing` | No automatic reverse adapter |

Legacy is a wallet-side adapter. It does not make a standard-only DApp client
understand every old wallet. An explicitly supplied Provider must still implement
the standard Provider contract. Applications serving old-only wallets can keep a
separate old-wallet integration until those wallets add the standard interface.
Never treat a displayed wallet name or a page-injected object as signing authority.

Business calls choose supported contract profiles from chain materials. New FT,
NFT, stablecoin, AMM/LP, HTLC, timelock and LOP methods are listed in
[supported functionality](../SUPPORT.md). Supported historical holder operations
do not imply support for creating all historical contracts. PiggyBank maps to
the height-based `timelock` profile; historical PoolNFT/Pool v1 is not a dedicated
high-level API. BTC and EVM are not part of this TBC package.

Simple DApps can connect and call a business method. They do not need to implement
Host, persistence or signing. Wallets supply their account, secure signer,
approval UI and transport. Backends can use `createTbcBackendService` from
`@tbc/kit/wallet` with their own signer/authorization, or the keyless Engine
directly; there is no browser or approval-window requirement on that path.
