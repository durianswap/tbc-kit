# 贡献指南

欢迎改进 TBC Kit 的接入体验、文档和实现。

## 本地检查

使用 Node.js 22 或以上版本：

```sh
npm run assets:fetch -- verification
npm ci
npm run verify
npm test
npm run check:install
```

修改源码请在 `source/` 中进行。`packages/` 保留当前安装包的类型、文档与示例；编译产物在检查前从锁定版本的 Releases 取回，不单独维护另一套实现。下载只在显式执行维护命令时发生，不属于钱包运行时。

仅检查 JS 包可使用 `npm run assets:fetch -- kit`，仅接入 Flutter 使用 `npm run assets:fetch -- flutter`。大型 Flutter 测试数据使用 `npm run assets:fetch -- fixtures`；当前验收记录对应的归档路径使用 `npm run assets:fetch -- acceptance`。本仓库不分发旧候选版本。现有文件若与锁定哈希不同，工具会停止，不覆盖本地修改。

## 提交变更

- 将改动限定在一个明确问题，并说明影响的公开接口。
- 文档示例使用实际导出的方法；不要提交密码、私钥、助记词或 HTLC 原像。
- 保留审批绑定、来源校验和签名校验；不要通过重复取数或重复审批绕开接入问题。
- 为受影响行为添加定向测试，不要求文档变更重跑完整链上验收。
- 修改分发内容时使用新包版本，并更新归档与校验清单。

详见 [维护指南](docs/maintaining.md)。问题反馈使用 [复现模板](SUPPORT.md)。
