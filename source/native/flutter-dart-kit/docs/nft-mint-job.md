# NFT 自动分批铸造

钱包原生页面通过 `TbcWalletActions.mintNftJob` 执行整份铸造清单。它复用普通 NFT 的材料读取、Engine、原生审批、Signer 和广播执行器，不是额外的交易构建器，也不是新的 Provider 方法。

```dart
final result = await actions.mintNftJob(
  collectionId: collectionId,
  items: [
    for (var slot = 1; slot <= 101; slot++)
      {
        'slot': slot,
        'name': 'NFT $slot',
        'symbol': 'NFT',
        'description': '',
        'attributes': <Map<String, dynamic>>[],
        'to': recipientAddress,
      },
  ],
  limits: {
    'maxTotalFee': maximumFeeAtomic,
    'expiresAt': DateTime.now().toUtc()
        .add(const Duration(minutes: 5)).toIso8601String(),
    'maxItemsPerBatch': 100,
  },
);
```

- 清单支持 1–2000 个不重复的集合槽位。省略 `to` 时使用当前账户，批准前会将实际收款人固化。
- 一次原生审批展示整份清单、收款人和整项任务的费用上限。连接权限授权与交易审批是不同步骤。
- `maxTotalFee` 为原生币最小单位的十进制整数字符串，整项任务共用，不是每个小批重新领取预算。
- `expiresAt` 使用 UTC；Dart 产生的微秒会在本地入口向下截为毫秒，不延长授权期限。页面应使用可滚动清单展示 `NativeReview.steps`，不要将上百项明细拼入不适合长内容的系统警告框。
- `maxItemsPerBatch` 是允许的上限，不承诺实际批次大小。执行器目前以最多 10 个的工作集连续执行，101 个无需调用方手动拆分或重复批准。
- 材料读取与审批并行；任务内复用集合数据和已验证找零，不为每个小批重新查余额或下载相同交易。
- 签名、必要校验和广播仍逐笔检查当前账户、权限与精确绑定。批准不等于无条件签名授权。

## 返回结果

`status` 为 `complete`、`partial`、`stopped` 或 `uncertain`；`minted` 只统计原生广播记录中 `accepted`／`known` 的交易，**不代表链上确认数**。`confirmedSubmissionFee` 是这些已接受提交的费用总额，也不是确认到账的证明。

`batches` 包含每个已执行小批的 `offset`、`count`、`planHash`、状态及交易列表。每条交易有 `txid`、`fee`、`status`，有可恢复广播记录时还包含 `recoveryId`。不会返回私钥或将原始签名材料用作恢复凭据。

发生部分成功或不确定结果时任务停止，不自动重发，不自动开始下一批。保留结果并查询已返回的交易；先消歧，再由用户对剩余槽位发起新任务。关闭页面、切换账户或撤销权限后，旧任务不能继续签名。
