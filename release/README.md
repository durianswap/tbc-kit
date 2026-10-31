# 版本、下载与验收记录

- [当前版本配对](current.json)、[下载与恢复清单](downloads.json)、[附件校验值](DOWNLOADS.SHA256)。
- [rc.21 下载](https://github.com/durianswap/tbc-kit/releases/tag/v0.1.0-rc.21)：JS、签名示例与错误处理已更新，配套 Native 与独立 Flutter 包字节不变。
- [本轮报告](candidates/host-port-signers-rc21/REPORT.md) 保留候选形成时的原始结论；[发布记录](rc21-publication.md) 记录提升为默认下载的结果。
- `candidates/host-port-signers-rc21/` 对应当前包；较早目录仅保留验收记录，下载器不再选择其旧 JS 归档。

## 取回对应材料

在仓库根目录执行：

```sh
npm run assets:fetch -- kit          # JS 安装包及完整展开内容
npm run assets:fetch -- flutter      # Flutter 安装包及配套原生库
npm run assets:fetch -- native       # 独立 iOS / Android SDK
npm run assets:fetch -- ios          # JS + iOS SDK + 版本锁
npm run assets:fetch -- android      # JS + Android SDK + 版本锁
npm run assets:fetch -- fixtures     # 大型 Flutter 测试数据
npm run assets:fetch -- verification # 当前分发的完整检查材料
npm run assets:fetch -- acceptance   # 当前验收报告引用的原始归档文件名
```

当前源码位于 `source/`。`tbc-kit-source.tgz` 是 rc.21 形成时的冻结源码快照；发布主页与下载清单以后续 main 为准。交易与构建源码必须与冻结快照一致；当前安装包和大型测试数据保留原始逐文件哈希。原始验收结论不因发布而改写。

下载器对归档和展开文件执行 SHA256 校验，已有不同内容拒绝覆盖。普通接入只需要对应平台安装包；无需下载历史候选、测试数据或整个 Git 历史。

## Git 历史

历史安装包、旧候选及其分支已按维护者授权从本仓库清理；原始历史在完整备份和开发仓库归档。当前源码、接入文档和当前验收记录保留，正常完整克隆不再下载历史候选包。现有工程的迁移说明见[维护指南](../docs/maintaining.md#历史清理后的本地工程)。

文件迁移索引见 [storage-migration.json](storage-migration.json)。它记录原始提交、备份摘要和每个移出 Git 的文件，不包含账户秘密。
