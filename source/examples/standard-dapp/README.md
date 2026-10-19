# 新标准 DApp

这是新 DApp 的首个 Core 迭代，使用公开 Wallet Standard 和 Provider，连接现有新架构
移动钱包与插件钱包。同一个构建使用同一份代码，不访问 window.Turing 或钱包私有源码。

当前 UI 提供钱包发现/选择、授权、能力读取、TBC Testnet 转账和本页公开交易记录。
TBC 金额精确到 6 位小数；单次测试转账最多 10 TBC，费用上限最多 0.01 TBC。
这些限制是本测试应用的使用边界，不是链协议上限。FT、NFT、DeFi 等尚未在本迭代实现，
不能将本应用构建成功写成全部业务互通完成。

## 启动

开发工作树中已装好公开 workspace 包时：

```sh
cd examples/standard-dapp
npm run build
npm start
```

默认地址为 http://127.0.0.1:43170。可用 TBC_DAPP_PORT 设置端口；TBC_DAPP_HOST
设置监听接口。Android emulator 可通过 adb reverse tcp:43170 tcp:43170 使用相同
loopback URL；钱包的可信导航配置必须明确允许该测试 origin。

构建产物 dist/build-identity.json 包含精确文件哈希，可对比 iOS、Android 与 Chrome
是否使用同一个 DApp 构建。生产页面不加载私钥或注资脚本。

单独复制本目录开发时，先安装 package.json 声明的公开包。若 SDK 版本尚未发布，
使用已冻结的 npm pack 产物安装同版本依赖，不复制 package/src；独立安装验证记录应
明确与当前 workspace 构建分开。当前还没有完成独立打包安装和真实三平台业务验收。

## 状态与恢复边界

“钱包报告已提交”仅表示公开 Provider 返回 submitted bundle，不等于节点/余额验收。
本页只保存请求 ID、公开地址、金额、时间、txid 与提交状态，不保存批准材料、签名或 raw。
页面重启时未完成记录变为结果未知，不自动重发。当前公开 Provider 尚无按业务请求 ID
查询钱包操作结果的方法；缺少 txid 时需要在钱包中核对，这仍是标准易用性缺口。

本页面的 localStorage 是 DApp 的普通本地历史，不代替钱包的 durable journal。
Wallet Standard 官方 registry 作为独立模块加载，TBC SDK 不内嵌另一个 registry。

## 验证

```sh
npm test
npm run build
```

金额用例覆盖最小单位、1000 TBC、浮点易错值、超过 Number 安全整数的余额和超精度拒绝。
真实签名、链查询、余额变化、重启与第三方独立接入需要各自单独证据。
