# rc.20 分发精简定向报告

## 结论

新本地候选为 JS `0.1.0-rc.20`，配套原 Native SDK
`0.1.0-rc.19.native.2`。本轮只调整依赖、分发与说明，不改变交易实现、
签名算法、审批绑定、并行预取或校验。未发布、未推送，当前 rc.19 和合作方
Flutter 交付保持原样。

## 体积（十进制 MB，同口径实测）

| 项目 | rc.19 | rc.20 | 变化 |
| --- | ---: | ---: | ---: |
| JS npm 归档 | 44.022 MB | 5.533 MB | -87.43% |
| Kit 展开文件 | 139.077 MB | 35.624 MB | -74.39% |
| 干净安装 node_modules 总量 | 154.533 MB | 39.861 MB | -74.21% |
| iOS SDK 归档 | 43.687 MB | 43.687 MB | 字节不变 |
| Android SDK 归档 | 36.109 MB | 36.109 MB | 字节不变 |

安装目录按普通文件逻辑字节数统计，不重复计入 npm 的 `.bin` 符号链接。
原生 SDK 只按目标平台另取，不再随 JS 包重复携带。可选底层资源归档用于
自定义 FFI，普通 Swift/Kotlin/RN 接入只需要配套 SDK。不要把所有可选附件
合成一个必须下载的大包，也不要把 npm 减少比例当成手机 App 减少比例。

## 实际改动

1. `tbc-contract@1.6.6`、`tbc-tx-parser@0.1.10` 从 runtime dependencies
   移到 devDependencies；`tbc-lib-js` 仍为构建依赖。新消费者不再安装这三个
   完整 SDK，也不再由它们引入 axios/secp256k1 等依赖。
2. 私有解析器所需的 `elliptic`、`bs58`、`hash.js` 保留；未删除仍有实际用途的库。
3. npm allowlist 不再包含 Native/keyless-native 二进制。带哈希的平台目录与
   Native SDK 原有版本锁共同校验平台资源，无安装钩子、运行时下载或静默回退。
4. 常规源码构建/打包规则同步更新，防止下一次构建重新装入完整 SDK 和全部原生库。
5. 文档补齐 NFT `batchTransfer`、`getMintStatus`、`listDeposits`、`verifyTransfer`
   等已有能力，明确 PiggyBank/timelock、Pool v1 边界及 Legacy 的适配方向。
   未把文档补齐冒充新合约实现。

## 定向验证

- 17/17 单元与桥接定向测试通过：分发策略、源码版本门禁、平台目录、防篡改、
  错配拒绝、桥接并发与错误透传。没有新增串行队列。
- 精确 tarball 干净安装通过；8 个公开入口 ESM/CJS 和 Node/browser/RN
  条件解析通过；公开声明及 DApp/钱包两个 TypeScript 消费模板通过。
- 958 个执行代码、类型、桥接示例、WASM/Native 文件与 rc.19 原字节相同。
- 5 个浏览器消费构建（API、RPC、连接、钱包、Prepared）的产物 SHA256 完全相同。
- 构造客户端及 Engine 时网络/WASM 调用为 0；8 路并发首次调用只加载各自 WASM
  一次，重复调用不再下载；注入 Native 后不加载 WASM。
- 原配套 iOS、Android SDK 分别在独立目录装配成功；分别复制 20/21 个文件，
  不携带另一平台 SDK。篡改文件和错误平台均拒绝。三份可选原生资源逐文件校验通过。
- 5 个离线示例运行与 rc.19 输出完全一致：后端签名、受控发送/结果核对、多轮归集、
  审批展示、多钱包发现。后端示例保持一次授权，受控请求计数未增加；模拟响应丢失
  后核对结果，不重新提交。**这些是合成数据，不是真实链广播。**
- 174/174 合作方冻结文件前后 SHA256 一致；原公开仓库 main 工作树未改动。

## 速度口径

运行代码、WASM、Native 与浏览器构建字节相同，本次没有增加热路径工作或 API 取数。
Mac/Node/WASM 交错运行、预热后各 100 次 `normalizeRequest`：

| 指标 | rc.19 | rc.20 |
| --- | ---: | ---: |
| 中位数 | 0.202 ms | 0.221 ms |
| P95 | 0.314 ms | 0.305 ms |

这是亚毫秒本地微基准，0.019 ms 的差值不能解释为设备交易性能变化；不能用它
宣称签名加速。业务执行字节未变。本轮未重新运行手机完整构建、端到端签名测速、
真实节点或资金广播，不将安装/装配检查表述为双端链上验收。

## 仍需如实说明

- npm audit 仍报告 2 个 low 条目，0 moderate/high/critical，相关于现有
  elliptic 依赖链。不能声称清零漏洞；本轮不替换密码学实现。完整数据在 evidence。
- 新 Kit DApp 不能自动连接仅提供旧 `window.Turing` 的钱包；需要钱包升级标准
  Provider，或 DApp 保持独立旧钱包接入。未新增反向适配器。
- 历史 PoolNFT/Pool v1 不是新增支持范围；PiggyBank 是现有 height-based timelock。
- 手机 App 仍需目标平台的原生库，当前 Flutter 包与 App 增量没有因此变化。
- 只有新的候选目录描述 rc.20；仓库 `release/current.json` 仍刻意描述冻结 rc.19，
  不能在本候选源码上用它冒充 rc.20 的新发布清单。

## 产物与复核

本目录包括 `tbc-kit.tgz`、两端原 SDK、三个可选平台资源归档、`source.tgz`、
`source-manifest.json`、`delivery-lock.json`、原 `native-sdk-lock.json`、接入 README
与定向证据。归档不覆盖旧交付；以 `SHA256SUMS` 复核全部文件。

JS SHA256：`78da28e717ce4d4234923f2b91c3fd4c01176f641def88981b2c6cba4c0c3614`

协议指纹：`8c2a5a935335463ecedef622011c187c645a9130df1b18610b0fba1262504ce9`

复现入口：`scripts/prepare-lean-candidate.mjs` → 原安装包检查脚本
`source/packages/kit/scripts/check-install-candidate.mjs` →
`scripts/check-lean-candidate.mjs` → `scripts/finalize-lean-candidate.mjs`。
每次使用新的输出目录；候选创建脚本拒绝覆盖已有目录。
