# Supported functionality

## Business methods

| Namespace | Methods |
| --- | --- |
| `tbc` | `transfer`, `merge` |
| `tbc20` | `create`, `transfer`, `merge` |
| `tbc721` | `createCollection`, `mint`, `batchMint`, `transfer` |
| `tbc20Stablecoin` | `create`, `mint`, `freeze`, `unfreeze`, `transfer`, `merge` |
| `amm` | `create`, `addLiquidity`, `removeLiquidity`, `swap`, `mergeToken` |
| `tbc20Lp` | `transfer`, `lock`, `unlock`, `merge`, `burn` |
| `htlc` | `lock`, `claim`, `refund` |
| `timelock` | `lock`, `unlock` |
| `lop` | `create`, `cancel`, `match` |

Available operations depend on the recognized contract and account roles.
For example, `amm.mergeToken` and `tbc20Lp.burn` are historical maintenance
operations, not alternatives to withdrawing liquidity from a current AMM.
New assets use current contract standards; supported historical assets retain
holder operations. Legacy converts request and result formats into the same
TBC execution path, without BTC/EVM namespaces.

## Wallet and DApp integration

- Wallet Standard discovery and TBC Provider.
- Message and typed-data signing; encryption/decryption with a wallet BIE1 adapter.
- Wallet-built and Prepared transactions, workflows, signing and sending.
- Approval presentation, parallel preparation and shared chain data.
- HTTP API, node RPC, transaction inspection and receipt verification.
- Optional wallet multisig through `@tbc/kit/multisig`, not Provider.

See [usage](docs/usage.md) and [multisig](docs/multisig.md) for the specific
methods, asset profiles and constraints. Receipt checks establish consistency
with the configured node/API; a returned transaction ID is not a confirmation.

## Environments

Browser ESM, Node.js ESM/CommonJS and React Native are supported through their
package entry points. React Native uses the paired native SDK. Flutter has its
own Dart plugin and platform guide. A wallet supplies its account, Vault,
approval UI and trusted transport; the SDK does not manage wallet secrets.
