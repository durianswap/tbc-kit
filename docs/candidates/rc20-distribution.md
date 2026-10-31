# rc.20 按需分发

rc.20 已选为当前 JS 分发版本，合作方 Flutter 交付包保持不变。
本轮不增加业务方法，不重新编译交易引擎：沿用 rc.19 的 JS、WASM、Native
和桥接执行代码，调整运行依赖、文档与平台资源装配。

## 选择文件

| 用途 | 文件 |
| --- | --- |
| Web、插件、Node.js | `tbc-kit.tgz`（JS `0.1.0-rc.20`） |
| React Native iOS | JS 包 + `ios-sdk.tgz` |
| React Native Android | JS 包 + `android-sdk.tgz` |
| Swift / Kotlin | 对应平台 SDK；不必安装 npm 包 |
| 自定义底层 FFI | 可选 `tbc-kit-native-resources-<platform>.tgz`；普通 SDK 接入不需要 |
| Flutter | 继续使用原合作方配套包，本候选不替换 Flutter |

Native SDK 仍是 `0.1.0-rc.19.native.2`，内容与原版完全一致。
不要为统一版本号而改写其身份。JS/Native 配对以 `delivery-lock.json`、
`native-sdk-lock.json` 和归档 SHA256 为准，协议指纹保持：

```text
8c2a5a935335463ecedef622011c187c645a9130df1b18610b0fba1262504ce9
```

## 安装

```sh
shasum -a 256 -c SHA256SUMS
npm install ./tbc-kit.tgz
```

Web/Node 无需另外安装官方完整 SDK。查询 API、创建客户端不加载 WASM；
Node 的交易构建仍在首次使用时加载包内 WASM，行为与原版相同。

React Native 解压所需平台的 SDK 后运行：

```sh
node node_modules/@tbc/kit/examples/react-native-engine/install.mjs \
  /absolute/path/to/app /absolute/path/to/extracted-sdk --platform ios
```

Android 使用 `--platform android`。双端工程可将两个 SDK 解到同一目录，
相同的 `identity.json` 只保留一份，再用 `--platform all`。安装脚本不会下载
任何文件；它先核对资源身份，再复制对应平台文件。不得混装其他候选的 SDK。
具体原生链接、后端注入、账户、审批及 Signer 配置见安装包内
`examples/react-native-engine/README.md`。不增加自动回退或运行时下载。

## 能力与兼容

包内 `SUPPORT.md` 补齐 NFT 批量转移、铸造查询、到账核验、存钱罐查询和
当前合约支持范围；`docs/compatibility.md` 明确三个方向：

- 新 DApp → 标准钱包：支持。
- 旧 `window.Turing` DApp → 开启 Legacy 的 Kit 钱包：支持已有映射。
- 新 DApp → 只提供 `window.Turing` 的旧钱包：没有自动反向适配。

PiggyBank 对应当前 `timelock` 高度锁接口；历史 PoolNFT/Pool v1 没有独立高层
业务实现。本轮只说明真实边界，不以修改文档冒充新增合约支持。

## 检查与证据

本候选包含 `REPORT.md`、`evidence/`、源码快照和 SHA256 清单。
干净 npm 安装、类型/导出、浏览器按需加载、配套 SDK 装配、桥接并发与错配拒绝
属于本轮定向检查；不把这些结果称为新的设备端或链上业务验收。
保留一次审批、并行预取、数据复用及必要校验。

平台二进制从 npm 默认包移出，不等于移动 App 的最终体积降低同样比例。
手机 App 仍需其目标架构的原生库。本轮的主要收益是避免给 Web/Node 用户下载
移动库，以及避免移动接入同时下载两份相同原生资源。
