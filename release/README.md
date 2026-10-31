# 版本、下载与验收记录

- [当前版本配对](current.json)、[下载与恢复清单](downloads.json)、[附件校验值](DOWNLOADS.SHA256)。
- [rc.19 下载](https://github.com/durianswap/tbc-kit/releases/tag/v0.1.0-rc.19)。当前 JS、iOS、Android 与独立 Flutter 安装包的内容未因存放位置调整而变化。
- `candidates/` 保留各阶段原始报告、验证结果、计划样例、版本锁和哈希，不将受控测试改写为真实链验收。

## 取回对应材料

在仓库根目录执行：

```sh
npm run assets:fetch -- kit          # JS 安装包及完整展开内容
npm run assets:fetch -- flutter      # Flutter 安装包及配套原生库
npm run assets:fetch -- native       # 独立 iOS / Android SDK
npm run assets:fetch -- fixtures     # 大型 Flutter 测试数据
npm run assets:fetch -- verification # 当前分发的完整检查材料，不下载历史归档
npm run assets:fetch -- history      # 原始候选归档恢复到历史报告引用的路径
```

当前源码位于 `source/`。`tbc-kit-source.tgz` 是与验收对应的冻结源码快照；大型测试数据和历史安装包只改变存放位置，均保留原始逐文件哈希。历史文档中的相对归档路径在执行 `history` 后恢复，不为迁移修改原始验收结论。

下载器对归档和展开文件执行 SHA256 校验，已有不同内容拒绝覆盖。普通接入只需要对应平台安装包；无需下载历史候选、测试数据或整个 Git 历史。

## Git 历史

此次迁移只新增正常提交，不改写任何历史、不强推、不删除旧分支。完整克隆暂时仍包含早期提交中的大文件；`git clone --depth 1` 可只获取整理后的当前分支。清理历史须在验证完整备份后另行批准。

文件迁移索引见 [storage-migration.json](storage-migration.json)。它记录原始提交、备份摘要和每个移出 Git 的文件，不包含账户秘密。
