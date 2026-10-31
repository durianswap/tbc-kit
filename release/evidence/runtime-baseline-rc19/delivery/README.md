# TBC Kit 旧 FT 配套接入

配套版本：`@tbc/kit 0.1.0-rc.19`、Native SDK `0.1.0-rc.19.native.2`。
本候选补齐旧 FT 审批摘要的合约 ID，并支持严格指定原始输入。
业务入口、整批一次审批、并行预取和签名算法不变。

## 安装

- JS：安装同目录的 `tbc-kit-0.1.0-rc.19.tgz`。
- iOS：解压 `ios-sdk-0.1.0-rc.19.native.2.tgz`，使用其中的 `apple/Package.swift`；包含真机与模拟器 arm64 资源。
- Android：解压 `android-sdk-0.1.0-rc.19.native.2.tgz`，将 `maven-repository` 加入本地仓库，引用 `io.tbc.local:engine:0.1.0-rc.19.native.2`；包含 arm64-v8a、armeabi-v7a、x86_64。
- React Native：使用 JS 包内 `examples/react-native-engine/module` 模板及其 `sync-native` 工具，指定本次 Native SDK 目录。

使用同目录的 `native-sdk-lock.json` 和 `SHA256SUMS` 核对配套资源。
协议指纹未改变不代表可以混用旧 Native；这些修复要求 JS 与 Native 一同升级。
平台适配器继续使用现有账户、审批、签名和顺序提交接口。

## 审批展示

旧 FT 转账和合并的 `preview.assetFlows` 现在包含 `contractId`。
钱包在用户批准前展示合约 ID、数量、收款人、费用，并保留逐笔 `outputReview`。
这是计划阶段的结构化信息，不是广播回执。不要用未核验的 DApp 标签替代资产身份，
也不要编辑已经绑定的计划或跳过 validate/finalize。

## 指定输入

旧 FT 的 `constraints.inputOutpoints` 表示需要恰好消费一次的全部原始输入，
包括所选 FT 输入和原生手续费输入。不能只列手续费或只列 FT，然后依赖钱包自动补选。
不传该字段则沿用自动选币。

Kit 校验账户归属、合约、材料、确认政策和输入集合。转账所需 FT 输入超过单笔上限时，
复用原有合并依赖计划；指定多个手续费输入时，复用原生资金归集前置交易。
中间输出由 Kit 内部衔接，调用方不需要提前列出。
整个计划仍受总手续费与交易数预算限制，独立旧 FT merge 仍为 2–5 个资产输入。

统一 `tbc20.transfer` / `tbc20.merge` 与映射后的 `tbc.ft.transfer` / `tbc.ft.merge`
具有相同的旧 FT 输入约束。数量使用最小单位十进制字符串。
完整示例见 JS 包内 `docs/usage.md` 的 Historical FT approval and selected inputs 章节。

升级后应重新准备尚未批准的计划，不要修改旧审批材料来迁移。
已有广播及未知结果仍按原交易标识核对，不因升级重新发送。

## 文件核验

`delivery-lock.json` 记录版本、协议指纹和归档哈希；`source.tgz` 与
`source-manifest.json` 保存对应源码。`REPORT.json` 和 `evidence/` 单独记录本候选的
打包与定向测试结果。本候选不替换现有合作方交付版。
