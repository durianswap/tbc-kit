# Flutter 与原生接线教程

本教程使用 `tbc_kit_flutter_dart` 配套包。先完成原生账户、审批和签名适配，再打开 Dart 钱包和 DApp 页面；Flutter 插件自动注册并不等于已经接入钱包的 Vault。

## 安装 Dart 依赖

从[安装指南](../installation.md)下载 Flutter 包并核对 SHA256；也可克隆仓库后执行 `npm run assets:fetch -- flutter`，将相同文件下载至 `artifacts/tbc-kit-flutter.tgz`。然后解压到工程的 `vendor` 目录：

```text
your_wallet/
├── pubspec.yaml
├── lib/
├── android/
├── ios/
└── vendor/
    └── tbc_kit_flutter_dart/
        ├── pubspec.yaml
        ├── lib/
        ├── android/
        ├── ios/
        ├── example/
        └── tool/
```

在钱包工程根目录执行，替换归档路径：

```bash
mkdir -p vendor
tar -xzf /path/to/tbc-kit/artifacts/tbc-kit-flutter.tgz -C vendor
```

在现有 `pubspec.yaml` 的 `dependencies` 中添加或合并以下项，不要覆盖钱包已有依赖：

```yaml
dependencies:
  flutter:
    sdk: flutter
  flutter_inappwebview: 6.1.5
  tbc_kit_flutter_dart:
    path: vendor/tbc_kit_flutter_dart
```

运行 `flutter pub get`，将更新后的依赖锁随钱包工程保存。

## 配置 Android

在应用模块 `android/app/build.gradle.kts` 中合并以下设置；Groovy 工程使用等价语法：

```kotlin
android {
    compileSdk = 36
    defaultConfig {
        minSdk = 26
        // 交付的 TBC 原生资源为 arm64-v8a。
        ndk { abiFilters += "arm64-v8a" }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging {
        jniLibs {
            useLegacyPackaging = true
            keepDebugSymbols += "**/libtbc*.so"
        }
    }
}
```

保证应用声明了网络权限：

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

在 `android` 目录运行 `./gradlew --version`，确认实际使用 Java 17。若 Flutter 全局 JDK 配置覆盖了终端环境，可在本地 Gradle 配置指定 `org.gradle.java.home`；不要提交开发机专属的绝对路径。

保留 `keepDebugSymbols` 设置，避免构建系统再次剥离原生库后导致完整性校验失败。若钱包还发布其他 ABI，需另行设计这些设备的功能与分发范围，不要直接改变钱包既有 ABI 策略。

## 配置 iOS

将应用及 Pods 的部署目标设为 iOS 15.0 或以上。`ios/Podfile` 设置：

```ruby
platform :ios, '15.0'
```

从钱包工程根目录执行：

```bash
cd ios
pod install
cd ..
ruby vendor/tbc_kit_flutter_dart/tool/install_ios.rb ios/Runner.xcodeproj
```

如 Xcode 工程或 App target 名称不同，传入实际工程路径，并将 target 名作为脚本第二个参数。脚本在 App 构建末尾验证嵌入的原生库，并生成运行时所需的配对信息。调整 Pods 装配后重新执行一次；不要删除该步骤或用任意运行时哈希替代它。

## 注册钱包原生宿主

包内提供三份接线模板，复制到钱包工程后连接自有实现：

| 文件 | 用途 |
| --- | --- |
| `example/ios/PartnerTbcIntegration.swift` | iOS 原生宿主与生命周期 |
| `example/android/PartnerTbcIntegration.kt` | Android 原生宿主与 WebView 挂载 |
| `example/lib/partner_browser.dart` | Dart 初始化及 Flutter WebView 页面 |

Swift 文件应加入 App target 的编译源；Kotlin 文件放入应用源码目录，按工程约定调整 package。每个 Flutter engine 持有一个 `PartnerTbcIntegration`，不要每打开一个标签页就重新注册。

需要实现的接口见 [账户与签名适配](ACCOUNT_AND_SIGNER.md)。以下 `accounts`、`approval`、`signer` 均表示钱包自己的适配器。

iOS 在主线程完成注册，保存 `integration` 实例到宿主对象：

```swift
let integration = PartnerTbcIntegration()
try integration.start(
    controller: flutterViewController,
    profile: "wallet-default",
    accounts: accounts,
    approval: approval,
    signer: signer
)
```

Android 在宿主执行线程完成注册，同样保存实例：

```kotlin
val integration = PartnerTbcIntegration()
integration.start(
    context = context,
    engine = flutterEngine,
    profile = "wallet-default",
    accounts = accounts,
    approval = approval,
    signer = signer
)
```

模板默认选择测试网。接主网时，Swift 中 `TbcPartnerNetwork` 的 `network` 改为 `"mainnet"`；Kotlin 中使用 `NativeBroadcastConfiguration("mainnet")`，并同步下方 Dart 配置及账户 `chainId`。不要只改其中一端。

需要加解密时，把钱包的 `NativeBie1Executor` 作为 `crypto` 参数传入。未提供时，该功能不可用，不影响已接入的摘要签名能力。

## 初始化 Flutter 钱包

原生注册完成后，从 `packaged_wallet.dart` 入口初始化：

```dart
import 'package:tbc_kit_flutter_dart/packaged_wallet.dart';

Future<TbcFlutterWallet> createTbcWallet() async {
  return TbcFlutterWallet.open(
    configuration: TbcWalletConfiguration(
      productId: 'com.example.wallet',
      name: 'Your Wallet',
      walletVersion: '1.0.0',
      profile: 'wallet-default',
      network: TbcNetworkConfiguration.official(TbcNetwork.testnet),
      legacy: true,
    ),
    compute: await tbcPackagedComputeLibrary(),
  );
}
```

在 App 的异步初始化流程中调用 `await createTbcWallet()`，保存返回的 `wallet`，供后续页面复用。

- `productId`：钱包产品的稳定唯一标识，可使用小写反向域名；不要因版本升级而更改。
- `name`：DApp 钱包选择器显示的名称，使用合作方自己的品牌。
- `walletVersion`：钱包 App 的版本信息。
- `profile`：钱包本地存储隔离标识，必须与原生注册一致且保持稳定。
- `icon`：可选的 base64 data image，支持 PNG、WebP、GIF 或 SVG。
- `legacy`：默认开启。关闭时，Dart 与原生 `TbcPartnerWalletHost` 两侧都设为 `false`。

当前 Flutter 入口会按原生实际能力生成能力声明；不要手填 `capabilityScopes`，也不要引入页面传来的能力列表。无需自行拼接原生库路径或预期哈希。

默认取数与解析在 Kit worker 中执行。通常无需传入 `chainDataRead` 或 `txoStatusRead`，也不要额外复制一套取数、交易构建或费用计算逻辑。

## 接入内置 WebView

把包内 `example/lib/partner_browser.dart` 复制到 App 的 `lib` 目录后使用：

```dart
import 'package:tbc_kit_flutter_dart/packaged_wallet.dart';
import 'partner_browser.dart';

PartnerBrowser buildDappPage(TbcFlutterWallet wallet) {
  return PartnerBrowser(
    wallet: wallet,
    url: Uri.parse('https://your-dapp.example'),
  );
}
```

将 `buildDappPage(wallet)` 返回的页面放入现有路由或页面容器，并替换为实际 HTTPS DApp 地址。模板的 `openPartnerWallet()` 是另一种初始化帮助函数；如果已按上一节获得 `wallet`，直接传入即可，不要再初始化一次。

模板先创建空白 WebView，在 document start 挂载脚本，完成原生视图绑定后才导航到 DApp。请保留此顺序，以及 Android 的 `resolveLegacyClient` 接线。不要额外注入另一份 `window.Turing`，也不要把摘要签名方法注册为公开 JavaScript handler。

新标准 DApp 通过钱包发现机制识别产品身份；旧 DApp 使用 Legacy 接口。两者共用交易执行能力，但授权分别管理。连接授权与交易审批是不同操作；一个已绑定的交易批次只需一次交易审批，钱包不要按批次内每个签名摘要重复展示交易审批。

## 主网与测试网同时接入

单网络接入完成后，如钱包同时开放两网：

1. 原生 `TbcPartnerWalletHost` 使用 `network` 与 `additionalNetworks` 注册两条网络配置，各自绑定对应 `chainId` 的账户源。
2. Dart `TbcFlutterWallet.open()` 使用相同主配置，并通过 `additionalNetworks` 添加 `TbcFlutterNetwork`。
3. 两端的网络、API、`trustId` 和 `profile` 必须一致；不得在已有实例中直接改 API 或串用缓存。

Dart 附加网络参数示例，合并到上面的 `open()` 调用：

```dart
additionalNetworks: [
  TbcFlutterNetwork(
    configuration: TbcNetworkConfiguration.official(TbcNetwork.mainnet),
  ),
],
```

若使用自有可信 API，Dart 使用 `TbcNetworkConfiguration.trustedCustom`，原生也传入同一网络、`apiOrigin`、`trustId` 及可选 `rpcOrigin`。地址必须是规范 HTTPS origin，不带路径、查询参数或末尾斜杠。端点由钱包配置，不接受页面传入。

## 生命周期接线

| 钱包事件 | 处理 |
| --- | --- |
| 切换账户、锁定/解锁、可签名账户变化 | 先更新账户源并递增 `revision`，再调用 `integration.walletStateChanged()` |
| iOS 即将进入非活动状态 | 调用模板的 `applicationWillResignActive()` |
| Android Activity 暂停 | 调用模板的 `onPause()` |
| 关闭标签页 | 释放对应 `TbcFlutterWalletView`；`PartnerBrowser` 已处理 |
| Flutter engine 销毁 | 释放 Dart `wallet.dispose()`，调用原生模板 `detach()` |

关闭一个标签页不应销毁整个共享钱包。密码或生物识别等待结束后，签名适配器仍需执行 `requireCurrent()`；具体回调规则见签名适配文档。

## 常见接入问题

| 现象 | 处理方向 |
| --- | --- |
| `TBC native package not registered` | 检查 Flutter 插件注册和配套包是否完整 |
| `PACKAGE_PINS` | 检查 iOS 安装脚本、最后构建阶段及原生资源是否成套；不要关闭校验 |
| `Wallet already registered` | 同一 Dart isolate 复用现有钱包，或释放后再创建 |
| WebView 挂载失败 | 检查空白页→注入→attach→导航顺序、插件版本和 Android 视图解析接线 |
| 网络配置不匹配 | 核对 Native/Dart 的 chainId、API、trustId、profile 及账户源 |
| 某能力未展示 | 检查对应原生适配器、资产类型和账户权限，不手工伪造 capability |
| 提交超时或结果不确定 | 按 Kit 返回的状态处理，让现有恢复流程核对结果；不要新建请求盲目重发 |

不要把交易返回和链确认混为一谈。展示“已确认”应以查询到的确认状态为准；广播超时不代表交易一定未提交。

## 问题反馈

请复制下面的模板，填写版本、环境、复现步骤和预期/实际结果。交易相关内容按需填写，不清楚的项目填“未知”，不适用的填“不适用”；无需为了补信息再次签名或广播。

```text
问题标题：
配套安装包 SHA256（见 SHA256SUMS）：
钱包 App 版本 / 构建模式（debug/profile/release）：
设备型号 / 系统版本 / 真机或模拟器：
Flutter / Dart / WebView 插件版本：
Android System WebView 版本（仅 Android）：
网络 chainId / API 域名：

调用入口（原生页面 / DApp WebView）：
调用方法 / intent.type：
发生时间及所在时区：
复现步骤：
预期结果：
实际结果及错误码：
出现频率（必现 / 偶发，约几次中几次）：

是否已批准签名（是 / 否 / 未知）：
是否尝试广播（是 / 否 / 未知）：
交易 txid（如有；多笔请按顺序列出）：
脱敏截图或最小日志（可选）：

仅速度问题填写，未采集的留空：
首次冷启动 / 同会话再次操作：
点击到弹出审批：
批准到签名完成：
批准到钱包返回：
计时方式与单位：
```

速度问题请区分钱包返回与链上确认，不要把用户阅读审批页、密码输入或生物识别等待混入签名计算耗时。没有分段数据时，说明实际观察到的起止位置即可，不要求新增埋点。

只提供定位问题所需的最少信息。不要提交助记词、私钥、密码、访问令牌、Cookie、HTLC 原像或解密明文；签名后的交易原文也可能包含原像，不要直接附上完整原文或请求/响应日志。截图和错误文本同样需要脱敏。

广播超时或结果不确定时，请保留原请求及已有 txid，先查询或对账，不要为复现问题重复发送交易。
