# rc.25 iOS / Android NFT 定向复验

日期：2026-11-01。结论：**主要批量功能和部分成功保留通过；不能判定全绿。原生审批期间到期的错误分类仍有一个缺口，Android 性能存在待定位差距。**

## 版本与范围

- JS：`@tbc/kit 0.1.0-rc.25`，SHA256 `035364a3251415107cdd14500a84e8b99551f4674a46a65373b5171b14dab746`。
- Native：配套冻结 `0.1.0-rc.23.native.2`，artifactSetId `0b5afe3c8f986c8e3835cd7488e68b3986c3be46fdef7ea518fa75dd5d4dc9b4`。
- 协议指纹：`8c2a5a935335463ecedef622011c187c645a9130df1b18610b0fba1262504ce9`。
- 测试网 API：`https://api.tbcdev.org`。无主网操作，无密钥或原像输出。
- iOS 26.5 模拟器 `DA8B84D5-FEFF-4F44-9A21-30E730076411`；Android API 36 arm64 模拟器 `emulator-5556`。
- 新建独立原生验收 App，真实路径为 **DApp WebView → Provider → 钱包 Core/Host → Native Engine / Native Signer → Testnet**。iOS 使用 JavaScriptCore；Android 使用独立 Hermes 0.81.5。不是修改当前钱包或合作方 Flutter App，也不是本轮的 Flutter/真机验收。
- 当前合作方交付的 174 个受保护文件、当前 `artifacts/tbc-kit.tgz`、rc.25 封存清单及配套 Native 文件全部复核不变。未重打包、未发布、未推送。只新增测试脚本、隔离验收工程和证据；已有脏工作树保留。

## 结果矩阵

| 定向场景 | iOS | Android | 证据层级 |
| --- | --- | --- | --- |
| 101 NFT 自动分批、一次批准、材料复用 | 通过 | 通过 | 真实 Native Engine；合成材料/签名、受控提交 |
| 已接纳 1 / 10 / 11 笔后到期，保留成功前缀 | 通过 | 通过 | 受控故障注入，无真实广播 |
| 拒绝、未知结果、原交易已知的对账；不重复提交 | 通过 | 通过 | 受控故障注入 |
| 低层广播到期返回成功/未提交 ID、审批与预取并行、防篡改 | 通过 | 通过 | 受控故障注入 |
| 11 NFT 整批任务，跨 10+1 两个内部批次 | 11/11，1 次审批 | 11/11，1 次审批 | 真实 DApp 路径、真实签名与测试网广播 |
| 总费用 850、每笔 80：前 10 成功后不足以做第 11 笔 | `partial / fee-budget`，10/11 | 同左 | 真实广播；完整保留 10 个成功 txid；未签/未发第 11 笔 |
| 提交任务前已到期 | `stopped / expired`，0 签名、0 POST | 同左 | 真实 DApp 路径，无广播 |
| **打开审批页后到期，再点击批准** | **错误分类失败：-32603** | **错误分类失败：-32603** | 原生 UI；安全停止通过，0 签名、0 POST |

受控套件为每端 11 组，共 22 组通过；不能用它覆盖最后一行真实原生适配器抛异常的情况。未重复执行其他已通过业务。

## 测试网核对

两端各创建一个 22 槽集合，使用槽 1–11 完成任务，再用槽 12–22 验证费用边界；后者只成功到槽 21。两组槽位不重叠，没有重新发送已成功交易。

| 平台 | 独立地址 | 集合 ID |
| --- | --- | --- |
| iOS | `1ERo1RicqQBr1CkqdKgf4JdBEoPETyhVyL` | `f48e7167ec575c5a5d820a5c72d12e0b7454b66525c322f79a6b8c90688d2fda` |
| Android | `18Dfipm9V56Sx6sKMJNvR9Z2tyLAzJN8Ew` | `3c3a5611daad7090e0ab0d7309138fc9455ae586161158cb4098016cf3fe9f4c` |

最终查询高度 **839503**，**44 笔业务交易全部至少 1 次确认**：2 笔集合创建 + 42 笔 NFT 铸造。另有两笔一次性测试资金注入，不计入 44 笔业务验收。

每笔均核对：节点原文计算的 txid、本地广播 journal 的原文 SHA256、真实父输出、输入签名 Script VM、费用、找零持有人。NFT 另用冻结 Keyless 解析器核对新标准、集合 ID、槽位/tokenId 和持有人脚本。每笔铸造费用 80，集合创建每笔 118 最小单位；两端 journal 均 22 个 completed/accepted，无 uncertain。

顺序交易消费未确认前序找零成功；没有等待 confirmations > 0 的隐含门槛。这里的确认数来自后续只读节点查询，不将提交接纳冒充区块确认。全部 txid 和逐笔证明见 [chain-reconciliation.json](evidence/rc25-devices/chain-reconciliation.json)。

## 耗时与取数

以下各 1 次独立实测，不是均值、P95 或真机性能保证。计时从批准动作完成起，不含阅读审批页的人工时间。

| 场景 | iOS 批准→最后签名 | Android 批准→最后签名 | iOS 批准→钱包返回 | Android 批准→钱包返回 |
| --- | ---: | ---: | ---: | ---: |
| 集合创建 | 28 ms | 254 ms | 191 ms | 913 ms |
| 11 NFT，跨两批完成 | 1,877 ms | 18,521 ms | 2,013 ms | 19,006 ms |
| 11 NFT 预算边界，成功 10 后停止 | 351 ms | 8,402 ms | 2,469 ms | 17,600 ms |

“到最后签名”**不是纯签名计算时间**：跨批任务中包含之前批次的构建、签名、顺序广播和后续批次准备。11 个 NFT 的 Native 签名计算合计 iOS 17.2 ms、Android 49.5 ms；Android Engine 实测合计约 148 ms，POST 网络阶段合计约 2,830 ms。其余本地 JS、桥接、序列化/校验、journal 和验收记录开销尚未完整分离，不能据此宣称已定位全部瓶颈。

每个真实批量任务 **只有 3 次 GET**：原生 UTXO、集合槽位索引、集合原文。均与一次审批并行；第二个内部批次没有重复 GET，复用了首批已验证材料和前序交易结果。取数计数不包含事后只读链上核对。

Android 的差距不能归因为多下载材料，也不是 Rust 签名计算占主导。本轮没有旧版本同设备同口径对照，**尚不能宣称是 rc.25 新增回归，也不能宣称性能门禁已通过**。验收 App 带计时和报告记录，数值不能直接当作合作方正式 App 速度。没有通过删校验、延长授权期限或更换签名算法提速。

## 仍需修复：审批期间到期的异常映射

真实步骤：任务进入一次原生审批页 → 等到 scope.limits.expiresAt → 点击批准。两端原生 fence 正确拒绝过期授权，未生成签名、未广播。但 `nft-mint-job.ts` 的 `await adapter.approve(...)` 没有处理适配器因到期而 reject，异常穿透至 Provider 变为 `-32603`，丢失业务上的 expired 结果。

对冻结 rc.25 的公共钱包/DApp 路径另做离线最小复现：

1. 适配器在 deadline 后抛错：**失败**，得到 `-32603`，应得到 `stopped / expired`。
2. 适配器在 deadline 前无关错误：维持错误，不能伪装成 expired。
3. 曾及时批准的回执稍后返回、时间已过：得到 `stopped / expired`，通过；这也是原受控 expiry 用例覆盖的路径。

脚本 `scripts/acceptance/rc25-device/approval-expiry-repro.mjs` 当前故意退出 1，保留为红灯证据；结果见 [approval-expiry-repro.json](evidence/rc25-devices/approval-expiry-repro.json)。不能删除这条失败或用已有成功用例替代。

推荐下一补丁仅收口等待审批的异常边界：在确认本任务已取消/到期时生成明确停止结果；非到期的适配器故障、防篡改失败仍保留真实错误。不扩大授权、不重置 deadline、不补签，不增加取数。需要新候选的定向复验，不能原地改已封存 rc.25。

## 验收工程自身的限制与已纠正问题

- 创建 profile 初稿字段形状和首次 iOS 手写批次 envelope 缺字段，均在业务签名/POST 前拒绝；修正的是测试输入，不是 Kit 交易逻辑。保留原失败记录。
- 从旧独立验收模板沿用的原生 `jobConsent` 是单任务/进程门禁；仅重建 JS VM 不清空它，所以第二任务会在 native adapter 拒绝。已证明零新增签名/POST，保留记录后用新进程执行新任务。不是把失败交易换 txid 重发。此模板生命周期限制不应当作正式钱包接入设计。
- 计时采集已按本次 request 分段，未把上一次成功签名/返回时间算入到期请求；错误案例没有签名时显示空值。
- 独立原文核对初稿误将 NFT Hold 当普通 P2PKH，已对齐真实 `V0 Curr NHold` 后缀并严格检查 controller；没有改变合约或放松业务验证。

## 证据和下一步

- [完整机器结果](evidence/rc25-devices/final-summary.json)
- [受控双端结果](evidence/rc25-devices/controlled-summary.json)
- [逐笔确认与 Script VM 核对](evidence/rc25-devices/chain-reconciliation.json)
- [iOS 到期错误画面](evidence/rc25-devices/ios-expiry-result.png)、[Android 到期错误画面](evidence/rc25-devices/android-expiry-result.png)
- 证据校验清单：`evidence/rc25-devices/evidence-sha256.json`；关键验收运行时快照位于同目录 `runtime/`。

下一轮只需修复/复验审批到期异常映射，并进一步拆分 Android 的本地执行耗时；无需再广播这些已完成的 NFT，不需要重跑全量业务。当前交付包继续保留，rc.25 暂不据本报告提升为“全绿最终交付”。
