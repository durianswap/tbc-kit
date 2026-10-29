# JS/TS 钱包接入

安装 `tbc-kit.tgz`，使用 `@tbc/kit/wallet` 创建钱包宿主；计算接口在 `@tbc/kit/engine`，只读查询在 `/api`、`/rpc`。它们是同一个安装包的入口。

当前使用 RC.18；原生钱包同时更新配套 Native SDK 和版本锁，见 [安装与升级](installation.md)。新版 Coin 多轮交易不新增钱包执行器，按 [多轮接入说明](coin-multiround.md) 复用现有审批、finalize continuation 与顺序提交。

## 钱包需要提供的适配

1. 当前账户、压缩公钥、网络与账户变化通知。
2. 实际浏览器/原生平台验证的来源和会话；不能相信 DApp 自报的 origin。
3. 原生审批 UI 与受控 Signer/Vault。密码、生物识别及私钥仍由钱包管理。
4. 平台存储、广播与不确定结果的恢复边界，以及前后台/导航/关闭通知。

这些是平台能力，不是重新编写 TBC 交易或取数逻辑。Kit 复用同一材料加载、预取、业务编排、校验及 Engine 路径。不要在适配层再次下载相同交易，也不要另写 Legacy 交易引擎。

从[独立钱包示例](../packages/kit/examples/independent-wallet/README.md)了解接线结构；其中合成账户、公开测试向量、固定 origin 与自动化 fixture 只用于离线演示，不可保护资金或替代正式审批。

审批参考[材料展示示例](../packages/kit/examples/approval-presentation/README.md)。一次业务或一批操作可复用一次受限批准，批准后的执行仍必须保持账户、来源、材料和签名绑定检查。

注册发现时复用平台建立的有效 session：

```ts
const session = await runtime.openSession({ authority: platformAuthority });
await runtime.register(session);
// 页面导航、撤权、锁定或 transport 结束时关闭：
session.close();
```

`runtime` 先按示例通过自己的适配器创建；`platformAuthority` 必须来自可信平台。钱包名称、图标、productId 用于发现与展示，不是授权凭据。

Flutter 请直接使用[专用桥接](flutter/README.md)。Swift/Kotlin、React Native 资源见[原生平台](native.md)。完整 JS Kit 的可选[多签](../packages/kit/docs/multisig.md)仅用于钱包，不新增 Provider 方法。
