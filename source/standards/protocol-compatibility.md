# Protocol compatibility scope

- EIP-1193 Provider、错误和事件语义：TBC 使用自己的方法和链能力，不是 EVM 交易兼容。
- 严格 EIP-2255 permissions：权限以实际账户、来源和方法绑定，连接不等于签名授权。
- Wallet Standard 用于 TBC discovery，`tbc:provider` 提供 TBC 连接入口；EIP-6963 仅用于 EVM。
- JSON-RPC 2.0 strict single-request profile：每个请求有独立 ID，不支持 JSON-RPC batch 或 notification。
- `tbc:` 是 TWS 本地 CAIP-compatible namespace，外部注册待完成。
- JCS 即 RFC 8785，用于协议对象的确定性序列化和哈希绑定。

这些是协议设计的采用范围，不是外部组织授予的认证，也不替代平台或链上验收。
