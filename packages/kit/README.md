# @tbc/kit

TBC SDK for JavaScript and TypeScript applications, wallets and backends.

[Documentation](https://github.com/durianswap/tbc-kit/blob/main/docs/README.md) · [API reference](https://github.com/durianswap/tbc-kit/blob/main/docs/api-reference.md) · [Examples](https://github.com/durianswap/tbc-kit/blob/main/docs/examples.md)

## Install

Download `tbc-kit.tgz` from the repository and install it in your application:

```sh
npm install ./tbc-kit.tgz
```

## Query the network

```ts
import { createTbcOfficialApi } from '@tbc/kit/api';

const api = createTbcOfficialApi({ network: 'testnet' });
const node = await api.nodeInfo();
console.log(node.blocks);
```

## Entry points

| Import | Purpose |
| --- | --- |
| `@tbc/kit` | DApp client, wallet discovery and connection |
| `@tbc/kit/wallet` | Wallet integration and transaction orchestration |
| `@tbc/kit/engine` | Keyless transaction construction and validation |
| `@tbc/kit/api` | TBC HTTP API |
| `@tbc/kit/rpc` | Node JSON-RPC |
| `@tbc/kit/sqlite` | Wallet storage adapter |
| `@tbc/kit/multisig` | Optional wallet multisig operations |
| `@tbc/kit/testing` | Offline integration helpers |

Use `mainnet` or `testnet` when selecting the network. Amounts are decimal
strings in atomic units; TBC has six decimals. Wallets retain custody and
approval UI. Transaction construction does not receive private keys.

## Guides

- [Usage and business methods](docs/usage.md)
- [Supported functionality](SUPPORT.md)
- [Wallet and contract compatibility](docs/compatibility.md)
- [Platform resources and version pairing](docs/platform-resources.md)
- [Multi-wallet discovery](examples/multi-wallet/README.md)
- [Wallet integration](examples/independent-wallet/README.md)
- [Backend integration](examples/backend-node/README.md)
- [React Native](examples/react-native-engine/README.md)
- [Multisig](docs/multisig.md)

For Flutter, use the [Flutter plugin](https://github.com/durianswap/tbc-kit/blob/main/docs/flutter/README.md)
instead of embedding the JavaScript runtime.
