# 维护指南

## 目录约定

| 目录 | 用途 |
| --- | --- |
| `source/packages/` | Kit、Core、Host、Provider、Wallet Standard 和 Engine 源码 |
| `source/native/` | Rust 签名内核、平台桥接与 Flutter 实现 |
| `source/standards/`、`source/schemas/`、`source/registry/` | 协议、数据结构和方法注册表 |
| `packages/` | 当前安装包的展开内容，便于浏览类型、实现与示例 |
| `artifacts/` | 可安装归档与原生 SDK |
| `docs/` | 使用指南与 API 导航 |
| `release/` | 构建来源、包配对与文件校验清单 |

修改源码后生成新版本，不直接覆盖已发给接入方的包。原生库、桥接和页面脚本按清单配套更新。

## 检查

在仓库根目录执行：

```sh
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

仓库可见性与注册表发布由维护者单独管理，代码推送不会触发发布。
