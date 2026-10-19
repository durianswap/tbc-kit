# TBC Kit

用于构建 TBC 应用的 SDK，支持 Web、Node.js、浏览器扩展和移动钱包。

查询链上数据，构建代币和合约交易，连接钱包并请求签名。钱包可以复用同一套链能力，接入自己的账户、审批界面与安全签名服务。

[快速开始](#快速开始) · [文档](docs/README.md) · [示例](docs/examples.md) · [API 参考](docs/api-reference.md)

## 快速开始

下载 [JavaScript / TypeScript 包](artifacts/tbc-kit.tgz)，在应用中安装：

```sh
npm install ./tbc-kit.tgz
```

查询测试网：

```ts
import { createTbcOfficialApi } from '@tbc/kit/api';

const api = createTbcOfficialApi({ network: 'testnet' });
const node = await api.nodeInfo();
console.log(node.blocks);
```

连接钱包：

```ts
import { createTbcClient } from '@tbc/kit';

const client = createTbcClient({ network: 'testnet' });
const wallets = client.wallets();
// 在应用的连接界面中让用户选择一个已发现的钱包。
const selected = wallets[0];
if (!selected) throw new Error('未发现支持 TBC 的钱包');
const wallet = await client.connect({ wallet: selected });
```

完整的发现、选择与连接流程见 [DApp 接入](docs/dapp.md)。

## 选择接入方式

| 应用 | 安装入口 | 指南 |
| --- | --- | --- |
| Web DApp | `@tbc/kit` | [连接钱包与发起交易](docs/dapp.md) |
| JS/TS 钱包、浏览器扩展 | `@tbc/kit/wallet` | [钱包接入](docs/wallet.md) |
| Node.js 服务端 | `/api`、`/rpc`、`/engine` | [查询与服务端](docs/api-and-backend.md) |
| Flutter 钱包 | [Flutter 插件](artifacts/tbc-kit-flutter.tgz) | [Flutter 接入](docs/flutter/README.md) |
| React Native、Swift、Kotlin | [平台 SDK](docs/native.md) | [原生接入](docs/native.md) |

JavaScript 各入口来自同一个 `@tbc/kit` 包，可按需导入。Flutter 插件包含 Dart 接口、原生计算库和 WebView 桥接，不需要额外安装 JavaScript 包。

## 主要能力

- 钱包发现、账户授权、网络选择、消息与结构化数据签名。
- 官方 HTTP API、节点 RPC、资产与交易查询、收款核验。
- TBC、TBC20、TBC721、稳定币、AMM/LP、HTLC、时间锁和 LOP。
- 钱包构建交易，或由 DApp/服务端构建后交给钱包签名。
- 批次编排、并行预取、材料复用、审批绑定及广播状态处理。
- `window.Turing` 适配 TBC 历史接口和受支持的旧资产操作。

钱包保留私钥管理、解锁和审批 UI；Kit 提供交易材料与执行流程。各平台的方法及使用方式见 [API 参考](docs/api-reference.md)。

## 示例

- [多钱包发现](packages/kit/examples/multi-wallet/README.md)
- [独立钱包](packages/kit/examples/independent-wallet/README.md)
- [Node.js 构建与签名](packages/kit/examples/backend-node/README.md)
- [Flutter 原生转账页面](docs/flutter/NATIVE_WALLET.md)
- [全部示例](docs/examples.md)

## 开发与贡献

工程源码位于 `source/`，可安装包位于 `artifacts/`，`packages/` 提供包内容浏览。文档、构建与检查方式见 [贡献指南](CONTRIBUTING.md)。

[问题反馈](SUPPORT.md) · [安全](SECURITY.md) · [许可证](LICENSE) · [包校验值](SHA256SUMS)
