# TBC Wallet Standard 1.0 test vectors

本目录是 TWS 1.0 的基础互操作向量。所有金额、供应量和大整数都使用十进制字符串；所有 hash 和公钥都使用小写 hex。

| 文件 | 用途 | Schema / 检查方式 |
| --- | --- | --- |
| `identifiers.json` | Mainnet、Testnet Chain ID 与 Account ID 派生 | `registry/networks.json` 与 TWS-002 规则 |
| `provider.json` | 请求 ID、乱序响应、账户与 Core capability | `registry/methods.json` 与 `schemas/provider.schema.json` |
| `permissions.json` | Permission Proposal、多链原子 CAS、断开撤销与强制 Caveat | `schemas/permissions.schema.json` 与 Permission Store Schema |
| `approval.json` | 八个 method binding 与六种严格 Preview | Approval Schema、Hash 与语义映射 |
| `intents.json` | 13 个公开 Intent 的最小有效请求 | `schemas/transaction-request.schema.json` |
| `signing.json` | JCS、Magic Hash 和 recoverable ECDSA 已知答案 | `schemas/signing.schema.json` 的结果定义，并重算密码学结果 |
| `workflow.json` | WorkflowPlan、deferred signing 唯一派生与原子失败 | `schemas/workflow.schema.json` |
| `integration.json` | TWS-011 九个 Port、18 个 Hash KAT、受限数据 allowlist、TBC transfer Canonical Profile 与语义失败 | `schemas/integration.schema.json`、Port/Hash 注册表并重算交易密码学结果 |
| `checkpoints.json` | 15 状态 checkpoint hash chain、CoreTransition、方法生命周期与过期边界 | Operation State registry 与 lifecycle oracle |
| `cancel-authority.json` | 按 cancellation reason 区分可省略与必需的当前 Authority | `integration.schema.json#/$defs/cancelInput` |
| `port-replay.json` | 14 个 Port operation 的 exact replay、collision 与三个 crash window | Replay oracle 与 Integration Schema |
| `errors.json` | JSON-RPC 与 TWS Execution Error 稳定形状 | `registry/errors.json` 与 `schemas/provider.schema.json` |
| `legacy-mapping.json` | 18 个已发布 Legacy flag 的完整迁移映射 | TWS-008 表格逐项一致 |
| `manifest.json` | 最小 Core + WebView 合规声明 | `schemas/conformance-manifest.schema.json` |
| `invalid.json` | 必须拒绝的 Schema 与安全边界样本 | 每项声明的 Schema 与 `expectedKeyword` |

`signing.json` 与 `integration.json` 使用众所周知的 secp256k1 测试标量 1。它只用于可复现测试，任何实现都不得把该测试密钥用于真实资产，也不得把 fixture key 当作 Integration Port 参数。

`integration.json` 的 Chain Snapshot 是在主网共识规则下运行的合成测试状态，不声明其中的 fixture UTXO 真实存在于主网。固定 Clock、Snapshot 与 Policy 只用于逐 byte 重现。

合规套件必须至少执行以下断言：

1. 所有正向请求通过对应 JSON Schema 和语义验证。
2. 规范化结果逐 byte 等于 `canonical`。
3. Magic Hash payload 和摘要逐 byte 相等；RFC 6979 fixture signer 还必须复现向量签名。
4. 对向量签名和生产 Signer 的任何合规签名，恢复出的压缩公钥、地址和 Account ID 必须一致。
5. Method、Event、Intent 与 Legacy flag 名称集合分别恰好为 14、6、13 与 18 项，且不得重复；Integration 注册表必须恰好为 9 个 Port 和 11 个操作。
6. Provider code、Execution Error name 及其合法 stage 组合必须与错误注册表逐项一致。
7. Workflow 只签名、不广播，绑定只写入声明的顶层 message 字段。
8. `integration.json` 的 Request、Snapshot、Policy、Plan 与 Approval Binding Hash 必须按 RFC 8785 重算；Template Hash 必须按 unsigned raw bytes 重算。
9. Canonical transfer 的 `0x41` sighash、compact64 low-S 签名、DER scriptSig、最终 raw transaction 和 TBC version-10 txid 必须逐 byte 相等。
10. `portExamples` 中的 JSON Pointer 必须解析，并通过注册操作声明的参数 / 结果 Schema；`semanticFailures` 必须产生指定 violation。
11. `coreExamples` 的 template 在验证前必须递归解析单字段 `{ "$refPointer": "/..." }`：用目标 JSON Pointer 的深拷贝替换占位对象，再分别验证 params 与 result Schema。
12. `portFailureExamples` 必须覆盖注册表中的全部九个 Port Error，并通过 `portFailure` Schema；Approval 的普通用户拒绝仍使用结构化 `status: "rejected"` 结果。
13. Secret-boundary scanner 必须覆盖注册的 14 个禁止字段名，并按 TWS-011 规则命中大小写、下划线、短横线和点号变体。
14. `hashKnownAnswers` 必须恰好覆盖 Hash Binding registry 的 18 项，并同时验证 `releaseFingerprint` 与 checkpoint payload；operationId、callId、commitId 另按 domain-separated byte layout 重算。
15. OperationCheckpoint 的 15 个 state 必须逐一重算 Hash 与前驱；Port/Provider commit replay 必须证明同 ID 同 payload 精确重放、同 ID 不同 payload fail closed。
16. Ordinary log、telemetry 与 Port error fixture 不得出现 allowlist 中的 approval token、raw transaction、signature、checkpoint 或完整 message，也不得出现 14 个禁止 secret field。
17. `cancelInput` 只允许 `REQUEST_ABORTED`、`TRANSPORT_CLOSED` 与 `PROTOCOL_RELEASE_CHANGED` 同时省略 current context/session；其他原因必须同时提供两者，所有原因都拒绝半组 authority。

这些是 v1.0 的最小基线，不替代边界、拒绝、安全和传输测试。
