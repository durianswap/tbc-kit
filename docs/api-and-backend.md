# 查询与服务端

`@tbc/kit/api` 封装官方 HTTP API，`@tbc/kit/rpc` 封装节点 JSON-RPC。二者不是同一个协议，也不会互相回退。RPC 地址由调用方配置；管理接口和节点凭据不能发送到网页。

```ts
import { createTbcOfficialApi } from '@tbc/kit/api';
const api = createTbcOfficialApi({ network: 'testnet' });
const node = await api.nodeInfo();
console.log(node.blocks);
```

默认网络：

| 网络 | chainId | HTTP API |
| --- | --- | --- |
| 主网 | `tbc:mainnet` | `https://api.turingbitchain.io` |
| 测试网 | `tbc:testnet` | `https://api.tbcdev.org` |

参阅[API/RPC 示例](../packages/kit/examples/api-rpc/README.md)及[可运行代码](../packages/kit/examples/api-rpc/read-only.mjs)。金额使用十进制整数字符串；TBC 为 6 位精度。代币精度由资产元数据决定，不用浮点运算代替链上整数。

服务端可只使用无私钥 Engine 构建，再把 Prepared 材料交钱包；也可显式注入自己的安全 Signer 和服务授权适配器。参阅[独立 Node 示例](../packages/kit/examples/backend-node/README.md)。其默认执行是离线合成验证，没有真实广播；不要将演示中的公开标量用作账户。

官方 API 是可配置的可信数据来源，本地一致性校验不是独立全节点证明。查询交易、核验收款和等待确认是不同操作，不能把“节点找到 txid”直接当成资产与金额正确且已到账。
