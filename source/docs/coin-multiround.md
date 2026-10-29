# Coin 多轮规划与钱包接入

适用版本：`@tbc/kit 0.1.0-rc.17` + `0.1.0-rc.17.native.2`。这是新版 `tbc20-stablecoin`（Coin）持有人转账/合并的增量，不把旧 StableCoin 当作 Coin 使用。

## 调用与审批

公开业务意图保持不变：`tbc20-stablecoin-transfer`、`tbc20-stablecoin-merge`。DApp 仍通过 `tbc_signTransaction` / `tbc_sendTransaction`，或者已有 Prepared 入口调用；钱包/后端仍使用已有业务执行器。

输入超过单笔五个 Coin 的限制时，Engine 自动生成 `maintenance → … → primary` 计划；需要归集原生手续费时，再在前面插入 `native-funding-1`。没有提高链上单笔 Coin 输入上限，没有改为旧稳定币协议。

整组只授权一次，但可能有多轮**内部签名任务**。钱包应继续执行既有 `finalize` continuation：签完前序交易、取得真实 txid 后绑定后续输入，直到得到最终 bundle。不要用未签名交易的预览哈希当作可消费 txid，不要对每轮重新弹审批。

审批继续使用 Kit 的可信审批证据和 `projectTbcApprovalPresentation`；复用原来的 Host evidence reader、完整 binding 及输出审阅。Engine plan 的 `preview.assetFlows` 表达业务资产流，`preview.totalFee` 是整组费用；`transactions` 内逐步列出 `id / role / dependsOn / fee`。不要把最终收款摘要当作整个计划的全部输出审阅，也不要跳过 maintenance 输出。

## exact inputOutpoints

`constraints.inputOutpoints` 表示**本次计划必须且只能使用的原始外部输入集合**，同时列出 Coin 输入和原生手续费输入。集合中的每个输入必须有效、属于正确账户且被使用一次；没有“从这些输入里任选一些”的含义。

- 多个指定原生输入由同一计划先归集，归集输出及 Coin 中间输出均留给原持有人。
- 后续中间输出由 `dependsOn`、`deferredInputs` 和 finalize continuation 表达，不需要调用者提前填出它们的 txid。
- 不会静默添加未列出的外部输入，也不会静默丢弃冗余的指定输入。
- 缺少指定材料、输入锁未成熟或不满足确认策略时失败，不把这类情况冒充余额不足。

未指定 exact 集合时，维持原来的自动选择策略。非 exact 原生手续费归集在 RC.16 已有公共 fallback，本次补齐的是 Coin 的 exact 接入与多轮组合，不是重写一套归集器。

## 计划/结果契约

公开 Prepared proposal 延用既有结构：

```text
proposal.payload.transactions[]
  id, role, dependsOn, fee
  kind=fixed: unsignedTransaction
  kind=deferred: unsignedTransactionTemplate + deferredInputs
proposal.payload.estimatedTotalFee
```

以上 `kind` 的精确取值与所有字段以本候选附带的真实 JSON 样例和公开类型为准，不要自己拼装或修改 proposal。输出被修改时，proposal、request、plan、snapshot、policy 和 approval binding 的核对仍会拒绝。

发送结果仍为逐笔 `transactions[{id, role, dependsOn, status, txid}]` 加 `totalFee`。`submitted` 表示已提交，不等于区块确认；后续未提交、拒绝或结果未知不能伪装为整组成功。

复用既有顺序提交、广播 journal 和 reconcile。前序已被节点接受、后序失败/未知时，用原 txid/原操作核对，不重新构造前序，不更换 request ID 盲发整组。已经成功的步骤不能重复提交；未知步骤先消歧。

## 策略、取数与边界

- 单笔仍至多 5 个 Coin 输入 + 1 个原生手续费输入。
- Coin planner 的材料上限为 128 个资产输入；默认 Chain Data 总输入预算也是 128，因此不能理解成“默认必然允许 128 个 Coin 再加手续费”。
- 公共自动手续费归集最多 100 个原生输入；默认整组交易上限 32，调用方的更严格策略仍生效。
- 遵守整组 `maxFee`、`maxBundleTransactions`、金额和到期限制。超限不靠拆分成多个未批准操作绕过。
- `minConfirmations=0` 不引入等一块的门槛。实际已签名前序输出可以作为后续输入，节点拒绝/未知继续按原提交机制处理。
- 全部轮次从同一快照与本地新产生的中间交易规划；复用不可变父交易缓存及并行预取，不为每轮重新请求 API。
- 币量槽位无法形成可缩减合并、超过材料/交易预算等情况仍明确失败，不宣称无限输入支持。

错误沿用现有协议错误码并带具体 path/message：真实余额不足为 `INSUFFICIENT_FUNDS`；材料缺失为 `MISSING_MATERIAL`；身份/祖先无效为对应验证错误；总费超限为 `FEE_CAP_EXCEEDED`；策略禁止多笔/交易数或材料上限为 `INVALID_INPUT`。不新增不兼容的错误枚举。

## 钱包升级要点

1. 同时替换配套 JS、Native 和版本锁；协议 schema 未变，因此 fingerprint 未变，但不能因此继续加载旧 Native 字节。
2. 钱包原本对“Coin 计划大于一笔”的拒绝只能在升级后解除；保留逐笔结果、余额投影、历史、原操作恢复和整组审批。
3. 原有 1～5 输入成功路径仍调用同一单笔构建器；无需新增 UI 或额外读取来使用多轮能力。
4. 此次没有改账户派生路径、签名算法、旧稳定币实现，也没有更新或替换冻结的 Flutter 合作方交付包。

候选附带 `examples/send6.json`、`merge20.json`、`exact-fee.json`（Testnet 实际 Prepared 计划与结果），以及 `engine-plan-six.json`（离线公开材料的 Engine plan/preview）。样例仅用于阅读契约，已花费的输入及过期 proposal 不可重放。
