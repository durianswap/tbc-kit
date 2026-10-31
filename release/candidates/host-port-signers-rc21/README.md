# TBC Kit rc.21

JS/TS `@tbc/kit@0.1.0-rc.21`，配套 Native SDK 继续为
`0.1.0-rc.19.native.2`。Native/WASM 未修改或重新编译；按
`delivery-lock.json` 和 `native-sdk-lock.json` 下载并校验，不能只按版本编号猜测。

安装 `tbc-kit.tgz` 后，阅读包内 `docs/signer-integration.md`，运行：

```sh
npm install /path/to/tbc-kit.tgz
node node_modules/@tbc/kit/examples/shared/check-signer.mjs
node node_modules/@tbc/kit/examples/independent-wallet/run.mjs
node node_modules/@tbc/kit/examples/backend-node/run.mjs
```

示例使用公开测试向量，不接触真实资金。生产钱包接上自己的受控 Vault；必须按
任务的 algorithm/encoding 分派，不能把 ECDSA 签名回调用于 BIP340 任务。

## 本轮修复

- 独立钱包和 Node 示例补齐 BIP340，登录示例复用同一严格算法分派。
- 恢复 Host → Core → Provider 类型化错误，保持内部诊断脱敏。
- 明确区分新 AMM 不支持历史维护、微额兑换零留存费、池已无有效流动性。
- 接入文档列出三种签名配置、Native 编码、角色/审批边界和失败处理。

新 AMM 减池用 `amm.removeLiquidity`；持有人 LP 合并用 `tbc20Lp.merge`。
`amm.mergeToken` / `tbc20Lp.burn` 是旧 Pool2 维护，不应传入新 AMM 池 ID。
微额兑换规则与固定官方 SDK 一致，不擅自修改金额、费率或 minimumOutput。

本候选通过干净安装、定向离线业务和双平台配对检查；没有进行真实广播或重新
构建设备 App。当前 rc.20 下载、已交付 Flutter/合作方包保持不变。
同事现场 Coin 创建失败尚需原始 Port 日志确认，不能把示例修复等同于现场结案。

结果及限制见 `REPORT.md`。安装前核对 `DOWNLOADS.SHA256`。
