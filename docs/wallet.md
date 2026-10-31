# JS/TS 钱包接入

安装 `tbc-kit.tgz`，使用 `@tbc/kit/wallet` 创建钱包宿主；计算接口在 `@tbc/kit/engine`，只读查询在 `/api`、`/rpc`。它们是同一个安装包的入口。

当前版本及配套 Native SDK 以[安装与升级](installation.md)的版本锁为准。新版 Coin 多轮交易不新增钱包执行器，按 [多轮接入说明](coin-multiround.md) 复用现有审批、finalize continuation 与顺序提交。旧 FT 的审批资产身份与精确选币规则见 [旧 FT 接入说明](legacy-ft.md)。

## 钱包需要提供的适配

1. 当前账户、压缩公钥、网络与账户变化通知。
2. 实际浏览器/原生平台验证的来源和会话；不能相信 DApp 自报的 origin。
3. 原生审批 UI 与受控 Signer/Vault。密码、生物识别及私钥仍由钱包管理。
4. 平台存储、广播与不确定结果的恢复边界，以及前后台/导航/关闭通知。

这些是平台能力，不是重新编写 TBC 交易或取数逻辑。Kit 复用同一材料加载、预取、业务编排、校验及 Engine 路径。不要在适配层再次下载相同交易，也不要另写 Legacy 交易引擎。

从[独立钱包示例](../packages/kit/examples/independent-wallet/README.md)了解接线结构；其中合成账户、公开测试向量、固定 origin 与自动化 fixture 只用于离线演示，不可保护资金或替代正式审批。

审批参考[材料展示示例](../packages/kit/examples/approval-presentation/README.md)。一次业务或一批操作可复用一次受限批准，批准后的执行仍必须保持账户、来源、材料和签名绑定检查。

## Signer 算法与失败处理

按每个 `task.algorithm` 和 `task.signatureEncoding` 分派，不按业务名或签名字节数猜测：

| 算法 | 编码 | 用途 |
| --- | --- | --- |
| `secp256k1-ecdsa-sha256d` | `compact64` | 普通交易输入：low-S 的 `r32 || s32` |
| `secp256k1-recoverable-ecdsa-sha256d` | `compact65-recoverable` | 消息签名：恢复头加 ECDSA 签名 |
| `secp256k1-schnorr-bip340` | `schnorr64` | 合约指定的 BIP340 输入，例如新版 Coin 创建中的管理员任务 |

新版 Coin 创建先签手续费来源交易，再由 `finalize` 返回后续任务。后续任务可以同时包含 Schnorr 和 ECDSA，仍受原来的一次整批审批约束。普通 TBC 或 TBC20 创建成功，不代表 Signer 已实现新版 Coin 创建所需的全部算法。

把给定 digest 按字节顺序交给对应算法；不要额外哈希或反转，不把 Schnorr 当作 ECDSA，也不对 Schnorr 做 DER/low-S 转换。核对任务公钥属于已批准账户；x-only 编码不能改变账户或角色授权。

不支持的算法应返回 `{ portError: { name: 'SIGNATURE_FAILED', retryable: false, message: 'Unsupported signing algorithm or encoding' } }`，不能伪造成功结果或降级算法。取数适配器也应保留 Kit 返回的 `{ portError }`，不要抛出或重新包装为通用异常。已知失败不必依赖英文错误信息判断。

独立钱包和 Node 示例共用[离线签名适配示例](../packages/kit/examples/shared/controlled-signer.mjs)，其中公开测试密钥只用于合成向量；正式接入必须替换为钱包自己的安全签名服务。

逐项接入清单与完整算法分派见[签名适配指南](../packages/kit/docs/signer-integration.md)。从示例开始接入时请保留 `examples/shared/`，不要复制旧的 ECDSA-only 回调；可以直接运行已安装包的 `examples/shared/check-signer.mjs` 检查三种签名配置。

注册发现时复用平台建立的有效 session：

```ts
const session = await runtime.openSession({ authority: platformAuthority });
await runtime.register(session);
// 页面导航、撤权、锁定或 transport 结束时关闭：
session.close();
```

`runtime` 先按示例通过自己的适配器创建；`platformAuthority` 必须来自可信平台。钱包名称、图标、productId 用于发现与展示，不是授权凭据。

Flutter 请直接使用[专用桥接](flutter/README.md)。Swift/Kotlin、React Native 资源见[原生平台](native.md)。完整 JS Kit 的可选[多签](../packages/kit/docs/multisig.md)仅用于钱包，不新增 Provider 方法。
