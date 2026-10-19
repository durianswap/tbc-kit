# Dart 业务调用与参数

本页用于把钱包的转账、资产和交易页面接到 Kit。先按 [接线教程](INTEGRATION.md) 打开钱包，再按 [原生页面说明](NATIVE_WALLET.md) 获取 `TbcWalletActions`。WebView 中的 DApp 继续使用 Provider，不要把 Dart 原生对象注入网页。

`examples/business_intents.dart` 是请求参数配方，`examples/wallet_calls.dart` 是公开方法调用示例。复制到钱包的 `lib/tbc/` 后按需调用；它们不是新的 SDK，也不负责查询、组装交易、校验或签名。

## 最短调用流程

```dart
import 'package:tbc_kit_flutter_dart/packaged_wallet.dart';
import 'package:tbc_kit_flutter_dart/queries.dart';
import 'tbc/business_intents.dart';
import 'tbc/wallet_calls.dart';

final actions = await wallet.openActions();
// 在用户启用本钱包的 TBC 转账功能时请求；不必每次发送重复申请。
await enableTransfers(actions);

// 在用户点击发送后调用。金额来自表单；精度来自对应资产资料。
final result = await sendTokenFromDisplay(
  actions,
  contractId: selectedTokenContractId,
  recipient: recipientAddress,
  displayAmount: enteredAmount,
  tokenDecimals: selectedTokenDecimals,
  maxFeeAtomic: walletConfiguredMaxFeeAtomic,
);
// 页面退出或结束该操作会话时：await actions.dispose();
```

将 `stablecoin: true` 传给 `sendTokenFromDisplay` 可转移稳定币。TBC、NFT、AMM 等使用下面的配方构造 `intent`，再传给同一个 `sendIntent`。单独做一次转账不需要包装成 workflow。

## 公共参数规则

| 参数 | 填法 |
| --- | --- |
| 金额、数量、`maxFee` | 最小单位的非负十进制整数字符串；转移数量为正。不要传 `double` 或科学计数法 |
| TBC 精度 | 6；`parseTbcDisplayAmount('1.25', 6)` 得到 `'1250000'` |
| 代币精度 | 使用该合约资料中的精度。按网络和合约 ID 缓存不可变资料，不缓存 UTXO 作为可花依据 |
| `contractId` / `poolContractId` | 当前网络的 64 位小写十六进制合约 ID，不是名称、symbol 或地址 |
| `from` / `chainId` | `actions.transactionRequest` 自动采用当前账户和网络 |
| `constraints.maxFee` | 钱包允许的本操作总网络手续费上限，单位为 TBC 最小单位；不是 AMM 或订单费率 |
| `constraints.expiresAt` | 可选 UTC ISO 8601 时间；可直接用 `DateTime.now().toUtc().add(...).toIso8601String()`，支持毫秒 |
| `constraints.inputOutpoints` | 可选精确输入限制：`[{'txid': '...', 'vout': 0}]`；传入后不是“优先选择”，必须满足实际资产和手续费输入需求 |

配方省略未提供的可选字段，不传 `null`。Kit 校验请求、资产身份、费用、签名与账户权限；配方本身不是校验器。

## TBC 与代币

下表列出配方函数及对应 `intent.type`。参数均为 Dart 命名参数，完整签名见示例文件。

| 配方 | `intent.type` | 必填参数 | 可选参数 |
| --- | --- | --- | --- |
| `tbcTransfer` | `tbc.transfer` | `to, amount` | 无 |
| `mergeTbc` | `tbc.maintenance.merge` | 无 | 精确输入放入请求的 `constraints` |
| `createToken` | `tbc20-standard-create` | `name, symbol, decimals, initialSupply` | `to` |
| `transferToken` | `tbc20.transfer` | `contractId, to, amount` | `payment` |
| `transferTokenToMany` | `tbc20.transfer` | `contractId, receivers` | 无 |
| `mergeToken` | `tbc20.merge` | `contractId` | 无 |
| 上述转移和合并传 `stablecoin: true` | `tbc20Stablecoin.transfer` / `tbc20Stablecoin.merge` | 同上 | 转移可带 `payment` |

`receivers` 中每项为 `{'to': address, 'amount': atomicAmount}`，不能同时传单收款人的 `to/amount`。TBC20 最多 8 个收款项；当前稳定币模板最多 7 个，历史模板的实际容量以 Engine 校验为准。可选 `payment` 是额外的 TBC 付款 `{'to': address, 'amount': atomicAmount}`，不是矿工手续费。

创建代币时 `decimals` 为 0–18 的整数，`initialSupply` 已乘过精度且不超过 `9223372036854775807`。名称与 symbol 的 UTF-8 字节数合计不超过 53；symbol 使用非空可打印 ASCII 字符。不要把 UI 字符数当作 UTF-8 字节数。

```dart
final intent = createToken(
  name: tokenName, symbol: tokenSymbol, decimals: decimals,
  initialSupply: parseTbcDisplayAmount(displaySupply, decimals),
);
final result = await sendIntent(
  actions, intent: intent, maxFeeAtomic: walletConfiguredMaxFeeAtomic,
);
```

转移和合并使用统一方法，Kit 根据实际合约材料选择新旧资产实现；不要仅凭 API 展示名称手动替换模板。

## NFT

| 配方 | `intent.type` | 必填参数 | 可选参数 |
| --- | --- | --- | --- |
| `createCollection` | `tbc721-standard-create-collection` | `name, description, supply, media` | `to` |
| `mintNft` | `tbc721-standard-mint` | `collectionId, item` | 见 item |
| `mintNfts` | `tbc721-standard-batch-mint` | `collectionId, items` | 每项见下文 |
| `transferNft` | `tbc721.transfer` | NFT 的 `contractId, to` | `payment` |

集合 `supply` 为 `'1'`–`'2000'`。`nftItem` 必填 `slot, name, symbol, description, attributes`，可选 `media, to`。`slot` 从 1 开始，必须是该集合未铸造的有效位置；批次不重复，最多 32 项。`attributes` 为 `{'traitType': '...', 'value': ...}` 的列表，可以为空；value 为字符串、布尔或安全整数。`media` 可用 `uriMedia('https://...')`，也支持 `ipfs://`、`ar://`。不要把集合 ID 当作已铸造 NFT 的 ID。

```dart
final item = nftItem(
  slot: selectedSlot, name: nftName, symbol: nftSymbol,
  description: description, attributes: [],
  media: uriMedia(mediaUri), to: recipientAddress,
);
final result = await sendIntent(
  actions,
  intent: mintNft(collectionId: collectionId, item: item),
  maxFeeAtomic: walletConfiguredMaxFeeAtomic,
);
```

## AMM 与 LP

新建池使用 `createAmm`。后续操作使用能识别实际模板的统一入口。

| 配方 | `intent.type` | 必填参数 | 可选参数 |
| --- | --- | --- | --- |
| `createAmm` | `tbc-amm-create` | `ftContractId, feePolicy, lpTimelock` | `controllers, serviceProviderTag` |
| `addLiquidity` | `amm.addLiquidity` | `poolContractId, budgetAsset, amount, minimumLpAmount` | `initialFtAmount, maximumTbcAmount, maximumFtAmount, lockTime, receiver, poolStateHash` |
| `swap` | `amm.swap` | `poolContractId, direction, amount, minimumOutput` | `receiver, poolStateHash` |
| `removeLiquidity` | `amm.removeLiquidity` | `poolContractId, lpAmount, minimumTbcAmount, minimumFtAmount` | `receiver, poolStateHash` |
| `transferLp` | `tbc20Lp.transfer` | `poolContractId, to, amount` | 无 |
| `lockLp` | `tbc20Lp.lock` | `poolContractId, amount, lockTime` | 无 |
| `unlockLp` | `tbc20Lp.unlock` | `poolContractId` | 精确输入放入请求的 `constraints` |
| `mergeLp` | `tbc20Lp.merge` | `poolContractId` | 同上 |
| `mergePoolTokens` | `amm.mergeToken` | 历史 Pool2 的 `poolContractId` | 同上 |
| `burnPoolLp` | `tbc20Lp.burn` | 历史 Pool2 的 `poolContractId` | 同上；不是退出流动性操作 |

`feePolicy` 必须包含 `lpFeeRate, taxFeeRate, serviceProviderFeeRate, protocolFeeRate, feeAddress`。四个费率都是整数 bps，`1 = 0.01%`，每项 0–9999，合计小于 10000；`feeAddress` 即使零抽水也必须合法。此格式不使用 `lpPlan`、`totalFeeBps` 或 `serviceFeeAddress`。费用配置在创建时确定，后续操作从链上池恢复，不能在 swap 请求覆盖。

合法的零费率配置不保证任意金额都能交换：当前合约要求按整数舍入后的留存费用为正，小额交易也可能被拒绝。UI 应展示实际报价与拒绝原因，不要为了通过而取消校验。

`controllers` 为 1–5 个不重复的公钥 Hash160（40 位小写十六进制），不是地址或私钥；省略时采用默认规则。需要独立控制账户时，在完整请求上附加 `signingRoles: [{'role': 'pool-controller', 'accountId': ...}]`，并实现原生角色账户解析和审批；这不能通过网页伪造账户描述获得授权。

首次加池用 `budgetAsset: 'tbc'`，`amount` 是 TBC 最小单位，另提供初始代币数量 `initialFtAmount`。已有池子使用 `'tbc'` 或 `'ft'` 表示预算资产。`lpTimelock: true` 的池子，加池应明确 `lockTime`，`'0'` 表示本次不锁定。最大投入和最小得到的数量应来自用户认可的报价与滑点设置，不要统一填 0。

买入使用 `direction: 'tbc-to-ft'`，卖出为 `'ft-to-tbc'`；`amount` 是输入资产数量，`minimumOutput` 是输出资产最小可接受数量。`receiver` 省略时为当前账户。`poolStateHash` 只传 Kit 认可的实际状态承诺，不能用任意 API JSON 自行哈希代替。

```dart
final intent = swap(
  poolContractId: selectedPoolId, direction: 'ft-to-tbc',
  amount: parseTbcDisplayAmount(displayTokenAmount, tokenDecimals),
  minimumOutput: minimumTbcAtomicFromQuote,
);
final result = await sendIntent(
  actions, intent: intent, maxFeeAtomic: walletConfiguredMaxFeeAtomic,
  expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 2)).toIso8601String(),
);
```

LP 转移、锁定、解锁需合约模板支持；不要把历史 Pool2 当作新 LP 模板。合并是维护操作，不能替代正常转账或减池，也无需每次交易前主动调用。

## 时间锁与 HTLC

| 配方 | `intent.type` | 参数与条件 |
| --- | --- | --- |
| `timelockTbc` | `tbc-timelock-lock` | `amount, lockHeight`；锁到当前账户，区块高度为 1–499999999 的整数字符串 |
| `unlockTbc` | `tbc-timelock-unlock` | 到期后，在请求 `constraints.inputOutpoints` 指定锁定输出 |
| `lockHtlc` | `tbc-htlc-lock` | `to, amount, hashlock, lockTime`；hashlock 为原像的 SHA256，小写 64 位 hex |
| `claimHtlc` | `tbc-htlc-claim` | `preimage` 为原像字节的小写 hex；不是 hashlock |
| `refundHtlc` | `tbc-htlc-refund` | 到期后由合法退款账户发起，不需要原像 |

HTLC 的 TBC 操作不传 `assetStandard/contractId`。领取和退款的锁定输入放在请求的 `constraints.inputOutpoints`。代币 HTLC 要同时传 `assetStandard`（`tbc20-standard` 或 `tbc20-stablecoin`）及 `contractId`；领取和退款还需 `intent.targetOutpoints` 指向单个实际代币锁定输出，其 `vout` 为 1。普通手续费选择仍交给 Kit。

HTLC `lockTime` 按合约区分区块高度与时间戳；时间戳成熟度依赖链的时间，不以手机时钟强行判断。普通 TimeLock 配方只支持高度。LP 的锁定语义也须以实际模板为准。

```dart
final result = await sendIntent(
  actions,
  intent: refundHtlc(
    assetStandard: 'tbc20-standard', contractId: tokenId,
    targetOutpoints: [outpoint(lockTransactionId, 1)],
  ),
  maxFeeAtomic: walletConfiguredMaxFeeAtomic,
);
```

原像不能写入日志、埋点、API 请求或错误上报。claim 的签名原文已经包含原像，即使只签名未广播也应视为敏感；一旦广播，合约领取所需的原像会公开。不要记录完整请求或签名结果。

## LOP 订单

`createOrder` 对应 `tbc-lop-create`，参数为 `market, side, assetA, saleVolume, unitPrice, feeRate, feeRecipient`，代币间市场另需 `assetB`。

- `market: 'native-token'`：`assetA` 填报价代币，不能填 `assetB`。`side: 'sell'` 卖出 TBC；`'buy'` 用报价代币买入 TBC。
- `market: 'token-token'`：`assetA` 填基础资产，`assetB` 填报价资产；sell 卖出基础资产，buy 买入基础资产。
- `orderAsset(standard: ..., contractId: ...)` 中 standard 支持新 TBC20 或新稳定币。
- `saleVolume` 为基础资产最小单位数量；`unitPrice` 和 `feeRate` 使用 `1000000` 定点比例，不是 AMM 的 bps。报价数量按 `floor(saleVolume × unitPrice / 1000000)` 计算；两种代币精度不同时先转换最小单位比例。`feeRate: '10000'` 为 1%。
- `cancelOrder(outpoint(...))` 对应 `tbc-lop-cancel`，只接收一个订单输出，需订单所有者权限。
- `matchOrders(buyOutpoint, sellOutpoint)` 对应 `tbc-lop-match`，接收两笔有效匹配订单；并非任意两笔 UTXO。

```dart
final intent = createOrder(
  market: 'native-token', side: 'sell',
  assetA: orderAsset(standard: 'tbc20-standard', contractId: quoteTokenId),
  saleVolume: tbcAtomicForSale,
  unitPrice: quoteAtomicPerBaseAtomicScaled,
  feeRate: orderFeeScaled, feeRecipient: serviceFeeRecipient,
);
final result = await sendIntent(
  actions, intent: intent, maxFeeAtomic: walletConfiguredMaxFeeAtomic,
);
```

## 一次批准的批次

已有操作只需一次签名请求时，直接调用 `sendTransaction`。业务确需组合交易和消息时，调用一次 `sendWorkflow`，不要先调用各子交易再请求批次。

```dart
await enableTransferReceipt(actions); // 在用户首次启用此功能时授权
final result = await sendWithReceipt(
  actions,
  intent: transferToken(contractId: tokenId, to: recipient, amount: atomicAmount),
  maxFeeAtomic: walletConfiguredMaxFeeAtomic,
  expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 2)).toIso8601String(),
);
```

该配方是转账加结构化回执：`steps` 中交易与回执通过 `dependsOn`、`bindings` 关联；真实 txid 由 Kit 注入回执，应用不用再次请求签名。一批最多 5 步；当前配方只涉及当前账户。不同角色或账户仍需其各自授权。

`failureMode: 'atomic'` 是钱包执行策略，不表示多笔链上交易可以回滚。广播中断或部分提交时不能整批盲重发。`maxTotalFee` 是批次总网络费上限，每个交易步骤也可设置 `constraints.maxFee`。

外部已构建交易使用 `sendPreparedTransaction`，只签不发送则为 `signPreparedTransaction`。必须提供完整 `proposal`，不能只传 raw hex 或把普通请求冒充 Prepared。Prepared 批次使用 `preparedTransaction` 步骤和 `sendPreparedWorkflow`；保留每个 proposal 的原始到期时间、证据和哈希，Kit 会取整批有效期的交集。配套 `sendPrepared` 示例直接复用此入口。

```dart
final result = await sendPreparedBatch(
  actions,
  steps: [
    {
      'id': 'preparedTransfer', 'kind': 'preparedTransaction',
      'dependsOn': <String>[], 'intent': originalIntent,
      'constraints': originalConstraints, 'proposal': preparedProposal,
    },
    {
      'id': 'note', 'kind': 'message', 'dependsOn': ['preparedTransfer'],
      'message': {'encoding': 'utf8', 'data': receiptJsonWithoutTxids},
      'bindings': [
        {'target': 'txids', 'source': {'stepId': 'preparedTransfer', 'output': 'transactionIds'}},
      ],
    },
  ],
  maxTotalFeeAtomic: walletConfiguredMaxFeeAtomic,
  expiresAt: workflowExpiryUtc,
);
```

上例的回执内容必须是 JSON 对象字符串，`txids` 字段可省略或先为空数组；此批次还需 `tbc_signMessage` 权限。多个外部 Prepared 交易不能各自选择同一个尚未花费输入后拼接成批次，构建方需先正确处理依赖和输入冲突。

## 消息与加解密

`signText(actions, text)` 调用普通 `signMessage`；`signTyped(actions, data)` 调用 TBC 的结构化签名。`data` 必须有 `domain, types, primaryType, message`；`domain.chainId` 与当前网络一致。此结构化协议不是 Ethereum EIP-712，不能直接用 EVM 验签规则替代。

首次使用分别请求 `tbc_signMessage`、`tbc_signTypedData` 权限。`encryptText` 和 `decryptText` 还需原生 `NativeBie1Executor` 与 `tbc_crypto` 权限；普通 ECDSA 签名适配器不能代替解密。消息和明文按 UTF-8 字节计算大小，不按中文字符个数计数。

## 返回值与异常

- `signTransaction` 返回签名 bundle，`transactions[]` 含 `txid, rawTransaction, role, dependsOn`；不代表已经广播。
- `sendTransaction` 返回 bundle 摘要，`transactions[]` 含 `txid, status: 'submitted', role, dependsOn`，不返回可直接当作已确认的标记。一个业务可产生多笔交易，不能只处理数组第一项。
- 创建结果有对应 `artifacts` 时，使用其 `contractId / collectionId / poolContractId`；不要把任意第一笔维护交易 txid 当作新资产 ID。
- workflow 结果在 `steps[]` 中按步骤记录结果或错误，交易步骤仍可能包含多笔交易；检查各步状态，不只检查顶层调用是否返回。
- `TbcWalletException` 提供脱敏 `code/message`。用户拒绝、账户切换、会话过期应回到页面等待新的用户操作。对发送失败或超时先核对提交状态，不能自动再次调用发送；txid 可查到也不等于已确认或收款资产正确。

原生页面与 WebView 权限隔离，但复用同一执行器、并行准备和校验。页面不要预先额外读取“所有交易所需数据”，也不要把实时余额、UTXO、池储备长期缓存来替代 Kit 的交易读取。

## 常用查询

```dart
final q = TbcQueryClient(network: actions.network);
try {
  final tokenInfo = await q.ftInfo(tokenId);
  final balance = await q.ftBalanceByAddress(actions.account.address, tokenId);
  final status = await q.inspectTransactionById(txid);
  // 使用上述返回值刷新页面；不要记录原像或完整签名请求。
} finally {
  q.close();
}
```

| 场景 | 方法 |
| --- | --- |
| 节点、余额与 UTXO | `nodeInfo`, `balanceByAddress`, `utxosByAddress` |
| FT 资料、列表、余额 | `ftInfo`, `ftTokenListByAddress`, `ftBalanceByAddress` |
| 稳定币资料、列表、余额 | `stablecoinInfo`, `stablecoinListByAddress`, `stablecoinBalanceByAddress` |
| NFT 与集合 | `nftInfo`, `nftCollectionInfo` |
| 池资料 | `poolInfo` |
| 原文与解析 | `txRaw`, `decodeTransaction`, `inspectTransactionById` |
| 本地金额与原文 | `parseTbcDisplayAmount`, `formatTbcAtomicAmount`, `inspectTbcTransaction` |

查询类返回 API 数据；`inspectTransactionById` 另做本地原文和 txid 一致性检查，不是独立全节点证明。`confirmations` 为 `null` 时未知、`'0'` 时未确认。方法不会自动轮询。查询和交易必须使用同一网络；仅地址格式相同不能证明是同一个网络。
