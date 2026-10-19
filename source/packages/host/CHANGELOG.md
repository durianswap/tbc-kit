# Changelog

## 1.0.0-draft.6.9

- `markCallUncertain` 成功后、调度首个 heartbeat 与触发 Port 之前，先以相同
  owner/fencing token 续租，确保此前 Store 读取/写入耗时不会侵蚀 Port 的首个租约窗口。
- Port 前续租失败时保持 call 为 `uncertain`，不触发 Port；可控时钟回归证明接近 TTL 的
  前置 Store 延迟后，第二实例在首 heartbeat 前仍不能接管。
- 关键 heartbeat、fencing、stop/in-flight 与慢 Port 测试改用可控 scheduler/fake clock，
  不再依赖 60ms wall-clock 竞态。
- 该候选取代被拒绝的 `1.0.0-draft.6.8`；6.8 的提交与 tar 字节保持不可变，仅作失败证据。

## 1.0.0-draft.6.8

- 在每次 Port await 的整个区间以相同 owner/fencing token 维持单飞 lease heartbeat，
  heartbeat 间隔不超过 lease TTL 的三分之一。
- Port 返回后先取消调度、等待在途续租并最后续租，之后才允许 durable response commit；
  任一续租失败都会 fencing 结果，且不会重试 Port 或 broadcast。
- 计时器由钱包运行时通过 `scheduleLeaseHeartbeat` 显式注入，不属于九个 Host Ports，
  Host 根包继续不读取 ambient timer；MV3 worker 终止后不会留下包内计时器能力。
- wire、Schema、Registry、九个 Host Ports 与五方法 Host facade 均未改变；该候选取代
  `1.0.0-draft.6.7`，后者字节与来源保持不可变。
- 人工审批的长期 suspended-checkpoint/释放租约协议仍是后续工作，不在本补丁中扩展。
- 后续复核发现首个 heartbeat 从 `markCallUncertain` 之后才开始计时，不能补回同一步骤
  前置 Store 工作已经消耗的租期；该候选已被 `.6.9` 取代，不应集成。

## 1.0.0-draft.6.7

- 将受限 `caller` / `arguments` accessor 的 getter/setter 身份精确绑定到引擎原生
  intrinsic descriptor，拒绝形状相同但由攻击者提供的自定义 accessor。
- 修正候选包自身的版本、README、测试与变更记录身份；运行时代码与不可变的中间候选
  `1.0.0-draft.6.6` 相同，并取代 `1.0.0-draft.6.5` / `.6.6` 作为当前未发布候选。
- wire、Schema、Registry、九个 Host Ports 与五方法 Host facade 均未改变。

## 1.0.0-draft.6.6

- 首次引入受限 accessor 的引擎原生 intrinsic 身份校验，但随包 README 与公开面测试仍残留
  `.6.5` 身份；该字节版本仅保留为不可变历史中间候选，不应继续使用。

## 1.0.0-draft.6.5

- 尝试允许 JavaScriptCore 与 Hermes 在普通函数上暴露的标准受限 `caller` / `arguments`
  accessor，但安全复核发现其仅比较 descriptor 形状，不能拒绝形状相同的恶意自定义
  accessor；该候选已由 `.6.7` 取代。
- 仅作为未发布的移动端补丁候选；wire、Schema、Registry、九个 Host Ports 与五方法
  Host facade 均未改变。

## 1.0.0-draft.6.3

- 新增可选的 `expectedAuthorityIdentity`，Host 在任何 Core/Port 工作前重读并精确绑定 Authority。
- 新增兼容默认关闭的 `deferDeliveryAcknowledgment`，支持 durable Transport 先 enqueue 再确认 Host delivery。
- `listRecoverable` 覆盖终态但尚未确认的 delivery；Memory、IndexedDB、SQLite 保持同一契约。
- 同一 Host 实例有界保存操作创建前到达的可信取消，避免 cancel/start 竞态丢失。

## 1.0.0-draft.6.2

- 新增 opt-in `@tbc-wallet/host/sqlite`，通过注入式事务 driver 支持移动端持久化。
- 新增 canonical row 校验、4 MiB 上限、命名空间隔离和索引身份绑定。
- 新增原子 CAS、effect journal、session commit、delivery、单调 lease fencing 与释放锚点。
- 覆盖关闭重开、双连接 100 次重放、busy、rollback 和 counter rollback ABA。
- SQLite 子路径通过 Browser、Worker、React Native/Hermes、Node ESM/CJS 可移植性扫描。

## 1.0.0-draft.6.1

- 新增严格五方法的 durable Host facade。
- 固定九个 Host Port，并将 Provider Session Authority 保持为钱包私有控制面。
- 新增带 lease fencing、CAS、call/session/delivery journal 的 Memory Store。
- 新增 opt-in、显式注入 `IDBFactory` 的 IndexedDB Store。
- 覆盖 11 个 Port 操作的三类崩溃窗口、Authority CAS 恢复和双 Host 竞态。
- 以真实 Core 与 TBC Engine 验证 canonical、任意合法参数及 testnet profile 转账。

这是 Draft.6 的实现补丁，没有修改 wire protocol、Schema、Registry、测试向量或冻结
release manifest。
