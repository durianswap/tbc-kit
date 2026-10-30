# 安装与升级

## 当前配套版本

| 组件 | 版本 | 下载 |
| --- | --- | --- |
| JavaScript / TypeScript Kit | `0.1.0-rc.19` | [tbc-kit.tgz](../artifacts/tbc-kit.tgz) |
| iOS Native SDK | `0.1.0-rc.19.native.2` | [ios-sdk.tgz](../artifacts/native/ios-sdk.tgz) |
| Android Native SDK | `0.1.0-rc.19.native.2` | [android-sdk.tgz](../artifacts/native/android-sdk.tgz) |
| Native 版本锁 | 与上面三项配套 | [native-sdk-lock.json](../release/native-sdk-lock.json) |
| Flutter SDK | 独立配套版本，未随本次 JS/Native 升级 | [Flutter 接入](flutter/README.md) |

精确版本和 SHA256 以 [版本清单](../release/current.json) 与 [SHA256SUMS](../SHA256SUMS) 为准。文件名保持稳定；项目应提交自己的依赖锁，升级时核对包内版本和哈希，不仅比较文件名。

## Web、浏览器扩展与 Node.js

下载 JavaScript 包后安装：

```sh
npm install ./tbc-kit.tgz
```

从克隆的仓库安装也可以：

```sh
npm install /path/to/tbc-kit/artifacts/tbc-kit.tgz
```

在应用中按需导入 `@tbc/kit`、`@tbc/kit/wallet`、`@tbc/kit/api`、`@tbc/kit/rpc` 或 `@tbc/kit/engine`。不要直接将仓库根目录作为 npm 包安装。

## 原生钱包

React Native 使用上面的 JS 包和配套平台 SDK；Swift/Kotlin 使用相应平台 SDK 与自己的 Host、账户和 Signer 适配。解压、安装脚本和最低系统要求见 [原生接入](native.md)。

必须整体更新 JS、Native 与版本锁。当前协议指纹为：

```text
8c2a5a935335463ecedef622011c187c645a9130df1b18610b0fba1262504ce9
```

协议指纹相同只表示协议结构相容，不表示旧 Native 已有新实现。运行时身份仍按版本锁中的文件哈希和 `artifactSetId` 核对。SDK 身份中的 `kitTarSha256` 记录其构建输入；最终 JS 包另包含配套版本锁，其下载哈希以 `release/current.json` 为准。

Flutter 插件自带 Dart 编排、原生库及页面脚本，按其独立指南整体接入，不混装本页的独立 Native SDK。Flutter 保留原配套版本，本页 JS/Native 的新增能力不自动适用于未更新的 Flutter 插件。

## 升级检查

在克隆的仓库根目录执行：

```sh
shasum -a 256 -c SHA256SUMS
npm ci
npm run verify
npm test
npm run check:install
```

这些检查核对安装包、源码快照、平台配对和公开入口，不读取账户、签名或广播。业务接入继续保留原有一次审批、并行预取、材料复用及必要校验。Coin 多笔计划的具体处理见 [Coin 多轮交易](coin-multiround.md)。

升级旧 FT 时按 [审批与指定输入说明](legacy-ft.md) 展示合约 ID，并重新准备尚未批准的计划；已有广播记录按原交易标识核对，不重新发送。
