# TWS-001：Provider、RPC、事件与错误

- 状态：Draft
- 版本：1.0.0
- 类型：Core
- 依赖：TWS-000、TWS-002、TWS-003、TWS-004、TWS-005、TWS-006、TWS-012

## 1. Provider 接口

合规 Provider 必须实现以下最小接口：

```ts
interface TbcProvider {
  request(args: {
    method: string;
    params?: readonly unknown[] | Record<string, unknown>;
  }): Promise<unknown>;

  on(event: string, listener: (...args: unknown[]) => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
}
```

`request` 必须解析为 RPC `result`，或以 `ProviderRpcError` 拒绝。新协议不得把 `{ error: ... }` 当作成功结果解析。

Provider 不得直接暴露助记词、私钥、WIF、Vault token、内部账户数据库、UTXO 选择器或任意签名原语。

## 2. Provider 方法

### 2.1 标准方法注册表

TWS v1 Provider 必须实现下表全部 20 个方法。Profile 决定钱包支持哪些 Intent 和业务版本，不裁剪 Provider 基线方法。调用钱包不支持的 Intent/Profile 时返回结构化执行错误；缺少基线方法的 Provider 不符合 TWS v1。

方法的 Profile、授权模式、批准类型、side effect、参数 Schema 和结果 Schema 由机器可读 [`registry/methods.json`](../registry/methods.json) 固定。实现不得只根据下表自然语言猜测 payload。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `tbc_chainId` | 无 | 当前 CAIP-2 Chain ID 字符串 |
| `tbc_accounts` | 无 | 已授权的原始 TBC 地址数组；无权限时为空数组 |
| `tbc_requestAccounts` | 无 | 用户批准后的原始 TBC 地址数组 |
| `tbc_getAccount` | `{ address?: string }` | `TbcAccount`；省略时返回首个已授权账户 |
| `tbc_getCapabilities` | `{ chainId?: string, address?: string }` | 当前上下文可用的版本化能力 |
| `tbc_switchChain` | `{ chainId: string }` | `null` |
| `tbc_signMessage` | TWS-005 `MessageRequest` | TWS-005 `MessageSignature` |
| `tbc_signTypedData` | TWS-005 `TypedDataRequest` | TWS-005 `TypedDataSignature` |
| `tbc_signTransaction` | TWS-004 `TransactionRequest` | TWS-004 `SignedTransactionBundle` |
| `tbc_signPreparedTransaction` | TWS-012 `PreparedTransactionRequest` | TWS-004 `SignedTransactionBundle` |
| `tbc_sendTransaction` | TWS-004 `TransactionRequest` | TWS-004 `SubmittedTransactionBundle` |
| `tbc_sendPreparedTransaction` | TWS-012 `PreparedTransactionRequest` | TWS-004 `SubmittedTransactionBundle` |
| `tbc_signReviewedTransaction` | `wallet-actions.schema.json` `signReviewedTransactionRequest` | TWS-004 `SignedTransactionBundle` |
| `tbc_encrypt` | `wallet-actions.schema.json` `encryptRequest` | `encryptResult` |
| `tbc_decrypt` | `wallet-actions.schema.json` `decryptRequest` | `decryptResult` |
| `tbc_signWorkflow` | TWS-006 `SignWorkflowRequest` | TWS-006 `SignWorkflowResult` |
| `tbc_signPreparedWorkflow` | TWS-012 `PreparedWorkflowRequest` | TWS-006 `SignWorkflowResult` |
| `wallet_getPermissions` | 无 | TWS-003 `Permission[]` |
| `wallet_requestPermissions` | `[RequestedPermissions]` | TWS-003 `Permission[]` |
| `tbc_disconnect` | 无 | `null` |

所有 TBC 方法的命名参数必须使用 JSON object。无参数方法的 `params` 必须省略或为空数组；不能用 `null` 代表参数对象。

方法注册表中的 `params.kind` 固定 wire 形状：`none` 表示省略 `params` 或使用空数组，`named` 表示必须传符合所列 Schema 的 JSON object，`positional` 表示必须传符合所列 Schema 的 JSON array。不得在三种形状之间自动转换。

`tbc_accounts`、`tbc_requestAccounts` 和 `tbc_getAccount` 只读取当前 `tbc_chainId` 上、当前 Origin 已授权的账户。跨链权限保存在 Permission 中，但 DApp 必须先 `tbc_switchChain` 才能把另一条链的账户变为活动账户集合。`tbc_getCapabilities.chainId` 可以查询受支持的非活动链；若同时传 `address`，该地址必须属于所查询链且已授权。

### 2.2 `TbcAccount`

```json
{
  "address": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "accountId": "tbc:mainnet:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "chainId": "tbc:mainnet",
  "publicKey": "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  "label": "Trading",
  "features": ["tbc:provider"]
}
```

- `address`、`accountId`、`chainId`、`publicKey` 和 `features` 必须存在。
- `publicKey` 必须是 33-byte 压缩 secp256k1 公钥的小写 hex。
- `label` 可以省略；它由钱包控制，DApp 不得依赖其稳定性。
- 方法只能返回调用来源已获授权的账户。

### 2.3 `tbc_getCapabilities`

结果必须包含：

```json
{
  "standard": "1.0.0",
  "provider": "1.0.0",
  "chainId": "tbc:mainnet",
  "methods": {
    "tbc_chainId": "1.0",
    "tbc_accounts": "1.0",
    "tbc_requestAccounts": "1.0",
    "tbc_getAccount": "1.0",
    "tbc_getCapabilities": "1.0",
    "tbc_switchChain": "1.0",
    "tbc_signMessage": "1.0",
    "tbc_signTypedData": "1.0",
    "tbc_signTransaction": "1.0",
    "tbc_signPreparedTransaction": "1.0",
    "tbc_sendTransaction": "1.0",
    "tbc_sendPreparedTransaction": "1.0",
    "tbc_signReviewedTransaction": "1.0",
    "tbc_encrypt": "1.0",
    "tbc_decrypt": "1.0",
    "tbc_signWorkflow": "1.0",
    "tbc_signPreparedWorkflow": "1.0",
    "tbc_sendWorkflow": "1.0",
    "tbc_sendPreparedWorkflow": "1.0",
    "wallet_getPermissions": "1.0",
    "wallet_requestPermissions": "1.0",
    "tbc_disconnect": "1.0"
  },
  "intents": {
    "tbc.transfer": ["1.0"]
  },
  "limits": {
    "workflowSteps": 0,
    "transactionBundleSize": 32
  },
  "profiles": ["core", "transport:webview"]
}
```

钱包必须只公布已经实现并通过对应合规测试的能力，且 `methods` 和 `intents` 必须完整列出当前 Chain ID / Account scope 支持的标准项。Capability 描述实现支持范围，不描述当前 Origin 的授权状态，因此不得仅因权限不足而省略受支持方法。权限由 `wallet_getPermissions` 表达，调用受限方法时仍必须执行 TWS-003 授权判断。DApp 若在 `tbc_getCapabilities` 中指定未授权的 `address`，钱包必须以 `4100` 拒绝，不能借此泄露账户信息。

`limits.workflowSteps` 必须是实际限制 `1` 至 `5`。Capability 中的方法版本、Profile 和方法注册表必须一致。`methods` 固定表达 22 方法协议基线；动态差异由 `intents`、`profiles` 和 `limits` 表达，不能用缺方法模拟 Profile。

### 2.4 `tbc_switchChain`

- 目标必须存在于 TWS 网络注册表或钱包显式支持的后续注册表版本。
- 钱包可以要求用户批准。
- 成功后必须在 Promise 解析前切换内部活动链，随后按第 5 节发出 `chainChanged`。
- 如果新链上的授权账户数组与旧链不同，状态提交后还必须发出 `accountsChanged`；Listener 中重查必须得到新链状态。
- 钱包不支持目标链时必须以 `4901` 拒绝。
- DApp 提供的 API endpoint、网络名称或地址前缀不得覆盖钱包网络配置。

### 2.5 `tbc_disconnect`

该方法撤销调用 Origin 在当前钱包配置中的全部 TWS 权限，取消其未完成请求并解析为 `null`。状态提交后依次发出 `permissionsChanged([])` 和 `accountsChanged([])`。它不表示钱包与区块链节点断开，不应触发 Provider `disconnect` 事件。

## 3. JSON-RPC 传输信封

Provider 的页面 API 隐藏 wire envelope，但所有 WebView、Extension 和 Remote 传输必须使用 JSON-RPC 2.0：

```json
{
  "jsonrpc": "2.0",
  "id": "01J...",
  "method": "tbc_chainId"
}
```

成功响应：

```json
{
  "jsonrpc": "2.0",
  "id": "01J...",
  "result": "tbc:mainnet"
}
```

失败响应：

```json
{
  "jsonrpc": "2.0",
  "id": "01J...",
  "error": {
    "code": 4100,
    "message": "The requested method is not authorized"
  }
}
```

要求：

- 每个未完成请求的 `id` 必须在当前 Session 内唯一。
- 对带有合法 `id` 的请求，响应必须携带完全相同类型和内容的 `id`。
- 无法提取合法请求 ID 的 Parse Error 或 Invalid Request 响应必须使用 `id: null`；它不得匹配任何 pending Promise。
- pending request 只能按 `id` 索引，不得按方法名、队列位置或事件顺序匹配。
- Response 必须只含 `result` 或 `error`，不能同时存在。
- 导航、Session 撤销或 Transport 关闭时，所有关联请求必须立即拒绝。
- JSON 不支持 `bigint`；大整数必须按对应 Schema 使用十进制字符串。
- TWS 1.0 的 wire request 必须包含 `id`，不支持 JSON-RPC notification。
- TWS 1.0 不接受 JSON-RPC batch 数组；并发请求必须作为独立 envelope 发送并按 ID 关联。

JSON-RPC `id` 只负责传输关联，不进入交易或消息签名摘要，也不承担防重放作用。

## 4. 错误模型

```ts
interface ProviderRpcError extends Error {
  code: number;
  data?: unknown;
}
```

### 4.1 标准错误码

机器可读代码、symbol、执行错误名和合法 stage 位于 [`registry/errors.json`](../registry/errors.json)。标准方法不得返回注册表外的错误 code 或 `-32000 data.name`；无法归类的内部故障必须映射为 `-32603`。

| code | 名称 | 使用条件 |
| ---: | --- | --- |
| `4001` | User Rejected Request | 用户明确拒绝、关闭批准页或取消认证 |
| `4100` | Unauthorized | Origin、账户、链或方法未获授权 |
| `4200` | Unsupported Method | Provider 不支持方法、Intent 或版本 |
| `4900` | Disconnected | Provider 无法连接任何 TBC 网络 |
| `4901` | Chain Disconnected | Provider 可用，但目标 TBC 网络不可用 |
| `-32700` | Parse Error | wire message 不是合法 JSON |
| `-32600` | Invalid Request | 不是合法 JSON-RPC 请求 |
| `-32601` | Method Not Found | 方法未注册且不是已声明扩展 |
| `-32602` | Invalid Params | 参数或 Schema 无效 |
| `-32603` | Internal Error | 钱包内部故障，不能更精确分类 |
| `-32000` | TBC Execution Error | 已验证请求在计划、签名或广播阶段失败 |

`-32000` 的 `data` 必须通过 `provider.schema.json#/$defs/executionErrorData`，并带稳定 `name`、`stage` 和 `retryable`：

```json
{
  "name": "INSUFFICIENT_FUNDS",
  "stage": "planning",
  "retryable": false,
  "details": {
    "asset": "tbc:native",
    "required": "1200",
    "available": "900"
  }
}
```

允许的 `name`：

- `REQUEST_EXPIRED`
- `WALLET_LOCKED`
- `INSUFFICIENT_FUNDS`
- `FEE_LIMIT_EXCEEDED`
- `PLANNING_FAILED`
- `SIMULATION_FAILED`
- `SIGNING_FAILED`
- `BROADCAST_FAILED`
- `CONFLICT`
- `POLICY_VIOLATION`
- `UNSUPPORTED_ASSET`
- `WORKFLOW_FAILED`

`name` 与 `stage` 的组合必须存在于错误注册表。`retryable: true` 只表示在保持同一规范化请求的情况下，解决短暂状态后可以安全重试；它不保证重试成功。已发生部分广播时仍必须先按 TWS-004 对账。

实现不得要求 DApp 解析英文 `message`。错误 `data` 不得包含私钥材料、完整内部堆栈、Vault 标识、未授权账户、完整 UTXO 集或秘密节点凭证。

## 5. 事件

Provider 必须支持：

事件名称、trigger 和 payload Schema 由 [`registry/events.json`](../registry/events.json) 固定。

| 事件 | Listener 参数 | 触发条件 |
| --- | --- | --- |
| `connect` | `{ chainId: string }` | Provider 首次能够为至少一条 TBC 链服务 |
| `disconnect` | code 固定为 `4900` 的 `ProviderRpcError` | Provider 无法为任何 TBC 链服务 |
| `chainChanged` | `chainId: string` | 活动 TBC Chain ID 改变 |
| `accountsChanged` | `addresses: string[]` | 当前 Origin 的授权账户集合或顺序改变 |
| `permissionsChanged` | `Permission[]` | 当前 Origin 的有效权限改变 |
| `capabilitiesChanged` | `Capabilities` | 当前链或账户的已公布能力改变 |

事件名称和参数大小写固定。实现不得要求 DApp监听旧 `TuringAccountChanged` 或 `TuringNetworkChanged` 事件。

事件必须反映已经提交的状态：Listener 内立即调用对应查询方法时，结果必须与事件一致。事件不得泄露未授权账户。

`disconnect` 表示 Provider 与所有支持链的连接状态，不表示用户撤销账户权限。账户撤销使用 `accountsChanged([])`。

## 6. 生命周期、取消和超时

- DApp SDK 应支持本地 `AbortSignal`；它是 SDK 扩展，不改变 RPC wire shape。
- 只读请求建议默认超时 30 秒。
- 交互请求允许等待用户，但必须在 5 分钟内过期；具体 `expiresAt` 可以更短。
- `4001` 只用于用户行为。超时使用 `-32000` / `REQUEST_EXPIRED`。
- WebView 顶层导航、扩展 tab/frame 销毁和 Remote Session 撤销必须取消关联请求。

### 6.1 Provider Session

活动链、活动账户和连接状态属于 `(walletProfile, TrustedContext.sessionId)` scope 的版本化 Provider Session，不是钱包进程全局变量，也不得来自 DApp params。`activeAccountIds` 必须唯一、按 bytewise 排序、最多 16 项，并且每项 Chain ID 都等于 `activeChainId`。`ProviderSessionSnapshot = { version, scope, state }` 的 scope、state 和 Trusted Context 三处 sessionId 必须一致。

Host 在每次 Core 调用前重新读取当前 Snapshot；Core 依次验证输入 Schema、release/checkpoint、当前 Trusted Context、Snapshot scope/connected、active chain、active accounts、revision，之后才解释 Port response 或产生 effect。只有 `acknowledgeCommit` 例外：当前 Snapshot 必须精确等于待确认 Provider Session mutation 的 target。

`tbc_switchChain` 的有效状态改变必须经过 Provider Session compare-and-swap；相同链 no-op 不请求批准、不提交 mutation、也不发送 `chainChanged`。`tbc_disconnect` 只原子撤销当前 Origin 的全部链权限，不把 Provider Session 写成 `connected: false`。

状态改变的固定顺序是：Core 返回 commit → Host CAS → Host 持久化 Commit Ack → `acknowledgeCommit` → Core complete → RPC Promise 完成并按 Core 顺序发送事件。Listener 内立即查询必须看见已提交状态。相同 `commitId` 与相同 mutation 重放首次 Ack；相同 ID 搭配不同 mutation 返回 `CONFLICT`。

### 6.2 取消映射

以下 11 个 reason 是机器注册表的完整集合：`USER_REJECTED`、`REQUEST_ABORTED`、`REQUEST_EXPIRED`、`SESSION_REVOKED`、`NAVIGATION_CHANGED`、`ORIGIN_CHANGED`、`CHAIN_CHANGED`、`ACCOUNT_CHANGED`、`TRANSPORT_CLOSED`、`SNAPSHOT_INVALIDATED`、`PROTOCOL_RELEASE_CHANGED`。

- `USER_REJECTED` → `rejected` / respond / `4001`。
- `REQUEST_ABORTED` → `cancelled` / suppress；不得构造 wire response。
- `REQUEST_EXPIRED` → `failed` / respond / `-32000` + `REQUEST_EXPIRED` / retryable false。
- `SNAPSHOT_INVALIDATED` → `failed` / respond / `-32000` + `CONFLICT` / retryable true。
- 页面、Origin 或 Transport 已不可安全送达时必须 suppress；`SESSION_REVOKED` 与 `PROTOCOL_RELEASE_CHANGED` 只有在原 channel 仍可认证时才 respond。

四个终态 `completed`、`rejected`、`failed`、`cancelled` 均不得 resume。取消后迟到的 Approval、Signer 或 Broadcast response 不得改变终态或 revision。

### 6.3 Wire Profile

TWS 使用 JSON-RPC 2.0 strict single-request profile：请求必须有 Transport Session 内唯一 `id`；不支持 batch，不支持 notification。并发通过多个独立 request envelope 和 ID 关联，不能借 batch 数组实现。

## 7. 非目标

TWS 1.0 Core 不定义通用节点代理、余额查询、区块查询、任意 raw transaction、任意 script 签名、加密或解密。钱包可以组合独立的 TBC Public Client，但不得把节点响应和钱包权限响应混在同一未声明方法中。
