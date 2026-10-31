# 分发存储整理

本页记录第一阶段的文件迁移和验证。后续经维护者授权完成的历史清理、旧候选归档与完整克隆实测见 [history-cleanup.md](history-cleanup.md)；当前发布范围以 `current.json` 与 `downloads.json` 为准。

## 范围与保护

基线提交：`2c1850f51c42bf2471ce67657afd42a54f0f2a04`。

本次仅改变大文件的存放位置和接入下载方式：当前安装包迁至版本化 GitHub Releases，编译副本和大型测试夹具按需恢复。没有修改业务源码、协议、签名算法、审批或交易执行路径；没有重打包已经验收的 JS、Native 或 Flutter 包，也没有广播交易。

完整 Git bundle 已建立并通过 `git bundle verify`，包含全部现有本地/远程引用和完整历史。备份 SHA256：`fece7912fbabf663a3179c7d7f915e4a435538113b7733669eae071b3990cab6`。本次不重写历史、不强推、不删除旧分支；后续历史清理需要单独批准。

## 文件与体积

- 原主分支文件：1117.08 MiB；整理后约 59.3 MiB，减少约 94.7%。这是当前文件树，不是 GitHub 历史存储量或 App 下载体积。
- 683 个归档、展开二进制和大型测试数据文件移出 Git；本地原文件保留，并有逐文件哈希和恢复映射。
- 223 个候选报告、验收证据、样例与清单文件继续跟踪且原字节未改。
- 核对 3472 个原有源码、包文件及归档均保持原字节；其中外置内容可从下载清单精确恢复。
- 174 个冻结交付文件哈希复核不变，合作方交付包不变。

`release/downloads.json` 记录下载 URL、大小、SHA256 和展开文件清单；`storage-migration.json` 记录移出 Git 的每个原路径。

## 已执行检查

- 迁移前四份当前归档与完整展开校验通过。
- 从精简后的 Git 索引导出干净工程，取回当前安装包、配套 SDK、源码快照和 Flutter 夹具后，1159 个展开文件、2286 个源码文件和 Flutter 清单校验通过。
- 分发/桥接定向测试 20 项通过，包括缓存复用、哈希错配拒绝、不覆盖本地修改、路径边界、恢复映射和双平台页面桥。
- 独立归档安装：8 个 ESM、8 个 CommonJS 入口和 2 个离线示例通过。
- 未重复业务广播或模拟器功能测试；本次没有运行时内容变化。

## 公开下载验证

- [RC19 Release](https://github.com/durianswap/tbc-kit/releases/tag/v0.1.0-rc.19) 已发布，保留预发布版本属性；8 个附件的 GitHub SHA256、字节数均与备份中的原文件一致。
- Release 标签指向精简提交 `6fdae68edb57a010ccbff8bf0e626a7cc5b6ea49`，GitHub 自动生成的源码归档不再携带已外置的大文件。已验收源码基线仍是上方的 `2c1850f`。
- 从公开 HTTPS 地址进行全新浅克隆，当前文件树 59.28 MiB，克隆的 `.git` 约 12 MiB。通过真实 Releases 下载恢复当前 6 份检查资源，而非使用本地镜像，全部 SHA256 匹配。
- 在此干净克隆中执行安装、完整性检查、20 项分发/桥接测试，以及 8 个 ESM、8 个 CommonJS 入口与 2 个离线示例，全部通过。
- [GitHub Distribution integrity](https://github.com/durianswap/tbc-kit/actions/runs/41194634035) 独立通过下载、安装、完整性、测试和入口检查。
- [Source conformance](https://github.com/durianswap/tbc-kit/actions/runs/41194634126) 在 `android-actions/setup-android@v3` 工具安装步骤失败，未进入源码构建；不计为源码全量构建通过，本次也没有借此重建或替换已验收包。
- 远程主分支使用普通快进提交更新，未重写旧提交或移动发布标签；完整历史仍在备份和 Git 中。

## 使用

普通接入只下载对应平台安装包。仓库检查执行 `npm run assets:fetch -- verification`；历史资料执行 `npm run assets:fetch -- history`。下载命令与钱包运行时完全分离，不增加交易取数。

只想取得当前源码可使用 `git clone --depth 1`。完整克隆仍含早期大文件，不能把本次目录瘦身表述为已经清理 Git 历史。
