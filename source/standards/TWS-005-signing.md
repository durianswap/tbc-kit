# TWS-005：消息与 Typed Data 签名

- 状态：Draft
- 版本：1.0.0 Candidate 2
- 类型：Core
- 依赖：TWS-000、TWS-001、TWS-002、TWS-003、RFC 8785

## 1. 方法与边界

Provider 只公开两个消息签名方法：

- `tbc_signMessage`
- `tbc_signTypedData`

不存在 `tbc_signTypedData_v1` alias，也不存在 `tbc_signIn` RPC、权限或状态机。两种方法都必须经过当前请求的 Approval Binding 和同一 Signer Port，且都不广播交易。

`tbc_signMessage` 是通用字节签名。登录是 `@tbc/kit` 在其上定义的应用层 profile；`tbc_signTypedData` 是 TBC JCS typed-data profile，不是 EIP-712。

## 2. 通用签名结果

算法标识固定为 `secp256k1-recoverable-ecdsa-sha256d`。签名是标准带 padding base64 编码的 65-byte compact recoverable low-S ECDSA：第一个 byte 为 `31..34`，后续为 64-byte `r || s`。公钥是 33-byte compressed secp256k1 小写 hex。

标准结果必须返回：`version`、`scheme`、`algorithm`、`address`、`accountId`、`publicKey`、`envelope`、`canonical`、`signingPayload`、`digest` 和 `signature`。验证者必须自行重建 payload 与 digest、验证恢复出的压缩公钥，并按 TBC 的 `HASH160(compressedPublicKey)`、版本字节 `0x00` 与 Base58Check 规则重新派生地址；派生地址必须等于期望地址，不能信任返回的 `address`、`accountId` 或 `publicKey` 字段本身。

## 3. Message 字节语义

Request：

```json
{
  "version": "1.0",
  "chainId": "tbc:mainnet",
  "from": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "clientRequestId": "optional-id",
  "message": { "encoding": "utf8", "data": "Hello, TBC!" }
}
```

`clientRequestId` 可省略且不进入签名内容。Request 不接受 `expiresAt`。Message 支持：

- `utf8`：必须是 well-formed Unicode，严格编码为 UTF-8 bytes；
- `hex`：非空、偶数长度、小写 hex；
- `base64`：RFC 4648 标准 canonical padded base64。

三种表示解码成相同 bytes 时，必须产生相同 payload 与 digest。钱包不得根据可打印性猜测或改变编码。

Envelope 固定为：

```json
{
  "type": "tbc.message",
  "version": "1.0",
  "message": { "encoding": "utf8", "data": "Hello, TBC!" }
}
```

签名 payload 与摘要为：

```text
magic   = UTF8("TBC Signed Message:\n")
body    = decode(message.encoding, message.data)
payload = CompactSize(byteLength(magic)) || magic
       || CompactSize(byteLength(body))  || body
digest  = SHA256(SHA256(payload))
scheme  = "tbc-message"
```

Message 的 `canonical` 仍是 envelope 的 RFC 8785 JCS，供审计与结构核对；它不是 message payload 的 body。禁止把 raw 32-byte digest 当消息隐式签名。

## 4. Typed Data 语义

Request 必须显式提供完整业务域：

```json
{
  "version": "1.0",
  "chainId": "tbc:mainnet",
  "from": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  "data": {
    "domain": {
      "name": "DurianSwap Order",
      "version": "1",
      "chainId": "tbc:mainnet",
      "origin": "https://durianswap.org"
    },
    "types": {
      "Order": [
        { "name": "amount", "type": "uint256" },
        { "name": "side", "type": "string" }
      ]
    },
    "primaryType": "Order",
    "message": { "amount": "1000000", "side": "buy" }
  }
}
```

`domain.name` 与 `domain.chainId` 必需。`domain.version`、`origin`、`verifyingContract`、`salt` 可选；若提供 `origin`，必须与 Trusted Context verified Origin 完全相同。`domain.chainId` 必须与 Request chain 一致。钱包不得自动加入 Origin、Account、nonce、签发时间或过期时间。

Envelope 固定为 `{ type:"tbc.typedData", version:"1.0", ...data }`，其中 type-field 数组按字段名规范排序。payload 与摘要为：

```text
magic     = UTF8("TBC Signed Typed Data:\n")
canonical = RFC8785_JCS(envelope)
payload   = CompactSize(byteLength(magic))     || magic
         || CompactSize(byteLength(canonical)) || UTF8(canonical)
digest    = SHA256(SHA256(payload))
scheme    = "tbc-typed-data"
```

数值类型使用规范十进制字符串，不接受浮点数、`null`、NaN 或 Infinity。Typed Data 必须严格匹配声明类型；未知字段、递归环、超限数组或超限对象必须拒绝。

## 5. Sign-In profile

`@tbc/kit` 的 `createSignInMessage` 生成 canonical UTF-8 message，`signIn` 恰好调用一次 `tbc_signMessage`。Backend 必须签发至少 16 个字符的单次 nonce，并在验证成功后原子消费；Kit 不声称替 Backend 提供持久化或原子性。

固定文本格式：

```text
TBC Sign-In
Domain: app.example
URI: https://app.example/login
Address: 1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH
Chain ID: tbc:mainnet
Nonce: backend_challenge_1234
Issued At: 2026-09-17T01:00:00Z
Expiration Time: 2026-09-17T01:05:00Z
Statement: Optional single-line statement
```

钱包必须在 `utf8`、`hex`、`base64` 任意表示中识别以 `TBC Sign-In\n` 开头的消息，并在批准前验证：canonical 格式、URI Origin/Domain、Trusted Origin、Chain、Account，以及 `issuedAt <= walletNow < expirationTime`。带该标记但格式或上下文不合法时必须拒绝，不能降级为普通消息。

`verifySignIn` 必须先校验消息、期望 RP context、标准 scheme、envelope、payload、digest、签名、恢复公钥，并从该公钥重新派生 TBC 地址且要求它等于期望账户，再调用 Backend 的 atomic `consumeChallenge`；回调返回 false 即验证失败。返回结果中的地址/账户字符串不能替代这个密钥到地址的证明，任何不匹配都必须在 challenge 消费前拒绝。

## 6. Approval 与恢复

Approval Preview 必须显示 verified Origin、网络、账户、scheme、实际 message bytes/文本或 typed-data domain/types/message、digest，以及“不直接广播交易”。Sign-In 还必须展示 Domain、URI、nonce、签发与过期时间。

六个严格 Preview 分支是 `transaction`、`message`、`typedData`、`permission`、`switchChain` 和 `workflow`。需要批准的方法映射固定为：

| 方法 | `operationKind` | `operationHash` 来源 |
| --- | --- | --- |
| `tbc_requestAccounts` | `permission` | `permissionProposalHash` |
| `wallet_requestPermissions` | `permission` | `permissionProposalHash` |
| `tbc_switchChain` | `switchChain` | `chainSwitchProposalHash` |
| `tbc_signMessage` | `message` | 最终 message digest |
| `tbc_signTypedData` | `typedData` | 最终 typed-data digest |
| `tbc_signTransaction` | `transaction` | `planHash` |
| `tbc_signPreparedTransaction` | `transaction` | `planHash` |
| `tbc_sendTransaction` | `transaction` | `planHash` |
| `tbc_sendPreparedTransaction` | `transaction` | `planHash` |
| `tbc_signReviewedTransaction` | `transaction` | `walletActionPlan.planHash` |
| `tbc_encrypt` | `crypto` | `walletActionPlan.planHash` |
| `tbc_decrypt` | `crypto` | `walletActionPlan.planHash` |
| `tbc_signWorkflow` | `workflow` | `workflowPlanHash` |
| `tbc_signPreparedWorkflow` | `workflow` | `workflowPlanHash` |
| `tbc_sendWorkflow` | `workflow` | `workflowPlanHash` |
| `tbc_sendPreparedWorkflow` | `workflow` | `workflowPlanHash` |

Approval Binding 的 `operationHash` 是最终 digest。Envelope、Preview、Binding、Receipt、Signing Task 和结果必须保存在 checkpoint Operation Memory 中；恢复不得重新生成或替换签名内容。

### 加解密输入预算

新 `tbc_encrypt` 请求及普通/Prepared workflow 的每个 `encrypt` 步骤，明文解码后不得超过 65,536 字节。UTF-8 按实际编码字节计算；hex/base64 按解码后字节计算。空明文允许。Core 和 Provider 在审批与密钥操作前执行同一预算检查；Legacy 映射不得绕过。Schema 的字符数上限只约束 wire 结构，不能替代此字节预算。

此预算不改变普通消息签名规则，也不收紧既有密文的历史解密结果 union。解密必须保留 MAC、填充、UTF-8/编码格式及原有长度校验，结果按显式 `encoding` 读取，不能假定只有 base64。不得为新建超长加密请求套用历史兼容规则。

## 7. Legacy Bitcoin Message

历史 `window.Turing.signMessage` 的 `Bitcoin Signed Message:\n` 语义只能由 wallet-private Legacy Adapter 选择。钱包私有路由先用受信逻辑计算 digest，并将其绑定到内部 marker；同一 digest 必须贯穿 Approval、Signer 校验和结果。

公共 Provider 请求无法选择 Legacy：普通 `tbc_signMessage` 即使伪造内部 marker，也必须保持 `tbc-message`。Legacy 结果明确标记 `scheme: "legacy-bitcoin-message"`，不得返回标准 `signingPayload`。不存在公开 `/legacy` package entry。

## 8. 禁止项

- 不得新增 `tbc_signIn` 或 `_v1` alias。
- 不得向标准 envelope 自动加入 nonce、时间、Origin 或 Account。
- 不得把 TBC typed data 宣称为 EIP-712。
- 不得仅展示或签署调用方提供的 raw digest。
- 不得让页面 Provider 访问 wallet-private Legacy 选择器。
- 不得在签名失败时返回部分签名、Approval Token 或未授权账户资料。

已知答案位于 [`test-vectors/signing.json`](../test-vectors/signing.json)。
