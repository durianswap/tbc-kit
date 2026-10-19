# TWS-002：TBC 链与账户标识

- 状态：Draft
- 版本：1.0.0
- 类型：Core
- 依赖：TWS-000、CAIP-2、CAIP-10

## 1. 目的

本文定义 TWS 使用的 TBC Chain ID、Account ID、地址、公钥、交易 ID 和合约 ID。标识必须在钱包、DApp、Extension、WebView 和 Remote Transport 之间保持一致。

## 2. 为什么不能使用 `bip122`

TBC 是从原始 Bitcoin 历史分叉的 UTXO 链，且 TBC 主网和官方测试网也共享一段早期 TBC 历史。`bip122` 使用创世区块哈希前 32 个十六进制字符，无法区分这些共享创世历史的网络。

TWS 因此定义 CAIP-2 兼容的本地 `tbc` namespace profile。该命名空间在 TWS 内立即具有规范性，但外部 Chain Agnostic Namespace Registry 注册待完成；未来注册不得静默改变本文生成的 Chain ID。

## 3. `tbc` namespace

### 3.1 语法

```text
chain_id = "tbc" ":" reference
reference = registered lowercase network name (1 to 32 characters)
```

完整正则表达式：

```regex
^tbc:[a-z0-9_-]{1,32}$
```

### 3.2 Reference 分配

官方网络固定使用 `mainnet` 与 `testnet`。Chain ID 是网络的可读身份，不是区块证明，不从区块哈希、链尖或 API 域名计算。

```text
chainId = "tbc:" + registered_network_name
```

语法合法不代表网络受支持。默认 Kit 仅注册 `tbc:mainnet` 和 `tbc:testnet`；旧哈希标识不作为这两个网络的别名，不自动重写外部请求或签名材料。

本次草案修改不实施测试网重置标记、历史状态迁移或缓存自动清理；测试环境可重新建立数据。交易哈希、交易内容校验、网络权限隔离不受此命名修改影响。

## 4. 官方网络注册

TWS 固定以下两个可读网络标识，代码中的分隔符必须是 ASCII 冒号。

### 4.1 TBC Mainnet

```text
chainId:      tbc:mainnet
officialApi:  https://api.turingbitchain.io
```

### 4.2 TBC Testnet

```text
chainId:      tbc:testnet
officialApi:  https://api.tbcdev.org
```

机器可读注册表位于 [`registry/networks.json`](../registry/networks.json)。可信 endpoint 由钱包或后端配置，不参与 Chain ID 计算，也不能由 DApp 覆盖钱包选择。

## 5. Account ID

TWS Account ID 遵循 CAIP-10：

```text
account_id = chain_id ":" address
```

示例：

```text
tbc:mainnet:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH
```

规则：

- `chain_id` 必须是第 3 节定义的 TBC Chain ID。
- `address` 必须是目标网络接受的规范显示地址。
- Wallet Host 必须验证地址和 Chain ID 的网络一致性。
- Account ID 区分大小写；实现不得擅自转换 Base58 地址大小写。
- DApp 可以展示原始地址，但跨链存储、权限和签名域必须使用完整 Account ID。

## 6. 原始地址与公钥

- TWS 1.0 的普通账户公钥必须是压缩 secp256k1 公钥：33 bytes、66 个小写 hex 字符，前缀为 `02` 或 `03`。
- 普通账户地址使用 P2PKH：`HASH160 = RIPEMD160(SHA256(compressedPublicKey))`，payload 为 `versionByte || HASH160`，checksum 为该 payload 的 SHA256d 前四 bytes，最终使用 Base58Check 编码。
- TBC Mainnet 与 TBC Testnet 的 P2PKH `versionByte` 均为 `0x00`，规范显示地址都以 `1` 开头。相同公钥在两个网络上产生相同的原始地址；不得用地址前缀推断网络。
- Mainnet/Testnet 必须由受信任的当前 `chainId`、节点配置和完整 CAIP-10 Account ID 区分。任何把 TBC Testnet 当作 Bitcoin Testnet 并使用 `0x6f`（`m`/`n` 开头）的实现都不符合 TWS。
- 钱包必须从其实际控制的密钥验证公钥和地址关系，不能接受 DApp 提供的 `fromPublicKey`。
- Provider 返回的原始地址只用于与现有 TBC 工具兼容；权限存储必须使用 Account ID。
- 助记词、派生路径、导入方式和账户类型属于钱包内部，不进入 Account ID。

测试标量 1 的压缩公钥为 `0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798`，在 Mainnet 与 Testnet 上的规范地址均为 `1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH`；对应 Account ID 因 `chainId` 不同而不同。该标量只用于公开测试，不能承载真实资产。

## 7. 交易与合约标识

### 7.1 Transaction ID

```regex
^[0-9a-f]{64}$
```

所有 TWS 结果必须使用小写 32-byte hex。实现接受外部大写输入时必须在验证后规范化为小写。

### 7.2 Contract ID

TWS 1.0 的 FT、NFT、Stablecoin 和 Pool `contractId` 使用创建该合约的 32-byte Transaction ID，格式同第 7.1 节。

Contract ID 只在其 `chainId` 内唯一。跨链数据库必须使用 `(chainId, contractId)` 组合键。

### 7.3 Native Asset

在能力、错误和预览对象中，TBC 原生资产标识固定为：

```text
tbc:native
```

该字符串不是 CAIP-19 Asset ID，不能与 CAIP-19 混用。

## 8. 网络验证

Kit 默认核对所选网络、官方 profile、Chain ID、可信 endpoint 配置的一致性。主网配置不得使用官方测试网域名，测试网配置不得使用官方主网域名；自定义 endpoint 必须由宿主显式信任。缓存与广播来源绑定仍包含网络身份和 endpoint。

此配置核对不等于远程节点独立证明。若可信 API/RPC 提供已经确认语义的网络名称，宿主可在连接预检中核对；不能把本地填写的名称当作远端验证结果。本次不新增逐笔区块哈希查询，不要求固定锚点，也不假定官方测试部署的 RPC `chain` 一定返回 `test`。

当实际网络与所选网络不匹配时：

- 钱包不得公布该 Chain ID；
- 已连接 Provider 必须把网络视为不可用；
- 针对该网络的请求必须以 `4901` 拒绝；
- 钱包不得自动将请求重定向到另一个网络。

## 9. 新网络注册

新增网络必须通过 TWS 变更提案，提供：

- 网络名称和用途；
- 唯一可读 reference、可信节点配置及验证依据；
- 地址格式和公钥算法；
- 规范测试向量。

官方 reference 保留为 `mainnet` 和 `testnet`；不得用 API 域名或可变 chain tip 生成身份，也不得把语法合法的自定义名字自动注册为官方网络。

## 10. Draft.3 Hash Binding Registry

所有 JCS 条目都使用 RFC 8785、UTF-8、SHA-256 和小写 hex；raw byte 或 identity 条目按机器注册表声明执行。以下 18 个名称是完整集合，任何实现不得增删或重解释：

- `contextHash`
- `requestHash.transaction`
- `requestHash.message`
- `requestHash.typedData`
- `requestHash.permission`
- `requestHash.switchChain`
- `requestHash.workflow`
- `snapshotHash`
- `policyHash`
- `templateHash`
- `planHash`
- `permissionProposalHash`
- `chainSwitchProposalHash`
- `workflowPlanHash`
- `operationHash`
- `bindingHash`
- `releaseFingerprint`
- `checkpointHash`

其中 `operationHash` 是已计算 Hash32 的 identity binding，不再次做 SHA-256；`templateHash` 对 unsigned transaction 的 hex 解码 bytes 计算；其余输入、consumer 与 canonicalization 以 [`registry/hash-bindings.json`](../registry/hash-bindings.json) 为权威。

## 11. 确定性 Operation、Port Call、Commit、Permission 与 Broadcast ID

Draft.3 的 `operationId`、`callId`、Provider Session `commitId`、Permission `id` 和 Broadcast `idempotencyKey` 都是 SHA-256 的 32-byte base64url no-padding，规范显示长度为 43 个字符。字节拼接中的 `NUL` 是单个 `0x00`，十进制字段必须是无前导零的 ASCII：

```text
operationId = base64url(SHA-256(
  "TWS/1.0/operation" || NUL ||
  releaseFingerprint.bytes || contextHash.bytes ||
  JCS(jsonRpcId).UTF8 || NUL || JCS(operation).UTF8
))

callId = base64url(SHA-256(
  "TWS/1.0/port-call" || NUL || operationId.UTF8 || NUL ||
  checkpointRevision.UTF8 || NUL || effectOrdinal.UTF8 || NUL ||
  operationName.UTF8
))

commitId = base64url(SHA-256(
  "TWS/1.0/provider-commit" || NUL || operationId.UTF8 || NUL ||
  checkpointRevision.UTF8 || NUL || JCS(mutationPayload).UTF8
))

permissionId = base64url(SHA-256(
  "TWS/1.0/permission" || NUL || operationId.UTF8 || NUL ||
  chainId.UTF8 || NUL || parentCapability.UTF8 || NUL || ordinal.UTF8
))

broadcastIdempotencyKey = base64url(SHA-256(
  "TWS/1.0/broadcast" || NUL || operationId.UTF8 || NUL || txid.bytes
))
```

`permissionId` 的 `chainId` 必须通过第 3.1 节语法验证，`parentCapability` 必须为非空字符串，`ordinal` 必须是从零开始的非负安全整数；同一 operation 内按规范化 permission change 顺序递增。`broadcastIdempotencyKey` 的 `txid` 必须先验证为 64 个小写 hex 字符，再按显示顺序解码为 32 bytes；不得把 64 个 hex 字符本身作为 UTF-8 输入。

这些 ID 只提供确定性绑定与幂等关联，不可用作密钥、nonce、approval token 或 bearer credential，也不授予任何权限。Transport Session 内 JSON-RPC ID 不得重复，因此相同合法 start 输入表示同一 operation 的恢复，而不是一项新请求。规范字面 KAT 位于 [`test-vectors/identifiers.json`](../test-vectors/identifiers.json)。
