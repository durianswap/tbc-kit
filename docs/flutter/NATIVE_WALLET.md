# Flutter 原生钱包页面

同一个 `TbcFlutterWallet` 可同时服务 DApp WebView 与 Flutter 原生页面。原生页面通过 `openActions()` 调用已有 Standard 执行器，不需要隐藏 WebView，不需要自行编写取数、交易构建或签名流程。

## 接入顺序

1. 按 `INTEGRATION.md` 注册原生账户、审批、Vault 签名回调及所需广播能力，打开 `TbcFlutterWallet`。
2. 调用 `wallet.openActions()`，保留会话供当前原生钱包流程复用。
3. 首次明确请求这个原生入口所需的权限。原生入口的权限与 DApp 权限隔离；授权不是交易批准。每个交易或工作流仍走自己的原生审批。
4. 页面退出调用 `actions.dispose()`。钱包锁定、账户变化、应用挂起仍按原生接线说明通知 Host；挂起失效的会话需重新打开。

```dart
final actions = await wallet.openActions();
await actions.requestPermissions({
  'tbc_accounts': {'chains': [actions.network.chainId], 'maxAccounts': 1},
  'tbc_signTransaction': {'chains': [actions.network.chainId]},
  'tbc_sendTransaction': {'chains': [actions.network.chainId]},
});

final request = actions.transactionRequest(
  intent: {
    'version': '1.0',
    'type': 'tbc.transfer',
    'to': recipientAddress,
    'amount': parseTbcDisplayAmount('1.25', tbcAtomicDecimals),
  },
  constraints: {'maxFee': walletConfiguredMaxFeeAtomic},
);
final result = await actions.sendTransaction(request);
```

金额与最大手续费均使用最小单位整数字符串。TBC 精度为 6；代币使用其实际精度，不要统一当作 6。广播仅在原生 Host 已配置广播能力时可用。广播结果表示提交结果，不保证已经确认；提交不确定时先查询，不能直接重复发送。

## 业务入口

| 调用 | 用途 |
|---|---|
| `signTransaction` / `sendTransaction` | 钱包构建并签名；后者还负责提交 |
| `signPreparedTransaction` / `sendPreparedTransaction` | 校验外部构建材料后签名；后者还负责提交 |
| `signWorkflow` / `sendWorkflow` | 整批业务请求共用一次批准，复用已有预取和执行规则 |
| `signPreparedWorkflow` / `sendPreparedWorkflow` | 外部准备的整批材料 |
| `signMessage` / `signTypedData` | 普通消息与结构化消息签名 |
| `getCapabilities` / `getAccounts` | 当前已注册能力、已授权账户 |
| `request(method, params)` | 其余已支持的 Standard 方法；不接受原生私有命令 |

业务请求和返回值与对应 Standard Provider 方法一致。FT、NFT、稳定币、AMM、LP 等使用同一个交易入口，按 `intent.type` 选择能力，不复制另一套业务实现。构造请求时可用 `transactionRequest(intent: ..., constraints: ...)` 补齐当前账户、链和请求版本；它只生成请求，不私自补查询或签名。

各业务的必填参数、可选字段、数量单位、返回值和调用配方见 [Dart 业务调用](BUSINESS_CALLS.md)。交付根目录 `examples/` 中的两个 Dart 文件可以复制到钱包工程，直接调用本包公开接口；无需引入内部 `src/` 模块。

## 查询与金额工具

```dart
import 'package:tbc_kit_flutter_dart/queries.dart';

final queries = TbcQueryClient(network: actions.network);
final balance = await queries.balanceByAddress(actions.account.address);
final token = await queries.ftInfo(contractId);
final transaction = await queries.inspectTransactionById(txid);
queries.close();
```

查询入口包含节点信息、余额、UTXO、FT/稳定币持仓与资料、NFT/集合资料、池资料、交易原文和 decode。每次调用只执行对应查询，不自动轮询，不为显示余额扩大交易取数。自定义 `read` 回调必须绑定同一个网络。

`inspectTransactionById` 使用一次 decode 查询和已有本地解析器校验原文与 txid；`confirmations == null` 表示未知，`0` 表示未确认，不能当作到账证明。`inspectTbcTransaction` 只做本地解析。收款人、资产和数量是否符合预期，需要业务另行核对。

`parseTbcDisplayAmount` / `formatTbcAtomicAmount` 使用整数精确转换，支持 0–18 位精度，超出精度拒绝而不是四舍五入。

## 页面示例

复制包内 `example/lib/partner_wallet_page.dart`，传入已有 `wallet` 与钱包设置的 `maxFeeAtomic`。示例包含原生入口授权、收款地址/金额输入、转账审批及手动余额查询，没有测试密钥，也不会自动批准。钱包自己决定布局、密码/生物识别和审批样式；Kit 提供校验后的审批内容与执行流程。

每个 `TbcFlutterWallet` 同时保留一个原生操作会话。不要把 `TbcWalletActions` 或私有 MethodChannel 暴露给网页 JavaScript；网页继续使用已验证的 Provider/WebView 通道。
