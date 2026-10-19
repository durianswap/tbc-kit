# @tbc-wallet/core

`@tbc-wallet/core` 是 TWS `1.0.0-draft.6` 的平台中立、可恢复执行内核。它让官方移动钱包、Chrome MV3 插件和第三方钱包复用同一套协议状态机，同时各自保留 UI、Vault、Keyring、Transport、RPC 与产品策略。

当前包是冻结候选，尚未发布到 npm。固定实现和完整哈希见 [`release/tws-core-1.0.0-draft.6.json`](../../release/tws-core-1.0.0-draft.6.json)。

## 公共边界

Core 只暴露四个状态机入口，全部返回 `Promise<CoreTransition>`：

| 方法 | 输入 Schema | 作用 |
| --- | --- | --- |
| `start` | `startInput` | 验证并启动一个 Provider 操作 |
| `resume` | `resumeInput` | 用一个匹配 `callId` 的 Port 响应恢复 |
| `acknowledgeCommit` | `commitAckInput` | 在 Host 持久提交 Provider Session 后恢复 |
| `cancel` | `cancelInput` | 按冻结原因与 authority 规则终止操作 |

返回值只有四种：`continue`、`waiting`、`commit`、`complete`。不存在公共 `execute` 快捷路径。

交易引擎是另一个严格的四方法 facade：`normalizeRequest`、`plan`、`validate`、`finalize`。引擎不能签名，也不能广播；批准后的签名只能经 `signer.sign` Port 发生。

所有公共交易路径必须保持：

```text
plan → approval-binding → signer.sign → finalize
```

`tbc_signTransaction` 到此结束；只有 `tbc_sendTransaction` 才能随后进入 `broadcast.submit`，不确定结果只能进入 `broadcast.reconcile`，不得盲目重发。

## 九个 Host Port

Host 必须恰好提供这些能力，不允许把隐藏函数、RPC URL 或 Vault 句柄塞进 Core：

| Port | 操作 |
| --- | --- |
| `accounts` | `accounts.resolve` |
| `chainData` | `chainData.resolve` |
| `policy` | `policy.resolve` |
| `permissionStore` | `permissionStore.load`、`permissionStore.commit` |
| `approval` | `approval.request` |
| `signer` | `signer.sign` |
| `broadcast` | `broadcast.submit`、`broadcast.reconcile` |
| `clock` | `clock.now` |
| `entropy` | `entropy.randomBytes` |

完整输入输出引用位于 [Integration Schema](../../schemas/integration.schema.json) 和 [Integration Port Registry](../../registry/integration-ports.json)。

## Host 驱动循环

下面是结构性伪代码。`persist` 必须在执行任何 effect 之前完成；Port 日志必须用 `callId` 绑定规范化后的完整 payload。相同调用可读取已持久响应，不同 payload 复用同一 `callId` 必须失败关闭。

```ts
const core = createTwsCore({ transactionEngine });
let transition = await core.start(startInput);

for (;;) {
  await checkpointStore.persist(transition.checkpoint);

  if (transition.kind === "continue") {
    transition = await core.resume({
      checkpoint: transition.checkpoint,
      currentContext: await host.readCurrentContext(),
      currentSession: await host.readCurrentSession(),
    });
    continue;
  }

  if (transition.kind === "waiting") {
    const response = await host.dispatchJournaled(transition.calls[0]);
    transition = await core.resume({
      checkpoint: transition.checkpoint,
      response,
      currentContext: await host.readCurrentContext(),
      currentSession: await host.readCurrentSession(),
    });
    continue;
  }

  if (transition.kind === "commit") {
    const acknowledgment = await host.commitProviderSessionCas(
      transition.mutation,
    );
    await host.persistCommitAcknowledgment(acknowledgment);
    transition = await core.acknowledgeCommit({
      checkpoint: transition.checkpoint,
      acknowledgment,
      currentContext: await host.readCurrentContext(),
      currentSession: await host.readCurrentSession(),
    });
    continue;
  }

  await host.deliverOnce(transition.completion);
  break;
}
```

Host 需要覆盖三个崩溃窗口：effect dispatch 前、dispatch 后但响应落盘前、响应落盘后但 `resume` 前。副作用 Port 必须由钱包侧提供幂等语义；广播还必须使用冻结的业务 idempotency key。

## 三类适配器

### React Native 移动钱包

- React Native 只实现屏幕、导航、持久化和九 Port；Core 本身不导入 React 或 React Native。
- checkpoint、Port journal、Provider Session CAS acknowledgment 必须进入可恢复的本地数据库，不能只留在组件 state。
- Keyring 或生物识别模块只能藏在 `signer.sign` 的 Host 实现之后。
- WebView Transport 在调用 Core 前构造可信 `currentContext`，每次恢复前重新读取，而不是相信页面传入值。

### Chrome MV3 插件

- Service Worker Host 使用 IndexedDB 或等价 durable storage 保存 checkpoint 与 journal。
- Content script / in-page Provider 只负责 Transport；批准窗口通过 `approval.request` Port 协调。
- `chrome.*` 只能存在于 Host 适配层。Core 已通过无 `eval`、无 `new Function` 的 MV3 CSP 冒烟测试。
- 插件内部 `wallet-vault/1` 可以继续存在，但只能被 `signer.sign` 适配器调用，不能成为 TWS 公共接口、参数或结果。

### 第三方钱包

- 实现九 Port、四方法交易引擎和 Host 驱动循环即可，不需要复制 Turing Wallet UI。
- 共享的是 semantic token 名称、状态 ID、风险和批准语义，不共享 React / React Native 组件或品牌素材。
- 钱包可以将自己的权限库、Keyring、节点服务和广播器映射到 Port，但必须在边界处删除私有句柄和敏感错误细节。

## TBC-first 是产品策略

官方钱包在发送、接收、跨链和资产入口默认选择 TBC，这一 **TBC-first** 行为由移动端或插件的产品适配器实现。Core 仍严格按请求、Provider Session、权限和 CAIP-compatible chain ID 工作；DApp 不能通过协议请求改写钱包全局默认链。

Bitcoin、Ethereum/BSC 与 Solana 继续使用各自标准。多链钱包可以在同一个 Host 中组合它们，但不能通过给 Core 增加隐藏分支来绕过 TWS Schema。

## 私有能力禁区

以下内容不属于本包，也不能出现在公共 TWS 数据中：私钥、助记词、WIF、Vault token、session handle、quick-sign handle、`wallet-vault/1`、RPC credential、任意页面授权头。错误返回应保持稳定且最小化，不能泄漏 checkpoint、签名器或底层节点细节。

## 验证

```bash
npm ci
npm run build:core
npm run test:core
npm run check:core-portability
npm run handoff -- --config release/tws-core-1.0.0-draft.6.config.json --verify release/tws-core-1.0.0-draft.6.json
```

完整仓库门禁使用 `npm run check`。
