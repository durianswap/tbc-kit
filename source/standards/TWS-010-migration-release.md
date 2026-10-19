# TWS-010：迁移与发布规范

- 状态：Draft
- 版本：1.0.0
- 类型：Migration / Release
- 依赖：TWS-000 至 TWS-009、TWS-011、TWS-012

> **Pre-v1 重基线声明（2026-09-16）**：本规范中真正需要保留的产品迁移对象只有旧 Turing Wallet、`window.Turing` 和真实旧 DApp。Draft.1～Draft.6 之间的迁移、fallback、不可变 manifest 和 exact-set 叙述是内部原型历史，不构成对外兼容义务，也不得迫使 v1 Candidate 叠加补丁。当前应直接形成一套一致的 v1 Candidate；正式发布后才启用跨正式版本迁移政策。

## 1. 目的

本文规定如何把旧 Turing Wallet 重构为使用 TWS 的成熟、可维护钱包，同时保持现有用户和 DApp 可用。旧钱包继续作为生产参考，新的标准内核和新应用在独立 monorepo 中开发。

迁移不能以“重构”为理由扩大密钥风险，也不能要求所有 DApp 在同一天切换。

## 2. 目标架构

实现应分为以下独立边界：

```text
standards / schemas / conformance
             │
             ▼
DApp SDK -> Standard Core -> Transaction Engine
                │             plan / sighash / finalize
                ├-> Accounts / Chain Data / Policy Ports
                ├-> Permission / Approval Ports
                ├-> Signer Port -> Secure Vault
                └-> Broadcast / Clock / Entropy Ports
             ▲
WebView / Extension / Remote transports
             ▲
Legacy Adapter (temporary)
```

必须满足：

- Turing Wallet 自身通过公开 TWS Provider 调用核心能力。
- 第三方钱包只需要实现 TWS-011 注册的九个 Wallet Host Port，不需要采用官方 UI、Vault、节点或账户数据库。
- Engine 使用 `plan -> sighash -> external signer -> finalize`，不得接收私钥。
- Mobile 和 Extension 共用协议、Schema、SDK 与设计 token，但拥有独立 Transport 和 UI 生命周期。
- BTC、EVM/BSC、Solana Adapter 不进入 TBC 协议包。

## 3. 阶段 0：冻结旧行为

开始替换代码前必须保存：

- 旧 Provider 方法和事件契约；
- 18 个 flag 的正向与失败 fixtures；
- 并发同名请求已知缺陷的回归测试；
- Legacy message magic 和返回别名；
- 多交易逗号拼接与 batch `dependsOn` 行为；
- DurianSwap P0 前端请求与后端验证样本；
- 主网和测试网真实交易向量。

这些 fixtures 只约束 Legacy Adapter，不定义 TWS。

## 4. 阶段 1：发布标准资产

发布：

- TWS-000 至 TWS-012；
- JSON Schema；
- 网络、方法、事件、错误与 Integration Port 注册表；
- Provider、权限、标识、签名、Intent shape、Workflow 与 Integration 基础向量；
- conformance runner 规范；
- 标准变更流程。

在文档、Schema 和测试向量冲突解决前，不开始生产切换。

## 5. 阶段 2：拆分交易引擎

从旧钱包提取纯 TBC Transaction Engine：

```text
validate intent
-> discover/accept verified chain context
-> plan funding and contract ancestry
-> produce preview + sighashes
-> external Signer
-> finalize signed bundle
```

Engine release gate：

- 不导入 Vault、Secure Storage、UI、WebView 或 Wallet Account context。
- 公共函数不接受 private key、WIF、mnemonic、password 或 Vault session。
- 每个 Intent 有固定链状态下的 plan、preview、sighash、raw transaction、txid、fee 和失败向量。
- 主网/测试网网络上下文显式传入且经过 Wallet Host 验证。
- 费用、最小输出、找零、Bundle dependency 和 maintenance 不变量通过测试。
- Request、Snapshot、Policy、Template、Plan 与 Approval Binding 使用 TWS-011 Hash 规则，所有 Hash 在消费前重算。
- Core 公共输入只使用原子整数；Pool 的人类小数转换留在 Legacy Adapter，`serviceFeeRate` 只来自 Policy Port。
- `tbc.pool.create` 在同一 Plan 和批准中编排 create + init，不暴露两个私有 DApp 操作。

## 6. 阶段 3：集成 Standard Core 与 Wallet Host

新官方钱包先集成 Standard Core，并由自己的 Wallet Host 提供产品能力：

- Standard Core 提供 Provider router、JSON-RPC ID、capability registry、权限编排、preview、事件和错误映射；
- Transport 与 Host 建立 Trusted Context、Session 和导航隔离；
- Wallet Host 实现 TWS-011 九个 Host Port，包括可信 approval UI；
- Core 执行 Signer 后的密码学验证与 Broadcast 拓扑对账；
- WebView Profile。

官方钱包的 DApp 请求必须进入 Standard Core，只有 Core 可以调用这些 Port；Port 实现不能反向绕过 Core，DApp WebView 也不能继续直接访问账户 Hook 或交易函数。

## 7. 阶段 4：接入 Legacy Adapter

在标准 Host 稳定后接入 TWS-008 Adapter：

- 保持旧返回和事件；
- 所有请求获得内部 ID；
- domain 和网络由钱包控制；
- raw signing 进入单独高风险服务；
- merge 进入内部 maintenance；
- 新 TWS 方法不依赖 Legacy Adapter。

Legacy Adapter 必须可以通过 feature flag 独立关闭，以验证新钱包没有反向依赖。

## 8. 阶段 5：DurianSwap 双协议

DurianSwap 前端和后端按以下顺序迁移：

1. 后端加入 TWS Typed Data 验证，同时保留 Legacy Bitcoin message 验证。
2. 前端发现 `tbc:provider` 和 capability。
3. 支持时使用 TWS Intent 与 `tbc_signWorkflow`。
4. 不支持时显式回退 Legacy Provider。
5. 记录去标识化的协议版本、失败阶段和 fallback 原因。
6. 对相同业务输入执行后端交易不变量验证。

双协议期间，订单必须携带明确 `signatureProtocol: "tws-1" | "legacy-turing"`，服务端不能根据签名长度猜测。

## 9. 阶段 6：第三方钱包试点

选择至少一个不复用官方 Wallet Host/Vault 的钱包：

- 只集成公开标准包并实现 TWS-011 九个 Port；
- 先通过 `core` 和一个 Transport Profile；
- 再通过 `integration`、`assets`、`defi` 和 DurianSwap P0；
- 发布 Conformance Manifest；
- 记录所有需要读取官方钱包私有代码才能实现的地方。

如果试点必须复制私有 UI、Hook、Vault 或 Legacy raw signing 才能工作，说明抽象层失败，不能把该结果计为 TWS 合规。

## 10. 阶段 7：生产灰度

建议顺序：

1. 内部开发网络。
2. 官方测试网。
3. 主网员工和测试账户。
4. 用户主动开启的新协议 beta。
5. 小比例默认启用，保持即时 rollback。
6. 扩大默认启用。
7. 新协议成为唯一内部实现，Legacy 只保留外部 facade。
8. 达到弃用门槛后逐步移除 Legacy。

每一阶段必须观察至少一个完整业务周期，并以预先定义的错误率、签名拒绝率、广播恢复率和后端验证失败率作为推进门槛。具体阈值属于发布 runbook，不写死在 wire protocol。

## 11. 强制发布门槛

生产切换前必须全部满足：

- 18 个 Legacy flag 全部具有测试过的映射或明确内部维护行为。
- TWS 13 个公开 Intent 的 Schema 和测试向量齐全。
- TWS-011 九个 Port、11 个操作、26 个 Semantic violation 与 Canonical Profile 向量齐全。
- 私钥、WIF、助记词和 Vault token 不越过 Signer port。
- TWS Core/Assets/DeFi/Integration 对应测试全部通过。
- WebView 或目标 Transport Profile 通过。
- 100 路并发、同名方法乱序、navigation cancel 和 Session revoke 通过。
- RFC 8785、magic、nonce、Origin 和过期向量通过。
- DurianSwap 买、卖、LP、Pool create 和 FT create 通过独立后端验证。
- 部分广播失败可以对账和恢复。
- 主网与测试网可读 Chain ID、可信端点绑定及跨网络隔离验证通过。
- 独立安全审查关闭阻断问题。
- 生产 feature flag、监控和 rollback 演练完成。

“大部分测试通过”不满足发布门槛。

## 12. Rollback

在 Legacy 退出前：

- 保留上一稳定钱包版本和可恢复发布 artifact。
- 标准 Provider、Legacy Adapter 和新 Engine 分别有 feature flag。
- 新旧权限数据库使用可迁移版本，不做不可逆就地覆盖。
- 未提交的 Plan、Workflow 和 Session 不跨版本恢复。
- rollback 后先根据 txid 对账已广播交易，不能重复发送。
- DApp SDK fallback 必须可远程禁用，但远程配置不能改变签名或权限语义。

## 13. Legacy 弃用门槛

满足全部条件后才能公告某项 Legacy 能力弃用：

- 对应 TWS 能力至少一个 Final 或 Review candidate 实现稳定运行；
- DurianSwap 和主要 DApp 已部署双协议；
- 至少一个第三方钱包通过对应 Profile；
- 连续观察窗口内 Legacy 调用量低于产品批准阈值；
- 没有只能通过 Legacy raw signing 完成的 P0 流程；
- 已发布迁移指南、截止日期和回滚方案。

首次弃用公告后必须保留至少一个稳定发布周期。安全漏洞可以加速禁用，但必须公开说明影响和替代路径。

## 14. 数据与遥测

迁移遥测默认只记录：

- 协议和 capability 版本；
- 方法或 Intent 名称；
- Transport Profile；
- 成功、标准错误码、稳定 `data.name`；
- 是否 fallback；
- 延迟区间和 Bundle 大小。

不得记录 private key material、raw signed transaction、完整签名消息、Typed Data 业务内容、Vault 标识或未哈希地址。Origin 和地址需要单独隐私审查和用户政策授权。

## 15. 钱包集成

钱包自行设计导航、账户管理和界面。TBC Kit 不规定宿主产品的其他网络或产品策略。

专业交易模式必须建立在相同 Wallet Host、权限、Signer 和 Intent 上。它可以增加行情、订单、批量预览和快捷操作，但不能创建第二套密钥或签名协议。

## 16. 完成定义

迁移只有在以下事实同时成立时完成：

- 官方钱包内部不再依赖旧大文件完成标准 DApp 请求；
- 第三方钱包不读取官方私有代码即可支持 TBC DApp；
- DurianSwap 默认使用 TWS 且后端严格验证；
- Legacy Adapter 可以独立关闭；
- 合规 Manifest 与安全审查可公开验证；
- 旧钱包生产用户完成安全迁移或仍有明确支持窗口。

## 17. Draft.1 → Draft.2 迁移

Draft.2 是协议资产 breaking release。Adapter 必须重新构造严格 Trusted Context、Approval Binding/Preview、Permission Proposal/atomic batch、WorkflowPlan、OperationCheckpoint、Port replay journal 与 Provider Session record；不得给旧对象补默认字段后继续执行。尤其禁止跨 release 恢复 pending signing、broadcast、commit 或 Approval Token。

Host 升级顺序必须是：部署可读取但不执行旧 operation 的迁移观察版本；等待或取消旧 pending operation；保存已广播 txid 供独立 reconcile；原子切换 ProtocolRelease；再接受 Draft.2 start。发现 `releaseFingerprint` 不同必须以 `PROTOCOL_RELEASE_CHANGED` 终止并禁止执行旧 pending effect。

插件、移动钱包和第三方钱包可以在不同产品版本接入，但必须引用同一个固定 Draft.2 protocol commit、Schema bundle Hash 和 registry bundle Hash。接入层可以转换产品内部对象，不能改变九 Port、11 operation、四个 Transaction Engine facade、四个可恢复 Core method 或公共 Provider wire shape。

正式 rollout 前必须留存 Draft.1 不可变交接文件，并验证 Draft.2 freeze artifact 能从固定 commit 独立重算；bundle Hash、测试摘要、breaking change、known gap 或合规命令任一不一致都阻止发布。

## 18. Draft.2 → Draft.3 迁移

Draft.2 继续作为不可变历史基线。Draft.3 是协议执行闭包的 breaking release，精确包含 13 项变化：

1. Core 输入要求当前 Provider Session snapshot；
2. Provider Session state 增加活动账户标识；
3. Operation checkpoint 携带累积、可恢复 memory；
4. Core transition 增加显式 continue 分支；
5. Resume 接受一个 pending Port response，或对 continue 不接受 response；
6. Committing checkpoint 区分 Permission Store 与 Provider Session commit；
7. Operation state policy 声明允许的 Port operation 和 memory field；
8. 首次 Clock 成功前的 failure/cancellation 使用受限 terminal checkpoint；
9. Cancel authority 输入依 cancellation reason 条件必需；
10. Chain switch proposal 使用 payload/hash wrapper；
11. Permission 与 Broadcast 业务 ID 使用确定性派生；
12. Method path 区分 session、permission 与 account read；
13. Clock sampling 与 `updatedAt` 语义被明确固定。

Adapter 不得给 Draft.2 checkpoint 补 `session`、`memory` 或默认 transition 后继续执行；所有 pending Draft.2 operation 必须完成、取消或作为不可执行审计记录归档。Draft.3 rollout 必须重新建立 checkpoint/replay store 版本边界，并以新的 release fingerprint 开始 operation。

Draft.3 协议冻结仍不表示 Portable Core、钱包产品、Transport 或第三方 Host 已通过实现合规。当前已知缺口是：规范 transaction bytes 仍仅覆盖 `tbc.transfer`；Portable Standard Core runtime 尚未实现；没有钱包产品或 Transport Profile 获认证；没有独立第三方 Wallet Host 通过 integration conformance。

## 19. Draft.3 → Draft.4 Cancel Authority 勘误

Draft.3 的协议 commit、bundle hash、release fingerprint 与 handoff 保持不可变。实现 standalone validator 时发现：正文规定部分 cancellation reason 可在当前 authority 已不可取得时调用 `cancel`，但 Draft.3 Schema 仍无条件要求 current context/session。

Draft.4 只把 `cancelInput` 修正为严格条件联合：`REQUEST_ABORTED`、`TRANSPORT_CLOSED`、`PROTOCOL_RELEASE_CHANGED` 可同时省略 current authority；其他八个原因必须同时提供 current context/session；任何原因都拒绝只提供其中一项。Adapter 不得通过给 Draft.3 输入填充旧 checkpoint authority 来伪装当前状态，也不得把 Draft.4 的宽化 Schema 用于恢复 Draft.3 checkpoint。

## 20. Draft.4 → Draft.5 Resolving Bootstrap 勘误

Draft.5 只移除 `resolvingCheckpointData.resolvedInputs.account` 在该 state 所有时刻的无条件必填，使 Core 能先返回带 `accounts.resolve` pending call 的持久化 resolving checkpoint，再在响应后填入账户。Host 不得用空 cursor 跳过 effect；Core 离开 resolving 前仍必须验证账户解析、权限、活动链和请求地址。Draft.4 checkpoint 不能由 Draft.5 Core 静默恢复，必须按 release fingerprint 失败关闭。

## 21. Draft.5 → Draft.6 Committing Clock 勘误

Draft.6 只允许两个既有 committing data 分支各自先等待唯一 `clock.now`。Clock response 后，permission-store 分支才产生 `permissionStore.commit` pending call，provider-session 分支才产生无 pending call 的 Core `commit` transition。Host 不得省略、合并或在持久化前执行该 Clock，也不得把 commit artifact 暂存在 `approval`。Draft.5 checkpoint 不能由 Draft.6 Core 静默恢复，必须按 release fingerprint 失败关闭。
