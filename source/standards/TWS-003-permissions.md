# TWS-003：权限与可信安全上下文

- 状态：Draft
- 版本：1.0.0
- 类型：Core / Security
- 依赖：TWS-000、TWS-001、TWS-002、EIP-2255

## 1. 安全模型

Provider 被视为暴露在不可信 DApp 环境中的接口。Wallet Host、Signer 和用户账户数据必须位于受信任边界。

权限必须至少绑定：

```text
wallet profile + verified origin + chainId + accountId + method
```

传输 Session 和 Navigation 只缩小权限，不能扩大持久权限。

拥有账户可见权限不等于获得签名批准。除非未来标准明确规定委托策略，TWS 1.0 的每次消息、交易和工作流签名都必须获得用户对具体内容的批准。

## 2. Trusted Context

每个请求进入 Wallet Host 时必须附带由 Transport 创建、且不属于 RPC params 的 Trusted Context：

```ts
interface TrustedContext {
  sessionId: string;
  transport: "webview" | "extension" | "remote";
  origin: string;
  topOrigin: string;
  frame: "top" | "child";
  navigationId?: string;
  createdAt: string;
}
```

规则：

- `origin` 必须从平台验证的 URL、扩展 sender 或远程会话握手得到。
- `topOrigin` 必须表示顶层浏览上下文。
- DApp payload 中同名字段必须被视为普通未知字段并由严格 Schema 拒绝；不得覆盖 Trusted Context。
- `sessionId` 必须不可预测，并在 Transport 生命周期内唯一。
- WebView 每次顶层导航必须生成新的 `navigationId`。
- 可信时间由钱包提供；DApp 不能提供 `createdAt`。

WebView 和 Extension 的 `origin`、`topOrigin` 与 Permission `invoker` 必须使用 URL Standard 的 ASCII serialized origin：scheme 与 host 规范化、IDN 使用 ASCII form、默认端口省略，且不含 path、query、fragment 或尾部 `/`。例如 `HTTPS://DURIANSWAP.ORG:443/path` 规范化为 `https://durianswap.org`。opaque origin 必须拒绝。`frame: "child"` 时 `origin` 本身就是调用 frame 的来源，不另行公开 `frameOrigin`、`tabId` 或 `frameId`。

Remote Session 若代表 Web DApp，同样必须绑定规范化 HTTPS Origin。非 Web requester 必须使用会话协议认证并规范化的 URI identity，钱包必须在批准 UI 明确标为 Remote identity；该 URI 不能由 RPC params 提供。验证者必须按会话类型比较期望 identity，不能把自声明名称当作 Origin 证明。

## 3. 安全上下文要求

- Web 页面必须运行在安全上下文中。
- 生产环境只允许 HTTPS。开发模式可以显式允许浏览器认定为可信的 loopback origin。
- Extension 的页面、content script 和 background 之间必须使用平台 sender metadata 验证来源。
- 第三方 iframe 默认不得获得 Provider。
- iframe 访问必须同时得到钱包策略和顶层 Origin 的显式授权，并把 `origin`、`topOrigin` 与 `frame: "child"` 写入批准 requester 视图。
- 页面跳转、frame 销毁、tab 关闭、Remote Session 撤销时必须取消关联的未完成请求和临时授权。

## 4. Permission 数据模型

权限对象采用 EIP-2255 风格：

```ts
interface Permission {
  id: string;
  parentCapability: PermissionName;
  invoker: string;
  date: number;
  caveats: PermissionCaveat[];
}
```

- `id` 是钱包生成的不透明标识。
- `invoker` 是经过验证的 Origin。
- `date` 是 Unix 毫秒整数。
- `caveats` 必须恰好包含一个 `restrictChains`、一个 `restrictAccounts` 和一个 `restrictMethods`；可以再包含至多一个 `expiresAt`。同类型 Caveat 不得重复。
- `restrictMethods.value` 必须包含 `parentCapability`，且不得包含超出本 Permission 授权意图的方法。钱包可以为多个方法分别返回 Permission，不能靠省略 `restrictMethods` 表示无限权限。

标准 Permission Name：

- `tbc_accounts`
- `tbc_accountMetadata`
- `tbc_switchChain`
- `tbc_signMessage`
- `tbc_signTypedData`
- `tbc_crypto`
- `tbc_signTransaction`
- `tbc_sendTransaction`
- `tbc_signWorkflow`

Prepared 方法不新增 Permission Name。它们复用同一安全动作的既有权限：

- `tbc_signPreparedTransaction` → `tbc_signTransaction`
- `tbc_sendPreparedTransaction` → `tbc_sendTransaction`
- `tbc_signPreparedWorkflow` → `tbc_signWorkflow`

复用表示用户不必重复授权同一种签名或发送能力，不表示钱包可以跳过逐次审批、Proposal 验证或 ApprovalBinding。

Workflow 权限是组合容器权限，不替代步骤本身的能力权限。Host 必须在显示批准页前按实际步骤追加检查：`transaction` / `preparedTransaction` 需要 `tbc_signTransaction`，`message` 需要 `tbc_signMessage`，`typedData` 需要 `tbc_signTypedData`，`encrypt` / `decrypt` 需要 `tbc_crypto`。因此仅持有 `tbc_signWorkflow` 不能借批次绕过更窄的签名或密钥操作授权。

每个 Provider 方法读取、要求或授予哪些 Permission，以 [`registry/methods.json`](../registry/methods.json) 的 `authorization` 为规范机器映射；权限实现不得只凭方法名前缀推断。

标准 Caveat：

```ts
type PermissionCaveat =
  | { type: "restrictChains"; value: string[] }
  | { type: "restrictAccounts"; value: string[] }
  | { type: "restrictMethods"; value: string[] }
  | { type: "expiresAt"; value: string };
```

`restrictAccounts` 使用 CAIP-10 Account ID。`expiresAt` 接受 UTC 整秒或 1–3 位小数秒；新生成时间统一使用三位毫秒 `YYYY-MM-DDTHH:mm:ss.SSSZ`。不接受时区偏移、微秒或非法日期。按实际时刻检查期限，到达截止时刻即失效；不得改写已绑定或签名的时间原文。详见 TWS-011 的 Clock Port 规则。

## 5. 请求权限

`wallet_requestPermissions` 的 JSON-RPC params 是只含一个对象的数组：

```json
[
  {
    "tbc_accounts": {
      "chains": ["tbc:mainnet"],
      "maxAccounts": 1
    },
    "tbc_sendTransaction": {
      "chains": ["tbc:mainnet"]
    }
  }
]
```

请求规则：

- `chains` 必须非空且只含合法 TBC Chain ID。
- `maxAccounts` 必须是 1 至 16 的整数；钱包可以授权更少账户。
- Core 默认每链提议一个账户；显式 `tbc_accounts.maxAccounts` 可提高其请求链上的提议上限。只从可信 `accounts.resolve(mode=available)` 结果选取，完整账户列表进入审批绑定；同批明确请求的该链方法使用同一列表，其他链及未请求的既有能力不扩权。此数量不是免审批或免签名授权；管理员操作仍需每个角色的 grant、会话、审批与 task 绑定。`tbc_requestAccounts` 和 Legacy 默认行为不变。
- 请求任何账户相关或签名权限时必须同时请求或已经拥有 `tbc_accounts`。
- 钱包可以缩小请求范围，不能静默扩大。
- 用户拒绝必须返回 `4001`。
- 未知 Permission Name 必须返回 `4200`。
- 成功结果是当前 Origin 对应请求能力的有效 `Permission[]`。

`tbc_requestAccounts` 等价于请求当前 Chain ID 上最多一个 `tbc_accounts` 权限，但保持 EIP-1193 熟悉的 `string[]` 返回值。

## 6. 查询权限

`wallet_getPermissions` 不接受参数，返回当前 Origin 的所有有效 TWS 权限。它不得返回其他 Origin、其他钱包 profile 或未授权账户的信息。

过期权限必须在结果计算前移除，并触发 `permissionsChanged`；如果账户集合改变，还必须触发 `accountsChanged`。

## 7. 授权判断

Wallet Host 在执行方法前必须按以下顺序验证：

1. Transport 和 Trusted Context 有效。
2. Origin 与 Session 未撤销。
3. Chain ID 受支持且连接正常。
4. 请求方法已实现。
5. Permission 未过期，且覆盖方法、Chain ID 与 Account ID。
6. Payload Schema、版本和过期时间有效。
7. 用户批准具体操作。

步骤 1 至 6 失败时不得显示误导性的签名批准页。步骤 7 的拒绝使用 `4001`，前置权限不足使用 `4100`。

## 8. 持久权限与临时授权

钱包可以在用户明确选择后持久保存 Origin 权限。持久权限不得包含自动签名能力。

以下状态绝不能跨导航或 Session 复用：

- 未完成请求；
- 已生成但未批准的 Plan；
- 生物识别或密码解锁会话；
- 快速签名 grant；
- Workflow 中间输出；
- Transport 消息密钥。

同一 Origin 重载后，钱包可以基于持久权限让 `tbc_accounts` 再次返回授权账户，但必须创建新的 Transport Session 和 Navigation ID。

## 9. 撤销

用户可以在钱包 UI 撤销任意权限。`tbc_disconnect` 撤销调用 Origin 的全部 TWS 权限。

撤销后必须：

- 立即取消受影响的未完成请求；
- 清除临时授权和计划；
- 发出 `permissionsChanged`；
- 账户权限变化时发出 `accountsChanged`；
- 后续调用以 `4100` 拒绝，直到重新授权。

## 10. 批准 UI 的最低信息

任何签名批准页必须展示：

- DApp Origin；iframe 时同时展示顶层与 frame Origin；
- Chain ID 的人类可读网络名称；
- 账户地址；
- 操作类型和业务语义；
- 资产、接收方、金额、预计费用和最大费用；
- 多笔交易和依赖关系；
- 消息签名的域、有效期和是否产生链上操作。

UI 可以更丰富，但不得隐藏或弱化上述信息。

## 11. 隐私

- 未调用连接方法前，`tbc_accounts` 必须返回空数组。
- Wallet Standard discovery 可以公开钱包名称和图标，但不能公开账户。
- 错误、日志和遥测必须去除地址之外的秘密数据；地址遥测也应默认哈希或禁用。
- 钱包不得因权限请求失败而泄露用户是否拥有某个未授权账户或资产。

## 12. Draft.3 Permission Proposal、确定性 ID 与原子提交

TWS permissions 严格采用 EIP-2255 的 `wallet_getPermissions` / `wallet_requestPermissions` 方法、Permission shape 与 caveat 语义；TBC 的 chain-local scope 与原子提交规则是该 profile 的明确约束，不允许返回简化的布尔权限表。

多链请求必须先产生一个 `PermissionProposal`，其 payload 同时绑定 verified Origin、完整请求、每条链的精确 change、narrow/reject decision、创建时间与失效时间；`permissionProposalHash` 进入 permission Approval Binding。批准预览只显示实际 grant，不显示内部 Permission `id`。

每个 Permission `id` 必须按 TWS-002 从 operationId、scope Chain ID、parent capability 和规范化 change 中从零开始的 ordinal 确定性派生。它只用于对象身份和重放关联，不是 bearer credential，也不能代替 caveat、Origin、Session 或 Approval Binding 验证。

每次 `permissionStore.load` 的 scope、完整结果和 revision 必须累积保存在当前 Operation Memory。`permissionStore.commit` 只允许在 `committing` 状态的 `permission-store` 判别分支中执行，接收按 `(origin, chainId)` 排序且 scope 唯一的 `changes[]`。Host 必须在一个原子事务内检查全部 `expectedRevision`：任一 scope 冲突时全部不写入；全部匹配时一次提交并返回同顺序的新 revision。权限记录中的 `invoker`、`restrictChains` 和 `restrictAccounts` 必须与 change scope 完全一致。

`tbc_disconnect` 必须枚举当前 Origin 在所有链上的 scope，并在一次 batch CAS 中提交空 `permissions`；不能只撤销活动链，也不能通过 Provider Session `connected` 字段代替权限撤销。
