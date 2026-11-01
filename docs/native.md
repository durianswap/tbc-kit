# 原生平台接入

从下面的 Releases 链接下载所需平台；使用仓库进行完整配对检查时，先执行 `npm run assets:fetch -- verification`，再执行 `npm run verify`。下载必须按 `release/current.json` 配对，不能按版本后缀相似或文件名称猜测。

当前配对为 `@tbc/kit 0.1.0-rc.23` 与 Native SDK `0.1.0-rc.23.native.2`，安装校验见 [安装与升级](installation.md)。[iOS SDK](https://github.com/durianswap/tbc-kit/releases/download/v0.1.0-rc.23/ios-sdk.tgz)、[Android SDK](https://github.com/durianswap/tbc-kit/releases/download/v0.1.0-rc.23/android-sdk.tgz) 和 [版本锁](../release/native-sdk-lock.json) 按清单配对；从旧版升级时同时替换 SDK 并重新构建原生应用。

## Flutter

只使用 [tbc-kit-flutter.tgz](https://github.com/durianswap/tbc-kit/releases/download/v0.1.0-rc.20/tbc-kit-flutter.tgz)。内含 Dart 编排、Swift/Kotlin 桥接、Engine、Signer 与 WebView 页面资源；不需要本页的独立 Native SDK。见 [Flutter 教程](flutter/README.md)。

## Swift / Kotlin

在新目录解压所需平台，原始 SDK 内容不修改：

```bash
mkdir -p vendor/tbc-native
tar -xzf /path/to/tbc-kit/artifacts/native/ios-sdk.tgz -C vendor/tbc-native
# Android 工程改用 android-sdk.tgz；跨端工程可解压两者。
```

iOS 将 `apple/` 作为本地 Swift Package；Android 使用 `maven-repository/` 本地 Maven 仓库及坐标 `io.tbc.local:engine:0.1.0-rc.23.native.2`。SDK 的 `identity.json` 与 JS Kit 的 RN 模板锁应一致。

这份独立 SDK 是无私钥计算桥，不自动提供钱包账户、UI、Vault、网络或全部高层编排。接入方复用 Kit 编排或使用 Engine 协议时，仍需连接自己的平台 Host 和 Signer。不要把它误当成 Flutter 的完整插件。

## React Native / Expo

安装 JS Kit，在一个新目录解压 iOS/Android SDK 后，使用已安装包的脚本：

```bash
node node_modules/@tbc/kit/examples/react-native-engine/install.mjs \
  /path/to/wallet /path/to/vendor/tbc-native --platform all
```

可将 `all` 改为 `ios` 或 `android`，只提取对应平台。脚本验证精确 SDK 锁，不隐式下载，不覆盖已有模块。随后按[RN 模板说明](../packages/kit/examples/react-native-engine/README.md)重建 App；不支持仅靠 Expo Go 加载原生库。

## 资源与平台范围

原生工程使用上述完整 SDK，无需再下载另一份原始库。JS 包不再附带 iOS、Android 或 macOS 原生库，只保留现有 WASM 路径；移动端按目标平台另取 SDK。Node 默认 WASM 路径不要求独立下载 macOS 库。

JS rc.23 与 Native rc.23.native.2 已完成模板、版本锁和 Native/WASM 定向向量检查。本轮 Native 含 AMM 控制人集合规范化修复，签名算法和协议结构不变。平台目录、SDK 版本锁、协议指纹与文件哈希共同核对配对关系。独立 Flutter/Dart 编排不会因升级 JS 自动获得本次修复；Flutter 仍使用自己的固定配套资源。

Engine SDK 不代替 Signer。完整业务的 ECDSA、可恢复 ECDSA 与 BIP340 配置见[签名适配指南](../packages/kit/docs/signer-integration.md)，不要按签名字节长度猜测算法。

自定义底层 FFI 可以显式下载 `resources-ios`、`resources-android` 或 `resources-macos-arm64`，普通钱包 SDK 接入不需要这些原始库附件。没有安装钩子、运行时下载或静默后端回退。

平台最低版本各自不同：当前 Flutter 为 iOS 15.0、Android API 26、arm64；独立 SDK 为 iOS 15.1、Android API 24，其 ABI 以清单为准。构建支持不等同于所有真机均已验证。
