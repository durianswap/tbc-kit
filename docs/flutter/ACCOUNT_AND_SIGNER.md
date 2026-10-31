# 账户与签名适配

钱包继续使用现有的账户恢复、密码、生物识别和密钥托管系统。接入 Kit 时，只提供公共账户信息、可信审批回调和受控签名结果，不把助记词或私钥传给 DApp。

## 派生与账户格式

TBC 默认派生路径沿用现有钱包规则：

```text
m/44'/236'/0'/1/0
```

使用 BIP39 → BIP32、secp256k1。BIP39 passphrase 不等于钱包解锁密码；不要把解锁密码加入派生。导入账户保持原本来源和恢复规则，不使用 EVM/Tron 路径重新替代 TBC 账户。

公钥为 33 字节压缩 SEC 格式，以 `02` 或 `03` 开头。地址算法为：

```text
Base58Check(0x00 || RIPEMD160(SHA256(compressedPublicKey)))
```

主网与测试网使用相同原始地址格式，通过 `chainId` 区分。Kit 账户标识为 `chainId:address`，例如 `tbc:testnet:<address>`。地址和公钥必须属于同一账户。

普通 TBC 转账的找零返回当前所选地址；代币及合约的找零输出由 Kit 构建。此接入规则不自动创建滚动找零、多账户递增路径或新的恢复扫描策略。

## 当前账户接口

实现原生 `NativeAccountSource`：

| 字段 | 含义 |
| --- | --- |
| `current` | 当前选定的 `NativeAccount(address, publicKey, chainId)` |
| `revision` | 账户状态递增序号；Swift 为 `Int64`，Kotlin 为 `Long` |
| `unlocked` | 钱包当前是否允许进入签名流程 |
| `signingAccounts` | 钱包当前选定且可用于相应角色的账户；默认只有 `current` |

不要把整个 Vault 的账户全部作为可签名账户返回，也不要使用 DApp 声称的地址来选择私钥。锁定/解锁、账户选择或密钥可用性变化时，更新状态和 `revision`，再通知 `walletStateChanged()`。

## 审批界面接口

实现 `NativeApprovalPresenter.present`。Kit 提供 `NativeReview`，包含：

- `operationId`：本次操作标识。
- `origin`、`chainId`、`accountAddress`：请求来源、网络和账户。
- `title`、`description`：Kit 生成的操作说明与审批材料。

用钱包自己的可信界面展示这些字段；不要以网页自己的标题或确认弹窗替代。用户批准时回调 `true`，拒绝或关闭时回调 `false`。回调只完成一次；返回的关闭句柄必须可重复调用，以便导航、账户变化或取消时安全关闭界面。

批次内可以有多个签名任务，不能把“调用一次 Signer”理解为“再弹一次交易审批”。保留 Kit 的批次授权范围；钱包密码/生物识别仍按自身解锁策略处理，不形成跨请求的无限自动授权。

## 摘要签名接口

实现 `NativeDigestSigner.sign`。接口输入包括 `account`、`digest`、`encoding`、`requireCurrent` 和结果回调。

执行顺序：

1. 按任务绑定的 `account` 选择钱包内的对应密钥。
2. 完成钱包需要的密码或生物识别解锁。
3. 在实际使用密钥前调用 `requireCurrent()`；失败则立即终止，不签名。
4. 对给定 32 字节 `digest` 直接做 secp256k1 ECDSA，返回要求的编码。
5. 成功或失败均只回调一次；Swift 回到 MainActor，Kotlin 回到注册宿主的执行线程。

不要再次哈希、反转字节，或加 Ethereum personal-sign 前缀。现有 web3dart 摘要签名计算可以复用，但应封装成钱包自己的私有签名服务，再由 Swift/Kotlin 适配器接入；不要向 WebView 暴露通用 `signDigest` 或私钥返回接口。

## 签名结果格式

| `encoding` | 返回字节 |
| --- | --- |
| `compact64` | 32 字节 r 加 32 字节 s；大端、左侧补零、low-S |
| `compact65-recoverable` | 1 字节 header 加 32 字节 r 和 32 字节 s；header 为 `31 + recoveryId` |

交易签名的返回值不带 DER 或 sighash 后缀；Kit/Engine 负责装配。消息签名也只签 Kit 传入的摘要，消息的域、前缀和返回形状由 Kit 处理。

以上是当前 Flutter 接入配置的 ECDSA 格式，不代表完整 JS Kit 的所有合约都只需要 ECDSA。完整 Kit 的新版 Coin 创建/管理员任务还可能要求 `secp256k1-schnorr-bip340` / `schnorr64`，详见[完整签名适配指南](../../packages/kit/docs/signer-integration.md)。web3dart 的 ECDSA `r/s/v` 不能转换为 Schnorr；底层 Rust/Swift/Kotlin 签名原语已有独立 Schnorr 编码，但仅替换算法并不能自动扩大 Flutter 的业务及审批配置。本轮不改变已交付 Flutter 包的能力或二进制。

如果直接使用未额外包装的 web3dart 2.7.3 `sign()`，它返回 `r`、`s`、`v`，其中 `v = recoveryId + 27`：

```text
compact64 = r32 || s32
recoveryId = v - 27
header = v + 4
compact65-recoverable = header || r32 || s32
```

仅对上述明确的 v 语义使用该转换。若钱包包装层返回的是 0/1 或 EIP-155 交易 v，不能直接加 4。low-S 与恢复位必须对应；不得只改 s 而不处理恢复位。r/s 不能丢失左侧补零。

web3dart 的未压缩公钥不能直接用于 TBC 地址计算，应先转为 33 字节压缩格式。不要用 Ethereum 的 Keccak 地址函数生成 TBC 地址。

## 加解密适配

需要 `encrypt/decrypt` 时，实现 `NativeBie1Executor` 并作为 `crypto` 参数传入原生接线模板。输入为账户、加密/解密用途、字节数据、`requireCurrent()` 和结果回调。

BIE1 与 ECDSA 摘要签名是不同能力，不能用签名结果代替密文，也不能自行换成不兼容的加密格式。在实际密钥使用前同样检查 `requireCurrent()`，完成后清理钱包创建的临时密钥/明文缓冲区，不记录明文、密钥或领取原像。

新加密消息按解码后最多 65,536 字节处理；中文和 emoji 按 UTF-8 字节计。读取解密结果时依据 `message.encoding` 解码，不要假定结果永远是 base64。

## 私钥与数据边界

- 私钥由钱包自己的托管边界管理，不进入 DApp、共享 JSON、日志或文档。
- 不在接入模板中硬编码账户或默认批准交易。
- 不因解锁成功跳过账户、来源、审批和任务绑定检查。
- 不自行重试已经消费的签名任务，也不把超时当成可重新广播的依据。
- 保留 Kit 管理的权限与必要提交记录；普通签名和广播恢复的职责不同，不另建一套相互冲突的恢复流程。
