# TWS-009：合规等级与测试要求

- 状态：Draft
- 版本：1.0.0
- 类型：Meta / Testing
- 依赖：TWS-000 至 TWS-008、TWS-011、TWS-012

> **Pre-v1 重基线声明（2026-09-16）**：本文现有 Draft.1～Draft.6 manifest 命令、14 Provider method exact set 和逐 Draft 迁移测试只验证历史内部原型，不是 v1 Candidate 的兼容要求。v1 Candidate 采用新的统一 Schema/Registry 后，必须一次性重写相应 exact set、Profile 和 conformance 清单；在此之前不得用本文件的旧数量阻止 Provider 或架构改进。唯一继续承担历史产品兼容测试的是 TWS-008 Legacy。

## 1. 目的

本文定义钱包、SDK 和 Transport 如何证明 TWS 合规。合规由可重复测试和机器可读清单证明，不由品牌、方法名称或人工声明证明。

## 2. Profile

### 2.1 `core`

必须实现：

- Wallet Standard `tbc:provider` feature；
- TWS-001 标记为 `core` 的全部方法、事件和错误；
- TWS-002 标识与官方网络注册表；
- TWS-003 权限与 Trusted Context；
- TWS-004 `tbc.transfer`；
- TWS-005 两种签名；
- TWS-012 Prepared Transaction/Workflow wire、Proposal 验证与错误映射；
- TWS-001 的 22 个 Provider 方法和六个事件 exact set。Profile 只改变受支持 Intent，不改变方法集合。

### 2.2 `assets`

依赖 `core`，并必须实现：

- `tbc721-standard-create-collection`
- `tbc721-standard-mint`
- `tbc721.transfer`
- `tbc20-standard-create`
- `tbc20.transfer`
- `tbc20Stablecoin.transfer`

2026-09-30 统一接口重基线：创建/发行仅使用当前受支持合约；旧创建及旧 NFT mint 不得出现在能力声明中。存量转移使用统一入口，必须另列实际支持的模板范围，不能仅凭方法名声称全部历史版本支持。钱包可以明确拒绝不支持的模板，但不能将拒绝算作该模板验收通过。

### 2.3 `defi`

依赖 `core` 和 `assets`，并必须实现：

- `tbc-amm-create`
- `amm.addLiquidity`
- `amm.removeLiquidity`
- `amm.swap`（双向）
- `tbc_signWorkflow`

### 2.4 Transport Profile

分别声明：

- `transport:webview`
- `transport:extension`
- `transport:remote`

每个 Transport 独立测试。钱包至少必须通过一个 Transport Profile 才能声明 TWS 产品合规。

### 2.5 `integration`

依赖 `core`，并必须实现 TWS-011 注册表中的全部九个 Host Port 与 11 个操作。钱包产品还必须通过至少一个 Transport Profile；独立 `core-library` 可以不声明 Transport，但不能据此宣称某个钱包产品合规。

合规声明分为两个互补部分：

- **Public Wire Conformance**：DApp 观察到的 Provider、权限、Intent、签名、事件与错误符合 TWS-001 至 TWS-008。
- **Wallet Integration Conformance**：Core 与第三方 Wallet Host 之间的 Snapshot、Policy、Plan、Approval、Signer 和 Broadcast 边界符合 TWS-011。

复用官方标准引擎的 Wallet Host 必须通过 Port 与编排测试。独立实现 Transaction Engine 的钱包还必须对 13 个 Intent 通过 Semantic Conformance；公共参考引擎必须逐 byte 通过 Canonical Profile。

`integration` 是发布 Manifest 能力，不是 `tbc_getCapabilities` 面向 DApp 公布的 Provider Profile。

### 2.6 Legacy

`window.Turing`、Legacy Adapter 和旧 raw signing 不是 Profile。实现或不实现它们都不影响 TWS 合规。

## 3. 规范性测试资产

合规套件由以下版本化资产组成：

- JSON Schema；
- 网络、方法、事件、错误与 Integration Port 注册表；
- 正向测试向量；
- 失败测试向量；
- Provider 行为测试；
- 签名与交易确定性测试；
- Transport 安全测试；
- Profile manifest validator。

发布套件必须提供内容摘要。认证结果必须绑定确切标准版本和套件 SHA-256，不能只写 `latest`。

Draft 可以先发布 Provider、Schema、标识、签名、Intent shape 和 Workflow 基础向量。进入 Review 前必须补齐第 4.5 节要求的逐 Intent 计划、sighash、raw transaction、txid 和失败向量；缺少这些链级向量时不能发布实现合规 Manifest。

### 3.1 当前协议资产校验

使用当前 Schema、Registry 与包清单计算和核对内容摘要。协议校验、运行时集成与设备验证分别报告；内容摘要通过不等于设备或真实链验收。

## 4. 必测矩阵

### 4.1 Provider 与 RPC

- 方法注册表恰好包含当前 Provider 的 22 个方法，名称唯一，且所有 Schema reference 可以解析。
- Integration Port 注册表恰好包含九个唯一 Port、11 个唯一操作、四个 Validator phase、26 个 violation、九个 Port Error 和 14 个禁止字段名；Port 名、方向、trust class 与全部参数 / 结果 Schema reference 必须匹配 TWS-011。
- Core / DeFi Profile、权限模式、批准类型、side effect 和 capability 与方法注册表一致。
- 事件注册表恰好包含 6 个事件，错误注册表的 code、symbol、execution name 和合法 stage 唯一且与 Schema enum 一致。
- 同时发起至少 100 个请求，其中包含并发同名方法。
- 响应乱序、重复、迟到、未知 ID 和错误 ID 类型。
- Request timeout、Abort、Session revoke 和 navigation cancel。
- 成功与错误互斥。
- JSON-RPC parse、request、method、params 和 internal errors。
- 方法只能 reject `ProviderRpcError`，不能 resolve `{ error }`。

### 4.2 权限与事件

- 未连接账户隐私。
- Origin、Chain ID、Account ID 和 method caveat。
- 权限缩小、过期、撤销和 `tbc_disconnect`。
- 状态提交后再发事件。
- 事件 Listener 内重查状态一致。
- iframe、跨 Origin navigation 和 forged origin。
- 持久权限不能复用临时 grant 或解锁状态。

### 4.3 Schema 与数值

- 每个方法、Intent、签名和 Workflow 的最小/完整正向向量。
- 未知字段、未知版本、缺失字段和错误 union branch。
- 空值、前导零、负数、小数、指数、UInt32 边界和超大整数。
- JavaScript safe integer 上下的等价性。
- media 大小、hash、scheme 和 base64 canonical encoding。
- Contract ID、txid、公钥、Chain ID 和 Account ID 格式。

### 4.4 签名

- RFC 8785 canonicalization 官方向量。
- UTF-8 byte length 与 Unicode 边界。
- CompactSize 的 252/253、65535/65536 边界。
- Message 与 Typed Data magic 分离。
- low-S、compact header、recoverable signature、公钥和地址恢复。
- RFC 6979 fixture signer 必须复现已知答案签名；生产 Signer 可以返回其他可验证的 low-S recoverable 签名。
- key order 不同但语义相同的 Typed Data 得到相同摘要。
- Origin、Chain ID、Account ID、nonce、字段或有效期变化导致摘要变化。
- 重放、过期、重复 nonce 和跨 Origin 验证失败。
- Legacy Bitcoin magic 与 TWS magic 永不混淆。

### 4.5 Transaction Intent

每个 Intent 必须有：

- 规范输入；
- 计划预览；
- sighash；
- 签名后 raw transaction 和 txid；
- 实际费用；
- 失败向量；
- 必要时的多交易依赖。

还必须测试：

- UTXO 选择和找零只属于授权账户；
- 自动 maintenance 不改变业务输出；
- `maxFee` 和最小输出；
- 合约版本与祖先交易验证；
- Plan 变化使批准失效；
- Bundle 拓扑顺序和最多 32 笔限制；
- 部分广播失败对账和幂等重试；
- Provider 不接受 DApp raw transaction；Signer / Approval / Permission Port 不接收 raw transaction；WIF、助记词和 Vault handle 不越过任何标准边界。经过验证的 parent、unsigned template 与 finalized raw 只能分别出现在 Chain Data、Plan / Finalize 与 Broadcast 的明确字段中。

Semantic Conformance 可以接受不同但安全的 UTXO 选择和生产 ECDSA nonce，但必须验证同一业务输出、费用上限、最小输出、账户控制、合约 ancestry、签名任务和 Bundle 依赖。Canonical Profile 在固定 Request、Snapshot、Policy 与 RFC 6979 fixture signer 下要求 Plan、sighash、raw transaction、txid 和 fee 逐 byte 相等。

### 4.6 Wallet Integration

- 九个 Port 与 11 个操作的最小、完整、失败和不可用响应。
- 100 路并发、乱序、重复、迟到、取消和未知 `callId`。
- Request、Snapshot、Policy、Template、Plan 与 Approval Binding Hash 全部重算。
- Plan、签名任务或过期时间改变后旧批准失效。
- Permission Store compare-and-swap、并发撤销和权限缩小。
- Chain Snapshot 过期、reorg、已花费输入、错误 txid 与 ancestry。
- Policy 只由可信 Host 提供；DApp `serviceFeeRate`、endpoint 和钱包句柄被拒绝。
- Signer 只接收 digest、公开账户身份和精确批准；compact64 / compact65 的 low-S、公钥验证，以及 schnorr64 的 BIP340 验证；算法、key 编码和签名编码不得混用。x-only 管理员角色必须绑定已授权账户，不冒用手续费账户。
- Finalize 不重新规划；raw transaction、txid、fee、业务输出和 artifact 重新验证。
- Broadcast 幂等、拓扑顺序、known transaction、部分失败与 reconcile。
- Clock 是唯一过期时间源；Entropy 返回长度与请求逐 byte 一致。
- 对所有嵌套字段执行 secret-boundary 扫描，测试 WIF、mnemonic、password、Vault handle、quick-sign grant 与节点凭据。

### 4.7 Workflow

- 1 至 5 个步骤。
- 交易 txids 和 artifact 的每种合法 Binding。
- target 类型、重复 target、缺失 artifact 和多 primary 错误。
- 后向引用、自引用、循环和未声明依赖。
- 绑定后 Typed Data 的再次类型验证。
- 总费用上限。
- 任意步骤失败不返回部分签名。
- 任何计划或绑定变化都重新批准。

### 4.8 Transport

WebView：

- 每次导航新 Session 和 navigationId；
- old-page request/response 不能进入新页面；
- HTTPS、loopback 开发例外、scheme 和 iframe policy；
- 页面伪造 URL、Origin、topOrigin 和 navigationId。

Extension：

- Page -> Content -> Background 边界；
- sender metadata、tab/frame navigation 和 service-worker restart；
- 多钱包发现，不覆盖全局单例；
- EVM 与 TBC discovery 不互相污染。

Remote：

- 加密会话、proposal scope、过期和撤销；
- requester identity 与会话 metadata；
- 重连不能扩大权限。

### 4.9 恶意输入和模糊测试

- 深层 JSON、超长字符串、重复键、prototype-like 字段和 Unicode confusable。
- 超限 array、递归 type、循环 dependency。
- malformed hex/base64/URL/JSON Pointer。
- 重复响应、消息风暴和 request ID collision。
- 错误数据不泄露 secret、堆栈或未授权账户。

## 5. DurianSwap 业务预言机

在 `assets` 和 `defi` 发布门槛中，DurianSwap P0 流程必须通过其独立后端验证器：

- 买入；
- 卖出；
- LP increase；
- LP consume；
- Pool create；
- FT create。

验证器必须检查实际收款人、金额、合约、交易结构、txids、订单 typed signature、Origin、nonce 和有效期。仅通过钱包单元测试不足以证明业务兼容。

Legacy P0 测试必须与 TWS 测试分开报告，避免旧行为通过掩盖新协议失败。

## 6. Conformance Manifest

认证实现必须发布符合 `schemas/conformance-manifest.schema.json` 的文件，例如：

```json
{
  "implementation": {
    "kind": "wallet",
    "name": "Example Wallet",
    "version": "2.0.0",
    "platforms": ["ios", "android"]
  },
  "twsVersion": "1.0.0",
  "featureVersion": "1.0.0",
  "profiles": ["core", "assets", "transport:webview"],
  "chainIds": [
    "tbc:mainnet"
  ],
  "intents": {
    "tbc.transfer": ["1.0"]
  },
  "suite": {
    "version": "1.0.0",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "executedAt": "2026-08-31T12:00:00Z",
  "result": "pass"
}
```

`implementation.kind` 为 `wallet` 或 `core-library`；省略时按 `wallet` 处理，以兼容早期 Draft Manifest。`core-library` 必须声明 `core` 与 `integration`，可以没有 Transport；它的结果只证明标准内核，不证明任何宿主产品、Vault 或 Transport。

Manifest 必须由发布实现的一方签名或随可验证发布 artifact 一起提供。失败、跳过或 flaky 的 mandatory test 都不能记为 pass。

## 7. Capability 与认证一致性

- `tbc_getCapabilities.profiles` 必须是当前发布 Manifest profiles 的子集或相同集合。
- 公布的 Intent 和版本必须包含在 Manifest。
- 运行时禁用的能力必须从 capability 结果移除或标记不可用。
- 未通过 DeFi 测试的钱包不能只因为可以构造某个 Pool 交易就公布 `defi`。

## 8. Final 状态门槛

TWS 1.0 从 Review 进入 Final 至少需要：

- 两个独立钱包实现通过 `core`；
- 其中至少一个通过 `assets` 和 `defi`；
- 至少两个不同 Transport 实现通过对应 Profile；
- 公共参考中间层和至少一个第三方 Wallet Host 通过 `integration`；
- 主网与测试网标识向量通过；
- DurianSwap 双协议 P0 验证通过；
- 独立安全审查关闭所有阻断问题；
- 没有未解决的规范文本、Schema 和向量冲突。

“独立钱包”要求密钥管理和 Wallet Host 实现不来自同一份应用代码；共享标准 SDK、Schema 和 conformance runner 不影响独立性。

## 9. Draft.3 强制机器集合

Draft.3 conformance 必须把以下集合当作 exact set，而不是最低数量：18 个 Hash Binding、15 个 operation state、四个 terminal state、11 个 cancellation reason、九个 Host Port、11 个 Host operation、14 个 Provider method、六个 event、八个 method-to-approval mapping、六种 Approval Preview、四个 Core method、四种 Core transition、十类 method path 和两种 committing kind。

新增必测项包括：四方法 Provider authority 输入；自包含 Operation Memory 和单调推进；continue/waiting 的 response 互斥；pre-clock terminal；checkpoint hash chain 与 release drift；三个 Port crash window 的 exact-response replay；Provider Session CAS/Ack/event 顺序；相同 commitId payload collision；Permission/Session 双 committing；多链 Permission batch 原子性；WorkflowPlan deferred task 唯一派生；五分钟 expiry 只收窄；过期 partial broadcast 最多一次 reconcile；全部终态不可 resume；取消后的 late Approval/Signer/Broadcast response 不推进 revision。

文档合规必须拒绝把本地 `tbc:` namespace 描述成已完成外部 CAIP 注册、把 EIP-6963 描述成 TBC discovery、把 JSON-RPC batch/notification 描述成受支持 profile，或把 `execute(request)`、`wallet-vault/1` 描述成公共 TWS 接口。
