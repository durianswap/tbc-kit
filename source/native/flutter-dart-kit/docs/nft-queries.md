# NFT 铸造状态查询

Flutter 页面可直接复用包内的集合解析器，不需要自行实现锁定脚本解析。

```dart
import 'package:tbc_kit_flutter_dart/packaged_wallet.dart';

final nft = await openTbcPackagedNftReader(
  network: TbcNetworkConfiguration.official(TbcNetwork.testnet),
);
try {
  final status = await nft.getMintStatus(
    collectionId: collectionId,
    address: selectedAddress,
  );
  // 按 status 字段处理 available / exhausted / not-owner / unknown。
} finally {
  nft.close();
}
```

`availableSlots` 是指定地址当前可见的铸造槽位，不是 NFT 转账余额，也不构成槽位预留或签名授权。

- `available`：查询覆盖完整，至少一个可用槽位。
- `exhausted`：查询覆盖完整，没有可用槽位。
- `not-owner`：指定地址不是集合铸造槽位的持有人。
- `unknown`：原文或状态查询不可用，或部分槽位没有明确结果。可展示已知槽位，但不能把缺失项当成可用项。

索引未提供的槽位自动按每次最多 25 个查询，最多 4 个请求同时进行。同一次查询不会重复请求同一输出。经过原文校验的不可变集合布局会复用，UTXO 状态每次重新查询；同一读取器中的并发相同查询会合并。

这个接口不申请账户权限，不弹交易审批，不取手续费 UTXO，不广播，不自动轮询或重试。实际铸造仍须通过钱包正常的构建、审批、校验和签名流程。页面应复用读取器，并在退出时调用 `close()`。

纯 Dart 服务可使用 `queries.dart` 中的 `Tbc721Reader`，注入可信的 `inspectCollection` 适配器。该适配器必须调用已固定版本的 Kit Keyless `inspectTokenMaterial`（`phase: inspectCollection`），不得直接相信 DApp 自报的集合布局。

## 升级原生包

更换依赖目录或包版本后，重新执行包内 `tool/install_ios.rb`，再运行 CocoaPods 和构建，以刷新宿主工程中的原生完整性检查路径。不要沿用指向旧解压目录的脚本路径，也不要删除完整性检查来绕过构建错误。
