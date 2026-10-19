# TWS-008：`window.Turing` 兼容

- 状态：Draft
- 版本：1.0.0
- 类型：Migration / Non-conformance
- 依赖：TWS-000 至 TWS-007

## 1. 目的

本文定义旧 Turing Wallet Provider 在迁移期的兼容边界。Legacy Adapter 让现有 DApp 继续运行，但它不是 TWS Provider，也不能作为第三方钱包接入 TBC 的新标准。

新 DApp 必须使用 Wallet Standard 和 `tbc:provider`。

## 2. 隔离原则

Legacy Adapter 必须位于 Wallet Host 外层：

```text
window.Turing
      │ old shapes / old errors
      ▼
Legacy Adapter
      │ normalized request + internal request ID
      ▼
Wallet Host / restricted legacy services
```

- Legacy Adapter 不得访问私钥或 Vault。
- 每个旧请求必须生成内部唯一 JSON-RPC ID。
- pending requests 必须按 ID 管理，不能按方法名管理。
- Adapter 必须设置超时，并在 navigation/session 结束时取消。
- TWS Provider 绝不能根据旧行为改变标准结果或错误。

## 3. 顶层方法映射

| 旧方法 | 迁移行为 |
| --- | --- |
| `connect` | 调用 TBC 账户授权并组装旧 `{ tbcAddress }` 对象 |
| `disconnect` | 调用 `tbc_disconnect` 并撤销当前 Legacy 会话授权 |
| `isConnected` | 根据当前 Origin 已授权账户返回 boolean |
| `getAddress` | 从标准 TBC 账户组装旧 `{ tbcAddress }` 对象 |
| `getPubKey` | 从 `tbc_getAccount.publicKey` 组装 `{ tbcPubKey }` |
| `getInfo` | 从 Wallet Standard metadata 与 capability 组装旧结果 |
| `getNetwork` | 将 TBC Chain ID 映射为旧 `{ network: "tbc", type }` |
| `sendTransaction` | 按第 4 节映射或执行受限 Legacy operation |
| `signMessage` | 使用第 5 节旧 Bitcoin magic 签名配置 |
| `sendBatchRequest` | 将旧请求列表规范化成一次标准 `tbc_signWorkflow`；旧结果/错误语义只在 Adapter 映射 |
| `signTransaction` | 映射到标准 reviewed-transaction 能力；旧矩阵和 `sigs` 仅为 DTO |
| `signAssociatedTransaction` | 映射到标准关联交易图；旧 source/inputs/outputs/txraws 仅为 DTO |
| `encrypt` / `decrypt` | 映射到标准 Workflow crypto step；旧字符串字段只在 Adapter 转换 |

TBC Legacy 不暴露其他网络的命名空间或空接口。多链钱包的其他 Provider 独立注册与授权。

## 4. 旧交易 flag

| Legacy flag | 新语义或内部行为 |
| --- | --- |
| `P2PKH` | `tbc.transfer` |
| `COLLECTION_CREATE` | `tbc.collection.create` |
| `NFT_CREATE` | `tbc.nft.mint` |
| `NFT_TRANSFER` | `tbc.nft.transfer` |
| `FT_MINT` | `tbc.ft.create` |
| `FT_TRANSFER` | `tbc.ft.transfer` |
| `FT_MERGE` | 内部 `maintenance.ft` |
| `POOLNFT_MINT` | 内部 `legacy.pool.mint`；新 DApp 使用 `tbc.pool.create` |
| `POOLNFT_INIT` | 内部 `legacy.pool.initialize`；新 DApp 使用 `tbc.pool.create` |
| `POOLNFT_LP_INCREASE` | `tbc.pool.liquidity.add` |
| `POOLNFT_LP_CONSUME` | `tbc.pool.liquidity.remove` |
| `POOLNFT_LP_BURN` | `tbc.pool.ftlp.burn` |
| `POOLNFT_SWAP_TO_TOKEN` | `tbc.pool.swap.exactTbcForToken` |
| `POOLNFT_SWAP_TO_TBC` | `tbc.pool.swap.exactTokenForTbc` |
| `POOLNFT_MERGE` | 内部 `maintenance.poolFt` |
| `FTLP_MERGE` | 内部 `maintenance.ftlp` |
| `STABLECOIN_TRANSFER` | `tbc.stablecoin.transfer` |
| `STABLECOIN_MERGE` | 内部 `maintenance.stablecoin` |

旧字段转换规则：

- `satoshis`、`tbc_amount`、`ft_amount` 和 `lpCostAmount` 在验证后转换为最小单位字符串。
- 超过 JavaScript safe integer 的值必须原本就是 string，否则拒绝。
- `domain` 为 deprecated；Adapter 接受但必须忽略，由钱包选择网络 endpoint。
- `poolNFT_version` 只接受当前生产支持的 v2；不能静默执行 v1。
- `serviceFeeRate` 不能覆盖链规则；不一致时返回旧格式错误。
- `serverProvider_tag` 和已经发布过的 `serviceProvider_flag` 别名都必须在 Adapter 输入边界识别，并规范化为一个内部字段。

## 5. Legacy Message Signature

旧 `signMessage` 保持：

```text
magic = "Bitcoin Signed Message:\n"
```

返回结构必须兼容历史字段：

```json
{
  "address": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "maddress": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "pubkey": "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  "sig": "IN34ok11cGo4HKR93qn7ViX27Euw23REsqRODKIW1vc5Yhh0px8FtxwXv5C71vTtxYuS/SjcpkR+L8nS0M5JQkc=",
  "message": "original-or-mutated-message"
}
```

Adapter 可以同时返回历史别名，但必须保证同义字段内容完全相同。

该签名不能标记为 TWS Message 或 Typed Data signature。新 TWS 方法不得自动降级到 Bitcoin magic。

## 6. Raw / Associated Signing 迁移

旧 `signTransaction` 和 `signAssociatedTransaction` 暴露 raw transaction、输入金额、scriptPubKey、脚本模板和合约版本。Adapter 必须把它们转换为标准 reviewed / associated transaction request；标准执行路径重新获取可信材料、解析资产影响、绑定预览与批准，并校验签名或 finalized transaction 结果。

迁移期实现必须：

- 旧 DTO 和错误形状只在明确的 Legacy Adapter 中注册；
- 对 verified Origin 使用独立 allowlist 或风险策略；
- 每次展示完整交易预览并获得批准；
- 验证输入属于授权账户和已知合约模板；
- 拒绝未知 script type、未知 sighash 和任意脚本模板；
- 不允许快速签名 grant 自动批准；
- 标准 capability 以标准 step / 类型公布，不能暴露 Legacy 方法名或允许 DApp 选择兼容 profile；
- 在调用方迁移完成后按 TWS-010 退出。

第三方钱包不需要实现这些方法，仍可通过 TWS 合规。

## 7. Legacy Batch

旧 `sendBatchRequest` 保留 1 至 5 个请求和历史返回数组。允许的方法固定为 `sendTransaction`、`signTransaction`、`signAssociatedTransaction`、`signMessage`、`encrypt`、`decrypt`；同一方法可以重复，且不使用业务配方白名单。Adapter 必须把完整列表转换为一次 `tbc_signWorkflow`，使用 `failureMode: "continue-independent"`，并由标准 WorkflowPlan、权限交集和 Approval Binding 覆盖全部子项、review、material、依赖、Origin、session、navigation、Chain 和 Account。

对于旧 `dependsOn`：

- 仅 `signMessage` 可以声明依赖，且只引用紧邻前一步的交易结果；
- 只允许把前一步 txid 数组注入消息 JSON 的一个经校验顶层字段；字段名必须匹配安全标识符且拒绝 `__proto__`、`constructor`、`prototype`；
- 必须使用结构化 JSON parse/validate/update，不能使用文本替换；
- 注入后仍使用 Legacy Bitcoin magic；
- 依赖来源失败或没有 txid 时不得执行依赖步骤；不依赖该失败结果的后续步骤按历史语义继续，并在相应位置返回 `{ error }`；
- `sendTransaction` 在 Legacy batch 内必须 `broadcastEnabled: false`；所有 merge 变体禁止进入 batch；
- 兼容结果仍保持输入顺序的旧数组和逐项 `{ error }` 语义。

旧 Bitcoin magic 只能由钱包私有的 `handleLegacyWorkflowRequest` 选择；页面不能调用该方法，也不能通过公开 `tbc_signWorkflow` 的字段选择兼容签名 profile。Raw `sigs`、associated `txraws` 和 crypto 字符串结果均从标准 step result 映射，不允许 `executeApproved`、任意函数回调或第二条钱包业务编排路径。

新 DApp 必须使用 `tbc_signWorkflow` / `tbc_signPreparedWorkflow` 的标准 1–5 step 能力，不能继续创建 Legacy batch。普通标准请求默认仍为 `atomic`；只有显式 `continue-independent` 才返回标准 failed/skipped step，Legacy Adapter 再把它映射成逐项 `{ error }`。

历史 FT-deposit、P2PKH-deposit 和 associated-deposit 三个硬编码双步骤 fallback 只允许作为 Mobile 切换期间的迁移暂态。它们不得被描述为完整通用批次能力；Mobile 安装标准批次 Adapter 并通过真实兼容验收后必须删除。

## 8. 返回与错误兼容

Legacy Adapter 必须保持已发布行为：

- 业务失败解析为 `{ error: string }`，而不是 Promise rejection；
- `broadcastEnabled: true` 返回 `txid`；
- `broadcastEnabled: false` 返回 `txraw`；
- 历史多交易结果使用逗号拼接，顺序固定；
- Merge 请求由钱包广播，且不能进入 Legacy batch；
- 用户拒绝保持旧错误文本和结构，同时内部记录标准 `4001`；
- 旧字段大小写和已发布别名保持可读。

这些规则只适用于 `window.Turing`。标准 Provider 必须使用数组、结构化错误和 Promise rejection。

## 9. Legacy 事件

Adapter 在已连接期间继续发出：

- `TuringAccountChanged`
- `TuringNetworkChanged`
- `TuringResponse`

事件数据必须从已经提交的标准 Wallet Host 状态生成。Adapter 不得要求新 Provider 发出这些事件。

## 10. DurianSwap P0 兼容

退出 Legacy 前必须保存并通过以下精确行为向量：

- 买入：P2PKH sign-only + txids message signature。
- 卖出：FT transfer sign-only + txids message signature。
- LP increase / consume sign-only。
- Pool mint 的有序多交易 raw 结果和后续 init。
- FT create 的钱包广播路径。
- 后端对收款人、金额、合约、txid 和订单签名的验证。

旧前端类型声明的差异也必须测试，包括 connect shape、`pubKey/pubkey`、encrypt/decrypt、签名数组和 service-provider 字段别名。

## 11. 弃用约束

Legacy Adapter 的弃用必须遵循 TWS-010。未通过双协议灰度、后端双验证和真实调用量审计前，不得强制删除。

Legacy Adapter 永远不能成为新标准的规范性来源。旧行为与 TWS 冲突时，只能在 Adapter 边界保留，不能污染 TWS Core。

## 12. Draft.2 Adapter 隔离

Legacy Adapter 必须把每项旧调用规范化为同一 `TwsCore.start` / `resume` checkpoint 生命周期；交易请求仍必须执行 plan → approval binding → `signer.sign` → finalize。Adapter 可以把最终 Provider rejection 翻译成历史 `{ error }` shape，但不能调用私有高层交易函数跳过 Approval、Signer、finalize、Port replay 或取消检查。

`execute(request)` 不属于 TWS 公共 Core 接口。官方钱包内部如保留高层 execute 兼容器，只能作为 adapter implementation detail，不能进入 Schema、registry、第三方 Host 契约或 capability。

同理，私有 `wallet-vault/1` 只能存在于某个 Wallet Host 的受信任实现内部，不得成为 TWS 公共接口，也不得出现在 Port params、checkpoint、Approval Receipt、测试向量或 DApp 返回值中。
