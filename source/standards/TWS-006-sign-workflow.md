# TWS-006：多步骤签名工作流

- 状态：Draft
- 版本：1.0.0
- 类型：DeFi
- 依赖：TWS-000 至 TWS-005

## 1. 目的

`tbc_signWorkflow` 允许 DApp 在一次用户批准中执行最多五个相关的交易签名、标准消息签名、Typed Data 签名或账户绑定加解密步骤，并安全地表达步骤依赖。

它替代旧 `sendBatchRequest`、按逗号拆分交易和 `dependsOn: "txids"` 后修改 JSON 字符串的行为。

TWS 1.0 Workflow **只签名，不广播**。

## 2. Request

```ts
interface SignWorkflowRequest {
  version: "1.0";
  chainId: TbcChainId;
  from: string;
  clientRequestId?: string;
  expiresAt?: string;
  maxTotalFee?: AtomicAmount;
  failureMode?: "atomic" | "continue-independent";
  steps: WorkflowStep[];
}
```

- `steps` 必须有 1 至 5 项。
- `id` 在 Workflow 内唯一，1 至 64 个 ASCII 字符。
- `expiresAt` 默认五分钟，最大为当前时间后十分钟。
- `maxTotalFee` 覆盖全部 transaction steps 的所有 primary、prerequisite 和 maintenance 交易。
- `chainId` 和 `from` 对所有步骤固定，步骤不能覆盖。
- 所有对象使用严格 Schema，未知字段必须拒绝。
- `failureMode` 省略时为 `atomic`。`continue-independent` 只允许继续执行不依赖失败步骤的分支；它不改变一次批准、权限检查或任何 Signer/Crypto/Reviewed Port 约束。

## 3. Step 类型

### 3.1 Transaction Step

```json
{
  "id": "trade",
  "kind": "transaction",
  "dependsOn": [],
  "intent": {
    "type": "tbc.transfer",
    "version": "1.0",
    "to": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
    "amount": "1000"
  },
  "constraints": {
    "maxFee": "100"
  }
}
```

Transaction Step 使用 TWS-004 Intent，但总是执行 `tbc_signTransaction` 语义。它不能请求广播。

### 3.2 Typed Data Step

```json
{
  "id": "order",
  "kind": "typedData",
  "dependsOn": ["trade"],
  "data": {
    "domain": {
      "name": "DurianSwap Order",
      "version": "1",
      "origin": "https://durianswap.org",
      "chainId": "tbc:mainnet"
    },
    "types": {
      "Order": [
        { "name": "side", "type": "string" },
        { "name": "txids", "type": "bytes32[]" }
      ]
    },
    "primaryType": "Order",
    "message": {
      "side": "buy",
      "txids": { "$tbcBinding": "unresolved" }
    }
  },
  "bindings": [
    {
      "target": "/message/txids",
      "source": {
        "stepId": "trade",
        "output": "transactionIds"
      }
    }
  ]
}
```

Typed Data Step 使用 TWS-005 类型系统。`bindings` 可以为空数组。

### 3.3 Message Step

`message` step 使用 TWS-005 标准 message envelope，明确携带 `utf8`、`hex` 或 `base64` 编码。它与 `signMessage` 使用相同签名语义，不提供 Legacy Bitcoin magic 选择项，也不接受任意结果注入。

为了迁移历史 JSON 消息，UTF-8 JSON object 可以声明最多一个 `bindings` 项：`target` 是一个安全顶层字段名，source 只能是更早 transaction、prepared-transaction 或 reviewed-transaction 的 `transactionIds`。Core 必须在批准前验证模板，在上游完成后以结构化 parse/update/serialize 注入数组，并对具体消息重新计算 envelope 与 digest。禁止字符串替换、嵌套路径以及 `__proto__`、`constructor`、`prototype`。新业务结构仍应优先使用 Typed Data。

### 3.5 Reviewed Transaction Step

`reviewedTransaction` 公开承载 raw 和 associated 两类待审交易。Host 在批准前通过 `reviewedTransaction.review` 读取可信材料、生成资产影响与费用预览；批准后仅能通过 `reviewedTransaction.execute` 执行同一 `requestHash` / `reviewHash`。Raw 模式可以在 `SignedTransactionBundle.detachedSignatures` 返回按 transaction/input 矩阵绑定的十六进制签名；Core 必须拒绝矩阵尺寸不一致，associated 模式不得返回该字段。

### 3.4 Encrypt / Decrypt Step

`encrypt` 与 `decrypt` step 必须明确声明算法 `tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1`。明文使用标准 encoded-message 结构，密文使用 base64。Core 只把批准绑定后的任务交给可选的 Host `crypto.execute` Port；私钥、派生标量和平台密钥句柄不得进入 Request、Checkpoint 或 Kit 公共结果。

纯 message、encrypt、decrypt Workflow 不得发起 `chainData.resolve` 或 `policy.resolve`。Host 未实现 `crypto.execute` 时只拒绝 crypto step，不得使其他标准方法不可用。

## 4. 依赖图

- 每个 `dependsOn` 只能引用数组中更早的 step `id`。
- `bindings.source.stepId` 也必须引用更早的 transaction step，并自动形成依赖。
- 每个绑定来源必须同时出现在该步骤的 `dependsOn` 中。
- 不允许自引用、后向引用、循环或重复依赖。
- Step 数组顺序必须是有效拓扑顺序。
- Wallet Host 必须在任何签名前验证完整图。

## 5. Binding

### 5.1 Target

`target` 使用 RFC 6901 JSON Pointer，但 TWS 1.0 只允许：

```text
/message/<top-level-field-name>
```

不允许嵌套 target、数组索引、domain、types、primaryType 或可信信封字段。目标字段必须已经存在于 `message`，其解析前的值必须严格等于 `{ "$tbcBinding": "unresolved" }`，且一个 target 只能绑定一次。

该占位符只允许出现在 Workflow 中明确列入 `bindings` 的顶层 message 字段。普通 `tbc_signTypedData` 不接受占位符，未被 Binding 引用的占位符也必须拒绝。

### 5.2 Source

允许的输出：

| output | 值 | Target 类型 |
| --- | --- | --- |
| `transactionIds` | 交易步骤 Bundle 中按顺序排列的全部 txid | `bytes32[]` |
| `primaryTransactionId` | 唯一 primary 交易的 txid | `bytes32` |
| `artifacts.collectionId` | Collection 创建 artifact | `bytes32` |
| `artifacts.contractId` | FT/NFT 创建 artifact | `bytes32` |
| `artifacts.poolContractId` | Pool 创建 artifact | `bytes32` |

如果请求的 artifact 不存在、primary 交易不唯一或 target 类型不匹配，Workflow 必须在签名前以 `-32602` 拒绝。

### 5.3 替换规则

钱包必须：

1. 完成所有 Transaction Step 的计划，但不签名。
2. 展示包含未来绑定含义的统一批准预览。
3. 获得一次用户批准。
4. 签署 Transaction Step 并确定 txid 和 artifact。
5. 以结构化值替换对应 target，不能做字符串拼接。
6. 对替换后的 Typed Data 再次执行完整类型验证。
7. 创建 TWS-005 显式 typed-data envelope、JCS payload 与 digest 并签名；不得注入 nonce、时间或 Account。
8. 全部成功后一次返回结果。

绑定后的完整 Typed Data 必须在签名前可被用户查看。若实际值与预览承诺不一致，必须废弃批准并重新提示。

## 6. 一次批准与不可变性

批准必须覆盖：

- verified Origin、Chain ID 和账户；
- 每个步骤的顺序和业务语义；
- 每个交易的接收方、资产、金额和费用；
- 自动 maintenance / prerequisite 交易；
- Typed Data domain 和字段；
- 标准消息的编码与完整字节；
- crypto 算法、操作方向和明文或密文摘要；
- 每个 Binding 的来源和目标；
- 总费用上限与过期时间。

以下任何变化都会使批准失效：

- Step 增删或顺序改变；
- Intent、接收方、金额、合约或最小输出改变；
- 费用或交易数量超过批准范围；
- Binding source、target 或解析值改变；
- Origin、Chain ID、账户或有效期改变。

## 7. 失败模式与返回

Workflow 签名不产生链上副作用。默认 `atomic` 模式下，Wallet Host 必须在受信任内存中暂存结果，只有所有步骤成功时才向 DApp 返回。

任何步骤失败时：

- 整个 Promise 以 `-32000` / `WORKFLOW_FAILED` 拒绝；
- 不得返回已签名 raw transaction、签名、txid-to-signature 对应关系或部分步骤结果；
- 必须清除暂存签名和 Workflow context；
- 重试是新的请求；内容变化时需要新的用户批准。业务若需要 replay protection，必须把 Backend 签发并原子消费的订单 challenge 显式放入声明类型的业务字段。

`continue-independent` 仅用于需要保持逐项兼容语义的显式请求。某个 secret Port 失败时，该 step 返回经清理的 `{ status: "failed", error }`；所有依赖它的后续 step 返回 `{ status: "skipped", error: { code: "DEPENDENCY_FAILED", ... } }`；其他无依赖分支继续。Port 原始错误、密钥材料和未声明中间态不得泄漏。计划和 Approval Binding 必须包含 failure mode，因此批准后不能切换模式。

## 8. Result

以下 JSON 只展示嵌套结构；完整且通过 Schema 的请求位于 [`test-vectors/workflow.json`](../test-vectors/workflow.json)，完整 transaction 与 typed signature 结果分别遵循 TWS-004、TWS-005。

```json
{
  "version": "1.0",
  "chainId": "tbc:mainnet",
  "from": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "requestHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "approvalId": "wallet-opaque-id",
  "steps": [
    {
      "id": "trade",
      "kind": "transaction",
      "result": {
        "version": "1.0",
        "transactions": []
      }
    },
    {
      "id": "order",
      "kind": "typedData",
      "result": {
        "version": "1.0",
        "signature": "HwQD+hU4oNbN5YHt99vFui+9YV5XutaZ9JTJwc19uKLHRYDedCDFvqW7iDY2qpx+oAaRI5R/3TnW3mrlCNy2Mlw="
      }
    }
  ],
  "totalFee": "80"
}
```

- `requestHash` 是应用默认值、但尚未解析 Binding 的完整 Workflow Request 的 JCS SHA-256。
- `failureMode` 必须出现在 Result 中并与批准计划一致。
- 每个 transaction result 是完整 TWS-004 `SignedTransactionBundle`。
- 每个 typedData result 是完整 TWS-005 `TypedDataSignature`，其 Envelope 必须包含解析后的绑定值。
- 每个 message result 是完整 TWS-005 `MessageSignature`；每个 crypto result 必须绑定原 task id 和算法，并只返回密文或显式编码的明文。
- `totalFee` 是所有 Transaction Step Bundle `totalFee` 的精确和。

## 9. 限制

- 最多五个步骤。
- 每个 Typed Data Step 最多一个 Binding；整个 Workflow 最多五个 deferred Binding。
- 每个 transaction step 仍受最多 32 笔交易限制。
- Workflow 不允许广播、任意函数执行、由 DApp 选择 Legacy 签名 profile，或让纯消息/加解密隐式触发链查询。
- 钱包不能在 Workflow 内静默插入 DApp 未请求的业务步骤；内部 maintenance 只能出现在对应交易 Bundle 中。

## 10. DurianSwap 迁移示例

买单和卖单使用一个 Transaction Step 产生签名交易包，再用 Typed Data Step 把 `transactionIds` 绑定到订单的 `txids` 字段。服务端验证：

1. TWS Typed Data 签名、显式 Origin/Chain domain，以及 Workflow Approval 有效期；
2. `txids` 与提交的 raw transaction 完全一致；
3. 交易的接收方、金额、合约和业务规则；
4. DApp 自己的订单 challenge 和订单 ID 未重复使用并在 Backend 原子消费。

这消除了对 V8 key insertion order、逗号拼接和错误文案正则的依赖。

## 11. Draft.2 WorkflowPlan 与 deferred signing

Core 必须在批准前生成完整 `WorkflowPlan`。其 payload 绑定 `requestHash.workflow`、Chain、Account、有效期、拓扑 `stepOrder`、每个 Transaction Step 的完整 `ExecutionPlan`、所有 immediate signing task、所有 deferred signing task、全部 crypto task、`maxTotalFee`、精确 `totalFee` 与 `workflow` Preview；`workflowPlanHash` 是 Approval Binding 的 `operationHash`。

Workflow 授权必须是步骤权限的交集：容器需要 `tbc_signWorkflow`，并按实际 step 额外要求 `tbc_signTransaction`、`tbc_signMessage`、`tbc_signTypedData` 或 `tbc_crypto`。该检查发生在计划、批准与任何 secret Port 调用之前。

Deferred task 在批准前只允许携带 source、target、精确 `targetType`、公钥和含 unresolved placeholder 的 envelope template，不能伪造尚不存在的 digest。运行时只可从已经 finalize 的上游 transaction bundle 读取声明的 `transactionIds`、`primaryTransactionId` 或已登记 artifact；上游 bundle 的 `requestHash`、Chain 与 `from` 必须与计划一致。解析后必须重新验证 target 类型、生成完整 typed-data envelope、JCS、digest 与 concrete signing task，并证明它是已批准 deferred task 的唯一合法派生。

`atomic` 模式下任何步骤失败都直接产生 terminal workflow failure；失败对象不能包含 `steps`、signature、raw transaction 或其他部分结果。`continue-independent` 模式只按第 7 节返回已批准图中的 completed/failed/skipped 项，绝不能继续依赖失败节点。Workflow 仍然只签名、不广播。
