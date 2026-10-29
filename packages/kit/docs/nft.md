# NFT 转移、批量铸造与查询

## 多合约批量转移

```ts
const wallet = await client.connect();
await wallet.tbc721.batchTransfer({
  transfers: [
    { contractId: firstNftId, to: firstRecipient },
    { contractId: secondNftId, to: secondRecipient },
  ],
  constraints: { maxFee: '10000', expiresAt },
});
```

每个 NFT 在批内只能出现一次，最多 100 个；实际还受字节和钱包政策限制。
Kit 根据已验证脚本识别当前及已支持的历史 NFT，汇总所需合集/父交易材料，
用同一个计划协调手续费输入和找零，不是循环调用独立的 `transfer`。
整批展示全部收款人并批准一次；多笔链上交易不承诺原子成功。

## 几百个 NFT 的自动分批铸造

```ts
const result = await wallet.tbc721.batchMint({
  collectionId,
  items, // 例如 250 个：每项包含明确 slot、名称、描述、属性及可选 to/media。
  limits: {
    maxTotalFee: '100000', // 整任务手续费上限，TBC 最小单位，不是每批额度。
    expiresAt,
    maxItemsPerBatch: 100,
  },
});
```

使用 `limits` 时进入 Kit 的整任务入口 `tbc_runNftMintJob`。一次同意绑定
全部有序内容、槽位、收款人、总费用和期限；省略 `to` 时会在同意前明确为
当前账户。任务最多 2000 项，仍不得超过合集实际可用槽位。

Kit 内部按不超过 100 个组成子批，再根据计划字节和 Engine 资源限制下调。
例如 250 个小项目通常分成 100／100／50；大媒体可能更少。资源不足才允许
本地缩小重规划，余额不足、归属错误或材料冲突不会通过缩小批次掩盖。
整个任务的 JSON 材料上限为 8 MiB，累计计划上限默认 32 MiB；可用
`maxPlanBytes`、`maxTotalPlanBytes` 和 `maxItemsPerBatch` 收紧，不能放大硬上限。
传输层的上限另行适用：现有 WebView 单条消息上限为 4 MiB（含信封），
所以 8 MiB 是原生任务材料的硬上限，不代表网页可以发送 8 MiB 消息。
大媒体优先使用 URI；超过传输预算会在签名之前拒绝，不偷偷拆成多次授权。

取数与一次审批并行。任务内索引/原文请求去重，后续子批使用已验证签名
交易的找零，不为自己的新输出再查 API。原始观察期限不会因复用而延长；
过期会停止，不自动重新取数或延长授权。普通不超过 100 个的单构建调用
仍可使用原来的 `constraints`，不增加任务预取或额外网络请求。
`limits` 与 `constraints` 不可同时提供。

结果包含 `status`、`reason`、`requested`、`minted`、各子批及交易状态：

- `complete`：全部提交已接受/已知，不表示已有区块确认。
- `partial`：已有部分成功，之后取消、失败、超时或预算用尽；不回滚已提交交易。
- `stopped`：未确认提交任何项目即停止。
- `uncertain`：提交或执行状态未能消歧；保留已有 txid 和恢复关联，不自动重发。

`confirmedSubmissionFee` 统计已接受/已知提交的手续费，不是链上确认数量。
用原有交易查询/广播日志核对结果；不要直接重复提交原任务。

### 钱包接入

`createTbcWallet` 增加可选 `nftMintJob` 配置：

- `approve({ scope, scopeHash })`：展示完整整任务摘要与项目列表，返回一次有界同意。
- `authorizeBatch({ scope, scopeHash, approval, params }, call)`：复用钱包已有
  Core 审批凭证签发机制，为精确子计划签发凭证，不再弹窗。

Kit 在签发回调前核对请求、计划、账户、来源、会话、费用和有效期；每个
子批仍经过同一 Core/Host、Engine 校验与 Signer。回调不负责切批、构建、
取数或广播，也不能拿整任务同意代替 Signer 的精确审批凭证验证。
默认网络已经提供任务材料读取；自定义网络需提供
`prepareNftMintJob(scope, account)`，并满足相同的材料身份、期限和复用约束。
钱包原生页面可直接调用 `session.runNftMintJob({ collectionId, items, limits })`。
独立执行通道只在当前会话内存中存活，不新增持久 UTXO 池或后台自动重试。

## 查询合集可铸造状态

无需连接钱包或申请签名权限：

```ts
import { createTbcClient } from '@tbc/kit';

const client = createTbcClient({ network: 'testnet' });
const result = await client.tbc721.getMintStatus({ collectionId, address });

switch (result.status) {
  case 'available':
    // 当前观察到的空闲槽位，按输出编号升序排列。
    console.log(result.availableSlots, result.availableCount);
    break;
  case 'exhausted':
    // 所有已验证槽位均被配置的 API 明确报告为已花费。
    break;
  case 'not-owner':
    console.log(result.collection.ownerAddress);
    break;
  case 'unknown':
    // API 不可用或结果不完整；不能作为剩余数量为 0 处理。
    console.log(result.reason);
    break;
}
```

钱包或后端已经有 API、Native/WASM 实例和不可变交易缓存时，可直接复用：

```ts
import { createTbc721Reader } from '@tbc/kit/api';

const reader = createTbc721Reader({ api, engine: materialEngine, cache });
const result = await reader.getMintStatus({ collectionId, address });
```

`materialEngine` 是只读 keyless 实例，提供 `execute`，不是私钥或 Signer。
也可向 `createTbcClient` 传入 `materialEngine`。`network`、`api.baseUrl`、
`api.fetch` 等配置沿用 Client 的设置，不另选 API 域名。

## 取数与语义

- 首次并行读取合集原文及账户的集合槽位索引；校验 txid、Tape、发行数量、
  槽位金额和持有人，复用 Rust 构建器的同一解析逻辑。
- 仅对索引缺失的确切槽位调用只读 `txoStatus`，每批最多 25 个输出、
  最多 4 批并行，每个缺失槽位只查询一次，不自动重试。不扫描其他资产，
  不查询手续费 UTXO、链高或额外祖先，也不向交易准备或签名流程增加请求。
- 已验证的合集原文及布局可以缓存；槽位是否已花费不跨查询缓存。
  同时发生的相同查询共享进行中的请求。
- 某批失败或返回不完整时保留其他批次已确认的槽位，返回 `unknown`；
  不会将缺失结果误判为已花费。每批独立校验请求身份、金额、脚本及重复项。
- `unknown.availableSlots` 仅表示本次已观察到的空闲槽位，不是完整数量；
  `unknown` 不提供 `availableCount`。`unknownSlots` 表示尚无完整状态的槽位。
- 当前与历史合集的创建格式相同，查询不会伪造“新合集”标记，也不会
  开启旧 NFT 创建能力。后续铸造仍走当前标准和正式审批绑定。
- 结果属于可信 API 的当前观察，不是全节点证明、槽位预留或铸造授权。
  铸造前仍由现有执行流程检查指定槽位；不要自动改用其他槽位重试。

这不是交易路径中的强制附加查询。已有明确槽位的铸造请求无需先调用它，
因此正常创建、铸造和转移路径不会因新增此入口而增加网络请求。

交易材料的 NFT 集合索引延迟回退也复用同一分批器：每次材料解析中，
只对缺失的指定槽位分成最多 25 个输出一批、最多 4 批并行。
历史 NFT 自动选择槽位的回退同样适用，不改变原先选择首个未花费槽位的规则。
正常索引命中不增加状态查询；合集原文和同一准备范围内的索引、手续费材料
继续复用。交易准备要求所需材料完整且未花费；任何批次失败、缺项或错配
都不能生成可签名快照，不会套用只读查询的部分结果继续交易。

## 内联媒体与字节预算

`media.kind = 'base64'` 的内容以 Base64 文本存入链上 Tape，而不是先解码
成二进制。因此 70,000 字节文件约占 93,336 字节 Base64 文本，再加上 JSON、
名称、描述、属性和交易结构。UTF-8 多字节字符与 JSON 转义也计入实际字节。

- 当前 NFT 的完整签名交易、单份父交易材料上限均为 1 MiB。
- 新标准请求的 Base64 文本早期上限为 1,048,576 个字符；这不是“刚好此
  大小的文件可以铸造”的保证，Engine 会继续计算完整交易及证明的实际预算。
- 单构建计划仍受 4 MiB 序列化预算约束；签名 continuation 与总证据各有
  8 MiB 预算。多个大媒体项目可能先触及总计划预算，不能只计算项目数量。
- 通用交易解码器使用原有的 2 MiB 完整交易上限，不再错误套用 10 KB
  脚本上限。解码成功不等于签名授权或合约验证通过。
- NFT 的证明按 NFT 材料预算限制；合集槽位较多时的首次转移不再误用
  Pool 的 64 KB 限制。Pool 以及其他合约的预算保持原样。

大媒体优先使用 `https://`、`ipfs://` 或 `ar://` URI，并按需要提供 SHA-256。
Kit 不会在构建或签名时自动下载 URI 内容，也不会上传文件或更换媒体。
正常 URI/小媒体路径不增加 API 请求；已签父交易与找零继续从任务内复用。
