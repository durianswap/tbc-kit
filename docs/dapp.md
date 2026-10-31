# DApp 接入

先按[安装指南](installation.md)从 Releases 下载并安装 `tbc-kit.tgz`。网页导入 `@tbc/kit`，无需安装私有 Core、Host 或 Engine 包，也不要将钱包 Vault 代码注入网页。

```ts
import { createTbcClient } from '@tbc/kit';

const client = createTbcClient({ network: 'testnet' });
const wallets = client.wallets();
// 在自己的 UI 中让用户选择 wallets 中的实际 descriptor。
const selected = wallets[0];
if (!selected) throw new Error('请先安装或打开支持 TBC 的钱包');
const wallet = await client.connect({ wallet: selected });
await wallet.tbc.transfer({ to: recipientAddress, amount: '1000' });
```

上例的 `recipientAddress` 由应用提供；`wallets[0]` 只是最小演示，生产页面应让用户选择，不按名字猜钱包。`1000` 是最小单位，即 `0.001 TBC`，不是 1000 TBC。创建 client 不会自动授权、取数、签名或广播。

主网选择 `mainnet`，测试网选择 `testnet`；对应 `tbc:mainnet`、`tbc:testnet`。正式操作前显示当前网络和账户。账户/网络变化、拒绝和断连需由应用处理。

普通交易意图可交钱包构建；自己构建时使用 Prepared 接口，并让钱包解析、校验和展示实际交易。钱包只能对已审批且绑定的材料签名，不能将任意页面 digest 当作受信输入。

进一步示例：

- [多钱包发现与默认钱包选项](../packages/kit/examples/multi-wallet/README.md)
- [消息登录](../packages/kit/examples/sign-in/README.md)
- [NFT 闭环](../packages/kit/examples/nft-three-step/README.md)
- [到账核验](../packages/kit/examples/receipt-verification/README.md)
- [业务 API](../packages/kit/docs/usage.md)

网站若自行使用 Engine/WASM 构建，应按 bundler 配置发布 `.wasm` 静态资源；导入轻量 client 不要求立即加载 Engine。钱包连接不等于广播成功，txid 也不等于已确认；到账需要结合网络、资产、输出和确认状态判断。
