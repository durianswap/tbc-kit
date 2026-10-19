# TWS-012：DApp Prepared Transaction 与 Workflow

- 状态：Candidate
- 版本：1.0.0
- 类型：Core / Integration
- 依赖：TWS-001、TWS-003、TWS-004、TWS-005、TWS-006、TWS-011

## 1. 目的

TWS 同时允许钱包构建和 DApp 构建交易，但只有钱包可以批准、签名和决定是否广播。

```text
DApp/Kit Intent + public chain data
→ untrusted TransactionProposal
→ wallet schema/hash/expiry validation
→ wallet semantic, ownership, ancestry, fee and policy validation
→ wallet-owned ExecutionPlan
→ ApprovalBinding
→ signer.sign
→ finalize
→ optional broadcast
```

DApp 构建不等于盲签 raw transaction。Prepared 请求必须同时携带 Intent 与 Proposal，钱包必须证明两者语义一致。

## 2. Provider 方法

TWS v1 包含三个 Prepared 方法：

| 方法 | 广播 | Permission |
| --- | --- | --- |
| `tbc_signPreparedTransaction` | 否 | `tbc_signTransaction` |
| `tbc_sendPreparedTransaction` | 是 | `tbc_sendTransaction` |
| `tbc_signPreparedWorkflow` | 否 | `tbc_signWorkflow` |

Prepared 方法是 17 方法 Provider 基线的一部分，不是可选补丁。它们与普通方法共享 Permission Name，但仍必须独立执行请求验证、逐次审批和签名边界。

## 3. PreparedTransactionRequest

规范 Schema 是 [`prepared-transaction.schema.json`](../schemas/prepared-transaction.schema.json)。请求包含：

- `version`、`chainId`、`from` 与可选 `clientRequestId`；
- TWS-004 `intent`；
- `proposal.payload` 与 `proposalHash`；
- 可选 TWS-004 `constraints`。

`proposalHash` 是 `proposal.payload` 的 TWS canonical JSON SHA-256。Provider 的 `requestHash` 必须覆盖完整 Prepared Request，因此 Intent、Proposal、约束和 Proposal Hash 都进入 ApprovalBinding；`operationHash` 仍绑定钱包重新验证后产生的 ExecutionPlan。

## 4. TransactionProposal

Proposal payload 必须包含：

- `engineProfile`：构建所使用的确定性 Engine/Profile 身份；
- `createdAt`、`expiresAt`；
- `intentHash`；
- 1 至 32 笔 proposed transaction；
- 父交易与合约 Evidence；
- `estimatedTotalFee`。

Evidence 是不可信输入，只用于减少重复下载。钱包必须重新计算父交易 txid，并通过自己的可信 ChainData endpoint 验证未花费状态、ownership、ancestry、合约版本和确认状态。

## 5. 固定与延迟交易

`fixed` 交易直接携带完整 unsigned transaction。

`deferred` 交易用于 TBC 中“子交易输入依赖父交易签名后 txid”的场景。它携带：

- `unsignedTransactionTemplate`；
- `deferredInputs[].inputIndex`；
- `deferredInputs[].sourceTransactionId`；
- `deferredInputs[].sourceOutputIndex`。

钱包只能在解析交易结构后替换指定输入中的零 prev-txid，并在替换后重新执行完整 pre-sign/finalized 验证。协议禁止使用 byte offset、任意 JSON Pointer 或脚本字符串替换表达依赖关系。

## 6. Prepared Workflow

规范 Schema 是 [`prepared-workflow.schema.json`](../schemas/prepared-workflow.schema.json)。Workflow 最多五步，可包含：

- `preparedTransaction`：Intent + Proposal；
- TWS-006 `typedData`：可绑定前序交易结果。

每一步使用唯一 `id` 与显式 `dependsOn` 形成 DAG。`tbc_signPreparedWorkflow` 不广播；未来若需要广播工作流，必须新增明确方法和安全语义，不得用隐藏参数改变本方法行为。

## 7. 钱包必须验证

进入 Approval 前，钱包至少必须验证：

1. Schema、canonical encoding、`proposalHash`、`intentHash` 与 expiry；
2. chain/account、输入所有权、未花费状态和 parent txid；
3. 依赖 DAG 无环、延迟输入只引用已声明父交易；
4. Intent 与输出、资产、Pool/LP 状态变化语义一致；
5. 交易大小、费率、总手续费、dust 与钱包 Policy；
6. signing task、sighash、finalized raw、txid 和 artifacts；
7. 发送方法在 `broadcast.submit` 前再次执行 pre-broadcast 验证。

DApp 的 Evidence、估算费用、业务预览和 Engine 身份都不能替代钱包验证。

## 8. 错误

Prepared 特有的稳定错误为：

- `INVALID_PROPOSAL`
- `PROPOSAL_HASH_MISMATCH`
- `PROPOSAL_SEMANTIC_MISMATCH`
- `PROPOSAL_STALE`

输入已花费、ownership、ancestry、费用和 Policy 失败继续使用 TWS-011 violation code 与既有 `CONFLICT`、`POLICY_VIOLATION`、`FEE_LIMIT_EXCEEDED` 等执行错误。钱包不得用含糊的 `INTERNAL_ERROR` 隐藏可诊断的 Proposal 拒绝。

## 9. 安全边界

- Proposal 不得包含私钥、WIF、Vault handle、approval token 或可信 Origin；
- DApp 不得指定钱包的 RPC/API endpoint；
- Prepared 模式不得绕过 Core、Host、九 Ports、ApprovalBinding 或 Signer；
- Kit 不得在批准后从 Prepared 自动回退到 Wallet-build；
- 发送失败或结果不确定时遵守 TWS-011 journal/reconciliation 规则，不得盲目重发。
