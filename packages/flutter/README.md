# TBC Flutter 钱包接入

这个包使用 Dart 编排和配对的 Rust Engine／Signer。交易、取数、审批绑定和 Legacy 映射由 Kit 提供；钱包提供账户、审批界面与 Vault。

## 安装

将完整包放到项目旁，通过 `pubspec.yaml` 的 `path` 依赖引用 `tbc_kit_flutter_dart`。不要单独拷贝原生库，也不要混用其他版本的页面脚本或 Engine。WebView 使用 `flutter_inappwebview: 6.1.5`。

Android 当前提供 API 26 及以上的 arm64 库，并要求现代 Android System WebView。应用的 `packaging.jniLibs.useLegacyPackaging` 设为 `true`，并在应用的 `packaging.jniLibs.keepDebugSymbols` 保留 `**/libtbc*.so`，避免二次剥离改变已固定的库。使用 Java 17。

iOS 设置最低 15.0，提供 arm64 真机及模拟器库。执行 `pod install` 后，运行包内 `ruby tool/install_ios.rb <应用的 ios/Runner.xcodeproj>`，为应用增加最后一个构建步骤。它验证嵌入的库只发生 Apple 重签名，生成运行时精确哈希。更改 Pods 装配后重跑一次该命令。不得删掉校验或直接把运行时自算的哈希当期望值。

最低版本是构建目标。接入后请按钱包实际支持的设备和系统范围确认兼容性。

## 钱包需要提供的接口

在 Swift／Kotlin 注册 `TbcPartnerWalletHost`，参考 `example/ios` 与 `example/android`。这些模板不含账户、私钥和自动批准，必须连接自己的钱包后才能执行交易。

- `NativeAccountSource`：当前选中账户、压缩公钥、网络、解锁状态和递增 revision。锁定、切换账户、改变可签名账户时，先更新 revision，再调用 `walletStateChanged()`。
- `NativeApprovalPresenter`：展示 Kit 的可信 review，包括来源、账户、网络和操作内容。用户明确同意后回调；返回一个可重复调用的关闭句柄。不要自动批准。
- `NativeDigestSigner`：对给定 32 字节摘要直接签名，不加前缀、不再次哈希。实际使用密钥之前，尤其密码／生物识别等待之后，必须调用 `requireCurrent()`。只返回签名，不返回私钥。
- `NativeBie1Executor`：需要 `encrypt/decrypt` 时提供钱包私有 BIE1 适配器。它不是普通摘要签名，不能用签名结果代替；省略时不会假装支持。

签名格式为 `compact64`（32 字节 r 加 32 字节 s，low-S）或 `compact65-recoverable`（头字节 `31 + recoveryId`，再加 r/s）。Kit／Rust 负责交易 DER 和 sighash 标记，钱包不要再添加。恢复 ID 不是 Ethereum 的 chainId 编码 v；适配时必须核对现有 web3dart 返回形式。

现有钱包正式派生路径为 `m/44'/236'/0'/1/0`。账户和找零使用选定的同一地址；不要自行切换到 EVM 派生路径。SDK 不派生或保存合作方密钥。

Flutter 导入 `package:tbc_kit_flutter_dart/packaged_wallet.dart`，先完成原生注册，再通过 `tbcPackagedComputeLibrary()` 与 `TbcFlutterWallet.open()` 打开钱包。`example/lib/partner_browser.dart` 展示空白页挂载、验证后导航及关闭流程。原生和 Dart 两侧的网络、profile、自定义 API trustId 必须一致。模板使用测试网；主网须由钱包配置显式选择。

原生 Flutter 钱包页面使用 `wallet.openActions()`；查询和金额工具从 `queries.dart` 导入。详见 [原生页面接入](NATIVE_WALLET.md)，页面模板为 `example/lib/partner_wallet_page.dart`。两种入口共用交易执行器、原生审批和受控签名，不需要另外实现交易逻辑。

进入后台调用 `suspendViews()`；Flutter engine 销毁时调用 `dispose()`。不要把页面 URL、账户声明或 JavaScript 布尔值当成原生授权。

## 默认边界

Legacy 默认开启，关闭时两端同时配置 `legacy: false`。Legacy 与新标准共享执行通道，但权限分别存储。普通只签名保持会话内状态；广播的不确定提交保留必要记录，先查链再决定后续动作，不盲重发。

Pool2 LP6 总费率为 3.3%，其中 LP 2%、服务方 1.3%。新 AMM 使用池子已承诺的自定义费用配置；不要从单次调用覆盖费率。
