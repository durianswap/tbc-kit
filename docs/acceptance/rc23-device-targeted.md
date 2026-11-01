# rc.23 双端定向复验

日期：2026-11-01。范围仅为 NFT 输入预算、AMM 控制人规范化和错误分类；未重跑全量功能，未广播。

## 产物与边界

- JS：`0.1.0-rc.23`，SHA256 `14fa77b6af1248edb5fc89c3dd7104d525c0c07a1529dc3dc0f6d6527d62b88b`。
- Native：`0.1.0-rc.23.native.2`，使用已冻结 iOS Simulator 静态库及 Android AAR，不重新编译 Rust。
- iOS：iOS 26.5 / arm64 Simulator，独立 `io.tbc.rc23.acceptance`。
- Android：Android 16 / API 36 / arm64-v8a，`emulator-5556` 上同名独立 App。
- WKWebView / Android WebView 运行实际冻结 Kit，调用 Swift / Kotlin Native JSON bridge。
- Provider→Host→Engine→Signer→finalize 使用公开合成测试密钥、受控审批适配器和模拟提交。没有真实 HTTP 广播、真机测试、手工审批 UI 或 100 枚实链整批完成的证据。
- 展开后 973 个包文件逐项匹配冻结 tar；JS、iOS SDK、Android SDK 归档哈希及 174 个合作方保护文件均未改变。没有修改生产代码、签名算法或校验规则。

## 结果

两端各 10 组全部通过；每端实际 Native 另通过 22 个向量及 16 并发调用。

| 定向范围 | iOS | Android |
|---|---|---|
| AMM 1–5 控制人，排序/未排序，普通及 workflow 入口：相同签名交易与读取次数 | 通过 | 通过 |
| 空、重复、超额控制人及非法费率，返回参数错误，审批/签名/提交为 0 | 通过 | 通过 |
| 普通 LP lock/unlock：明确 `UNSUPPORTED_POOL_OPERATION` | 通过 | 通过 |
| 122/128/256 手续费候选不挤占 100 个铸造槽位；257 候选、129 exact 输入仍拒绝 | 通过 | 通过 |
| 缺材料、已花费槽位、错误槽位、接口失败及恢复，保留具体错误原因 | 通过 | 通过 |
| 122 候选下 1/7/100 枚 Native 规划及 validate，共用同一材料 | 通过 | 通过 |
| 7 枚 Provider→Native finalize，1/122/256 候选：每次 1 审批、14 签名任务、7 模拟提交 | 通过 | 通过 |
| NFT Provider 槽位冲突及拒绝审批：不签名、不模拟提交 | 通过 | 通过 |

每端 23 个成功 Provider 业务调用均只有一次审批。NFT 7 枚场景固定为一次原生币列表读取、一次集合索引读取，原文/decoded/status 额外读取均为 0；增加候选数不增加读取。已知材料复用，状态查询仍保留原分批及至多 4 并发门禁。

## 本地时间参考

以下为受控测试组总耗时，不是用户点击到链上确认，也不是与 rc.22 的同设备性能对照。

| 测试组 | iOS | Android |
|---|---:|---:|
| 20 个 AMM 排序对照调用合计 | 1544 ms | 2129 ms |
| NFT 1/7/100 枚 Native 规划及 validate 合计 | 46 ms | 66 ms |
| 7 枚铸造的三个候选数对照调用合计 | 601 ms | 1130 ms |

未增加网络读取，未修改生产执行路径。不能由这些数字承诺真机/真实网络延迟或断言跨版本端到端速度相同。

## 新收到的独立问题：100 枚实链部分成功

用户随后提供同事的 rc.23 实链报告：请求铸造槽位 200–299，报告已有 33 枚（200–232）出现，调用却返回 `-32603 / The Provider request failed.`。随后已另做只读链核对和受控到期复现，详见 [100 枚部分成功诊断](rc23-mint100-diagnosis.md)；不能将这份早先设备复验报告当作新问题已修复。

这个问题未被上述受控通过覆盖：本轮 100 枚只核对材料、规划和 validate；实际 Provider→签名→模拟提交覆盖的是 7 枚，不能当成 100 枚真实提交已通过。

只读源码确认：`client.ts` 的 `batchMint` 在有 `limits` 时走 `tbc_runNftMintJob`；没有 `limits` 且不超过 100 项时走普通 `tbc_sendTransaction`。因此“允许 100 项单次构建”不等于“自动进入整任务分批执行”。当前钱包任务执行器的内部子批为 10（还可能因资源限制缩小）。同事报告未附完整参数/最后 Host 操作，尚不能确认当次走了哪条路径或为何在第 33 枚后中断。

多笔已被节点接受的交易无法由 Kit 回滚。后续应先按原 txid/槽位只读对账，确定已完成、未提交及未知部分，再定位失败与结果丢失边界；不能整批盲重发。本轮未因这个新问题更改生产实现或发布新包。

## 环境处理与证据

Android 最初因低空间门槛拒绝安装。经用户授权，先调用系统缓存回收；未释放足够空间后，仅清除四组旧独立 probe 的 16 个重复 `.so` 缓存文件，清除前确认未被进程映射，并逐项哈希校验及本机去重备份。模拟器实际可用空间增加 79,640 KiB（约 77.8 MiB）。未卸载任何现有钱包，未清理账户、数据库、向量或验收记录；副本可恢复。

- `evidence/rc23-devices/summary.json`：双端结果摘要。
- `evidence/rc23-devices/ios.json`、`android.json`：操作/读取/Native 分段记录。
- `evidence/rc23-devices/native-devices.json`：22 个 Native 向量及并发结果。
- `evidence/rc23-devices/integrity.json`：冻结包和合作方保护核对。
- `scripts/acceptance/rc23-device/`：独立受控测试源码。未并入运行时包。
