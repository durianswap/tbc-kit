# NFT 批量转移

使用已接入钱包的 `TbcWalletActions`。同一批可发送不同 NFT，支持当前 TBC721 和受支持的历史 NFT；资产版本由已验证的交易材料识别，无需调用方指定。

```dart
final request = actions.transactionRequest(
  intent: {
    'version': '1.0',
    'type': 'tbc721.batchTransfer',
    'transfers': [
      {'contractId': firstNftId, 'to': firstRecipient},
      {'contractId': secondNftId, 'to': secondRecipient},
    ],
  },
  constraints: {'maxFee': '10000'},
);
final signed = await actions.signTransaction(request);
// 若由钱包提交，改用 actions.sendTransaction(request)，不要先签后再重调发送。
```

`maxFee` 使用 TBC 最小单位，覆盖整批实际网络手续费。每批 1–100 个不同 NFT，不能重复填写同一 `contractId`；依赖交易和必要归集也受交易数量、输入及数据体积限制。

当前 TBC721 的单个转移项可包含 `payment: {'to': address, 'amount': '1000'}`，表示随该 NFT 一同支付 TBC 最小单位金额；历史 NFT 不支持这一参数。钱包审批显示每个 NFT、收款人、附带付款和整批费用上限。

钱包仅请求一次整批审批，材料准备与审批并行；每个签名仍绑定到已批准请求及 Engine 验证的交易。多个 NFT 不代表链上原子交易。若提交出现失败或结果不确定，应先用返回的交易标识及查询接口核对，不要重发整个请求。

网页 DApp 通过已有 Provider 的 `tbc_signTransaction` 或 `tbc_sendTransaction` 传入相同请求，无需新增接口名。Prepared 方式使用对应 Prepared 方法，并提供与整批意图匹配的 proposal。
