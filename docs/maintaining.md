# 维护指南

## 目录约定

| 目录 | 用途 |
| --- | --- |
| `source/packages/` | Kit、Core、Host、Provider、Wallet Standard 和 Engine 源码 |
| `source/native/` | Rust 签名内核、平台桥接与 Flutter 实现 |
| `source/standards/`、`source/schemas/`、`source/registry/` | 协议、数据结构和方法注册表 |
| `packages/` | 当前安装包的类型、接入源码、文档与示例；编译产物按需取回 |
| `artifacts/` | 本地下载缓存，不提交 Git；安装包位于版本化 Releases |
| `docs/` | 使用指南与 API 导航 |
| `release/` | 构建来源、包配对、文件校验清单和原始验收报告 |

修改源码后生成新版本，不直接覆盖已发给接入方的包。原生库、桥接和页面脚本按清单配套更新。

## 检查

在仓库根目录执行：

```sh
npm run assets:fetch -- verification
npm run verify
npm test
npm run check:install
```

`verify` 核对归档、展开文件、源码清单、平台资源及文档链接；`test` 检查 TBC 接口范围和页面桥接；`check:install` 从归档进行干净安装，检查公开入口并运行离线示例。它们不读取钱包账户，也不发送交易。

完整工程的构建脚本位于 `source/package.json`。部分历史验收工具依赖设备和外部服务，不属于默认检查。修改交易或签名路径时，应补充受影响的业务测试；仅修改文档无需重跑链上交易。

## 包更新

1. 修改源码、类型、相关文档和测试。
2. 为变更生成独立包版本，更新 `release/current.json` 和 `SHA256SUMS`。
3. 检查安装入口、平台资源配对、归档内容与必要的回归测试。
4. 审查许可证与秘密扫描结果，再提交变更。

包版本用于依赖锁定，文件名保持稳定。发布新版本时更新校验清单，不修改已经交付的包。

将已验收归档提升为默认下载时，应逐字节上传对应 Releases，不要重新打包。更新 `release/current.json`、`release/downloads.json`、Native 版本锁、源码清单与校验值后执行上述检查。下载 URL 固定到版本标签，已发布同名附件不得覆盖。JS/Native 与 Flutter 独立配对；仅提升 JS/Native 时，不运行会重打包 Flutter 的 `scripts/package-release.mjs`。

rc.20 是分发层调整，Native 继续使用 rc.19.native.2；`nativeBuildInputKitVersion` 保留其原构建身份。验收快照中的源文件路径相对仓库根目录，`verify` 核对其中全部 `source/` 文件，发布主页和下载清单允许在提升版本时更新。复现 rc.20 候选形成过程应使用 `current.json` 中的 `sourceCommit`，不是把发布后的清单当成旧输入重新打包。

大型 Flutter 测试夹具按文件哈希保留在 `flutter-test-fixtures.tgz`，使用 `assets:fetch -- fixtures` 恢复。`assets:fetch -- acceptance` 可按当前验收记录中的文件名取回同一份已验收包，原始验收记录无需改写。可恢复文件由 `release/downloads.json` 索引。旧候选和实验版本只在开发仓库归档，不在本发布仓库或 Releases 分发。

分发整理不会自动缩小既有 Git 历史。任何历史重写、分支删除或强制推送均需维护者另行批准，并先验证完整备份；不要把普通文件迁移当作该授权。

## 历史清理后的本地工程

本仓库已按维护者授权移除历史安装包和旧候选文件，当前源码与安装包内容未变。已有克隆建议另建干净目录重新克隆，先保留未提交的工作，再逐项迁移必要修改；不要把旧分支整段 merge 或强推回来，以免重新引入大文件历史。正常完整克隆无需 `--depth`。

包锁、冻结源码及原始验收记录中的旧提交标识继续作为构建来源保留，不为整理而改写。提交映射见 [history-rewrite-map.json](../release/history-rewrite-map.json)。

仓库可见性与注册表发布由维护者单独管理，代码推送不会触发发布。
