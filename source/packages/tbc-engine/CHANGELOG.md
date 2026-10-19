# Changelog

## 1.0.0-draft.6.3

与 TWS wire `1.0.0-draft.6` 保持逐字节兼容的协调发布；Engine 公共接口和协议资产未改变。

## 1.0.0-draft.6.2

与 TWS wire `1.0.0-draft.6` 保持逐字节兼容的协调发布；Engine 公共接口和协议资产未改变。

## 1.0.0-draft.6.1

首个兼容 TWS wire `1.0.0-draft.6` 的 clean-room TBC Engine 实现：

- 提供精确的 `normalizeRequest`、`plan`、`validate`、`finalize` 四方法 facade，不提供 `execute`。
- 支持任意原生 `tbc.transfer@1.0`、确定性选币、version-10 codec、直接 SIGHASH 65、compact64 low-S 验签、严格 P2PKH DER/scriptSig 与 TuringTXID。
- 在 `plan`、`pre-sign`、`finalized`、`pre-broadcast` 四阶段重新推导安全不变量，并返回 TWS-011 冻结 violation code。
- 通过真实 Core-to-Engine canonical/多 UTXO 发送链路，以及 ESM、CJS、browser/Hermes-neutral 可移植性门禁。
- 多输入路径固定 plan/template hash、两个 signing digest、unsigned/signed raw 与 txid KAT；React Native 实际发布入口在无 ES2022 `Array.prototype.at` 的 ES2020 环境执行。
- Engine 不接收私钥，不签名、不广播、不联网、不持久化，不依赖旧钱包、TBCNODE、`tbc-lib-js`、UI、Vault 或私有协议。

本版本只新增实现包与更强 TypeScript 边界；冻结的 Draft 6 Schema、Registry、测试向量、fingerprint 和 release manifest 均未改变。
