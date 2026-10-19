# AMM 费用与合约

Kit 支持自定义 AMM 费用。钱包负责账户、审批界面与安全签名；Kit 与无私钥 Engine 负责取数、交易构建、费用计算和绑定校验。

## 新 AMM 费用输入

`tbc-amm-create` 使用 `feePolicy`，不再接受 `lpPlan` 或 `serviceFeeRate`：

```ts
import { normalizeAmmFeePolicy } from '@tbc/kit';

const feePolicy = normalizeAmmFeePolicy({
  lpFeeRate: 20,
  taxFeeRate: 0,
  serviceProviderFeeRate: 10,
  protocolFeeRate: 0,
  feeAddress: serviceAddress,
});
// 在建池 intent 中传入 feePolicy。
// ftContractId、lpTimelock、controllers 保持各自业务含义。
```

四项费率单位均为 bps，1 bps 等于 0.01%；均为非负整数，四项合计必须小于 10000。上述配置总费率为 0.30%，其中 LP 为 0.20%，非 LP 为 0.10%。`feeAddress` 必须是合法的规范 P2PKH 地址；非 LP 费用合并支付到该地址。即使非 LP 费率为零，也要提供合法地址。

前端可自行提供预设，但预设必须是完整费用数据，与用户自定义配置走相同校验路径。

费用配置承诺在新池 Code/Tape 中。后续加池、交易、减池从认证的链上材料读取，不接受单次请求覆盖费率或收款地址，也不以 API 数据库摘要替代原始合约配置。总费用与 LP 费用分别向下取整，二者相减得到非 LP 费用；保留 SDK 的 10 最小单位支付阈值。

零费率能通过配置校验，但 SDK 1.7.3 的 swap 仍要求实际留给池子的 LP 费用为正。零 LP 费率及小额取整为零的交易可能被拒绝；不要承诺所有合法配置都能执行任意金额的 swap。

审批页面展示总费率、四项分成、非 LP 合计及收款地址。依赖交易仍属于同一有界审批；正式签名前校验完整交易、账户、配置和批准绑定。

## 历史 Pool2

Pool2 LP6 仅采用总费率 330 bps、LP 200 bps、服务方 130 bps，即总费率 3.3%。交易构建、报价和私有原文解析保持一致。

历史 Pool2 其他使用接口不受此变更影响；旧资产创建支持范围仍按合作方能力清单执行。历史 143 字节 AMM 模板与新 168 字节模板独立识别，不能只凭 `POOLTAPE` 标记判断版本。

## API 和性能

UTXO 查询支持 `limit`、`after`、`target`，业务读取只在响应有 `next_cursor` 时继续分页，并进行有界去重。无分页响应保持一次 GET。LP 查询明确返回 `utxos: null` 时视为空；接口报错或缺失列表不能伪装为空余额。

保留一次审批、并行预取及稳定材料复用。不缓存可变余额、UTXO 或池储备来代替新鲜取数。Engine 不读取网络或私钥，也不新增后台合并或自动广播。
