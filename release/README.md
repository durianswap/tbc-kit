# 版本、下载与验收记录

- [当前版本配对](current.json)、[下载与恢复清单](downloads.json)、[附件校验值](DOWNLOADS.SHA256)。
- [rc.19 下载](https://github.com/durianswap/tbc-kit/releases/tag/v0.1.0-rc.19)。当前 JS、iOS、Android 与独立 Flutter 安装包的内容未因存放位置调整而变化。
- `candidates/legacy-ft-exact-rc19/` 只保留当前最新版的原始报告、验证结果、计划样例、版本锁和哈希，不将受控测试改写为真实链验收。旧候选只在开发仓库归档。

## 取回对应材料

在仓库根目录执行：

```sh
npm run assets:fetch -- kit          # JS 安装包及完整展开内容
npm run assets:fetch -- flutter      # Flutter 安装包及配套原生库
npm run assets:fetch -- native       # 独立 iOS / Android SDK
npm run assets:fetch -- fixtures     # 大型 Flutter 测试数据
npm run assets:fetch -- verification # 当前分发的完整检查材料
npm run assets:fetch -- acceptance   # 当前验收报告引用的原始归档文件名
```

当前源码位于 `source/`。`tbc-kit-source.tgz` 是与验收对应的冻结源码快照；当前安装包和大型测试数据均保留原始逐文件哈希。原始验收结论不因存放位置改变而改写。

下载器对归档和展开文件执行 SHA256 校验，已有不同内容拒绝覆盖。普通接入只需要对应平台安装包；无需下载历史候选、测试数据或整个 Git 历史。

## Git 历史

历史安装包、旧候选及其分支已按维护者授权从本仓库清理；原始历史在完整备份和开发仓库归档。当前源码、接入文档和当前验收记录保留，正常完整克隆不再下载历史候选包。现有工程的迁移说明见[维护指南](../docs/maintaining.md#历史清理后的本地工程)。

文件迁移索引见 [storage-migration.json](storage-migration.json)。它记录原始提交、备份摘要和每个移出 Git 的文件，不包含账户秘密。
