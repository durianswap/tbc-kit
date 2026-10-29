# API 参考

## JavaScript / TypeScript

所有入口均来自一个 `@tbc/kit` 安装包。下表链接到随包提供的类型定义；IDE 可直接补全方法、参数与返回值。

| 入口 | 用途 | 类型 |
| --- | --- | --- |
| `@tbc/kit` | DApp 客户端、钱包发现、连接与业务调用 | [主入口](../packages/kit/dist/types/index.d.ts) |
| `@tbc/kit/wallet` | 钱包宿主、业务编排、审批和平台适配 | [Wallet](../packages/kit/dist/types/wallet.d.ts) |
| `@tbc/kit/engine` | 无私钥交易构建、摘要与交易完成校验 | [Engine](../packages/kit/dist/types/engine.d.ts) |
| `@tbc/kit/api` | 官方 HTTP API | [API](../packages/kit/dist/types/api.d.ts) |
| `@tbc/kit/rpc` | 节点 JSON-RPC | [RPC](../packages/kit/dist/types/rpc.d.ts) |
| `@tbc/kit/sqlite` | 钱包持久化存储适配 | [SQLite](../packages/kit/dist/types/sqlite.d.ts) |
| `@tbc/kit/multisig` | 钱包内部多签业务，不是 DApp Provider | [多签指南](../packages/kit/docs/multisig.md) |
| `@tbc/kit/testing` | 离线夹具与接入测试辅助 | [Testing](../packages/kit/dist/types/testing.d.ts) |

业务参数和使用示例见 [JavaScript 使用手册](../packages/kit/docs/usage.md)。

新版 Coin 稳定币的多轮合并、exact 输入与结果处理见 [Coin 多轮交易](coin-multiround.md)。这些操作仍使用现有公开方法，不新增一套 Provider 协议。

## Flutter / Dart

- [业务调用](flutter/BUSINESS_CALLS.md)：转账、资产、AMM/LP、锁定和批次。
- [原生钱包页面](flutter/NATIVE_WALLET.md)：公开 Dart 调用和查询工具。
- [账户与签名适配](flutter/ACCOUNT_AND_SIGNER.md)：派生路径、摘要签名和返回格式。

Flutter 使用独立的平台接口，不以 JavaScript 导出列表作为能力声明。

## 协议与网络

网络标识为 `tbc:mainnet` 与 `tbc:testnet`。公开 DApp 方法由 [方法注册表](../source/registry/methods.json) 定义，旧页面由 [Legacy 适配](legacy.md) 映射到 TBC 路径。

金额使用最小单位的十进制整数字符串。TBC 精度为 6；其他资产使用其元数据中的精度。
