# TWS-011：Wallet Integration Ports

- 状态：Draft
- 版本：1.0.0
- 类型：Integration / Security
- 依赖：TWS-000 至 TWS-008
- 被引用：TWS-009、TWS-010

## 1. 目的

本文定义 TWS 标准内核与钱包宿主之间的可移植集成边界。它解决两个不同层次的互操作问题：

1. TWS-001 至 TWS-008 定义 DApp 与钱包之间的公开 wire protocol；
2. TWS-011 定义标准内核与第三方钱包账户、链数据、策略、批准、签名和广播能力之间的 host protocol。

第三方钱包可以保留自己的 UI、Vault、Secure Enclave、账户数据库、节点供应商和发布流程。它实现本文规定的九个基础 Host Port，并按能力实现两个可选 Port，即可复用同一 TWS Provider、Intent 规范化、确定性交易引擎和安全不变量。

TWS-011 不是新的 DApp API。任何本文端口、Plan、Snapshot、Policy、Approval Token 或 Signer 任务都不得暴露到 `window`、Wallet Standard feature 或不受信任页面。

## 2. 组件所有权

标准内核必须拥有：

- Provider 路由、方法注册表和 JSON-RPC 关联；
- Intent 默认值应用、规范化和语义验证；
- 确定性交易计划、sighash 生成和交易完成；
- Session 生命周期、权限与批准编排；
- Bundle 拓扑广播和失败对账状态机。

Wallet Host 必须提供九个基础 Port；启用加解密或已构建交易签名时，还必须提供对应的可选 Port：

| Port | 操作 | 权威边界 |
| --- | --- | --- |
| `accounts` | `accounts.resolve` | 公开账户身份与钱包选择状态 |
| `chainData` | `chainData.resolve` | 链包含性、确认数和已花费状态 |
| `policy` | `policy.resolve` | 钱包费用、安全限额和合约版本策略 |
| `permissionStore` | `permissionStore.load`、`permissionStore.commit` | 按 Origin 与 Chain 的权限持久化 |
| `approval` | `approval.request` | 可信 UI 和用户批准 |
| `signer` | `signer.sign` | 唯一允许触达密钥实现的边界 |
| `crypto` | `crypto.execute` | 可选；执行已批准的账户绑定加解密任务 |
| `reviewedTransaction` | `reviewedTransaction.review`、`reviewedTransaction.execute` | 可选；审批前校验公开原文/关联交易，审批后在密钥边界执行完全相同的审查任务 |
| `broadcast` | `broadcast.submit`、`broadcast.submitBatch`、`broadcast.reconcile` | 单笔/有序批量节点提交和链上对账 |
| `clock` | `clock.now` | 可信当前时间 |
| `entropy` | `entropy.randomBytes` | Session、nonce 与幂等键随机源 |

规范性端口集合和 Schema reference 位于 `registry/integration-ports.json`。TWS 1.0 实现不得删除、改名或重新解释端口；某个产品暂不支持的功能仍必须提供端口，并返回稳定的 Port Error。

实现可以在同一进程中直接调用，也可以使用进程间 RPC。跨进程传输必须保持与 `schemas/integration.schema.json` 等价的 JSON 数据模型、请求关联和错误语义。

## 3. 调用包络与并发

每个 Core-to-Host 调用使用逻辑包络：

```json
{
  "version": "1.0",
  "callId": "etIjrXRWdnGta84eKtv6Ixg4_lqK8aS0zIXlWDcSZDY",
  "operation": "chainData.resolve",
  "params": {}
}
```

成功响应必须回显相同 `callId` 并只包含 `result`；失败响应必须回显相同 `callId` 并只包含结构化 `error`。`callId` 是 operation 内确定性 effect idempotency key，不能作为权限、批准、签名或广播凭据。

Port 必须支持并发调用和乱序响应。实现不得按操作名、Intent type、当前页面或“最后一次请求”关联响应。Host 必须在 dispatch 前查 durable replay journal：相同 `callId + operation + params` 返回第一次持久化的完全相同 response，不再执行副作用；相同 `callId` 搭配不同 operation 或 params 返回 `CONFLICT` 并终止 operation。未知、迟到、重复或已经取消的 response 不能推进 checkpoint。

标准 Port Error 名称为：

- `INVALID_INPUT`
- `UNAVAILABLE`
- `NOT_FOUND`
- `CONFLICT`
- `UNAUTHORIZED`
- `REJECTED`
- `SIGNATURE_FAILED`
- `BROADCAST_REJECTED`
- `INTERNAL_ERROR`

错误文案不是程序接口。Core 必须按 TWS-001 将 Port Error 映射为 Provider code 和稳定的 Execution Error，不得把宿主堆栈、节点认证信息或 Vault 细节返回 DApp。

## 4. 可信上下文与最小披露

`TrustedContext` 只能由 Transport 与 Wallet Host 建立，至少绑定：

- `sessionId`；
- `transport`；
- 规范化 `origin`；
- 顶层 `topOrigin`；
- `frame`；
- WebView / Extension 的当前 `navigationId`（Remote 可以省略）；
- `createdAt`。

DApp payload 中的同名字段没有任何权威性。Core 只能把完成某个 Port 操作所需的最小上下文传给该 Port：例如 Chain Data Port 不接收 Origin，Signer Port 不接收页面标题或 DApp 任意 metadata，Broadcast Port 不接收 Vault 状态。

所有集成对象使用严格 Schema。除 Schema 明确列出的字段外，未知字段必须拒绝。以下秘密或实现句柄不得出现在 DApp Request、Chain Snapshot、Policy、Plan、Preview、Approval Binding 或 Broadcast 参数中：

- private key、WIF、mnemonic、seed、password；
- Vault token、Vault handle、session handle、quick-sign grant handle；
- API key、Authorization header、RPC endpoint 或节点凭据。

机器可读字段集合登记在 `registry/integration-ports.json`。扫描器必须对每个嵌套 object key 执行 ASCII lowercase，并删除 `_`、`-` 和 `.` 后，与注册项按同样规则归一化比较；因此 `privateKeyWif`、`private_key_wif` 和大小写变体等价。Signer Port 的实现可以在自己的受信任进程内使用不可导出的 Vault handle，但该 handle 不能成为 TWS-011 参数或结果。发现禁止字段必须终止当前操作；语义验证报告 `SECRET_FIELD_PRESENT`，不得静默删除后继续签名。

## 5. 规范化与 Hash 绑定

TWS-011 使用 RFC 8785 JCS 和 SHA-256 固定跨钱包边界。执行 Hash 前必须拒绝重复 JSON key、非 Unicode scalar、非 I-JSON 数值和 Schema 外字段。

以下规则均产生 32-byte SHA-256 的小写 hex：

| 名称 | 输入 |
| --- | --- |
| `requestHash` | 应用全部协议默认值后的完整 `TransactionRequest` 的 JCS UTF-8 bytes |
| `snapshotHash` | `ChainSnapshot.payload` 的 JCS UTF-8 bytes |
| `policyHash` | `ExecutionPolicy.payload` 的 JCS UTF-8 bytes |
| `templateHash` | `unsignedTransaction` hex 解码后的原始 bytes |
| `planHash` | `ExecutionPlan.payload` 的 JCS UTF-8 bytes |
| `bindingHash` | `ApprovalBinding.payload` 的 JCS UTF-8 bytes |

Hash 字段本身永远不进入自己的 Hash 输入。Core 在使用每个对象前必须重算并恒定时间比较对应 Hash；不能只信任提供该对象的 Port。

## 6. Accounts Port

`accounts.resolve` 返回 TBC 地址、CAIP-10 Account ID、Chain ID 和压缩 secp256k1 公钥。它不得返回余额、密钥句柄或解锁状态。

`mode: "available"` 查询钱包可供选择的账户，`"active"` 只查询当前产品选择，`"by-id"` 必须携带 `accountIds` 并只解析这些身份。返回顺序是宿主偏好顺序，不授予权限；Core 仍按 Origin Caveat 过滤。

Core 必须独立检查：

- 地址、Account ID、Chain ID 与公钥互相一致；
- 账户属于请求网络；
- 当前 Origin 的权限 Caveat 允许该账户；
- `from` 与最终签名账户完全一致。

账户可用不等于 DApp 已获授权，Vault 已解锁也不等于用户已批准本次操作。

## 7. Chain Data Port

`chainData.resolve` 接收由 Core 从 Intent 派生的最小查询，不接收 DApp 自选 UTXO、API endpoint 或任意脚本。结果是有过期时间且带 Hash 的不可变 `ChainSnapshot`。

Snapshot 可以包含：

- 锚定区块的高度、哈希和确认语义；
- 当前账户的候选 UTXO；
- 合约当前 outpoint 与版本记录；
- 验证合约祖先所需的 raw parent transaction。

信任被有意拆分：Host 对链包含性、确认数和“当前未花费”状态负责；Core 仍必须解析 raw transaction，并验证 txid、outpoint、金额、script、账户控制权、合约 ancestry 和记录之间的内部一致性。`classification` 与索引 metadata 只是候选提示，不能替代交易字节验证。

同一 Plan 只能绑定一个 Snapshot。Snapshot 过期、输入已花费、reorg、确认数下降或所需 ancestry 不完整时必须废弃 Plan 并重新开始批准流程。

## 8. Policy Port

`policy.resolve` 根据规范化 Request 和 `snapshotHash` 返回带 Hash 的不可变 `ExecutionPolicy`。Policy 由 Wallet Host 或其受信任注册表产生，DApp 不能覆盖。

Policy 至少固定：

- fee rate、dust threshold、最小确认数与最大 Bundle 大小；
- 允许的合约版本和创建版本；
- 资产数值范围；
- Pool 的解析后 `lpPlan`、`serviceProviderTag` 和 `serviceFeeRate`；
- Policy 失效时间。

`serviceFeeRate` 永远不是公开 Intent 字段。`tbc.pool.create` 中 DApp 请求的 `lpPlan` 或 `serviceProviderTag` 只有在钱包策略允许时才能进入解析后 Policy；实际费率必须由可信策略派生并写入 `policyHash`。

TWS 1.0 交易输入签名固定使用 sighash byte `0x41`（`SIGHASH_ALL | SIGHASH_FORKID`）。80 sat/kB fee rate 和 24 sat dust 是 Canonical Profile 测试向量的固定策略，不是所有钱包在所有时间的全局产品默认值。

## 9. 数值语义

Schema 只验证无符号十进制字符串的词法形式；Semantic Validator 必须在任何算术前验证具体资产与合约版本的范围：

- 原生 TBC 的总货币上限为 `2100000000000000` satoshi；
- 单个 UTXO satoshi 字段必须同时满足链编码范围和总货币上限；
- 当前 FT 总量模型可以使用 UInt128，但某些 slot、Pool state 或合约版本字段仍是 UInt64；
- 合约版本比通用资产类型更严格时，以该版本限制为准；
- 中间加、减、乘、除必须使用 checked integer arithmetic，不能先溢出再比较。

任何越界、下溢或精度损失报告 `AMOUNT_OUT_OF_RANGE`。Adapter 不得使用 JavaScript `number` 解析、缩放或计算 TBC、FT、Stablecoin、LP 或 Pool 数值。旧接口的人类小数字符串必须在 Legacy Adapter 边界按明确 decimals 精确转换，进入 Core 后只能是最小单位整数。

## 10. Plan 与确定性引擎

Core 的计划入口接收且只接收规范化 Request、`ChainSnapshot` 和 `ExecutionPolicy`。`ExecutionPlan.payload` 必须包含：

- `requestHash`、`snapshotHash`、`policyHash`；
- Chain ID、Account ID 和失效时间；
- 一至 32 个按拓扑顺序排列的 transaction template；
- 每个输入或结构化消息的完整 signing task；
- UI 无关、无 raw transaction 的结构化 Preview；
- 可验证的 artifact 预期值。

Reviewed 的数量也按总交易数计算：raw 最多32笔，associated 的source占一笔，因此children最多31笔。公开请求必须在入口Schema拒绝超限，不能等到取数或审批预览阶段才发现33笔不能表示。底层SDK/Legacy私有计算的容量不自动扩大此公开协议的容量。

`schemas/integration.schema.json` 中的 `normalizeRequestParams` / `normalizeRequestResult`、`planParams` / `planResult`、`validateParams` / `validationResult` 和 `finalizeParams` / `finalizeResult` 是 Core conformance facade。它们定义可移植引擎必须可被独立测试的逻辑输入与输出，不是第 2 节的 Host Port，也不要求各语言 SDK 使用相同函数名。生产 Provider 可以通过一个更高层 facade 编排这些纯 Core 步骤和九个 Host Port。

每个 transaction template 包含 unsigned raw bytes、`templateHash`、角色、依赖和费用。签名任务在批准前生成并进入 `planHash`。任何 input、output、fee、sighash、digest、任务顺序、依赖或 artifact 改变都会改变 `planHash` 并使旧批准失效。

确定性分为两个合规等级：

- **Semantic Conformance**：实现可以使用不同但安全的 UTXO 选择；最终 Plan 必须满足全部规范不变量。
- **Canonical Profile**：固定的 Request、Snapshot、Policy 和 RFC 6979 fixture signer 必须逐 byte 产生指定 Plan、sighash、raw transaction、txid 和 fee。

公共中间层参考实现必须通过 Canonical Profile。第三方钱包若复用该引擎，只需证明九个 Host Port 与编排符合；独立实现引擎的钱包还必须通过逐 Intent Semantic Conformance，并至少运行官方 Canonical 向量作为差异诊断。生产 Signer 可以使用其他 nonce；只要签名可验证且满足 low-S，Semantic Conformance 不要求其 raw transaction 或 txid 等于 fixture。

`tbc.pool.create` 是一个公开的复合 Intent。Core 必须在一次 Plan 与一次批准中编排 Pool create 和 init，交易间依赖写入 Bundle；不能要求 DApp 发起两个私有操作或批准两次。

## 11. Preview 与批准

Preview 是 UI-neutral 数据，不规定布局或文案。它至少包含：

- 发送、接收、mint、burn、lock、unlock 和 fee 的资产流；
- 原生币总矿工费；
- 交易数量；
- 不可逆标记；
- 稳定 warning code。

Preview 不包含 unsigned/raw transaction、sighash、签名、Vault 标识或节点信息。钱包可以在可信 UI 中增加本地化解释，但不能隐藏规范 Preview 中的接收方、金额、费用、合约、锁定或 warning。

`transactionPreview.signingTaskCount` 可选；存在时表示已绑定计划**全部阶段**的精确外部签名任务数，不是批准次数，也不是初始 `signingTasks.length`。总数随 Preview 一起受 `planHash` 与批准绑定。Engine 无法从当前计划确定后续上下文相关任务数时应省略；展示层必须标为未知，不以交易输入数、业务名称或当前阶段任务数猜测。Workflow 汇总需要计入每个 transaction plan 的后续阶段，同时不得重复累计已经复制到 `immediateSigningTasks` 的初始任务。此计数不得触发额外取数、签名或持久化。

`approval.request` 使用 `ApprovalBinding` 精确绑定：

- `operationKind`；
- Origin 与 Session；
- Chain 与 Account（适用时）；
- `requestHash`；
- `operationHash`；
- 失效时间。

Transaction 的 `operationHash` 是 `planHash`；Message/Typed Data 是最终 signing digest；Workflow 是包含全部步骤和绑定的 workflow plan hash。批准结果必须返回不透明 `approvalId`、`approvalToken`、原始 `bindingHash` 和不晚于 Binding 的失效时间。

Core 必须证明当前任务包含在已批准的 Plan；Signer 必须验证 Approval Receipt 未过期、`approvalToken` 真实且绑定其 `bindingHash`。批准拒绝映射为 Provider `4001`。Host 不能用“已解锁”“快捷签名开启”或之前批准过同类操作替代当前 Binding；快捷策略如果允许自动批准，也必须生成同样可审计、同样绑定的 Approval Receipt。

## 12. Signer Port

`signer.sign`、`crypto.execute` 与 `reviewedTransaction.execute` 都是明确的密钥边界，且用途不可互换。`signer.sign` 请求只包含：

- task ID、purpose、algorithm 和 32-byte digest；
- Account ID 与所选签名算法对应的公开公钥编码；
- 交易 input index 和固定 sighash byte，或消息 Origin；
- 与任务精确匹配的 Approval Receipt。

Transaction task 支持两种严格配对的算法 profile，均使用 sighash `65`：

| algorithm | publicKey | signatureEncoding | 返回字节 |
| --- | --- | --- | --- |
| `secp256k1-ecdsa-sha256d` | 33-byte compressed SEC，小写 hex | `compact64` | 64-byte `r || s`，low-S |
| `secp256k1-schnorr-bip340` | 32-byte x-only，小写 hex | `schnorr64` | 64-byte BIP340 签名 |

响应不带 `0x41` 后缀，Engine 在严格验证后装配。两种 64-byte 签名不能因长度相同而互换，Schnorr 不经过 ECDSA DER 转换或 low-S 归一化。Message 与 Typed Data 仍使用 recoverable compact ECDSA；结果为 header byte `31..34`（hex `1f`、`20`、`21`、`22`）加 64-byte `r || s`，并满足 low-S；本次不修改消息签名标准。

Transaction task 的 `digest` 是对 TBC sighash preimage 直接执行 `SHA256(SHA256(preimage))` 后所得 32 bytes 的小写 hex，按该 byte 顺序交给 secp256k1 Signer；不得为了 txid 展示或旧 JavaScript 库的 little-endian ECDSA wrapper 反转 digest。Adapter 必须在 Port 边界统一该表示。

BIP340 将该已计算的 32-byte digest 作为消息输入，不再套一层通用消息哈希。其内部 BIP340 tagged-hash 计算仍按算法正常执行。仅在对应合约和构建器明确选择 Schnorr 时使用该 profile，不把全部交易自动切换算法。

`accountId` 继续表示已授权的真实钱包账户，不因任务使用 x-only 编码就替换为另一个地址。Signer 必须核对该 x-only key 确属已授权账户和已批准角色；同一密钥的 SEC/x-only 表示可按可信账户规则关联，但其脚本 hash160/地址不能混为同一值。独立管理员密钥不能冒用手续费账户授权。尚未实现该 profile 的 Signer 必须明确拒绝，不能静默降级为 ECDSA。

Signer adapter 必须在 Port 边界前把硬件钱包或 Vault 的 DER、恢复位和厂商格式按对应算法规范化。Core/Engine 必须验证签名、ECDSA 的 low-S、算法/公钥/编码配对、账户、digest 和任务 ID；不能因为 Signer 返回成功就跳过密码学验证。

## 13. Finalize 与广播

Finalize 是纯 Core 操作。它必须重新验证 Request、Snapshot、Policy、Plan、Approval Receipt 和每个 Signature，再把签名填入已批准的 template；不得重新选择输入、修改输出或重新规划。

Finalize 后 Core 必须验证：

- raw transaction 解析成功；
- 每个签名对应指定 input 与 digest；
- txid 从最终 raw bytes 重算一致；
- fee、业务输出、找零、合约状态和 artifact 与 Plan 一致；
- Bundle 依赖有效且最多 32 笔。

`broadcast.submit` 每次只接收一笔已完成交易和幂等键。Core 按 Bundle 拓扑顺序提交；`accepted` 和 `known` 都可记为 submitted，`rejected` 必须停止后继交易。发生部分失败时，Core 使用 `broadcast.reconcile` 按 txid 对账，并按 TWS-004 返回不含 raw transaction 的稳定失败详情。

`broadcast.submitBatch` 接收一至三十二笔已完成交易及一个批次幂等键。Host 必须保持 Core 给出的拓扑顺序，默认使用节点批量接口完成一次网络提交，不得静默退化为逐笔 POST。结果逐笔返回 `accepted`、`known`、`rejected` 或 `unknown`；响应截断、身份不符或提交响应丢失不能记为成功。若前置交易为 `rejected` 或 `unknown`，依赖它的后继交易不得报告为已提交。批量提交不具有链上原子性；真实提交后仍为 `unknown` 的记录只能经 `broadcast.reconcile` 查询，不得换键重发。

同一幂等键只能绑定同一 txid 和 raw bytes。节点 endpoint、认证与重试供应商策略只存在于 Broadcast Port 内部。

## 14. Permission Store、Clock 与 Entropy

权限存储 scope 恰好是规范化 Origin 与 Chain ID。`permissionStore.commit` 必须使用 `expectedRevision` 做原子 compare-and-swap；空权限数组表示撤销。冲突返回 `CONFLICT`，Core 必须重新读取，不能覆盖并发权限缩小或撤销。

`clock.now` 新生成的时间统一为 UTC 三位毫秒，例如 `2026-10-07T00:00:00.123Z`（整秒写为 `.000Z`）。协议输入接受整秒或 1–3 位小数的 UTC 时间，拒绝时区偏移、微秒和非法日期。Core 的过期判断只能使用 Clock Port，不能混用页面时间；按实际时间比较，不按字符串排序，到达截止时刻即过期。

时间格式化只发生在生成未绑定材料时。审批绑定、签名消息、Prepared 材料和既有 checkpoint 中的时间必须保留原字符串；表示同一时刻不意味着哈希相同。Dart 的微秒时钟在生成新时间时按 epoch milliseconds 取值，不能对收到的已绑定时间截断或向上取整。此规则不改变交易 `nLockTime`、HTLC、链上时间及单调时钟。

`entropy.randomBytes` 接受 16 至 64 bytes 长度并返回无 padding base64url。Core 必须检查解码后长度完全相等；返回值只用于确实要求不可预测性的 session 或 nonce，不能替代密钥生成 API。Draft.3 的 `operationId`、`callId`、Permission ID 与 Broadcast idempotency key 按 TWS-002 确定性派生，不消耗 Entropy Port，也不能代替 bearer credential。

## 15. Semantic Validator

标准 Validator 阶段为 `plan`、`pre-sign`、`finalized` 和 `pre-broadcast`。每次验证返回全部安全相关 violation，不用英文字符串控制分支。

TWS 1.0 violation 集合为：

- `REQUEST_HASH_MISMATCH`
- `SNAPSHOT_HASH_MISMATCH`
- `POLICY_HASH_MISMATCH`
- `PLAN_HASH_MISMATCH`
- `APPROVAL_BINDING_MISMATCH`
- `PLAN_EXPIRED`
- `SNAPSHOT_EXPIRED`
- `CHAIN_MISMATCH`
- `ACCOUNT_MISMATCH`
- `INPUT_NOT_IN_SNAPSHOT`
- `INPUT_ALREADY_SPENT`
- `ANCESTRY_INVALID`
- `UNSUPPORTED_CONTRACT_VERSION`
- `AMOUNT_OUT_OF_RANGE`
- `BUSINESS_OUTPUT_MISMATCH`
- `MINIMUM_OUTPUT_NOT_MET`
- `CHANGE_NOT_CONTROLLED`
- `FEE_MISMATCH`
- `FEE_LIMIT_EXCEEDED`
- `DEPENDENCY_INVALID`
- `SIGNING_TASK_MISMATCH`
- `SIGNATURE_INVALID`
- `TXID_MISMATCH`
- `ARTIFACT_MISMATCH`
- `BUNDLE_LIMIT_EXCEEDED`
- `SECRET_FIELD_PRESENT`

四个阶段和 26 个 code 的机器可读权威集合同时登记在 `registry/integration-ports.json`；Schema enum、规范正文与注册表不得分叉。

`valid: true` 要求 violations 为空；存在任何 violation 时 `valid` 必须为 false，且当前阶段不能继续。Provider 映射是规范性的：

| Violation | Provider 映射 |
| --- | --- |
| `REQUEST_HASH_MISMATCH`、`SECRET_FIELD_PRESENT` | `-32602` `INVALID_PARAMS` |
| `APPROVAL_BINDING_MISMATCH`、`CHAIN_MISMATCH`、`ACCOUNT_MISMATCH` | `4100` `UNAUTHORIZED` |
| `PLAN_EXPIRED`、`SNAPSHOT_EXPIRED` | `-32000` / `REQUEST_EXPIRED` / `validation` |
| `INPUT_ALREADY_SPENT` | `-32000` / `CONFLICT` / `validation` |
| `UNSUPPORTED_CONTRACT_VERSION` | `-32000` / `UNSUPPORTED_ASSET` / `validation` |
| `MINIMUM_OUTPUT_NOT_MET` | `-32000` / `SIMULATION_FAILED` / `simulation` |
| `FEE_LIMIT_EXCEEDED` | `-32000` / `FEE_LIMIT_EXCEEDED` / `planning` |
| `FEE_MISMATCH`、`DEPENDENCY_INVALID`、`ARTIFACT_MISMATCH` | `-32000` / `PLANNING_FAILED` / `planning` |
| `SIGNING_TASK_MISMATCH`、`SIGNATURE_INVALID`、`TXID_MISMATCH` | `-32000` / `SIGNING_FAILED` / `signing` |
| 其余 Hash、链数据、数值、业务输出、找零和 Bundle violation | `-32000` / `POLICY_VIOLATION` / `validation` |

实际用户拒绝 Approval 或硬件 Signer 确认使用 `4001`，但不是 Semantic violation。Port Error 还必须稳定映射：`INVALID_INPUT -> -32602`、`UNAUTHORIZED -> 4100`、`REJECTED -> 4001`、`CONFLICT -> -32000/CONFLICT`、`SIGNATURE_FAILED -> -32000/SIGNING_FAILED`、`BROADCAST_REJECTED -> -32000/BROADCAST_FAILED`、`INTERNAL_ERROR -> -32603`；`NOT_FOUND` 与 `UNAVAILABLE` 由当前阶段映射到已注册的 execution name，并保留 `retryable`。

## 16. 生命周期

Transaction 请求的标准生命周期为：

```text
trusted context
-> schema + permission
-> normalize + requestHash
-> accounts.resolve
-> chainData.resolve + snapshotHash
-> policy.resolve + policyHash
-> plan + planHash
-> semantic validate(plan)
-> approval.request(bindingHash, preview)
-> semantic validate(pre-sign)
-> signer.sign(each task)
-> finalize
-> semantic validate(finalized)
-> return signed bundle OR broadcast in topological order
-> reconcile when uncertain
```

任何 Session revoke、导航、Origin 改变、Chain 切换、Account 切换、过期、Snapshot 失效或 Hash 改变都必须取消未完成操作。取消后到达的 Approval、Signer 或 Broadcast 响应不得恢复该操作。

Message、Typed Data 和权限操作使用相同的 Trusted Context、Permission Store、Approval Binding、Clock 和 Entropy，但不伪造 Transaction Plan。Workflow 将所有 transaction plan 和 signing task 先绑定为一个不可变 workflow plan，再进行一次批准。

## 17. 合规要求

声明 `integration` Profile 的实现必须：

- 实现注册表中恰好九个 Port 和全部 11 个操作；
- 通过所有 Port Schema、并发、取消、错误和秘密边界测试；
- 通过 Hash 重算、批准失效和 Signer 密码学验证；
- 对全部 13 个 Intent 通过 Semantic Conformance；
- 对参考引擎通过 Canonical Profile；
- 证明 Provider、Plan、Preview、Snapshot、Policy 和 Broadcast 数据不含密钥或实现句柄；
- 证明第三方 Wallet Host 不依赖 Turing Wallet 私有 UI、Hook、Vault 或旧 `window.Turing`。

只实现与九个 Port 相似的内部接口，或只能在官方钱包中运行，不构成 TWS-011 合规。

## 18. 非目标

TWS-011 不规定 Vault 内部 API、硬件钱包传输、节点 RPC、索引器实现、UI 组件、日志后端、报价源、跨链桥或多链账户抽象。它也不允许钱包通过“自定义 Port”扩大 DApp 能力；新的权威边界必须通过后续 TWS 版本标准化。

## 19. Draft.3 可恢复 Core 与 Authority 输入

公共 `TwsCore` 只包含四个方法：`start`、`resume`、`acknowledgeCommit`、`cancel`。对应输入路径 `startInput.currentSession`、`resumeInput.currentSession`、`acknowledgeCommitInput.currentSession`、`cancelInput.currentSession` 都绑定 Host 在调用前重新读取的 `ProviderSessionSnapshot`；其中 `REQUEST_ABORTED`、`TRANSPORT_CLOSED` 与 `PROTOCOL_RELEASE_CHANGED` 的原因本身已证明当前 authority 不可取得或不再适用，因此 `cancel` 可同时省略 current context/session。其他原因必须同时提供两者；任何原因都禁止只提供其中一项。Core 不读取 React state、Redux、Chrome tab、WebView navigation、Vault、数据库、节点或其他隐式全局状态。

以下 JSON 是本节与 Schema/registry 必须逐项相等的机器可读契约摘要：

```json
{
  "kind": "tws-draft3-core-contract",
  "coreMethods": ["start", "resume", "acknowledgeCommit", "cancel"],
  "coreTransitions": ["continue", "waiting", "commit", "complete"],
  "providerAuthorityInputs": [
    "startInput.currentSession",
    "resumeInput.currentSession",
    "acknowledgeCommitInput.currentSession",
    "cancelInput.currentSession"
  ],
  "methodCategories": [
    "session-read",
    "permission-read",
    "account-read",
    "permission-request",
    "switch-chain",
    "message-signing",
    "sign-transaction",
    "send-transaction",
    "sign-workflow",
    "send-workflow",
    "wallet-action",
    "disconnect"
  ],
  "committingKinds": ["permission-store", "provider-session"]
}
```

每次调用的强制处理顺序是：验证 release/checkpoint → 验证 current context/session → 消费至多一个匹配的 response → 写入单调累积 memory → 返回 transition。`acknowledgeCommit` 的当前 Session 必须精确等于待提交 mutation target；普通 resume 的 chain、active accounts、scope、connected 或 revision 漂移必须在解释 response 前 fail closed。

`CoreTransition` 恰好有四个分支：`continue`、`waiting`、`commit`、`complete`。

- `continue` 携带非终态且无 pending call 的 checkpoint；Host 持久化后以不含 response 的 `resume` 推进。
- `waiting` 的 calls 必须与 checkpoint pending calls 完全相等且非空；每次 `resume` 必须且只能消费一个匹配 response。
- `commit` 只携带 Provider Session mutation；checkpoint 必须处于 provider-session committing 且无 pending call。
- `complete` 只携带四个终态之一及一次性 respond/suppress completion，不能再次 resume 或 cancel。

Host 不得把连续纯 Core 阶段折叠为一次未持久化调用，也不得给 continue checkpoint 伪造 response 或在 waiting checkpoint 省略 response。公开 Core 不提供高层 `execute(request)`。

## 20. Operation Checkpoint、Memory 与 State Policy

Operation state 的完整 15 项集合是：`initializing`、`validating`、`authorizing`、`resolving`、`planning`、`approval`、`signing`、`finalizing`、`broadcasting`、`reconciliation`、`committing`、`completed`、`rejected`、`failed`、`cancelled`。其中 `completed`、`rejected`、`failed`、`cancelled` 是无 Port、continue、commit 或 outgoing transition 的终态。

`OperationCheckpoint.payload` 必须绑定 `ProtocolRelease`、`releaseFingerprint`、`operationId`、十进制 revision、前驱 `checkpointHash`、state、JSON-RPC request ID、规范化 operation、完整 Trusted Context、`contextHash`、Provider Session snapshot、可信时间、pending calls、严格 Operation Memory 与 state-specific cursor；wrapper 的 `checkpointHash` 是 payload 的 JCS SHA-256。除 bootstrap 外，revision 必须逐一递增并引用直接前驱。

Operation Memory 是 additional-properties false 的累积对象，允许的 32 个字段是：`trustedTime`、`requestHash`、`permissionLoads`、`accountResolutions`、`normalizedTransaction`、`preparedTransaction`、`chainSnapshot`、`executionPolicy`、`workflowPolicies`、`executionPlan`、`walletActionPlan`、`permissionProposal`、`chainSwitchProposal`、`messageEnvelope`、`typedDataEnvelope`、`workflowPlan`、`reviewedTransactionReviews`、`approvalBinding`、`approvalPreview`、`approvalReceipt`、`signingTasks`、`signatures`、`cryptoResults`、`reviewedTransactionResults`、`finalizationStages`、`finalizedBundle`、`workflowProgress`、`permissionCommit`、`broadcastProgress`、`providerSessionMutation`、`providerSessionCommitAck`、`providerCompletion`。当前 checkpoint 必须单独包含继续执行所需的全部 artifact；前驱 Hash 只证明链连续性，不是外部数据引用。不可变 artifact 不得替换；列表和进度只能按规范追加、填充 pending 结果或保持不变。

`resolving.data.resolvedInputs` 是当前解析 cursor。第一次进入 `resolving` 并等待 `accounts.resolve` 时它可以是空对象；接受账户响应后的后续 resolving checkpoint 必须填入 `account`，且任何离开 resolving 进入 planning、approval、signing、finalizing 或成功终态的账户相关路径都必须已经拥有符合请求、权限与活动 Session 的账户解析 artifact。该 bootstrap 形状不能用于绕过账户权限或向 DApp 返回未授权账户。

首次 `clock.now` 成功前只允许 revision 0 的 initializing，或从它产生的 revision 1 failed/cancelled。Pre-clock terminal 必须引用 initializing hash，省略 created/updated/expires 时间且不能携带 pending call 或成功结果。Clock 是唯一可信当前时间；`updatedAt` 表示最近一次已接受的 Clock observation。除 bootstrap 外，Clock effect 只允许在 planning、approval、signing、finalizing、broadcasting 和 committing 的已登记 self transition 中出现。

`committing` data 是两个严格互斥分支。两者都可先只包含唯一 `clock.now` pending call，以便在最后提交 effect 前更新可信时间并复核 expiry。Clock 成功后，`permission-store` 包含 `permissionStore.commit` pending call 与 Permission Commit artifact；`provider-session` 不含 pending call，包含 Provider Session mutation 并产生 commit transition。前者是九 Port 中的 effect，后者是 Host/Core CAS handshake，不是第十个 Port；provider-session 永远不能携带 `permissionStore.commit`。

十二类 method path 是 exact set：`session-read`、`permission-read`、`account-read`、`permission-request`、`switch-chain`、`message-signing`、`sign-transaction`、`send-transaction`、`sign-workflow`、`send-workflow`、`wallet-action`、`disconnect`。其关键路径固定为：

| 类别 | 方法与规范路径 |
| --- | --- |
| session/permission/account read | `tbc_chainId`: initializing → validating → completed；`wallet_getPermissions`: 增加 authorizing；`tbc_accounts` / `tbc_getAccount` / `tbc_getCapabilities`: 再增加 resolving |
| permission request | `tbc_requestAccounts` / `wallet_requestPermissions`: initializing → validating → authorizing → resolving → approval → committing → completed/rejected |
| switch chain | `tbc_switchChain`: initializing → validating → authorizing → approval → committing → completed/rejected；同链 no-op 可直接 completed |
| message signing | `tbc_signMessage` / `tbc_signTypedData`: initializing → validating → authorizing → resolving → approval → signing → completed/rejected |
| sign transaction/workflow | `tbc_signTransaction` / `tbc_signWorkflow`: resolving 后必须经过 planning → approval → signing → finalizing → completed |
| independent wallet action | `tbc_signReviewedTransaction` / `tbc_encrypt` / `tbc_decrypt`: initializing → validating → authorizing → resolving → approval → signing → completed；reviewed transaction 必须经过钱包可信 reviewer，crypto 不读取链数据 |
| send transaction | `tbc_sendTransaction`: planning → approval → signing → finalizing → broadcasting → reconciliation（需要时）→ completed |
| disconnect | `tbc_disconnect`: initializing → validating → authorizing → committing → completed |

Registry 为每个 state 声明 allowed transitions、allowed Port operations、allowsContinue、memoryRequired 与 memoryAllowed。Sign-only 路径永远不能产生 Broadcast Port；所有交易路径都必须保持 plan → approval binding → `signer.sign` → finalize。

## 21. Host Loop、Effect 持久化与 Crash Recovery

规范 Host loop 固定为：

```text
Core transition
-> durably store exact checkpoint
-> continue: resume without response
-> waiting: execute or replay pending Port calls, persist exact responses, resume one response at a time
-> commit: CAS Provider Session, persist exact Ack, call acknowledgeCommit
-> complete: deliver or suppress once, then publish ordered events
```

每次 `resume` 与 `acknowledgeCommit` 前，Host 必须重新读取 current context/session。固定 effect 顺序是：持久化 checkpoint → 查询 replay journal → dispatch → 持久化 exact response → resume。Host 无法证明 checkpoint 已落盘时，不得执行 Approval、Signer、Permission Commit 或 Broadcast。多 pending call 可以乱序完成，但每次只消费一个；其余 call 必须原样保留，已消费、迟到、重复或未知 callId 不推进 revision。

三个 crash window 的安全行为固定：dispatch 前崩溃可以从 journal 判断并执行一次；dispatch 后、response 持久化前崩溃不得盲目重发，必须由 Port 的执行记录恢复同一 response；response 持久化后、resume 前崩溃直接重放该 response。`broadcast.submit` 与 `broadcast.submitBatch` 同时携带按 TWS-002 派生的业务 `idempotencyKey`，它与 call replay 解决不同层次的问题。

11 Port 与 15 operation 是 exact set：`accounts` / `accounts.resolve`，`chainData` / `chainData.resolve`，`policy` / `policy.resolve`，`permissionStore` / `permissionStore.load`、`permissionStore.commit`，`approval` / `approval.request`，`signer` / `signer.sign`，`crypto` / `crypto.execute`，`reviewedTransaction` / `reviewedTransaction.review`、`reviewedTransaction.execute`，`broadcast` / `broadcast.submit`、`broadcast.submitBatch`、`broadcast.reconcile`，`clock` / `clock.now`，`entropy` / `entropy.randomBytes`。

Provider Session mutation 的 scope 是 `(walletProfile, TrustedContext.sessionId)`，target revision 恰好加一并携带有序事件。Host 必须 CAS 一次、持久化 exact Ack，再调用 `acknowledgeCommit`；只有 complete 后才能完成 RPC 并发送事件。相同 commitId/相同 payload 重放首次 Ack；相同 ID/不同 payload 返回 `CONFLICT` 且不发送事件。Permission request/disconnect 使用 permission-store committing；有效 chain switch 使用 provider-session committing。

Checkpoint、Approval Token、raw transaction、signature、完整 message/Typed Data 和 Provider Session Snapshot 是受限操作数据，不能进入普通日志或遥测；WIF、mnemonic、private key、Vault/session/quick-sign handle、RPC endpoint 与认证信息在任何公共对象中都禁止出现。

## 22. Transaction Engine Conformance Facade

可移植交易引擎仍有四个纯逻辑 facade：`normalizeRequest`、`plan`、`validate`、`finalize`。它们分别接受严格 Request；Request + Snapshot + Policy；阶段所需全部已绑定对象；以及 Plan + Approval Receipt + signatures，并返回规范化 Request/hash、Execution Plan、Validation Result 与 finalized bundle。这四项用于引擎差异测试，不是 Host Port，也不是可恢复 Provider orchestration API。

私有 `wallet-vault/1`、Vault handle、quick-sign handle 或官方钱包 React/React Native 组件均不得成为 TWS 公共接口；跨产品只共享 Schema、semantic token 名称、状态 ID、风险与批准语义。
