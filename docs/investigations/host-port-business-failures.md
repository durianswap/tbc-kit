# Coin 创建与 AMM Host 错误核查

状态：隔离源码修复与定向验证完成，已生成 rc.21 候选，完整打包与示例检查见 [候选报告](../../release/candidates/host-port-signers-rc21/REPORT.md)；同事运行环境的 Coin 原始失败仍需日志确认。

基线为 JS `0.1.0-rc.20` / Native `0.1.0-rc.19.native.2`，源码提交 `f8d5277246d1e0fa4c53c9d39cc4defa7ec02056`。没有改 Rust、签名算法、合约费率或协议 Schema，也没有真实签名、广播、发布或修改合作方交付包。

## 已确认的结果

### 1. 类型化错误被 Core 丢失

`default-chain-data.ts` 原来已能为当前 AMM 的 `amm.mergeToken` / `tbc20Lp.burn` 返回 `INVALID_INPUT`。Host dispatch 能保留该错误，但 Core `failFromPort` 把所有剩余 Port 错误统一返回 `-32603`。这与 TWS-011 已有错误映射要求不一致。

本次恢复规范映射，未知内部异常继续脱敏。不会把适配器任意 message、details、堆栈透传给 DApp。仅允许固定公开原因码：

| 情况 | Provider code | 可程序识别字段 |
| --- | --- | --- |
| 当前池模板不支持历史维护 | `-32602` | `data.reason = UNSUPPORTED_POOL_OPERATION` |
| AMM 整数舍入后留存手续费为零 | `-32602` | `data.reason = AMM_RETAINED_FEE_ZERO` |
| 当前池已无有效流动性 | `-32000` | `data.name = CONFLICT`、`data.details.reason = AMM_POOL_INACTIVE` |
| Signer 明确返回不支持/失败 | `-32000` | `data.name = SIGNING_FAILED`、`data.stage = signing` |

广播结果不明的 reconciliation 分支、workflow 独立步骤失败分支不改；没有增加 GET、重试或审批。

### 2. 卖出 1 个代币的历史状态回放

只读查询已成功交易 `3d1875251f4cb3d479871c428102573dc42fdbf2954fe8b0909cce00ac6933ce`，用冻结 keyless WASM 解析其输出池状态：

- 池 ID：`8c53ed166e6f68c65f0d70a0a05d7b4766ac5fa9ebff15ecac2ce00aaf348a78`。
- FT 储备 91、定价 TBC 储备 10998、实际 Pool output 12500、LP 10000，均为原始整数。
- 费用：LP 25 bps，其余三个费率均 0。
- 输入 1：`floor(10998 × 1 / (91 + 1)) = 119`；`floor(119 × 25 / 10000) = 0`。
- 冻结 Engine/keyless 返回 `AMM swap requires positive retained pool fee`。

独立核对 npm `tbc-contract@1.7.3`，归档 SHA256 `32c3d291e9f566a9ccfcca73d42fe54a25c592361004b2acf3946f04547f028e`。其 `lib/util/tbc-amm/math.js:178-180` 同样要求实际扣除的 Pool value 严格小于 gross TBC output，即有正的池内留存费。没有通过删除判断或改手续费算法来强行交易。

这是对“已知成功买入之后的池状态”的可复现结果，不声称覆盖同事后来再次加池时的全部状态。实时池已撤空，与历史有流动性时的失败分开记录。

### 3. Coin 创建与签名适配

用账户 `164nB7hUpDSx3neWu293wKqW1sRNBg1e3X` 的公开公钥和实时 GET，以下两组均通过 Chain Data、Host Port、Policy、Engine 规划并到达审批；诊断在审批处拒绝，不使用该账户私钥：

- decimals 0 / initialSupply `20`；
- decimals 6 / initialSupply `1000000`。

进一步使用公开合成账户、真实冻结 Engine、mock 链数据和无网络提交的完整 Client→Provider→Host 流程，两组均成功：每组 2 笔依赖交易、一次业务审批、实际 ECDSA 与 BIP340 分阶段签名及 finalize。取数均为 3 次且无重复（nodeinfo、原生 UTXO、父交易）。

独立钱包和 Node 示例之前只实现 ECDSA（compact64 / compact65），不会正确处理创建 Coin 后续的 `secp256k1-schnorr-bip340` / `schnorr64` 任务。本次补齐公共离线示例的算法分派；未知配对明确返回 `SIGNATURE_FAILED`，绝不降级为 ECDSA。生产钱包仍需在自己的安全密钥边界实现 BIP340；示例不提供生产 Vault。

这证明一个可复现的接入缺口，**尚不能证明同事使用了该示例或他的原始失败恰好发生在该步骤**。仍需其端口异常和调用参数。

## 已执行检查

- Core transaction lifecycle：29/29。
- Workflow、signing roles、permissions：51/51。
- 完整业务路径定向测试：6/6（含 2 组 Coin 创建、池维护有/无流动性、微额卖出、空池、ECDSA-only 拒绝、签名编码验证）。
- Core / Host / Provider / Wallet Standard / Kit TypeScript 编译通过。
- `git diff --check` 通过。
- rc.20 JS、配套 iOS / Android SDK、Flutter 归档均匹配原版本锁 SHA256。

测试不等于真实链上验收；本次没有使用真实账户签名，零 POST、零广播，没有重跑已有成功交易。rc.21 的安装检查、原生配对和本地耗时另见候选报告；当前交付包不改动。

## 复现命令

在 `source/` 下，令 `TBC_TEST_WASM_DIR` 指向 rc.20 已验收 `artifacts/wasm` 目录：

```sh
node --test packages/core/test/transaction-lifecycle.test.mjs
node --test packages/core/test/workflow-signing.test.mjs packages/core/test/workflow-signing-roles.test.mjs packages/core/test/permissions.test.mjs
TBC_TEST_WASM_DIR=/path/to/accepted/artifacts/wasm node --test packages/kit/test/host-port-business-errors.test.mjs
TBC_TEST_WASM_DIR=/path/to/accepted/artifacts/wasm node scripts/diagnose-host-port-business.mjs
TBC_TEST_WASM_DIR=/path/to/accepted/artifacts/wasm node scripts/diagnose-host-port-business.mjs --replay
```

最后两条只查报告中的公开测试网状态；签名和广播回调被硬性禁止。历史回放不重新发送原交易。

## 请同事补充

1. Node / 浏览器 / Flutter 环境与版本，Kit、WASM / Native 的准确版本和包来源。
2. 失败方法完整调用片段，包含 `constraints`、`signingRoles`、金额和 receiver；说明用了 Kit 默认取数还是自定义 Port。
3. 失败发生在审批前还是审批后；失败 Port 的 `operation` 和内部异常 name / message / stack（脱敏），以及 Provider 的 code / message / data。
4. 如果是 `signer.sign`，提供 taskId、algorithm、signatureEncoding、purpose，说明是否支持 BIP340；提供相关适配器最小代码片段即可。

不发送助记词、私钥、领取原像、签名值、认证 token、完整签名交易或整个 Vault。已有错误日志优先，不需要为了收集信息重复广播。
