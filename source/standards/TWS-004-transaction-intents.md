# TWS-004：Transaction Intent

- 状态：Draft
- 版本：1.0.0
- 类型：Core / Assets / DeFi
- 依赖：TWS-000、TWS-001、TWS-002、TWS-003

## 1. 目的

Transaction Intent 描述用户希望完成的业务结果。DApp 不选择 UTXO、不构造解锁脚本、不传入 WIF，也不决定找零和维护交易。

钱包必须按以下边界执行：

```text
Intent -> validate -> plan -> preview -> user approval
       -> sighash -> Signer -> finalize -> optional broadcast
```

`tbc_signTransaction` 在完成签名后返回交易包，不广播。`tbc_sendTransaction` 在完成签名后按依赖顺序广播。

## 2. 数字与编码

- 所有 TBC、FT、Stablecoin、LP token 金额必须是最小单位的无符号十进制字符串。
- 零的唯一形式是 `"0"`；非零值不得有前导零、加号、小数点、指数或空格。
- 金额正则表达式为 `^(0|[1-9][0-9]*)$`。
- `tbc.transfer` 和交换输入金额必须大于零。
- FT `decimals` 是 0 至 18 的 JSON integer；`initialSupply` 仍使用最小单位字符串。
- Transaction ID 和 Contract ID 必须是 64 个小写 hex 字符。
- Raw Transaction 必须是偶数字节的小写 hex 字符串。
- 原生 TBC 的语义最大值是 `2100000000000000` satoshi；任何输入、输出或中间算术都不得超过链和具体合约版本的更严格限制。
- FT 总量可以由具体版本使用 UInt128，但单个 slot、LP 或 Pool state 可能仍是 UInt64。Schema 的十进制正则不替代资产版本范围验证。
- 当前 version-10 交易的 `txid` 必须按 TBC 共识 transaction-header 算法计算，不能误用 Bitcoin 的完整 raw transaction SHA256d。

钱包不得把金额转换为 JavaScript `number` 后再做签名或交易计算。所有加、减、乘、除必须使用 checked integer arithmetic；Legacy 人类小数必须在适配器边界精确换算，进入 Core 后只能是最小单位整数。

## 3. Transaction Request

```ts
interface TransactionRequest {
  version: "1.0";
  chainId: TbcChainId;
  from: string;
  clientRequestId?: string;
  intent: TbcIntent;
  constraints?: {
    expiresAt?: string;
    maxFee?: AtomicAmount;
    feePreference?: "economy" | "standard" | "priority";
  };
}
```

规则：

- `from` 是目标 Chain ID 上、调用 Origin 已获授权的原始 TBC 地址。
- Wallet Host 必须把 `from` 与 `chainId` 组合为 CAIP-10 Account ID 后做权限判断。
- `clientRequestId` 是 1 至 128 字符的 DApp 幂等键，只在当前 Trusted Session 内有效。
- 同一 Session 内重复的 `clientRequestId` 与完全相同的规范化请求必须复用未完成或已缓存结果；内容不同必须返回 `CONFLICT`。
- `expiresAt` 接受 UTC 整秒或 1–3 位小数秒，新生成时间统一使用 `YYYY-MM-DDTHH:mm:ss.SSSZ`；不接受时区偏移、微秒或非法日期。按实际时刻比较且不改写已绑定原文。钱包默认有效期不得超过五分钟，也不得接受超过当前时间十分钟的 DApp 有效期。
- `maxFee` 表示整个 Transaction Bundle 允许消耗的 TBC 最大矿工费。
- 省略 `feePreference` 时使用钱包的 `standard` 策略。
- DApp 不得提供 API endpoint、UTXO、change address、fee UTXO、service fee rate、活动网络或密钥来源。
- 所有对象都使用严格 Schema；未知字段必须以 `-32602` 拒绝。

交换 Intent 必须提供 `constraints.expiresAt`。钱包还应在计划阶段验证最小输出。

## 4. Core Intent

### 4.1 `tbc.transfer`

```json
{
  "type": "tbc.transfer",
  "version": "1.0",
  "to": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "amount": "1000"
}
```

- `amount` 必须大于零，单位为 satoshi。
- `to` 必须是目标网络支持的 TBC 地址；可以是钱包明确支持的 P2PKH 或 MultiSig 地址。
- TWS 1.0 每个 Intent 只允许一个业务接收方。钱包生成的找零和内部维护输出不计入该限制。

## 5. Assets Intent

### 5.1 Media Reference

Collection 和 NFT 使用以下二选一结构：

```json
{
  "kind": "uri",
  "uri": "ipfs://bafy...",
  "sha256": "0123...cdef"
}
```

```json
{
  "kind": "base64",
  "mediaType": "image/png",
  "data": "iVBORw0KGgo...",
  "sha256": "0123...cdef"
}
```

- URI 只允许 `https`、`ipfs` 和 `ar` scheme。
- `sha256` 在 URI 模式可以省略，在 base64 模式必须存在并匹配解码字节。
- base64 必须是标准 RFC 4648 编码，解码后不得超过 2 MiB。
- 钱包必须在批准页标记外部内容，并防止预览请求泄露未经用户同意的网络信息。

### 5.2 `tbc.collection.create`

```json
{
  "type": "tbc.collection.create",
  "version": "1.0",
  "name": "Genesis Collection",
  "description": "...",
  "supply": "2000",
  "media": {
    "kind": "uri",
    "uri": "ipfs://bafy..."
  }
}
```

- `name` 为 1 至 64 个 Unicode scalar value。
- `description` 最多 2048 个 Unicode scalar value。
- `supply` 必须是 `"1"` 至 `"2000"`。
- Collection 的控制权归 `from` 账户；TWS 1.0 不提供由 DApp 指定另一个初始 owner 的字段。
- 成功结果的主要交易 ID 同时是 `collectionId`。

### 5.3 `tbc.nft.mint`

```json
{
  "type": "tbc.nft.mint",
  "version": "1.0",
  "collectionId": "1111111111111111111111111111111111111111111111111111111111111111",
  "name": "Turing 001",
  "symbol": "TRG",
  "description": "...",
  "attributes": [
    { "traitType": "Color", "value": "Acid Green" }
  ],
  "media": {
    "kind": "uri",
    "uri": "ipfs://bafy..."
  }
}
```

- `name` 为 1 至 64 个 Unicode scalar value。
- `symbol` 为 1 至 16 个可见 ASCII 字符。
- `attributes` 最多 64 项；`traitType` 最多 64 字符，`value` 只能是字符串、布尔值或 JSON safe integer。
- `media` 可以省略；省略时钱包可以使用 Collection media，但必须在预览中显示实际采用的内容。
- 新 NFT 必须铸造给 `from` 账户；钱包必须验证 `from` 具有该 Collection 版本要求的铸造权限。
- 成功结果的主要交易 ID 同时是 NFT `contractId`。

### 5.4 `tbc.nft.transfer`

```json
{
  "type": "tbc.nft.transfer",
  "version": "1.0",
  "contractId": "1111111111111111111111111111111111111111111111111111111111111111",
  "to": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"
}
```

钱包必须验证目标地址满足该 NFT 合约版本的接收条件。不能支持的地址类型返回 `POLICY_VIOLATION`，不得自动替换地址。

### 5.5 `tbc.ft.create`

```json
{
  "type": "tbc.ft.create",
  "version": "1.0",
  "name": "Example Token",
  "symbol": "EXT",
  "decimals": 8,
  "initialSupply": "100000000000000"
}
```

- `name` 为 1 至 64 个 Unicode scalar value。
- `symbol` 为 1 至 16 个大写字母或数字，首字符必须是大写字母。
- `decimals` 为 0 至 18。
- `initialSupply` 使用最小单位且必须大于零。
- 初始供应量必须归 `from` 账户；TWS 1.0 不允许另设初始接收方。
- 成功结果的主要交易 ID 同时是 FT `contractId`。

### 5.6 `tbc.ft.transfer`

```json
{
  "type": "tbc.ft.transfer",
  "version": "1.0",
  "contractId": "1111111111111111111111111111111111111111111111111111111111111111",
  "to": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "amount": "100000000",
  "attachedTbcAmount": "0"
}
```

- `amount` 使用 FT 最小单位且必须大于零。
- `attachedTbcAmount` 可省略，默认 `"0"`；它是发送给同一业务接收方的额外 TBC，不包含矿工费。
- 钱包必须从链上可信上下文发现 FT 版本和祖先交易，DApp 不得提供这些内部数据。

### 5.7 `tbc.stablecoin.transfer`

字段与 `tbc.ft.transfer` 相同，但 `type` 为 `tbc.stablecoin.transfer`。钱包必须验证 `contractId` 是它支持的 Stablecoin 合约类型，不能把普通 FT 静默当作 Stablecoin。

## 6. DeFi Intent

### 6.1 通用规则

- `poolContractId` 是 Pool 创建交易的 Contract ID。
- 钱包必须从链上发现 Pool 版本、LP plan、余额、锁定状态和祖先交易。
- `serviceFeeRate`、fee UTXO、Pool 上下文和解锁脚本不是公开参数。
- `serviceFeeRate` 必须由 Wallet Host 的可信策略解析，并进入 `policyHash`；它不能来自 DApp、页面配置或未认证的索引 metadata。
- 所有交换都必须包含最小输出和过期时间。
- 钱包可以生成必要的 prerequisite 或 maintenance 交易，但必须展示并写入 Transaction Bundle。

### 6.2 `tbc.pool.create`

```json
{
  "type": "tbc.pool.create",
  "version": "1.0",
  "ftContractId": "1111111111111111111111111111111111111111111111111111111111111111",
  "lpPlan": 1,
  "serviceProviderTag": "durian",
  "initialLiquidity": {
    "receiver": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
    "tbcAmount": "100000000",
    "ftAmount": "500000000"
  },
  "lock": {
    "publicKeys": ["0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"],
    "costRecipient": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
    "costAmount": "1000",
    "untilHeight": "900000"
  }
}
```

- `lpPlan` 是 1 至 6 的整数。
- 标准服务费率由链规则、受信任注册表和解析后的 `lpPlan` 派生，DApp 不能覆盖；解析结果按 TWS-011 写入 Execution Policy。
- `serviceProviderTag` 可以省略，最大 64 个可见 ASCII 字符。
- `initialLiquidity.tbcAmount` 与 `ftAmount` 都必须大于零。
- `lock` 可以省略；存在时 `publicKeys`、`costRecipient` 和 `costAmount` 必须存在。
- `publicKeys` 为 1 至 16 个唯一压缩 secp256k1 公钥。
- `untilHeight` 可以省略；存在时必须是有效 UInt32 高度字符串。
- 该 Intent 合并旧 Pool mint 和 init 业务流程。它必须形成一个 `requestHash`、一个 `planHash` 和一次批准，并可返回多笔有依赖关系的交易；不得要求 DApp 调用两个私有 Intent。

### 6.3 `tbc.pool.liquidity.add`

```json
{
  "type": "tbc.pool.liquidity.add",
  "version": "1.0",
  "poolContractId": "1111111111111111111111111111111111111111111111111111111111111111",
  "receiver": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "tbcAmount": "1000000",
  "minimumLpAmount": "1",
  "lockUntilHeight": "900000"
}
```

`tbcAmount` 和 `minimumLpAmount` 必须大于零。`lockUntilHeight` 可以省略，存在时必须是有效 UInt32 高度字符串。

### 6.4 `tbc.pool.liquidity.remove`

```json
{
  "type": "tbc.pool.liquidity.remove",
  "version": "1.0",
  "poolContractId": "1111111111111111111111111111111111111111111111111111111111111111",
  "receiver": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "lpAmount": "1000",
  "minimumTbcAmount": "1",
  "minimumFtAmount": "1"
}
```

所有金额必须大于零。钱包必须验证计划输出同时满足两个最小值。

### 6.5 `tbc.pool.liquidity.close`

```json
{
  "type": "tbc.pool.liquidity.close",
  "version": "1.0",
  "poolContractId": "1111111111111111111111111111111111111111111111111111111111111111"
}
```

该 Intent 表示销毁或关闭当前账户可消费的 LP position。所有可返回资产必须回到 `from` 账户；TWS 1.0 不允许另设接收方。钱包必须在预览中显示可返回资产和不可逆结果。

### 6.6 `tbc.pool.swap.exactTbcForToken`

```json
{
  "type": "tbc.pool.swap.exactTbcForToken",
  "version": "1.0",
  "poolContractId": "1111111111111111111111111111111111111111111111111111111111111111",
  "receiver": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "tbcAmount": "100000",
  "minimumFtAmount": "5000"
}
```

输入和最小输出必须大于零。钱包必须从链上发现 LP plan，并验证计划输出不低于 `minimumFtAmount`。

### 6.7 `tbc.pool.swap.exactTokenForTbc`

```json
{
  "type": "tbc.pool.swap.exactTokenForTbc",
  "version": "1.0",
  "poolContractId": "1111111111111111111111111111111111111111111111111111111111111111",
  "receiver": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "ftAmount": "5000",
  "minimumTbcAmount": "100000"
}
```

输入和最小输出必须大于零。钱包必须验证计划输出不低于 `minimumTbcAmount`。

## 7. 自动维护与合并

钱包负责处理 TBC、FT、Stablecoin、Pool FT 和 FTLP 碎片。新 DApp 不得请求公开 merge Intent。

自动维护必须满足：

- 仅消费 `from` 账户控制且与业务资产匹配的 UTXO；
- 不得改变业务接收方、业务金额或最小输出；
- 计入 `maxFee`；
- 在批准预览中明确显示；
- 在交易包中标记为 `maintenance` 或 `prerequisite`；
- 失败不得自动降低 DApp 的最小输出或提高最大费用。

Legacy Adapter 可以把旧 merge flag 映射到钱包内部维护命令，但该命令不属于 TWS Provider。

## 8. Signed Transaction Bundle

`tbc_signTransaction` 返回：

```json
{
  "version": "1.0",
  "chainId": "tbc:mainnet",
  "from": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "requestHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "approvalId": "wallet-opaque-id",
  "transactions": [
    {
      "id": "tx-1",
      "txid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "rawTransaction": "01000000...",
      "role": "primary",
      "dependsOn": []
    }
  ],
  "totalFee": "80"
}
```

- `requestHash` 是钱包应用默认值后，对完整 Transaction Request 执行 RFC 8785 JCS，再做 SHA-256 的小写 hex。
- `approvalId` 是钱包不透明审计标识，DApp 不得解析。
- `id` 在当前 Bundle 内唯一，1 至 64 个 ASCII 字符。
- `dependsOn` 只能引用同一数组中更早的交易 `id`，且图必须无环。
- `role` 为 `primary`、`prerequisite` 或 `maintenance`。
- `totalFee` 是整个 Bundle 的矿工费最小单位字符串，必须等于各交易实际费用之和。
- 交易顺序必须是有效拓扑顺序。
- 默认最大 Bundle 为 32 笔；钱包可以公布更小限制，不能超过 32。
- 多笔交易必须使用数组，禁止逗号拼接 raw transaction 或 txid。

如果 Intent 创建新合约，结果还可以包含：

```json
{
  "artifacts": {
    "collectionId": "...",
    "contractId": "...",
    "poolContractId": "..."
  }
}
```

只允许与 Intent 相关的已定义 artifact key；未知 artifact key 必须由未来版本增加。

## 9. Submitted Transaction Bundle

`tbc_sendTransaction` 成功时返回：

```json
{
  "version": "1.0",
  "chainId": "tbc:mainnet",
  "from": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "requestHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "approvalId": "wallet-opaque-id",
  "transactions": [
    {
      "id": "tx-1",
      "txid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "status": "submitted",
      "role": "primary",
      "dependsOn": []
    }
  ],
  "totalFee": "80"
}
```

`submitted` 表示钱包选择的节点已经接受交易或报告交易已知，不表示确认或最终性。

钱包必须按拓扑顺序广播。依赖交易未被接受时，不得广播其后继交易。

## 10. 部分广播失败

多交易广播不是原子操作。如果至少一笔交易已提交、但 Bundle 未全部提交，Promise 必须以 `-32000` / `BROADCAST_FAILED` 拒绝，并在 `data.details` 返回不含 raw transaction 的对账信息：

```json
{
  "name": "BROADCAST_FAILED",
  "stage": "broadcast",
  "retryable": true,
  "details": {
    "requestHash": "...",
    "transactions": [
      { "id": "tx-1", "txid": "...", "status": "submitted" },
      { "id": "tx-2", "txid": "...", "status": "failed" },
      { "id": "tx-3", "txid": "...", "status": "not-attempted" }
    ]
  }
}
```

DApp 可以据此轮询链状态，但不得要求钱包重新签名已经提交的前缀。使用相同 `clientRequestId` 重试时，钱包必须先对账，再只执行安全的剩余步骤；无法安全恢复时返回 `CONFLICT`。

## 11. 计划不变量

钱包在签名前必须验证：

- 所有输入属于当前账户或已验证合约上下文；
- 所有业务输出与 Intent 完全一致；
- 找零返回受控地址；
- 合约版本和祖先交易来自可信链数据；
- 总费用不超过 `maxFee`；
- Pool 最小输出和锁定条件满足；
- Plan 在批准后没有变化。

任何会改变接收方、金额、费用上限、合约、锁定条件、交易数量或步骤绑定的重新规划都必须废弃旧批准并重新提示用户。

TWS-011 规定 Request、Chain Snapshot、Execution Policy、Plan 和 Approval Binding 的机器可读边界。实现可以在真实链状态下选择不同但安全的 UTXO；固定 Canonical Profile 输入和 RFC 6979 fixture signer 必须逐 byte 复现标准 Plan、sighash、raw transaction、txid 和 fee。生产 Signer 的合法 low-S 签名可以不同。

## 12. 禁止项

TWS Provider 必须拒绝以下请求：

- 任意 raw transaction 盲签；
- DApp 指定的 UTXO、satoshi matrix 或 scriptPubKey matrix；
- 自定义 unfinished scriptSig；
- DApp 指定的 change address 或 fee UTXO；
- 私钥、WIF、助记词、Vault token 或解锁密码；
- DApp 覆盖活动网络、API endpoint 或标准服务费率；
- 未声明 Intent type、版本或字段。

## 13. Draft.2 交易生命周期与过期

`tbc_signTransaction` 与 `tbc_sendTransaction` 共用 normalize → plan → approval binding → `signer.sign` → finalize 安全路径，但终点不同：sign-only 在 finalize 后直接返回 `SignedTransactionBundle`，不得进入 `broadcasting` 或调用 Broadcast Port；send 才能执行 `broadcast.submit`，必要时进入 `reconciliation`。

首个可信 `clock.now` 建立后，授权 operation 最长有效五分钟。有效期必须取五分钟上限与 Request、Snapshot、Policy、Plan、Approval Receipt、Workflow Plan 中所有更早时间的最小值，后续只能收窄，不能延长。过期后禁止产生新的 `approval.request`、`signer.sign`、finalize 或 `broadcast.submit`。

若过期前已经尝试提交至少一笔交易，Core 只允许再调用一次 `broadcast.reconcile`，范围仅限已尝试 txid。对账后必须返回已提交 bundle 或稳定的部分广播错误；不得循环对账、重新签名或用新的过期时间恢复原批准。

Snapshot 被 reorg、spent state 或策略改变失效时进入 `failed`，映射 `-32000 / CONFLICT / validation / retryable:true`；它不能在旧 Approval Binding 下静默重新规划。
