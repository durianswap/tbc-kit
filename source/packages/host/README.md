# @tbc-wallet/host

`@tbc-wallet/host` 是 TWS `1.0.0-draft.6` 的平台中立、可恢复 Wallet Host 驱动。
当前实现版本为本地补丁候选 `1.0.0-draft.6.9`。它把公开 `@tbc-wallet/core` 的 transition
安全地连接到第三方钱包能力，并在每个外部副作用前后写入 durable journal。

这个包不包含 Vault、Keyring、RPC Client、Transport、UI 或 Turing Wallet 私有代码，
也不会接触私钥。签名始终只能发生在钱包实现的 `signer` Port 内。

## 安装

```bash
npm install @tbc-wallet/core@1.0.0-draft.6.3 \
  @tbc-wallet/tbc-engine@1.0.0-draft.6.3 \
  @tbc-wallet/host@1.0.0-draft.6.9
```

这些包当前仍是冻结候选，尚未发布到 npm。

## 公共边界

Host facade 固定为五个方法：

```ts
type TwsHost = {
  startOperation(input): Promise<TwsHostOperationResult>;
  resumeOperation({ operationId }): Promise<TwsHostOperationResult>;
  recoverPendingOperations({ limit }?): Promise<readonly TwsHostRecoveryResult[]>;
  cancelOperation({ operationId, reason }): Promise<TwsHostOperationResult>;
  inspectOperation({ operationId }): Promise<TwsHostOperationInspection>;
};
```

不存在 `execute`、`executeTransaction` 或 `signAndSend`。交易必须保持：

```text
normalize → plan → approval binding → signer.sign → finalize → broadcast
```

`inspectOperation` 只返回 operation ID、revision、state、transition kind、release
fingerprint、terminal 和时间戳。它不会返回 checkpoint、批准 token、签名、交易原文或
Authority 内容。

## 九个 Host Port

钱包必须提供且只能提供以下九个 own-function 属性：

| Port | 注册操作 | 钱包责任 |
| --- | --- | --- |
| `accounts` | `accounts.resolve` | 返回当前钱包控制且允许暴露的 TBC 账户 |
| `chainData` | `chainData.resolve` | 从可信节点构建有时效、带 hash 的快照 |
| `policy` | `policy.resolve` | 返回费用、dust、确认数和限额策略 |
| `permissionStore` | `permissionStore.load`, `.commit` | 原子读取或 CAS 提交权限 |
| `approval` | `approval.request` | 展示绑定后的预览并返回精确 receipt |
| `signer` | `signer.sign` | 在钱包私有安全域内按 task 签名 |
| `broadcast` | `broadcast.submit`, `.reconcile` | 按 idempotency identity 提交或查询不确定结果 |
| `clock` | `clock.now` | 返回钱包信任的 RFC 3339 时间 |
| `entropy` | `entropy.randomBytes` | 返回指定长度的安全随机字节 |

Port 输入输出由冻结的 TWS Integration Schema 与 Registry 定义。Port 可以返回注册的
成功结果，或 `{ portError }`；抛出的异常和不合规结果会被 Host 转换为稳定、脱敏的错误。
`portError` 本身是协议可见结果，钱包必须在返回前使用稳定、安全的公开 message，不能把
节点地址、堆栈、账户内部标识、签名材料或底层异常文本复制进去。

任何 Port 函数都不能挂载 `vaultHandle`、session handle 或其他隐藏 capability。
`wallet-vault/1` 不是公共接口。

## Authority control plane

Authority 不是第十个 Port。它是钱包私有的 Provider Session 控制面：

```ts
type TwsAuthoritySource = {
  read(): Promise<{
    currentContext: TrustedContext;
    currentSession: ProviderSession;
  }>;

  compareAndSwapSession(input: {
    operationId: string;
    commitId: string;
    mutation: ProviderSessionMutation;
    expected: AuthoritySnapshot;
  }): Promise<{
    acknowledgment: ProviderSessionCommitAcknowledgment;
    authority: AuthoritySnapshot;
  }>;
};
```

`read()` 必须从钱包当前可信来源重新读取 origin/navigation/session，而不是接受 DApp
传入的快照。`compareAndSwapSession` 必须同时比较完整 `expected`、以 `commitId` 幂等，
并只在 mutation 的 expected revision 匹配时提交。相同 `commitId` 的精确重放必须返回
同一个结果；不同内容复用同一个 ID 必须失败关闭。

## 最小接线

```ts
import { createTwsCore, TWS_RELEASE } from "@tbc-wallet/core";
import { createTbcTransferEngine } from "@tbc-wallet/tbc-engine";
import {
  createMemoryTwsHostStore,
  createTwsHost,
  deriveHostAuthorityIdentity,
  type TwsHostPorts,
} from "@tbc-wallet/host";

const ports: TwsHostPorts = Object.freeze({
  accounts: (call) => walletAccounts.resolve(call),
  chainData: (call) => tbcNodeSnapshots.resolve(call),
  policy: (call) => walletPolicy.resolve(call),
  permissionStore: (call) => permissions.dispatch(call),
  approval: (call) => approvalUi.request(call),
  signer: (call) => secureSigner.sign(call),
  broadcast: (call) => tbcBroadcaster.dispatch(call),
  clock: () => ({ now: new Date().toISOString() }),
  entropy: (call) => secureEntropy.randomBytes(call),
});

const host = createTwsHost({
  core: createTwsCore({ transactionEngine: createTbcTransferEngine() }),
  ports,
  store: createMemoryTwsHostStore(), // 只用于测试或单进程工具
  authority: walletProviderSessionAuthority,
  ownerId: "wallet-runtime-instance-1",
  scheduleLeaseHeartbeat: (delayMs, run) => {
    const handle = setTimeout(run, delayMs);
    return () => clearTimeout(handle);
  },
});

const authority = await walletProviderSessionAuthority.read();
const result = await host.startOperation({
  version: "1.0",
  release: TWS_RELEASE,
  expectedAuthorityIdentity: deriveHostAuthorityIdentity(authority),
  request: {
    jsonrpc: "2.0",
    id: "dapp-request-1",
    method: "tbc_sendTransaction",
    params: transactionIntent,
  },
});
```

`startOperation` 不接受 `currentContext` 或 `currentSession`；Host 会通过 Authority
重新读取。Transport 在派发前已验证一个 Authority 快照时，必须传入由该快照派生的
`expectedAuthorityIdentity`。Host 会在任何 Core 或 Port 工作前重读并精确比较；不匹配时以
`HOST_AUTHORITY_FAILURE` 失败关闭，避免“验证 A、执行 B”的权限竞态。调用方必须按 `status`
处理 `complete`、`cancelled`、`waiting`、`busy` 和
`failed`，不能只依赖英文 message。

`scheduleLeaseHeartbeat` 是钱包运行时显式提供的平台调度能力，不是 Host Port。Host 在
等待每一个 Port 的整段时间内以不超过 lease TTL 三分之一的间隔单飞续租；Port 返回后会先
取消下一次调度、等待在途续租并最后续租，再提交 durable response。任何续租失败都会让
该 Port 结果被 fencing，绝不写入 journal，也不会触发或重试 Port。Host 根包自身不读取
ambient timer；浏览器、MV3、React Native 和 Node 集成必须在其平台边界提供调度函数。
worker 或进程终止时平台计时器自然消失，租约到期后新实例按正常 recovery 接管。

当同一个 Host 实例正在持有 operation lease 时，并发 `cancelOperation` 会保持公开的
`busy` 返回，同时在该实例内登记第一次取消原因；当前 effect 收敛后，driver 会在派发下一个
Port 前通过 Core 写入取消终态。调用方仍不能把 `busy` 当成已经取消。跨进程或多个 Host
实例时，请按 durable Store/lease 规则重试取消；内存登记不能替代钱包自己的持久生命周期。
同一 Host 实例中，操作创建前到达的可信取消会进入有界队列，并在对应 operation 启动后以
原 operation ID 消费；`busy` 仍只表示已登记或当前不可取得 lease，不表示链上副作用可撤销。

## Store 选择

`TwsHostStore` 是公开可实现的 SPI，但它只能存在于钱包的可信内部边界，绝不是 Provider、
DApp 或可观察数据接口。持久记录会包含完整 Core checkpoint/transition，以及可能带有批准
token、签名响应和 Authority 快照的 journal。数据库、备份和调试导出必须按敏感授权与
签名材料保护；不得把 Store、原始记录或通用数据库访问能力桥接到 Provider、页面脚本、
telemetry、崩溃上报或普通应用日志。对外运维查询只能使用脱敏的 `inspectOperation()`。

| Runtime | 推荐 Store | 说明 |
| --- | --- | --- |
| 单元测试、CLI、短生命周期工具 | `createMemoryTwsHostStore()` | 进程退出后不恢复，不适合生产钱包 |
| Browser、WebView、Chrome MV3 | `@tbc-wallet/host/indexeddb` | 显式注入 `IDBFactory`，根入口不读取全局 `indexedDB` |
| React Native / iOS / Android | `@tbc-wallet/host/sqlite` | 注入平台 SQLite driver；包本身不导入 Expo 或 React Native |

浏览器示例：

```ts
import { createIndexedDbTwsHostStore } from "@tbc-wallet/host/indexeddb";

const store = createIndexedDbTwsHostStore({
  factory: globalThis.indexedDB,
  databaseName: "tws-host-v1",
});
```

IndexedDB 是 opt-in 子路径；导入 `@tbc-wallet/host` 不会访问 DOM、IndexedDB、网络或
任何浏览器全局。

React Native / 移动端示例：

```ts
import { createSqliteTwsHostStore } from "@tbc-wallet/host/sqlite";

const store = createSqliteTwsHostStore({
  driver: walletSqliteDriver,
  namespace: "wallet-profile-7",
});
```

`walletSqliteDriver` 只有 `transaction(work)` 边界；`work` 内每条查询必须使用传入的
transaction 对象，driver 负责独占写事务、commit、rollback 和跨连接串行化。完整契约见
标准仓库的 `docs/reference/sqlite-driver-contract.md`。
SQLite 子路径与根入口一样不读取数据库全局，也不包含平台驱动。

## 幂等与崩溃语义

Host 在调用 Port 前先持久化 intent，再标记 `uncertain`，最后持久化 response。
Service worker 或应用可能在任意一步终止，因此：

- 每个 Port 必须把 `call.callId` 作为幂等键；相同内容重试只能产生一个逻辑副作用。
- `signer.sign` 必须保存或可重建相同 `callId` 的结果，不能生成第二次独立授权。
- `broadcast.submit` 必须以请求中的业务幂等 identity 去重；不确定时通过
  `broadcast.reconcile` 查询，不能换 ID 盲目重发。
- Authority CAS 必须以 `commitId` 去重。
- 多个 Host 实例必须共享同一 durable Store；lease fencing token 与 CAS 会拒绝陈旧写者。
- `recoverPendingOperations()` 恢复当前冻结 release fingerprint 下的非终态操作，以及终态但
  delivery 仍为 `pending` 的操作。

生产 Transport 可以在创建 Host 时显式设置 `deferDeliveryAcknowledgment: true`。此模式下
Host 返回 completion 时保留 delivery 为 `pending`；Transport 必须先把精确 delivery bytes
写入自己的 durable outbox，再以租约调用 Store 的 `markDeliveryDelivered`，最后才向页面或
远端发送。该确认必须按 delivery identity 幂等。默认值为 `false`，保持直接 Host 调用方的
兼容行为。抑制旧 navigation 的结果时不创建伪 JSON-RPC 响应；只在结果已由可信 Transport
安全退休后确认 Host delivery。

Host 已对 11 个注册操作分别验证 intent 后、effect 后、response 后三类崩溃窗口，
并在 Memory、IndexedDB 与 SQLite 上运行相同 Store contract。SQLite 还覆盖关闭重开、
两连接 100 次精确重放、事务中途失败 rollback、busy 锁、释放后 fencing anchor 与合法
counter rollback ABA。平台 driver 不能把多个 journal 写拆成可见的半完成状态。

## 验证

```bash
npm run test:host
npm run test:host:portability
npm pack ./packages/host --dry-run
```

真实 testnet 广播、Provider/Wallet Standard transport 与正式钱包 UI 属于后续发布门禁；
本包的通过不等于整个钱包已获得生产合规认证。

## License

CC0-1.0。见 `LICENSE`。
