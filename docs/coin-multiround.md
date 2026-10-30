# Coin 多轮交易

适用于当前配套 [JS 与 Native SDK](installation.md)，处理新版 `tbc20-stablecoin`（Coin）持有人转账与合并，不切换成历史稳定币协议。

## 业务调用不变

继续使用 `tbc20-stablecoin-transfer`、`tbc20-stablecoin-merge` 意图和现有业务执行器。DApp 通过 `tbc_signTransaction`、`tbc_sendTransaction` 或已有 Prepared 入口调用，不增加独立 Provider 方法。

单笔协议限制仍是最多 5 个 Coin 输入和 1 个原生手续费输入。需要更多输入时，Kit 规划多笔 `maintenance → … → primary`；需要归集原生手续费时，在前面加入 `native-funding-1`。最终收款、合约身份、中间输出和找零均受现有校验约束。

## 一次审批与顺序签名

- 用户对整组操作批准一次；审批展示使用可信材料、`projectTbcApprovalPresentation` 和完整绑定校验。
- 一次批准可能包含多轮内部签名任务。通过既有 `finalize` continuation 获取真实已签名前序 txid，再绑定下一笔输入，直到完整 bundle 生成；不要每轮重新弹审批。
- 不要把未签名预览哈希当成可消费的 txid，也不要修改 Kit 生成的 proposal。
- 审阅所有步骤，包括维护交易；`preview.assetFlows` 是业务资产流，`preview.totalFee` 是整组费用，不能用最终收款摘要代替全部输出审阅。

Kit 在同一次规划内复用已验证 Coin 材料和证明引用映射。新的规划、validate、finalize 调用仍各自核对材料及绑定；不引入跨账户缓存，也不增加 API 请求。

## 指定输入

`constraints.inputOutpoints` 是本次计划**必须且只能使用的原始外部输入集合**，包含 Coin 与原生手续费输入，不是“任选其中几个”的候选列表。

多个指定原生输入可先归集，再由后续交易消费。中间输出留给原持有人，通过 `dependsOn`、`deferredInputs` 与 finalize continuation 表达；调用者不需要预先知道这些输出的 txid。每个指定输入只能使用一次，不静默增加或丢弃外部输入。

## 计划与结果

Prepared proposal 的现有结构保持不变：

```text
proposal.payload.transactions[]
  id, role, dependsOn, fee
  kind=fixed: unsignedTransaction
  kind=deferred: unsignedTransactionTemplate + deferredInputs
proposal.payload.estimatedTotalFee
```

精确字段以公开类型和以下样例为准：

- [六个 Coin 输入转账](examples/coin/send6.json)
- [二十个 Coin 输入合并](examples/coin/merge20.json)
- [指定原生手续费输入归集与转账](examples/coin/exact-fee.json)
- [Engine plan 与 preview](examples/coin/engine-plan-six.json)

这些 JSON 是契约样例，不可重放：其中输入可能已花费，proposal 也已过期。

发送结果保留逐笔 `transactions[{id, role, dependsOn, status, txid}]` 和 `totalFee`。`submitted` 只表示已提交，不代表已确认。前序接受、后序失败或未知时，用原 txid 和原操作核对，不重新构造或重发已成功的步骤；未知结果先消歧。

## 预算与错误

- Coin 规划器最多接收 128 个资产输入；默认 Chain Data 总输入预算也是 128，因此默认不能理解为“128 个 Coin 另加手续费输入”。
- 公共自动原生归集最多 100 个原生输入；默认整组交易上限 32，更严格的调用方策略优先。
- 遵守整组 `maxFee`、`maxBundleTransactions`、金额和有效期。策略禁止多笔时明确失败，不拆成多次未授权操作。
- `minConfirmations=0` 不额外要求前序交易先等一块；使用真实已签名前序输出，并按节点接纳结果处理后续提交。
- 多轮共享同一快照、不可变父交易缓存及本地产生的中间交易，不逐轮重复取数。

余额不足为 `INSUFFICIENT_FUNDS`，缺材料为 `MISSING_MATERIAL`，总费用超限为 `FEE_CAP_EXCEEDED`，多笔策略/交易数/材料预算限制为 `INVALID_INPUT`，其他身份和祖先问题保留相应验证错误。错误同时携带具体 path/message，不能统一当作余额不足或网络失败。

钱包升级后可解除旧版“Coin 计划不得多于一笔”的限制，但必须保留整组审批、逐笔结果、余额投影、历史及原操作恢复。账户派生路径和签名算法没有变化。JS 与 Native 的安装配对见 [安装与升级](installation.md)。
