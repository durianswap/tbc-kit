# rc.20 发布配对

当前 JS 默认版本为 `0.1.0-rc.20`，沿用已验收候选的原始归档，不重新打包。
配套 Native SDK 为 `0.1.0-rc.19.native.2`：Native 本体没有改动，不为统一编号
改写元数据或二进制。Flutter 与合作方交付保持原字节和独立版本。

- [下载](https://github.com/durianswap/tbc-kit/releases/tag/v0.1.0-rc.20)
- [安装与配对](../docs/installation.md)
- [冻结候选报告](candidates/lean-distribution-rc20/REPORT.md)
- [冻结包锁](candidates/lean-distribution-rc20/delivery-lock.json)
- [当前下载清单](downloads.json)

候选报告和包内元数据中的“未发布”“本地候选”是验收当时的原始记录，保留原文；
本页与 `current.json` 记录其后续提升状态，不通过改写包内容更新历史描述。

本次更新只涉及分发入口、版本配对检查与接入文档，不增加业务方法、不修改交易
热路径。配套检查继续验证原 Native 构建版本、artifactSetId、协议指纹、目录哈希
及 SDK 文件哈希，JS 与 Native 编号不同不代表放宽验证。

rc.20 npm 归档为 5,533,148 字节，SHA256：
`78da28e717ce4d4234923f2b91c3fd4c01176f641def88981b2c6cba4c0c3614`。

公开 Releases 仅分发当前配套安装包、平台资源、源码与测试夹具；不重新上传旧候选集合。
普通 Web/Node 接入只需 JS 包；原生钱包按平台选 SDK；测试夹具不是应用运行依赖。
