# TWS-000：术语、版本与治理

- 状态：Draft
- 版本：1.0.0
- 类型：Meta
- 创建日期：2026-08-31

> **Pre-v1 重基线声明（2026-09-16）**：TWS 尚未正式发布，也没有第三方产品依赖任何 TWS Draft。Draft.1～Draft.6、对应 manifest/hash、14 方法集合及 draft 包号仅是内部研发与审计证据，不构成向后兼容义务。v1 Candidate 可以整体修改这些草案，但必须同步更新规范、Schema、Registry、类型和向量。当前唯一需要保持的已发布产品兼容面是 TWS-008 定义的旧 `window.Turing`/真实旧 DApp 行为。本文中描述 Draft-to-Draft 迁移或“永久封存”的段落只保留为历史工程记录，不约束 v1 Candidate。

## 1. 目的

本文规定 TBC Wallet Standard 的规范语言、版本方式、权威顺序、变更流程和合规声明。所有其他 TWS 文档都依赖本文。

## 2. 规范语言

文档中以大写形式出现的“必须（MUST）”、“不得（MUST NOT）”、“要求（REQUIRED）”、“应当（SHOULD）”、“不应（SHOULD NOT）”和“可以（MAY）”按 RFC 2119 与 RFC 8174 解释。

说明性示例不覆盖规范性文字或 Schema。

## 3. 术语

- **DApp**：通过 TWS 请求钱包能力的应用。
- **Provider**：向 DApp 暴露 `request`、`on` 和 `removeListener` 的对象。
- **Wallet Host**：验证请求、建立可信上下文、执行权限和用户批准策略的受信任组件。
- **Host Port**：标准内核调用 Wallet Host 能力的严格、版本化接口；不得直接暴露给 DApp。
- **Wallet**：持有或控制账户签名能力的产品。
- **Account**：某条 TBC 网络上的地址与签名身份。
- **Origin**：由宿主环境验证并规范化的 requester identity URI；WebView 与 Extension 使用 Web Origin，Remote 按 TWS-003 使用认证会话 identity；不得来自 DApp payload。
- **Trusted Context**：Wallet Host 从传输层获得的来源、页面、会话和导航信息。
- **Intent**：描述用户业务目标、不包含密钥或 UTXO 选择的版本化对象。
- **Plan**：钱包根据规范化 Intent、固定链状态快照、账户和版本化钱包策略生成的内部确定性交易计划。
- **Chain Snapshot**：由 Chain Data Port 返回、与固定区块和过期时间绑定的不可变链数据集合。
- **Execution Policy**：Wallet Host 提供并经过 Hash 绑定的费用、版本、限额与业务策略。
- **Approval Binding**：把 Origin、Session、Request 与待批准操作 Hash 精确关联的不可变对象。
- **Signer Port**：TWS 内唯一允许宿主触达密钥实现的集成边界；端口参数本身不得包含密钥或 Vault handle。
- **Transaction Bundle**：一笔或多笔签名交易及其显式依赖关系。
- **Capability**：钱包已经实现并通过对应合规测试的功能和版本。
- **Profile**：Core、Assets、DeFi、Integration 或某个 Transport 的合规范围。
- **Legacy Adapter**：兼容旧 `window.Turing` API 的非标准边界组件。

## 4. 版本

TWS 使用三层版本：

1. **标准版本**：整个文档集合的 SemVer，例如 `1.0.0`。
2. **Feature 版本**：Wallet Standard feature 的 SemVer，例如 `tbc:provider` 的 `1.0.0`。
3. **Payload 版本**：Intent、Typed Data 或 Workflow 的 `major.minor` 字符串，例如 `1.0`。

实现必须拒绝未知主版本。实现可以接受同一主版本中它明确声明支持的更高次版本；不得根据未知字段猜测兼容性。

补丁版本只能修正拼写、示例或不改变 wire behavior 的歧义。增加可选字段或能力至少提高次版本。删除字段、改变既有字段含义或改变签名摘要必须提高主版本。

## 5. 文档状态

规范依次经历：

```text
Draft -> Review -> Final -> Superseded
```

- **Draft**：设计完整但仍可根据审阅修改。
- **Review**：wire shape 已冻结，正在进行实现、测试和安全审查。
- **Final**：至少两个独立钱包实现通过相关合规套件，且安全审查关闭阻断问题。
- **Superseded**：被明确列出的后续规范替代；历史实现仍可引用。

状态不是版本号。`Final` 文档也必须通过新版本进行规范变更。

## 6. 规范权威顺序

当仓库内容冲突时，按以下顺序解释：

1. `standards/` 中的规范性语义文字。
2. `registry/` 中的规范性网络、方法、事件、错误与 Integration Port 注册项。
3. `schemas/` 中的 JSON Schema wire shape。
4. `test-vectors/` 中的规范性输入和预期输出。
5. 已发布的合规测试套件。
6. 自动生成的类型定义。
7. SDK、示例和参考实现。

较低层不能静默改变较高层。发现冲突必须通过规范变更解决。

## 7. 变更提案

改变 wire behavior 的提交必须附带 TWS Change Proposal，至少包含：

- 问题和用户场景；
- 被修改的规范章节；
- 完整向后兼容性分析；
- 安全与隐私影响；
- 新增或修改的 Schema；
- 正向、反向和失败测试向量；
- 迁移与弃用时间线。

签名摘要、网络标识、安全上下文、权限和交易广播语义的变更必须经过独立安全审查。

## 8. 扩展规则

标准字段不得被供应商重新解释。供应商扩展必须满足全部条件：

- 方法名以反向域名或注册命名空间开头，不能使用 `tbc_` 或 `wallet_`；
- Schema 不允许扩展时，不得注入额外字段；
- 必须通过 `tbc_getCapabilities` 显式声明；
- DApp 在没有扩展时仍能完成标准核心流程；
- 扩展不得绕过权限、预览或 Signer 边界。

## 9. 合规声明

钱包只能声明它通过测试的 Profile、Feature 版本、Intent 版本和 Transport Profile。声明必须包含规范版本和合规套件摘要。

“兼容 Turing Wallet”或实现 `window.Turing` 不等于 TWS 合规。

## 10. 开放性

TWS wire protocol 不得要求第三方钱包使用特定 UI、Vault、后端、编程语言或官方 SDK。参考实现用于验证规范，不拥有重新定义规范的权力。

规范文本以 CC0-1.0 发布，便于生态无许可实现和引用。

## 11. 内部 Draft 证据记录（非兼容轨道）

本节记录此前内部候选如何产生及如何避免测试过程中误恢复不匹配的持久状态。它不是已发布版本历史，也不要求 v1 Candidate 逐版兼容或沿用其 exact set。v1 重基线完成时，应生成一套新的单一 Candidate release identity，而不是继续追加 Draft 修补轨道。

每个 release identity 都是严格对象：版本、排序后的 Schema bundle SHA-256 和排序后的 registry bundle SHA-256 共同形成 `ProtocolRelease`，其 RFC 8785 JCS SHA-256 为 `releaseFingerprint`。Operation ID 与每个 checkpoint 都绑定该 fingerprint；任何 bundle 改变都禁止跨 release 恢复旧 operation。

冻结按两阶段进行：先提交全部规范资产和合规测试，再由冻结脚本计算固定 protocol commit、bundle Hash 与交接文件。交接文件生成后，已纳入 Hash 的协议资产不得在同一版本下修改；修订必须打开新 release track。

Draft.1 → Draft.2 是明确的 breaking migration，包括：Trusted Context 收窄为严格六字段加可选 `navigationId`；Approval Binding 新增 `method` 与 `contextHash`；Permission Commit 改为多 scope 原子 CAS；Workflow 引入完整 `WorkflowPlan` 与 deferred signing task；Port call 采用持久精确重放；Provider Session 采用 CAS/Ack；公开 Core 改为可恢复 checkpoint 状态机；Transport Session 内 JSON-RPC ID 不得复用。Draft.1 checkpoint、Approval Receipt、Permission Commit 或 Port replay journal 不能直接当作 Draft.2 对象恢复。

Draft.2 已由固定交接文件封存。Draft.3 是新的 breaking 修订：四方法输入绑定 Provider Session snapshot；Session 增加 active accounts；checkpoint 增加累积 Operation Memory；transition 增加无 response 的 continue；committing 区分 Permission Store 与 Provider Session；state/effect policy、pre-clock terminal、条件取消 authority、Chain Switch Proposal、Permission/Broadcast 确定性 ID、精确 method path 和 Clock 语义成为规范。Draft.2 checkpoint 不得补默认值后当作 Draft.3 恢复。

Draft.3 同样由固定交接文件封存。Draft.4 是实现期发现的最小勘误：冻结的 Draft.3 `cancelInput` Schema 没有表达正文已经声明的条件 authority。Draft.4 只修正这一 Schema 闭包并增加对应向量；它不回写 Draft.3，不增加 API、Port、state、Hash Binding 或 DApp 能力。Draft.3 与 Draft.4 的 checkpoint 必须按各自 release fingerprint 隔离。

Draft.5 是 Portable Core 只读账户路径发现的第二个最小运行闭包勘误：第一次进入 `resolving` 时允许空的 `resolvedInputs` cursor，以便先持久化 checkpoint 再调用该状态唯一允许的 `accounts.resolve`。Draft.1 至 Draft.4 仍由原 commit 与 manifest 永久封存；Draft.5 不增加 API、Port、state、Hash Binding、方法或权限，也不放宽任何批准与签名边界。

Draft.6 是 Portable Core 提交路径发现的第三个最小运行闭包勘误：两个严格区分的 `committing` kind 都允许先持久化唯一 `clock.now`，以满足正文既有的 pre-effect freshness 规则，再分别进入 Permission Store effect 或 Provider Session Core commit。Draft.1 至 Draft.5 仍由原 commit 与 manifest 永久封存；Draft.6 不增加 API、Port、state、Hash Binding、方法、权限或 committing kind。

协议冻结不等于产品认证。官方钱包、浏览器插件、Transport、Vault 与第三方 Host 必须分别通过其声明 Profile 的实现合规；任何私有 Vault API 均不获得 TWS 标准地位。
