# TWS-007：钱包发现与传输配置

- 状态：Draft
- 版本：1.0.0
- 类型：Core / Transport
- 依赖：TWS-000 至 TWS-006、Wallet Standard

## 1. 目的

本文规定 DApp 如何发现多个 TBC 钱包，以及 TWS RPC 如何安全运行在移动 WebView、浏览器 Extension 和 Remote Session 上。三种传输共享完全相同的方法、Schema、权限、事件和错误语义。

## 2. Wallet Standard Feature

合规钱包必须通过 Wallet Standard 注册，并公布：

```ts
interface TbcProviderFeature {
  "tbc:provider": {
    version: "1.0.0";
    provider: TbcProvider;
  };
}
```

Wallet 对象：

- `version`、`name`、`icon`、`chains`、`features` 和 `accounts` 必须符合 Wallet Standard。
- `chains` 使用 TWS-002 Chain ID。
- 未连接前 `accounts` 必须为空。
- 连接后的 Wallet Standard `WalletAccount.address` 必须是原始 TBC 地址，`publicKey` 必须是 33-byte 压缩公钥 bytes，`chains` 必须列出对应 TWS Chain ID，`features` 必须包含 `tbc:provider`。完整 CAIP-10 Account ID 由 `tbc_getAccount.accountId` 返回，不能塞入 Wallet Standard 的原始 `address` 字段。
- 钱包不能仅因为安装了 Legacy Adapter 就公布 `tbc:provider`。

## 3. Discovery

DApp SDK 必须：

1. 使用 Wallet Standard 的 `getWallets()` 获取当前钱包。
2. 监听 Wallet Standard 注册事件，以发现延迟注入的钱包。
3. 过滤包含兼容 `tbc:provider` major version 的钱包。
4. 当存在多个钱包时，让用户选择，不能按注入顺序静默选择。
5. 当前文档生命周期内必须按 Wallet 注册对象 identity 记住选择。跨页面持久化只能把 `name + icon` 当作 UI 提示，不能当作安全身份或自动授权依据；出现零个或多个匹配项时必须让用户重新选择。TWS 1.0 不定义可持久化 Wallet ID。

TWS 不定义 `window.tbc` 或新的单钱包全局变量。多钱包发现不能依赖谁最后覆盖 `window.Turing`。

Legacy fallback 只有在以下条件全部满足时才可启用：

- DApp 或 SDK 显式打开 legacy 模式；
- 没有可用的标准钱包，或用户明确选择旧钱包；
- UI 标明连接的是非 TWS Provider；
- 新方法不得通过旧对象伪装成功。

## 4. 版本协商

协商按三层进行：

1. Wallet Standard feature SemVer。
2. `tbc_getCapabilities` 的方法、Intent 和 Profile 版本。
3. 每个 Request payload 的 `major.minor`。

规则：

- SDK 必须先检查 feature major version。
- DApp 在使用 Assets、DeFi 或 Workflow 前必须检查对应 capability。
- 未知 payload major version返回 `4200`。
- 已知主版本但参数不符合已公布 minor version 时返回 `-32602`。
- 不能通过捕获英文错误后猜测钱包版本。

## 5. 通用 Wire 要求

所有 Transport 必须遵守 TWS-001 JSON-RPC 2.0 envelope，并额外满足：

- 单条 wire message 最大 4 MiB UTF-8；超限以 `-32600` 拒绝。
- Request 和 Response 必须在同一可信 Session 内关联。
- Transport 必须限制消息来源、目标和方向。
- 反序列化后必须在 Wallet Host 再做严格 Schema 验证。
- Transport 只能携带 RPC 数据，不能携带私钥、Vault handle 或解锁密码。
- Session 销毁后收到的迟到响应必须丢弃，不能解析到新 Session 的 Promise。
- Transport 不得把 JSON-RPC `id` 当作权限 token。

## 6. WebView Profile

### 6.1 架构

```text
DApp page
   │ injected Provider (untrusted page realm)
   ▼
WebView message bridge
   │ verified URL + navigationId
   ▼
Native Wallet Host
```

注入脚本只能构造 Provider 和序列化 RPC。账户、权限、签名、网络选择和交易逻辑必须在 Native Wallet Host。

### 6.2 导航

- 每次顶层文档提交都必须生成新的不可预测 `navigationId`。
- 旧 navigation 的 pending requests、临时 grant、计划、批准和消息密钥必须立即失效。
- 即使新旧 URL 的 Origin 相同，也必须建立新 Transport Session。
- 持久 Origin 权限可以重新查询，但不能复用旧解锁或批准状态。
- Wallet Host 必须从原生 WebView navigation state 验证当前 URL；不能只相信页面 postMessage 的 URL。

### 6.3 注入策略

- 生产环境默认只向 HTTPS 顶层页面注入。
- `http://localhost` 和 loopback 只能在显式开发模式中启用。
- 不向 `data:`、`file:`、`javascript:`、未知 scheme 或第三方 iframe 注入。
- iframe 例外必须符合 TWS-003 双重授权，并在每条请求中验证 frame identity。
- 页面 CSP 不能成为唯一安全边界。

### 6.4 消息验证

Native Host 必须验证：

- WebView 实例；
- 当前 `navigationId`；
- 顶层 Origin；
- frame policy；
- Session ID；
- JSON-RPC ID、方法和 Schema。

任何字段不一致都必须在进入 Wallet Host 方法路由前拒绝。

## 7. Extension Profile

### 7.1 架构

```text
Page Provider
    │ window messaging
    ▼
Content Script
    │ extension messaging + sender metadata
    ▼
Background / Service Worker
    │
    ▼
Wallet Host -> Signer -> Vault
```

- Page Provider 和 Content Script 不得访问密钥。
- Content Script 只做最小的消息转发、channel 隔离和大小限制。
- Background 必须根据浏览器 `sender` 得到 tab、frame 和 Origin；不得使用 page payload 的这些字段。
- 用户批准 UI 必须运行在受信任扩展页面，而不是 DApp DOM。
- Service Worker 重启后，无法恢复可信关联的请求必须拒绝，不能猜测继续。

### 7.2 TBC 钱包发现

TBC 使用 Wallet Standard `tbc:provider`。多链钱包的其他 Provider 独立实现和注册，
不属于 TBC Kit，也不共享 TBC 的授权。Extension 不得用一个 Legacy 注入对象代替各链的发现机制。

### 7.3 Tab 与 Frame 生命周期

- 每个 tab/frame/navigation 组合必须具有独立 Session。
- frame 或 tab 关闭必须取消 pending requests。
- frame 跨 Origin 导航必须失去旧权限上下文。
- 同一页面的并发同名方法必须按 JSON-RPC ID 独立处理。

## 8. Remote Profile

Remote Profile 是 TWS 1.0 可选能力，适用于 WalletConnect 类二维码或深链会话。

要求：

- 使用经过认证的加密会话；
- 会话提案明确列出 TWS methods、Chain IDs、Account IDs 和过期时间；
- 用户在钱包受信任 UI 中批准会话；
- 会话只能调用已批准 capability；
- 每条请求仍经过 TWS-003 权限和具体操作批准；
- 会话撤销立即取消 pending requests；
- Origin / requester identity 必须来自经过验证的会话 metadata，并写入 Trusted Context；
- 二维码或深链不得直接携带私钥、签名或长期 bearer token。

Remote Profile 可以使用 CAIP session 标识，但 TWS Core 不依赖仍处于 Review/Draft 的外部会话提案。

## 9. Transport 一致性

对相同规范化请求和链状态：

- 三种 Transport 必须使用相同的 Schema、Intent 语义、JCS、Magic Hash、权限判断和交易计划不变量。
- `origin` 的来源形式可以不同；Wallet Host 生成的 nonce 和可信时间也会不同。一旦这些值进入 Trusted Context 或签名信封，三种 Transport 必须使用相同的规范化和验证规则，不能因 Transport 改变字段含义。
- 错误码、结果字段和事件参数不能因 Transport 改变。
- 除规范化后的 verified `origin` 外，Session、tab、frame、navigation 等 Transport metadata 不得出现在签名 payload，除非未来规范明确加入。

## 10. SDK 责任

标准 DApp SDK 可以提供：

- Wallet Standard discovery；
- Provider 类型和 Schema validation；
- capability negotiation；
- 本地 `AbortSignal` 和超时；
- Chain/Account ID helper；
- JCS 与签名验证；
- Legacy fallback adapter 的显式入口。

SDK 不得：

- 代表钱包保存密钥；
- 绕过钱包批准；
- 在多个钱包中静默选择；
- 把 SDK 特有字段写入标准 payload；
- 将某个官方后端作为 TWS 合规的强制依赖。

## 11. Transport Profile 声明

合规清单使用：

```text
transport:webview
transport:extension
transport:remote
```

每个 Profile 单独测试和认证。通过 Extension 不代表通过 WebView 或 Remote。

## 12. Draft.2 Discovery 与 Authority 边界

Wallet Standard 用于 TBC discovery，钱包通过 `tbc:provider` feature 暴露 TWS Provider；EIP-6963 仅用于 EVM。Extension 不能把 EIP-6963 宣称为 TBC discovery，也不能让同一注入对象在协议不明时猜测链。

三种 Transport 必须先创建权威 `TrustedContext`，再调用 Core：WebView 从受信任导航控制器取得 Origin 与 navigation；Extension 从浏览器 sender 取得 tab/frame 对应 Origin，但只把严格 Context 投影送入 Core；Remote 从已认证会话 metadata 取得 requester identity。`sessionId`、`navigationId`、`origin`、`topOrigin`、`frame`、`createdAt` 都不能由 DApp request 覆盖。

Transport Session 内 JSON-RPC ID 必须全程唯一。页面重载、frame 导航、tab 销毁、Remote revoke 或认证 channel 关闭时，Host 必须调用取消路径并 suppress 无法安全投递的旧页面 response；迟到 Port response 只能进入 replay journal，不能恢复 operation。
