# rc.23：NFT 100 枚部分成功与错误丢失诊断

日期：2026-11-01。任务是复现和定位，不是发布修复。本轮没有真实签名资金账户或广播；没有修改生产代码或当前交付包。

## 结论与证据边界

确认存在 **广播途中审批到期被错误归类为内部失败，公开调用没有带回已成功交易的明细** 的缺陷。已经用冻结 rc.23、真实 Core/Host/Provider 和 WASM Engine，在受控网络/时钟下复现了 `-32603 / The Provider request failed.` 与前 33 笔成功并存。

用户确认反馈对应这一问题。但同事原始调用参数、deadline 和最后 Host 日志尚未取得，因此本报告不把人为设置的第 33 笔到期时间冒充同事原始运行的时序证据。没有证明存在链上“最多 33 枚”的限制。

### 固定产物

- `@tbc/kit 0.1.0-rc.23`；SHA256：`14fa77b6af1248edb5fc89c3dd7104d525c0c07a1529dc3dc0f6d6527d62b88b`。
- 使用包内冻结 WASM，不重新构建引擎，不更改 Native；模拟器此前使用的配套版本仍是 `rc.23.native.2`。
- 源码基线：`8e1c9bd7d3edea7fd9e6c0dacc59a2b80d68ec84`。
- 174 个合作方受保护文件逐项 SHA256 一致。

## 复现结果

共同材料：供应量 300 的合成集合、槽位 200–299、100 枚 NFT、字符串属性、相同媒体 URI；公开合成密钥；测试提交器只记录交易，绝不 HTTP 广播。

| 场景 | 结果 | 审批 / 签名任务 | 模拟接受笔数 |
|---|---|---:|---:|
| 时钟未过期，Client + 手工适配的 session transport | 正常返回 100 个 txid | 1 / 200 | 100 |
| 时钟未过期，直接 Host | `complete`，revision 809 | 1 / 200 | 100 |
| 第 33 笔接受后受控到期，直接 Host | `failed / HOST_INTERNAL / The Core transition failed.` | 1 / 200 | 33 |
| 同样到期条件，实际 `createTbcProvider` → session → Host | `-32603 / The Provider request failed.`，没有部分结果 | 1 / 200 | 33 |

每个场景均为原生币列表 1 次、集合索引 1 次；额外原文、decoded、txo status 读取为 0。未降低审批/材料/绑定/签名校验。普通路径不是最多 33 枚，也不是规划器不支持 100 枚。

未注入故障的两次受控 Node 执行约 95.4 / 94.8 秒；实际 Provider 到期复现约 69.0 秒，首次模拟提交在 56.3 秒。它们是 Node + WASM + 合成网络测试时间，不是 iOS/Android 速度、API 耗时或真实确认速度，不用于声称性能回归。

初次到期测试使用轻量 Provider 适配器，直接收到 `Host operation did not produce a response: failed`，与脚本原先预期的最外层 Provider 文案不同，故保留一次断言失败记录。随后改为使用冻结包真正的 `createTbcProvider` 重跑相同场景，准确复现公开错误，断言通过；未改生产实现以让测试过关。

## 根因链路

1. `source/packages/core/src/reducers/broadcasting.ts:126`：广播每笔前检查到期；到期抛出 `TwsApprovalError(RECEIPT_EXPIRED)`，没有形成带广播进度的终态结果。
2. `source/packages/host/src/driver.ts:152`：该异常不是 `TwsHostError`，被包装为 `HOST_INTERNAL`，原有业务分类丢失。
3. `source/packages/kit/src/wallet-runtime.ts:2447`：Host `failed` 又变成普通 Error，不向公开调用返回成功前缀及停止原因。
4. `source/packages/provider/src/provider.ts:276`：transport 的 rejected promise 变成通用 `-32603`。

**到期停止是正确边界；把它当内部故障，以及公开返回丢失部分成功信息，才是需要修复的地方。** 已接受的独立交易不能由 Kit 自动回滚。不能把普通单次调用包装成“100 笔全部原子成功或全部回滚”的承诺。

## 为什么没有走已有自动分批

`source/packages/kit/src/client.ts:658` 存在两个重载入口：

- 传 `limits`：`tbc_runNftMintJob`，整任务范围/总费用预算、内部子批和结构化部分结果。
- 不传 `limits`，且数量不超过 100：普通 `tbc_sendTransaction`；不会因为数量达到 100 自动切到任务编排。

因此，支持“一次规划 100 枚”不等于“自动走整任务分批”。完整请求仍是确认同事当次入口的最直接证据。当前钱包任务执行器的私有子批上限为 10；它复用整任务材料和前序结果，而不是每批重取全部数据。

默认链数据快照有效期是 120 秒；计划及审批使用请求/材料/政策等约束的较早期限。长任务在准备、签名和提交中消耗同一窗口，不能用“请求中没填 expiresAt”推断不存在到期限制。本轮没有独立复现同事原始默认 deadline 的实际耗尽时间。

## 真实链只读核对

查询时间：2026-11-01T11:09:01Z。API：`https://api.tbcdev.org`。

- 集合：`e7f266c86c6b8981fcfdcd377c15d03f1218202dd7466600a42bed16fb9f86ad`。
- 持有人：`164nB7hUpDSx3neWu293wKqW1sRNBg1e3X`。
- 冻结 Kit `getMintStatus` 校验集合原文、身份和槽位，再核对缺失槽位状态。
- 供应量 300，当前可用 117，已花费 183。
- 200–232 全部已花费；**233–236 也已花费**，237–299 的 63 个槽位仍可用。比同事报告多出的 4 个已花费槽位不能未经日志关联就归为那次请求。
- 此观察证明槽位状态，不替代逐枚 NFT 元数据/收款人/确认数的完整验收。没有重复铸造，没有重发已有交易。

## 建议的下一步修复范围（本轮尚未实施）

1. 收敛 `batchMint` 到已有整任务编排，保留单次审批、总费用预算、并行预取与材料复用；不能默默扩大授权/截止时间。
2. 广播阶段的到期等可预期失败形成类型化终态，保留已接受 txid、未提交部分、未知提交及恢复标识；不要吞成 Host/Provider 内部错误。
3. 对已有 txid/槽位先对账，仅在新授权范围内处理已证明未提交的剩余项。未知 POST 不能当未提交重发。
4. 定向覆盖提交前到期、接受若干笔后到期、节点拒绝/未知结果、自动子批，以及进度完整返回；不要移除校验、无限延时或重跑已成功实链交易。

## 模拟器缓存清理

- 7 个旧 GPU 缓存文件：10,901,112 字节；删除前逐项核对 atime/mtime/ctime 都超过 48 小时、文件未变且没有打开句柄。
- 136 个系统 `com.apple.containermanagerd/Dead` 下的旧安装残留可执行文件：2,937,571,520 字节。仅删除 `TuringClientLab.app/TuringClientLab` 二进制副本；文件最近访问/修改/变更均超过 48 小时，且不属于当前安装路径、不被进程打开。
- 两次删除时段文件系统可用空间合计增加约 **2.71 GiB**（2,906,341,376 字节；系统其他活动会造成小幅波动）。删除的缓存可由重建生成，但没有移动到回收站。
- Android 的可访问旧 TBC App cache/code_cache 未找到符合条件的文件；无法证明超过 48 小时未使用的内容跳过。没有使用不限时间的系统 trim 命令。
- 整个 Dead 目录未删除；其余存在较新访问或不符合筛选条件的文件保留。没有卸载当前 App、删除账户/数据库、测试记录、源码或交付包。

## 复现脚本与证据

- 脚本：`scripts/diagnostics/rc23-mint100/`；复用 `scripts/acceptance/rc23-device/build-fixtures.mjs`，仅诊断模式附加用例。
- `TBC_RC23_REPRO=1 node scripts/acceptance/rc23-device/build-fixtures.mjs`
- `TBC_RC23_SCENARIO=expiry-provider node scripts/diagnostics/rc23-mint100/run.mjs`
- 证据：`evidence/rc23-mint100-repro/report.json`（未注入失败对照）、`expiry-report.json`（保留首轮断言不匹配）、`expiry-provider-report.json`（真正 Provider 复现）、`chain-observation.json`、`cache-cleanup.json`、`dead-binaries-audit.json`、`dead-binaries-deletion.json`。

本报告证明同类缺陷可复现与错误丢失的代码路径；不代表已经修复、发布或完成新的实链 100 枚验收。
