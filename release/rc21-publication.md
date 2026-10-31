# rc.21 发布配对

默认 JavaScript / TypeScript 下载为 `0.1.0-rc.21`，直接使用已验证的 Release
归档，不重新编译或打包。源码标签为 `v0.1.0-rc.21`，提交
`cc5c3554bf6036eea1fe942930a493fb6294f7b6`。

- [下载](https://github.com/durianswap/tbc-kit/releases/tag/v0.1.0-rc.21)
- [安装与配对](../docs/installation.md)
- [Signer 接入](../packages/kit/docs/signer-integration.md)
- [冻结候选报告](candidates/host-port-signers-rc21/REPORT.md)
- [候选包锁](candidates/host-port-signers-rc21/delivery-lock.json)

JS 包为 5,541,374 字节，SHA256：
`a7df6f8b6f98dba2b4691dd854eacee5c344b4781422529cd195912cd0bb6c91`。
Native SDK 仍为 `0.1.0-rc.19.native.2`；原生二进制、构建身份、协议指纹和
原始归档均不变。Flutter 继续使用独立原包，SHA256：
`f782b21ff2aa5d069669ae080615bde083e45006e5536a98b11233025d322b7f`。

当前源码与候选冻结快照一致；仓库主页、下载清单和说明按本次提升更新。
候选报告中的“当前交付不替换”记录其形成时的状态，不改写历史报告或归档。
此次只将 JS 候选选为默认版本，合作方交付包不动。

提升检查覆盖下载哈希、展开文件、源码一致性、平台配对、文档链接、干净 npm
安装和离线入口/示例；不重复已通过的业务验收，不读取账户或进行真实广播。
同事环境中的 Coin 原始失败仍需其 Port 日志确认，不能把发布视为现场验收。

## 提升检查结果

- 从版本化 Releases 取回分发材料；10 项远程附件的大小与 SHA256 匹配。
- 4 个配套归档、1,151 个展开文件、2,219 个源码文件一致性通过。
- 54 份公开说明中的 166 条本地链接有效。
- 仓库分发、TBC 接口和 WebView 桥接检查：21/21。
- 干净 npm 安装实际加载 `0.1.0-rc.21`：8 个 ESM、8 个 CJS 入口及
  2 个离线示例通过；三种签名配置、错配拒绝和 BIP340 向量检查通过。
- 原 174 个受保护文件哈希不变，Flutter 包及其 181 个清单文件不变。

这是仓库提升与安装验证，不是重新执行设备端或链上业务验收。
