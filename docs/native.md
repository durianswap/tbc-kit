# 原生平台接入

先执行根目录 `node scripts/verify-release.mjs`。下载必须按 `release/current.json` 配对，不能按版本后缀相似或文件名称猜测。

## Flutter

只使用 [tbc-kit-flutter.tgz](../artifacts/tbc-kit-flutter.tgz)。内含 Dart 编排、Swift/Kotlin 桥接、Engine、Signer 与 WebView 页面资源；不需要本页的独立 Native SDK。见 [Flutter 教程](flutter/README.md)。

## Swift / Kotlin

在新目录解压所需平台，原始 SDK 内容不修改：

```bash
mkdir -p vendor/tbc-native
tar -xzf /path/to/tbc-kit/artifacts/native/ios-sdk.tgz -C vendor/tbc-native
# Android 工程改用 android-sdk.tgz；跨端工程可解压两者。
```

iOS 将 `apple/` 作为本地 Swift Package；Android 使用 `maven-repository/` 本地 Maven 仓库及 SDK 自带的坐标。SDK 的 `identity.json` 与 JS Kit 的 RN 模板锁应一致。

这份独立 SDK 是无私钥计算桥，不自动提供钱包账户、UI、Vault、网络或全部高层编排。接入方复用 Kit 编排或使用 Engine 协议时，仍需连接自己的平台 Host 和 Signer。不要把它误当成 Flutter 的完整插件。

## React Native / Expo

安装 JS Kit，在一个新目录解压 iOS/Android SDK 后，使用已安装包的脚本：

```bash
node node_modules/@tbc/kit/examples/react-native-engine/install.mjs \
  /path/to/wallet /path/to/vendor/tbc-native --platform all
```

可将 `all` 改为 `ios` 或 `android`，只提取对应平台。脚本验证精确 SDK 锁，不隐式下载，不覆盖已有模块。随后按[RN 模板说明](../packages/kit/examples/react-native-engine/README.md)重建 App；不支持仅靠 Expo Go 加载原生库。

## 原始资源

`*-resources.tgz` 仅供桥接维护者使用。使用完整 SDK 的接入方不必再重复集成原始库。macOS arm64 资源是可选本机计算库；Node 默认 WASM 路径不要求它。

平台最低版本各自不同：当前 Flutter 为 iOS 15.0、Android API 26、arm64；独立 SDK 为 iOS 15.1、Android API 24，其 ABI 以清单为准。构建支持不等同于所有真机均已验证。
