# 安装与升级

## 当前配套版本

| 组件 | 版本 | 下载 |
| --- | --- | --- |
| JavaScript / TypeScript Kit | `0.1.0-rc.23` | [tbc-kit.tgz](https://github.com/durianswap/tbc-kit/releases/download/v0.1.0-rc.23/tbc-kit.tgz) |
| iOS Native SDK | `0.1.0-rc.23.native.2` | [ios-sdk.tgz](https://github.com/durianswap/tbc-kit/releases/download/v0.1.0-rc.23/ios-sdk.tgz) |
| Android Native SDK | `0.1.0-rc.23.native.2` | [android-sdk.tgz](https://github.com/durianswap/tbc-kit/releases/download/v0.1.0-rc.23/android-sdk.tgz) |
| Native 版本锁 | 与上面三项配套 | [native-sdk-lock.json](../release/native-sdk-lock.json) |
| Flutter SDK | 独立配套版本，未随本次 JS/Native 升级 | [Flutter 接入](flutter/README.md) |

精确版本和 SHA256 以 [版本清单](../release/current.json) 与 [SHA256SUMS](../SHA256SUMS) 为准。下载链接固定到对应 Release，不使用会随升级漂移的 `latest` 地址。文件名保持稳定；项目应提交自己的依赖锁，升级时核对包内版本和哈希，不仅比较文件名。完整配套文件使用[下载校验清单](../release/DOWNLOADS.SHA256)；rc.23 Release 的 [DOWNLOADS.SHA256](https://github.com/durianswap/tbc-kit/releases/download/v0.1.0-rc.23/DOWNLOADS.SHA256) 校验该页 JS、Native、源码和说明附件。Flutter 继续从原 Release 取回原始文件。

## Web、浏览器扩展与 Node.js

下载 JavaScript 包后安装：

```sh
npm install ./tbc-kit.tgz
```

从克隆的仓库按锁定哈希下载后安装也可以：

```sh
npm run assets:fetch -- kit
npm install /path/to/tbc-kit/artifacts/tbc-kit.tgz
```

在应用中按需导入 `@tbc/kit`、`@tbc/kit/wallet`、`@tbc/kit/api`、`@tbc/kit/rpc` 或 `@tbc/kit/engine`。不要直接将仓库根目录作为 npm 包安装。

## 原生钱包

React Native 使用上面的 JS 包和配套平台 SDK；Swift/Kotlin 使用相应平台 SDK 与自己的 Host、账户和 Signer 适配。解压、安装脚本和最低系统要求见 [原生接入](native.md)。

按清单整体核对 JS、Native 与版本锁。本次 JS rc.23 必须配对 Native rc.23.native.2，原生应用替换 SDK 后重新构建。Rust 和 WASM 均包含 AMM 控制人集合规范化修复；不能仅升级 JS 后继续使用旧 Native。当前协议指纹为：

```text
8c2a5a935335463ecedef622011c187c645a9130df1b18610b0fba1262504ce9
```

协议指纹相同只表示协议结构相容，不表示旧 Native 已有新实现。运行时身份仍按版本锁中的文件哈希和 `artifactSetId` 核对。SDK 身份中的 `kitTarSha256` 记录其构建输入；最终 JS 包另包含配套版本锁，其下载哈希以 `release/current.json` 为准。

Flutter 插件自带 Dart 编排、原生库及页面脚本，按其独立指南整体接入，不混装本页的独立 Native SDK。Flutter 保留原配套版本，本页 JS/Native 的新增能力不自动适用于未更新的 Flutter 插件。

## 升级检查

在克隆的仓库根目录执行：

```sh
npm run assets:fetch -- verification
shasum -a 256 -c SHA256SUMS
npm ci
npm run verify
npm test
npm run check:install
```

这些检查核对安装包、源码快照、平台配对和公开入口，不读取账户、签名或广播。业务接入继续保留原有一次审批、并行预取、材料复用及必要校验。Coin 多笔计划的具体处理见 [Coin 多轮交易](coin-multiround.md)。

仓库不再重复保存归档和展开二进制。`assets:fetch` 默认选择 `verification`，只取回当前检查需要的文件，不提供旧候选版本。下载器检查每个归档的字节数、SHA256 和展开文件清单，已有相同文件直接复用，已有不同文件不覆盖。此命令不修改包内容，也不会被交易、审批或签名路径调用。

升级旧 FT 时按 [审批与指定输入说明](legacy-ft.md) 展示合约 ID，并重新准备尚未批准的计划；已有广播记录按原交易标识核对，不重新发送。

### rc.21 签名适配与错误处理

更新包后按[Signer 接入指南](../packages/kit/docs/signer-integration.md)检查自己 Vault 的三种签名配置，并运行包内 `examples/shared/check-signer.mjs`。示例通过不等于自有 Vault 已通过；Coin 创建的后续任务可能使用 BIP340，必须在同一已批准操作内继续分派。

Host 现在保留类型化失败；页面应读取错误 code/data，而不是将所有失败视为网络错误。新 AMM 的旧维护操作、零留存手续费和空池各有明确原因码，见[能力范围](../packages/kit/SUPPORT.md)。不需要增加审批、取数或自动重试，也不要重复广播既有交易。

### rc.22 零余额输入处理

升级 JS 后，自动选择持有人代币输入会在读取父交易前跳过有效的零余额输出。显式 `inputOutpoints` 包含零余额输入时返回 `INVALID_INPUT`，固定原因为 `SELECTED_ZERO_BALANCE_INPUT`，不能忽略指定输入后自动重试。池子储备为零的合法状态不受影响。见[调用约定](../packages/kit/docs/zero-balance-inputs.md)。

此修复位于 JS/TS Chain Data 和 Core，不改变 Native 计算库、签名算法或必要校验。独立 Flutter/Dart 编排没有随此 JS 更新，不能据此声称 Flutter 已获得同一修复。

### rc.23 输入容量与可诊断错误

NFT 和 Token LOP 自动选择手续费输入时，只计算实际需要的资金角色，不把所有备选 UTXO 都计入材料预算。显式 `inputOutpoints` 仍必须完整满足，单笔输入预算与收款人容量不放宽。AMM 控制人按集合规范化，调用者无需预先排序；收款人、工作流步骤和历史多签顺序不受影响。

材料不足、指定输入不可用、已花 NFT 槽位、无可用槽位和不支持的池操作保留明确的错误 code/reason。页面应按[容量与错误约定](../packages/kit/docs/transaction-capacity.md)处理，不自动忽略指定输入或重发交易。一次审批、并行预取及材料复用的接入方式不变。
