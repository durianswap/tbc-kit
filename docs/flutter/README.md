# TBC Flutter 钱包接入指南

本指南用于在 Flutter Android/iOS 钱包中接入 TBC 网络与内置 WebView DApp。钱包继续管理账户、密码、生物识别和私钥；Kit 提供链数据读取、交易构建、审批材料、签名任务、广播处理及新旧 DApp 协议接入。

## 接入资料

按以下顺序接入：

1. 阅读本页，安装配套包并确认平台配置。
2. 按 [Flutter 与原生接线教程](INTEGRATION.md) 注册原生宿主、初始化 Dart 钱包并接入 WebView。
3. 按 [账户与签名适配](ACCOUNT_AND_SIGNER.md) 连接现有账户系统、审批界面和签名服务。
4. 按 [原生钱包页面](NATIVE_WALLET.md) 接入 Dart 业务调用、查询工具与原生转账页面。
5. 按 [业务参数与调用配方](BUSINESS_CALLS.md) 接入代币、NFT、池、LP、锁定、订单和批次；复制 `examples/` 中需要的 Dart 示例。

遇到接入问题时，请按 [问题反馈模板](INTEGRATION.md#问题反馈) 提供复现信息。

本仓库提供以下配套内容：

```text
tbc-kit/
├── artifacts/tbc-kit-flutter.tgz
├── packages/flutter/              # 同一归档的完整展开内容
├── docs/flutter/
│   ├── README.md
│   ├── INTEGRATION.md
│   ├── ACCOUNT_AND_SIGNER.md
│   ├── NATIVE_WALLET.md
│   ├── BUSINESS_CALLS.md
│   └── examples/
├── release/current.json
└── SHA256SUMS
```

安装包为 [artifacts/tbc-kit-flutter.tgz](../../artifacts/tbc-kit-flutter.tgz)，Dart 依赖名为 `tbc_kit_flutter_dart`。安装前在仓库根目录执行 `shasum -a 256 -c SHA256SUMS` 核对完整性；对应归档的精确 SHA256 记录在该文件中。接入反馈时可提供该校验值，便于确认使用的是同一份配套包。

包内已包含配对的 Engine、Signer 原生资源、Dart 编排、Swift/Kotlin 桥接和页面脚本。无需另外安装 JS Kit 或手动下载 Engine；请整体使用，不要替换其中某个库或页面脚本。

Flutter 使用 Dart 编排与原生桥接。接入 Flutter 钱包只需安装此插件，无需再安装 JavaScript 包。

## 环境与平台配置

| 项目 | 配置 |
| --- | --- |
| Flutter / Dart | Flutter 3.29.3 / Dart 3.7.2 |
| WebView 插件 | `flutter_inappwebview: 6.1.5` |
| 现有摘要签名库 | 可复用 `web3dart: 2.7.3`，按签名适配说明转换结果 |
| Android | `minSdk 26`、`compileSdk 36`、arm64-v8a、Java 17 |
| iOS | 部署目标 iOS 15.0 或以上；arm64 真机和 arm64 模拟器 |

Android System WebView 需支持安全消息桥所需的平台能力；不提供绕过主框架或来源校验的降级路径。此包不包含 Android x86 或 Intel iOS 模拟器库。请按钱包实际支持的系统、WebView 和设备组合配置发布范围。

## Kit 与钱包的职责

| Kit 提供 | 钱包提供 |
| --- | --- |
| 链数据读取、交易与合约处理、费用计算、交易校验 | 当前账户、压缩公钥、网络选择 |
| DApp 发现和通信、Legacy 映射、权限与请求生命周期 | 钱包名称、图标和原生审批界面 |
| 批次编排、并行准备、审批与签名任务绑定 | 密码或生物识别解锁、受控签名服务 |
| 广播、提交结果与不确定状态处理 | 前后台、账户切换、锁定和销毁通知 |

Kit 不接收助记词，也不替钱包管理私钥。配套模板没有内置账户或自动批准逻辑。

## 功能

- TBC 转账与 UTXO 合并。
- 新 TBC20 创建、转移及适用的合并操作；新 NFT 集合、铸造与转移。
- 新 AMM 建池、加减流动性、买卖，以及 LP 转移、锁定、解锁和适用的维护操作。
- 稳定币持有人转移、合并及支持的使用操作。
- 支持资产的 HTLC、时间锁和 LOP 操作。
- 消息签名、结构化数据签名、普通及 Prepared 交易、批次签名与发送。
- 旧 DApp 的 Legacy 接口，以及旧资产受支持的持有人操作。
- 加解密：接入钱包私有 BIE1 执行器后启用。

资产操作是否可用还取决于合约类型和账户权限。能力由实际接入的宿主推导，请勿仅通过改描述字段宣称支持。

测试账户由接入方独立生成并获取测试网资金。仓库不包含测试私钥或已注资账户；需要专属测试账户时通过私下渠道协调，不把凭据写入代码或 issue。

## 网络与金额

| 网络 | chainId | 默认 API |
| --- | --- | --- |
| 主网 | `tbc:mainnet` | `https://api.turingbitchain.io` |
| 测试网 | `tbc:testnet` | `https://api.tbcdev.org` |

网络由钱包配置，不由 DApp 指定 API 地址。两网使用相同原始地址格式，不能根据地址前缀判断网络。主网、测试网的账户标识、授权和数据缓存分别隔离。

交易金额使用最小单位的十进制字符串，不使用浮点数。TBC 精度为 6，即 `1 TBC = 1000000` 最小单位；代币数量使用该资产定义的精度。显示单位转换与链上整数金额分开处理。

## 升级方式

整体替换配套包，更新依赖锁，并重新执行 iOS 安装步骤。保持钱包 `productId`、`profile` 和账户恢复规则稳定；不要混装不同版本的 Dart、页面脚本或原生资源。

请保留包内 `LICENSE` 和第三方声明。升级不需要用户向 Kit 提供私钥或重新创建账户。
