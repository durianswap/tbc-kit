# 示例

以下示例随 JavaScript 包一起提供。标为离线的示例使用合成数据，不会广播交易；接入实际钱包时替换示例中的账户、审批和签名适配器。

| 目标 | 示例 |
| --- | --- |
| 发现和选择钱包 | [多钱包连接](../packages/kit/examples/multi-wallet/README.md) |
| 接入一个独立钱包 | [钱包宿主](../packages/kit/examples/independent-wallet/README.md) |
| 服务端构建与签名 | [Node.js](../packages/kit/examples/backend-node/README.md) |
| 查询 API 与节点 RPC | [只读查询](../packages/kit/examples/api-rpc/README.md) |
| 登录与消息签名 | [Sign-in](../packages/kit/examples/sign-in/README.md) |
| 展示审批材料 | [Approval presentation](../packages/kit/examples/approval-presentation/README.md) |
| 创建、铸造和转移 NFT | [NFT](../packages/kit/examples/nft-three-step/README.md) |
| 核验收款 | [Receipt verification](../packages/kit/examples/receipt-verification/README.md) |
| 合并 UTXO | [维护操作](../packages/kit/examples/merge-maintenance/README.md) |
| React Native 接入 | [原生计算桥](../packages/kit/examples/react-native-engine/README.md) |
| Flutter 原生业务页面 | [Dart 转账与资产页面](flutter/NATIVE_WALLET.md) |

安装 JavaScript 包后，可直接运行离线示例：

```sh
node node_modules/@tbc/kit/examples/multi-wallet/run.mjs
node node_modules/@tbc/kit/examples/backend-node/run.mjs
```
