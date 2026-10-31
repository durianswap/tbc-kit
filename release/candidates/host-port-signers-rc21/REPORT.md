# rc.21 定向修复与接入验证

## 已确认并修复

1. **真实发布示例遗漏**：直接调用 rc.20 已安装独立钱包 Signer，传入 Schnorr
   任务，原示例返回 compact64 ECDSA，BIP340 验证失败。rc.21 同一公开向量返回
   schnorr64，验证成功。Node 原示例有相同的无条件 ECDSA 实现，现共用修复。
2. **类型化错误丢失**：底层 INVALID_INPUT / CONFLICT / SIGNATURE_FAILED 等
   被 Core 统一改成 internal failure。已按原协议恢复映射，只公开白名单原因，
   不透传任意适配器 message/details/stack。广播不明结果的核对分支保持原样。
3. **新 AMM 与旧维护范围不明确**：对新池调用旧 Pool2 mergeToken/burn，返回
   UNSUPPORTED_POOL_OPERATION。SDK 1.7.3 和当前 1.7.4 新 AMM 均无这两个
   独立历史维护接口；新池减池和持有人 LP 合并不是这两个方法。
4. **微额兑换错误不明确**：历史池回放卖出 1 个代币得到 gross 119，25 bps
   留存手续费舍入为 0，固定 SDK 和 Engine 都拒绝。现明确返回
   AMM_RETAINED_FEE_ZERO；空池独立返回 AMM_POOL_INACTIVE。不改合约计算。

## 签名示例审计

| 位置 | 结论与处理 |
| --- | --- |
| independent-wallet、backend-node | 确实遗漏 Schnorr；统一为共享三配置分派 |
| sign-in | 原本只演示可恢复消息签名；复用共享分派，原登录安全负例保留 |
| third-party-wallet-minimal | 注入外部 Signer 的普通 TBC 验收工具，不是全业务模板；指南明确范围 |
| Swift / Kotlin / WASM signer primitives | 已有 Schnorr ABI tag 164；原 Rust 测试复验通过，不改算法 |
| Flutter PartnerTbcIntegration | 注入钱包 NativeDigestSigner，不提供默认 Vault；当前 Flutter 配置与完整 JS 管理员能力区分说明，冻结包不改 |
| multi-round/legacy 示例 | 复用执行器或业务映射，没有另一套通用 ECDSA-only Signer |

同时修正初始修复草稿的可恢复消息算法名：准确值为
`secp256k1-recoverable-ecdsa-sha256d`，不是普通交易 ECDSA 的算法名。
六种错配组合均拒绝；未知算法不会静默降级。

## 验证

- Core 生命周期、workflow、角色、权限：80/80。
- Kit 完整路径定向测试：6/6；同一组在源码与干净安装候选上均通过。
- Rust signer 原有兼容用例：6/6，含独立 BIP340 官方向量、ABI、无效输入。
- 7 个已安装示例场景与 rc.20 输出一致，包括一次 workflow 审批、登录及广播
  丢失响应后的受控核对。16 个 ESM/CJS 入口可加载。
- Coin 两组 decimals/supply 均完成 2 笔依赖交易的合成全过程：每组一次审批，
  ECDSA + BIP340 继续签名；3 次必要材料 GET fixture，无重复取数，实际 POST=0。
- iOS、Android 全新 RN 模板按原 Native SDK 版本锁安装及校验通过；不是设备运行验收。
- 460 个冻结 WASM/私有解析器文件保持相同；174 个冻结交付文件复核相同。
- 没有改签名算法、网络读取策略、审批/预取流程、schema 或协议指纹。

## 性能与体积

JS 安装包 5,541,374 bytes，rc.20 为 5,533,148 bytes，增加 8,226 bytes
（约 8.0 KiB / 0.15%），主要是指南、示例和错误映射。

Mac Node 交错运行，每样本为两组完整合成 Coin 创建，剔除首轮：

| 轮次 | rc.20 中位数 | rc.21 中位数 | 差异 |
| --- | ---: | ---: | ---: |
| 首轮 6 对 | 197.02 ms | 199.57 ms | +1.30% |
| 第二轮 6 对 | 196.03 ms | 193.24 ms | -1.42% |

未观察到一致的性能倒退，不把这些小幅波动宣称为提速。原生计算文件不变，
新增失败分类只在失败分支执行；签名分派不取数或重复计算摘要。
以上不是 iOS/Android 真机或真实节点端到端速度，不能据此承诺所有设备零回归。

## 未确认及不包含

- 现场 Coin 创建失败是否确实使用该 ECDSA-only 示例，仍需同事 Port/Signer 日志。
- 再次加池后的失败缺当时状态，历史回放不覆盖该次尝试。
- 没有真实签名账户、真实广播或重发既有交易；没有重打包 Flutter/Native。
- 没有新增新 AMM 历史维护方法或改变零留存手续费规则。

候选来源、归档、配对和证据由 delivery-lock、source-manifest 与校验清单固定。
