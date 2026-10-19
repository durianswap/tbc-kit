# TBC Legacy 兼容

Legacy 适配为已有 TBC DApp 保留 `window.Turing` 的调用与返回形式。新 DApp 使用 Wallet Standard 发现钱包，并通过 `@tbc/kit` 调用标准 Provider。

## 保留的接口

- 连接与查询：`connect`、`disconnect`、`isConnected`、`getAddress`、`getPubKey`、`getNetwork`、`getInfo`、`getBalance`。
- 交易与签名：`sendTransaction`、`signTransaction`、`signAssociatedTransaction`、`sendBatchRequest`、`signMessage`。
- 加解密与维护：`encrypt`、`decrypt`、`mergeUtxos`、`mergeFtUtxos`、`mergeStableCoinUtxos`。
- 事件订阅：`on`、`removeListener` 及 Turing 账户、网络和响应事件。

接口按钱包声明的实际能力启用，旧资产操作仍受合约类型与账户权限约束。适配层只转换协议，不另建交易、签名或取数实现。

## 接入范围

TBC Kit 不注入 `window.Turing.evm` 或 `window.Turing.btc`。多链钱包在各链自己的 Provider 中实现其他网络，不能通过 TBC 的连接状态授权其他链。

旧 TBC 消息签名沿用 Bitcoin Signed Message 编码以兼容现有 DApp。这是签名格式，不是 Bitcoin 网络支持；不要删除对应摘要和验签逻辑。

Legacy 可以关闭。关闭后不注入 `window.Turing`，标准钱包发现与 TBC Provider 保持可用。
