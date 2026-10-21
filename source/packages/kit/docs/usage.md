# JavaScript / TypeScript 使用手册

## 多收款人与定额 TBC 付款

统一业务入口 `tbc20.transfer` 根据经校验的资产脚本选择实现，不由调用方猜测新旧版本：

```ts
const intent = {
  type: "tbc20.transfer", version: "1.0", contractId,
  receivers: [
    { to: addressA, amount: "100" },
    { to: addressB, amount: "200" },
  ],
};
```

历史 FT 单笔最多 5 个收款人，超过 5 个明确拒绝，不自动拆单；已有的
`to` / `amount` 单收款人写法不变，不能与 `receivers` 混用。碎片输入需要
归并时，仍使用同一批准绑定的维护交易流程，不能把输入归并误认为收款人拆单。
历史 FT 的附带 TBC 仍仅支持单收款人同址付款；历史稳定币仍为单收款人。

新 TBC20 可额外附带 `payment: { to: paymentAddress, amount: "1234" }`。
所有金额都是最小单位整数字符串；新 TBC20 的普通 TBC 付款至少 42 最小单位，
与手续费及找零分别计算、分别展示。支付占用输出组，实际可用收款人数还受
Token 找零、TBC 找零及金额分槽约束。配置不适用时明确拒绝，不丢弃付款。
多轮输入维护只在最后的业务交易支付一次，不在每轮重复支付。

主动原生币归集 `tbc.maintenance.merge` 单笔支持 2–500 个输入。
默认取一个最多 500 项的 UTXO 页面，不为原生币下载祖先交易。
它不会无限递归清空账户，也不扩大普通转账/AMM 的自动手续费取数范围。
已有多轮归集仍按每轮最多 100 个输入的批准范围执行，明确绑定每轮选中的
outpoints，不因单笔上限提高而扩大已批准的输入集合。

## 后端接入已构造交易

`createTbcBackendService` 的 `reviewedTransaction` 接受已有标准能力或一个
按服务身份创建能力的工厂。复用 `createTbcStandardWorkflowCapabilities`
返回的 `reviewedTransaction`，不要另写交易构造或审批校验逻辑：

```ts
const service = createTbcBackendService({
  serviceId: "org.example.settlement", account, engine, network, signer, authorize,
  reviewedTransaction: (context) => makeServiceReviewCapabilities(context).reviewedTransaction,
});
const prepared = await service.prepareWorkflow({
  version: "1.0", chainId: account.chainId, from: account.address,
  expiresAt, maxTotalFee: "1000",
  steps: [{ id: "reviewed", kind: "reviewedTransaction", dependsOn: [],
    request: { payload: { format: "raw", transactions } } }],
});
const signed = await service.executePrepared({ kind: "workflow", action: "sign", prepared });
```

`makeServiceReviewCapabilities` 是调用方的装配函数，用服务自己持有的审核器、
签名适配器和当前账户校验创建共享标准能力。工厂提供的 `context` 含绑定的
origin、sessionId、navigationId、chainId、accountId、account 和 `isActive()`；
不得用远端请求中的身份替换这些值。也支持 `format: "associated"` 的父子交易材料。
准备阶段不加载私钥能力；执行必须显式提供 `authorize` 与 `signer`，整批一次批准。
未配置审核能力则拒绝，批准后材料变更也拒绝。默认只签名，发送仍须显式接入广播和对账。

## Registering a wallet

Discovery reuses a live session created with **wallet-platform authority**:

```ts
// platformAuthority comes from the trusted extension/native transport, not
// DApp input, window.location, display metadata or a fixed sample origin.
const session = await runtime.openSession({ authority: platformAuthority });
await runtime.register(session);
const descriptor = await runtime.standardWallet(session);
// On navigation, revocation or transport shutdown:
session.close();
```

The session must belong to this runtime and remain live. No-argument discovery,
foreign sessions and static `openSession({ origin })` fixtures are rejected.
Repeated registration of the same live session is idempotent; distinct sessions
have distinct Providers. Registration does not open another session or reread
accounts. Existing explicit Provider/session operations retain their behavior.
The platform must keep authority current and close sessions when their transport
ends. A Wallet Standard descriptor is discovery metadata, not a permission grant.
Registration is scoped to the page/document lifetime; closing a session disables
its Provider, not a guarantee that every DApp removes its cached discovery item.

`@tbc/kit/testing` is an intentional public test-support surface, limited to
`createRequestLedger`, `createImmutableTransactionCache`,
`loadIndependentGroups`, `selectThenLoadAncestry`, `createLegacyKitFacade`,
`createOptimizedChainDataResolver`, `assertRequestBudget`, and their exported
types. Internal evidence JSON is not packaged; only the declared runtime
artifacts and public test helpers are part of the tarball contract.

```ts
import { createTbcClient } from "@tbc/kit";

const client = createTbcClient({ network: "testnet" });
const discovered = client.wallets();
renderWalletChoices(discovered, async (selected) => {
  const wallet = await client.connect({ wallet: selected });
  await wallet.sendTbc({ to, amount: "1000" });
});
```

`connect()` requests account access only. Before using the public
`wallet.crypto` helpers, the DApp must explicitly request the `tbc_crypto`
capability through the connected Provider:

```ts
const wallet = await client.connect({ wallet: selected });

await wallet.provider.request({
  method: "wallet_requestPermissions",
  params: [{
    tbc_accounts: {
      chains: [wallet.chainId],
      maxAccounts: 1,
    },
    tbc_crypto: {
      chains: [wallet.chainId],
    },
  }],
});

const encrypted = await wallet.crypto.encrypt({
  message: {
    encoding: "utf8",
    data: "wallet-owned secret",
  },
});
```

An early preparation review or DApp consent screen is not a permission grant;
only the successful `wallet_requestPermissions` result establishes
`tbc_crypto` authority. The wallet still performs its formal, request-bound
approval for every `wallet.crypto.encrypt(...)` and
`wallet.crypto.decrypt(...)` operation. Permission does not pre-approve those
operations.

Direct Pool swaps require a caller-selected replay deadline. Kit never invents
one from an ambient clock:

```ts
const wallet = await client.connect({ wallet: selected });
const expiresAt = new Date(Date.now() + 5 * 60_000)
  .toISOString()
  .replace(/\.\d{3}Z$/, "Z");
await wallet.pool.buy({
  poolContractId,
  receiver: wallet.account,
  tbcAmount: "1000",
  minimumFtAmount: "1",
  constraints: {
    expiresAt,
  },
});
```

The deadline is mandatory for both `pool.buy` and `pool.sell`, and the protocol
accepts UTC seconds or 1–3 fractional digits. New timestamps use
`YYYY-MM-DDTHH:mm:ss.SSSZ`. A missing, malformed or
already-expired value fails before Transport; the wallet still enforces the
same signed request deadline independently.

Use `formatProtocolTimestamp(Date.now())` for new unbound timestamps and
`parseProtocolTimestamp(text)` to validate a timestamp without rewriting it.
Never normalize timestamps inside signed messages, approval bindings or existing
checkpoints. Equivalent instants may have different signed bytes. Expiry uses
instant comparison, including milliseconds, with no rounding extension.

When a DApp wants to show recommended or partner wallets even before discovery,
configure a presentation catalog and merge it with the live Wallet Standard
registry:

```ts
import { createTbcClient } from "@tbc/kit";

const client = createTbcClient({
  network: "testnet",
  walletCatalog: [{
    productId: "org.example.wallet",
    name: "Example Wallet",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    homepageUrl: "https://wallet.example/",
    installUrl: "https://wallet.example/install",
  }],
});

const showChoices = (choices) => renderWalletChoices(choices, async (selected) => {
  // Only a detected option has a discovered wallet and concrete Provider.
  if (selected.status === "detected") {
    const wallet = await client.connect({ wallet: selected.wallet });
  }
});
showChoices(client.walletOptions());
const unsubscribe = client.subscribeWalletOptions(showChoices);
```

`renderWalletChoices` is the DApp's own UI function; the user supplies
`selected`. Kit intentionally does not ship a framework-specific picker.

`not-detected` means only that no matching Wallet Standard registration is
visible in the current page. It does not prove that a wallet is not installed.
The DApp may render the configured HTTPS `installUrl` as ordinary navigation,
but Kit never opens or executes catalog URLs. `productId`, name, and icon are
metadata rather than authentication, permission, or authority. If two instances
claim the same product ID, or two products use the same display name, show both
and pass the exact user-selected descriptor to `connect({ wallet })`; Kit never
chooses an instance by product ID. The older `walletName` convenience rejects
ambiguous names, and connection without a selection rejects when multiple
wallets are available.

Wallet authors set `productId`, name, and icon in `createTbcWallet(...)`; the
private `profile` remains an authority scope and is deliberately unrelated.
See the runnable [multi-wallet example](../examples/multi-wallet/README.md). This
flow covers injected Wallet Standard providers only. Mobile deep links, QR
pairing, WalletConnect, and cloud transports are not claimed or implemented.

Wallet implementers can run the separate
[independent-wallet example](../examples/independent-wallet/README.md). It uses a
non-Turing product identity and only public Kit entry points to exercise the
default network, default Node Engine, approval/Signer, a signed transaction to
dependent-message sequence, associated public journaling, and shared FT/Pool
metadata. Its platform fetch and scalar-1 signer are controlled offline
fixtures; POST and broadcast remain zero.

Stablecoin transfer uses the same connected-wallet lifecycle as the other
public transaction intents. Amounts are canonical raw decimal integers:

```ts
await wallet.stablecoin.transfer({
  contractId,
  to: wallet.account,
  amount: "1000000",
});

await wallet.maintenance.mergeStablecoin({ contractId });
```

Wallet-owned build/sign and DApp Prepared flows use the same canonical intent;
they do not introduce a separate stablecoin executor:

```ts
const intent = {
  type: "tbc.stablecoin.transfer",
  version: "1.0",
  contractId,
  to,
  amount: "1000000",
} as const;

const signed = await wallet.walletBuild.sign({ intent });

const prepared = await prepareTbcTransaction({
  request: {
    version: "1.0",
    chainId: wallet.chainId,
    from: wallet.account,
    intent,
  },
  network,
  engine,
});
const preparedSignature = await wallet.wallet.signProposal(prepared);
```

This legacy stablecoin helper selects 2 to 5 inputs for a single merge.
Use the unified business methods for current stablecoin operations and administration.

DApps stay on the package root. `composeTbcWorkflow(...)` adds stable local
step IDs, backward-only dependency validation and ordered result typing over
the existing `tbc_signWorkflow` executor; it does not add a second workflow
runtime or turn sign-only workflow results into broadcasts:

```ts
import { composeTbcWorkflow } from "@tbc/kit";

const workflow = composeTbcWorkflow({
  steps: [{
    id: "message",
    kind: "message",
    dependsOn: [],
    message: { encoding: "utf8", data: "approve this exact workflow" },
  }],
});
const signed = await wallet.walletBuild.signWorkflow(workflow);
```

After the existing `tbc_accounts` and `tbc_sendTransaction` permissions are
present, a DApp can request the same wallet-owned bounded multi-round merge
without importing `/wallet` or receiving a wallet session object:

```ts
const result = await wallet.maintenance.multiRoundMerge({
  asset: { kind: "tbc" }, // also ft, stablecoin, pool-ft, or ftlp
  limits: {
    targetUtxoCount: 1,
    maxTransactions: 4,
    maxTotalFee: "5000",
    expiresAt,
  },
}, { signal });
```

The Provider request opens one bounded approval and returns an immutable
terminal progress trace plus the ordinary complete/partial/stopped/uncertain
result. `atomic` is always `false`: accepted transaction identities remain
visible on partial or uncertain completion, cancellation is scoped to this
request, and an uncertain submit is reconciled rather than repeated. Live
progress presentation remains wallet-owned. Stablecoin uses its existing
2–5-input transaction contract; six fragments are the minimum state that
forces two rounds when the target is one.

The placement of this orchestration extension, including the rule that every
step still enters the canonical Core/Host `tbc_sendTransaction` path, is
recorded in
the installed `/wallet` type definitions.

Wallet implementers get bounded multi-round TBC, FT, Stablecoin, Pool-held FT and FTLP
consolidation directly
from the default wallet session. Mobile supplies only its existing account,
scope UI, Signer, storage/authority and default-network transport:

```ts
const runtime = createTbcWallet({
  accounts,
  approval, // existing ordinary approval UI
  multiRoundMerge: {
    approve: showBoundedMergeScope, // exactly one finite scope UI
    // Reuse the wallet's existing journal + token vault for Core's exact
    // per-step binding. This must issue a credential without reopening UI.
    authorizeStep: issueApprovedMergeStepCredential,
  },
  signer,
  storage,
  network: { defaultTestnet }, // or defaultNetwork
});
const session = await runtime.openSession({ authority });

const result = await session.runMultiRoundMerge({
  // Also: { kind: "ft", contractId }, { kind: "stablecoin", contractId },
  // { kind: "pool-ft", poolContractId }, or { kind: "ftlp", poolContractId }.
  asset: { kind: "tbc" },
  limits: {
    targetUtxoCount: 1,
    maxTransactions: 4,
    maxTotalFee: "5000",
    expiresAt,
  },
  signal,
  onProgress,
});
```

For Pool assets, `multiRoundMerge.approve({ scope })` receives a derived
`scope.impact` with `poolIdentity: { poolContractId, ftContractId,
currentPoolTxid }`, the exact per-transaction asset-input bound, and explicit
`custody` / `resultOwner`. Pool-held FT is `pool-contract` to
`pool-contract` and uses at most four asset inputs in addition to its existing
covenant/fee semantics. FTLP is `active-account` to `active-account`, uses at
most five asset inputs, and does not claim a Pool-state input. A Pool FT state
advance is accepted only when the next Pool state is the transaction just
accepted by this run; FTLP requires the Pool state identity to remain unchanged.
The Pool and underlying FT identities may never change inside the approved run.

Kit owns the permission-first entry, fresh index, deterministic selection,
Chain Data and Engine plan, scope-to-formal binding checks, Signer execution,
durable submit/reconcile and bounded index refresh. The wallet-owned
`authorizeStep` hook writes Core's exact per-step binding into the same approval
journal and token verifier already used by Signer; Kit never fabricates an
approval ID or token, and the hook must not reopen native UI. It runs only after
Core produces a plan whose request, authority and fee are inside the approved
scope. `createTbcMultiRoundMergeOrchestrator` remains
available as an advanced low-level adapter for non-default networks.

This API does not reinterpret the existing one-shot `mergeTbc` or `mergeFt`
methods. The first approval is a bounded run consent, not an unlimited grant;
each step remains tied to its final material and formal Kit approval. A fee or
fact outside the approved scope stops before the next Signer/POST. An uncertain
POST is reconciled and never blindly repeated. Completed txids remain in a
partial result because multiple transactions are not chain-atomic. See the
runnable [installed-package example](../examples/multi-round-merge/README.md).

The package root has separate browser and React Native implementations behind
the same `@tbc/kit` specifier. Browser builds retain synchronous Wallet Standard
discovery. The `react-native` condition never statically evaluates the DOM-only
Wallet Standard registry; its client supports an explicitly supplied Provider
and reports no browser-discovered wallets. Mobile does not need an `Event`
polyfill, wrapper, or alternate import path.

The same root also exposes the low-level Wallet Standard seam needed by a
WebView page and a custom DApp discovery UI: `registerTbcWallet`,
`getTbcWallets`, `subscribeTbcWallets`, `isTbcProviderFeature`, the two feature
constants, and self-contained TBC wallet types. Browser builds delegate these
operations to the official registry. The React Native condition exposes the
same names without loading a DOM registry: registration is a validated no-op,
discovery is empty, and subscriptions never emit. A page bootstrap bundled for
the browser and the DApp page can therefore import only `@tbc/kit`; the native
host continues using its explicit Provider and must not treat display metadata
as authority or instance identity.

Importing only this discovery seam does not statically retain the transaction
Engine or its WASM artifact. The default Engine used by the asynchronous
proposal helpers is loaded only when a proposal helper is actually called;
explicitly injected engines remain unchanged.

For a native WebView, create its page Provider and transport together from the
same Kit version. This prevents a separately frozen Provider codec from
drifting behind the Host/native schema:

```ts
import { createTbcKitWebViewPageProvider } from "@tbc/kit";

const page = createTbcKitWebViewPageProvider({
  channel: platformWebViewStringChannel,
  isTopFrame: () => window.top === window,
});

page.acceptInitialize(nativeInitializeEnvelope);
installPageProvider(page.provider);

// At verified navigation or session end:
await page.destroy();
```

The channel and initialize envelope remain platform/native-owned. Do not install
or import `@tbc-wallet/provider` for this page path: the root factory bundles
the Provider, WebView transport, strict codec, and generated validators from
this exact Kit release. Invalid or stale native envelopes still fail closed.
DApp code that needs the Provider interface imports `TbcProvider` from the Kit
root. Known methods retain typed results, the interface is structurally
assignable from the Wallet Standard Provider in this release, and runtime
validation still uses the exact schema bundled into Kit. Consumers do not need
a private package.

The wallet-native half comes from the same installation through `/wallet`:

```ts
import {
  TBC_WEBVIEW_CHANNEL,
  assertTbcProviderRequest,
  createTbcKitWebViewNativeController,
  decodeTbcWebViewPageMessage,
  encodeTbcWebViewNativeMessage,
  encodeTbcWebViewPageMessage,
  type TbcWebViewNativeHandlers,
  type TbcWebViewSessionStore,
  type TbcWebViewVerifiedNavigation,
} from "@tbc/kit/wallet";

const native = createTbcKitWebViewNativeController({
  channel: platformWebViewStringChannel,
  store: durableWebViewSessionStore,
  chainId,
  handlers: {
    send: (request) => session.handleRequest(request),
    acknowledgeDelivery: acknowledgeHostDelivery,
    cancel: (requestId) => session.cancelRequest(requestId),
    close: () => session.close(),
  },
});

await native.openNavigation(
  verifiedNavigation satisfies TbcWebViewVerifiedNavigation,
);
```

The platform still owns construction of verified navigation, the string-only
WebView bridge, durable session/outbox storage and Host-delivery acknowledgment.
The bundled controller preserves the existing ACK, replay and termination
semantics; the page cannot provide or replace those authorities. Wallet-native
code also imports its JSON-RPC/Provider types, strict request/event/delivery
validators, WebView envelope decoders and digest from this same `/wallet`
entry. A production Mobile consumer therefore needs no direct
`@tbc-wallet/provider` import or installation, while its verified navigation,
session store and lifecycle implementations remain wallet-owned.

Standard message and typed-data signing are also root-client operations. Sign-in
is a Kit profile over exactly one standard message request; it is not a wallet
RPC method. The package includes a runnable, non-production frontend/backend
example with an explicit process boundary:

```sh
node node_modules/@tbc/kit/examples/sign-in/run.mjs
```

The example backend issues and stores a random challenge bound to one login
attempt, atomically changes it from `issued` to `consumed`, rejects replay, and
creates the login session only after verification. Its frontend executes both
public signing methods plus Sign-In through a real local Kit wallet. It also
proves that a valid signature from a public key that does not derive the
claimed TBC P2PKH address is rejected before challenge consumption. See
`examples/sign-in/README.md` and the source beside it.

The example's in-memory Map is deliberately not a production database. A real
backend owns durable challenge issuance and must implement the exact conditional
`issued -> consumed` update as one database transaction before creating a
session. Kit verifies the canonical message, signing payload, recoverable
signature, recovered compressed public key and its TBC address binding before
it invokes that callback.

```ts
import {
  configureTbcKitSha256Backend,
  createTbcNetworkContext,
  createTbcWallet,
} from "@tbc/kit/wallet";
import {
  createTbcKitMemoryHostStore,
  createTbcKitSqliteBroadcastJournal,
} from "@tbc/kit/sqlite";

// Trusted wallet bootstrap only. Mobile can bind its existing synchronous
// platform SHA-256 primitive before creating a wallet or handling a request.
configureTbcKitSha256Backend(platformSha256);
const liveHostStore = createTbcKitMemoryHostStore({
  sha256: platformSha256,
});
// The wallet supplies only its SQLite platform driver. Kit owns the broadcast
// identity, uncertainty, replay and reconcile state machine.
const broadcastJournal = await createTbcKitSqliteBroadcastJournal({
  driver: platformSqliteDriver,
  // Mobile can consume its existing three tables in place with:
  // schema: "legacy-tws-mobile-v1"
});
const networkContext = createTbcNetworkContext({ network: "testnet" });

const wallet = createTbcWallet({
  accounts,
  approval,
  signer,
  storage,
  network: {
    defaultNetwork: {
      network: networkContext,
      fetch,
      broadcast: { journal: broadcastJournal },
      // poolNative is optional. Web uses the bundled keyless WASM; a mobile
      // platform may inject createNativeTbcKeylessEngine(nativeExecute).
    },
  },
});

// A native WebView wallet injects only its platform-verified Host authority.
// This is wallet composition state, never DApp request data.
const session = await wallet.openSession({
  authority: verifiedAuthoritySource,
  execution: { hostStore: sessionMemoryHostStore },
});
```

Wallet-native screens and background coordinators use that same session; they
do not need a WebView or a second execution runtime. The low-level facade
starts, inspects and resumes the exact Kit Core/Host operation while retaining
the same authority, Port calls, call journal and Store selection as
`handleRequest`:

```ts
const started = await session.startOperation(exactWalletRequest);
const inspection = await session.inspectOperation(started.operationId);
const resumed = await session.resumeOperation(started.operationId);
const cancelled = await session.cancelOperation(started.operationId);
```

`startOperation` is wallet-owned and accepts the same validated JSON-RPC
request shape as `handleRequest`; it is not a Provider method and must not be
given to page code. All new operations use this one live-session Store and can
be resumed only while it exists. `storage.hostStore` is retained only to
inspect or explicitly cancel historical operation records; Kit never resumes
those rows after restart. Approval, signing, raw bytes and whole transaction
plans are not restart state.

`cancelOperation` defaults to `REQUEST_ABORTED` and goes through the same Core
cancellation transition and Host journal. It does not directly interrupt a
Signer or network callback; an in-flight Port completes and the cancellation
is applied cooperatively before the next effect.

The default network's `now` callback and the wallet `clock.now` Port must come
from the same trusted clock. This does not add I/O: pass the same function
reference to both compositions. Letting the default network fall back to wall
clock while Core uses a fixture or platform clock can create a snapshot after
the request deadline; Engine validation correctly rejects that plan as
`PLAN_EXPIRED` and must not be weakened to hide the composition error.

The default broadcast path requires a durable Kit journal, but not a durable
Host store. It validates raw/txid identity,
persists `prepared` before preflight, marks `uncertain` before the network POST,
returns a stored accepted result on exact replay, and only calls status
reconciliation after an ambiguous POST. It never blindly resubmits an
uncertain identity. A restarted `prepared` identity is audit-only and never
POSTed; only `uncertain` may be queried. The journal binds the network source,
active-account scope, exact Host-call digest, txid, raw hash, idempotency key
and result without retaining raw transaction or signatures.

`createTbcNetworkContext({ network: "mainnet" | "testnet" })` is the single
transaction-stack selector. It binds the Engine profile, chainId, default API
origin, policy, chain-data caches, Pool material and broadcast recovery to one
immutable source identity. Official Mainnet uses
`https://api.turingbitchain.io`; official Testnet uses
`https://api.tbcdev.org`. An audited custom API/RPC origin must use
`endpoint: { kind: "trusted-custom", apiOrigin, rpcOrigin?, trustId }`.
Supplying the other network's official origin fails before I/O. A runtime never
mutates or switches this context: close its sessions/controllers and construct
a new runtime, with a distinct broadcast journal, so old in-flight requests
cannot be redirected or relabeled. `defaultTestnet` remains only as the
backwards-compatible Testnet composition path.

Official chain IDs are `tbc:mainnet` and `tbc:testnet` (ASCII colon), not block
hash prefixes. Endpoint consistency validates trusted local configuration, not
an independent proof of the remote node's chain. Kit adds no anchor lookup or
per-transaction network-identification request. Testnet reset detection and
old-state migration are not performed automatically; old hash-derived IDs
are not official-network aliases.

The official network surfaces are separate, inert subpath imports. `/api`
contains the 60 documented REST endpoints; `/rpc` contains the exact 127
methods registered by TBCNODE v3.3.1. Neither subpath imports Engine, Signer,
wallet UI, native code, or WASM:

```ts
import { createTbcOfficialApi } from "@tbc/kit/api";
import { createTbcReadRpcClient } from "@tbc/kit/rpc";

const api = createTbcOfficialApi({ network: "testnet", fetch });
const [{ blocks }, { utxos }] = await Promise.all([
  api.nodeInfo(),
  api.utxosByAddress({ address }),
]);

const rpc = createTbcReadRpcClient({
  url: "https://read-only-rpc.example",
  fetch,
});
const height = await rpc.getblockcount();
```

API and RPC endpoints are never substituted for each other. Every JSON integer,
including zero and values above JavaScript's safe range, is returned as a
decimal string. Fractions remain numbers. The complete machine-readable
coverage matrix ships as `artifacts/api-rpc-coverage.json`.

Node administration and wallet RPC are deliberately separate trusted-host
factories. They require `trustedServer: true`, reject browser runtimes, and do
not accept credentials embedded in a URL. Use `createTbcRpcTransport` only as
an explicit low-level extension escape hatch; the named clients do not expose
that escape hatch.

Kit does not impose a semaphore or fixed concurrency limit on independent
read-only network work. Tip, native index, asset index and contract requests
start as soon as their inputs exist; a real dependency, such as selected
outputs needed before ancestry lookup, remains sequential. The request ledger
single-flights the same category and exact request key within one transport
instance and retry mode. Static headers are snapshotted at construction;
instances never merge responses even when they share a ledger. Calls using
dynamic `provideHeaders` do not merge, because credentials can change identity.
Each subscriber may cancel independently. Only the last subscriber cancelling
aborts shared I/O; a caller without a signal keeps its subscription alive.
Subscribers share the original operation deadline. State-changing POST calls
are not merged. Existing collection and page bounds remain enforced.

API reads (including the read-only `txoStatus` POST) and classified read RPCs
default to at most four total attempts for fetch failures, per-attempt timeout,
HTTP 429, 500, 502, 503 or 504. Backoff has a 25ms base, a 1000ms cap and full
random jitter. Only a failure schedules a retry wait; success adds no delay or
network call. `Retry-After` seconds and HTTP dates are respected as a minimum,
even above the client backoff cap. If that wait exceeds the remaining total
budget, the last HTTP error is returned immediately with `retryAfterMs`.
JSON/body parsing errors, header-provider exceptions, response-origin/identity
mismatches, ordinary 4xx and business-envelope rejection fail immediately.

`timeoutMs` (default 15000) covers each attempt's header provider, fetch and
response body. `totalTimeoutMs` (default 30000) covers the whole operation and
retry waits. Both actively abort I/O and bound the returned promise even with a
custom adapter that ignores abort. Streaming fetch bodies are size-limited
while reading, including split UTF-8 codepoints. Native adapters without a
ReadableStream retain deadline/cancellation protection and check byte size
after `text()` resolves; use a streaming-capable adapter for an early body
memory bound.

All public API/RPC transport factories accept `retryPolicy: { maxAttempts,
baseDelayMs, maxDelayMs, jitter: "full" | "none" }` and optional `onAttempt`.
The observer receives attempt outcomes/durations/status and scheduled retry
delays with a transport-local request ID. It receives no URL, credentials or
body; its errors cannot fail requests. It is disabled by default. Existing
ledger counts remain logical request counts; observer attempt events show
physical HTTP attempts. `retry: "none"` disables retries for an individual
read. Named write methods force a single attempt even if the caller requests
retries. Configure one client per immutable identity/endpoint and reuse it.
The legacy generic RPC client cannot infer whether an arbitrary extension
method changes state, so retry is explicit for a known idempotent extension
read:

```ts
const height = await rpc.call("getblockcount", [], {
  retry: "idempotent-read",
});
```

Without that option a generic extension RPC call is attempted once. API write `POST`, broadcast,
signing and every other state-changing call are always attempted once; an
uncertain broadcast must use journal/status reconciliation, never automatic
resubmission. Retries for one request remain inside its single-flight promise.

At startup, call `session.listBroadcastRecovery()`. Treat `prepared` rows as
audit-only. Pass only selected `uncertain` txids to
`session.recoverBroadcasts(txids)`, which performs status GETs and never POSTs
transaction bytes. Unknown stays incomplete. Rows from another network source
or account scope are excluded or rejected. `recoverPostSigner` is fail-closed.

After the wallet has rendered its native request review, it may overlap only
the immutable/read-only Chain Data preparation with the user's review time:

```ts
const preparation = session.prefetchRequest(exactWalletRequest);

// Approval: execute the byte-for-byte same id/method/params request.
const delivery = await session.handleRequest(exactWalletRequest);

// Rejection, navigation, or wallet-side request invalidation:
preparation.cancel(); // session.cancelRequest(id) and session.close() also discard it
```

`prefetchRequest` is a wallet-private session seam, not a Provider method. It
runs only Engine normalization plus the same `chainData.resolve` function used
by normal execution. It does not enter the Host journal, approval, Signer,
planning, finalization, broadcast, or reconciliation. The result exists only
in memory, for at most 30 seconds and never beyond the request or snapshot
expiry. Kit binds it to the exact request hash, verified authority snapshot,
active account and chain; it rechecks all of them at execution and consumes the
snapshot once. Any miss, cancellation, expiry, changed request, navigation or
account falls back to the ordinary resolver (or to the existing Host authority
failure). Mobile must call `cancel()` on native rejection/navigation instead of
retaining a request-list preparation. This overlap is a general latency tool;
it does not replace same-device measurement of Kit's own execution overhead.

`openSession({ execution: { hostStore } })` supplies one wallet-owned memory
Host store for every new Core operation: reads, approval, signing, finalization,
submit and reconciliation. Every callback receives immutable
`call.execution.type: "session-only"`; request params cannot select another
lifetime. Durable state begins only inside the broadcast journal at submit.
The older `signOnly.hostStore` spelling is a compatibility alias and cannot be
supplied together with `execution`.

Wallets that support Standard raw/associated workflow steps and BIE1 crypto
can install both optional Ports through the shared composer instead of copying
review, conversion and result-assembly logic into the app:

```ts
import {
  createTbcStandardWorkflowCapabilities,
  createTbcWallet,
} from "@tbc/kit/wallet";

const standard = createTbcStandardWorkflowCapabilities({
  navigation, // immutable native-verified top-frame navigation
  chainId: networkContext.chainId,
  account: { accountId, address, publicKey },
  networkSourceIdentity: networkContext.sourceIdentity,
  readCurrentAuthority,
  rawReviewer,
  associatedReviewer,
  privateNative: loadWalletPrivateNativeAdapters,
});

const wallet = createTbcWallet({
  ...walletOptions,
  crypto: standard.crypto,
  reviewedTransaction: standard.reviewedTransaction,
  // `legacy` is optional and may remain absent or false.
});
```

Kit converts Standard raw/associated requests, binds the one trusted review,
computes the exact fee, assembles detached signatures or the associated
transaction dependency chain, and maps crypto results. The wallet supplies
only current authority, the existing shared reviewers and an account-scoped
one-shot Native adapter; private keys and handles never enter Kit. Approved
execution is deterministic from the Core task and approval receipt, so a
recreated composer does not need an in-memory review map or a second API read.
The composer adds no HTTP request, approval, retry or duplicate transaction
construction. Host remains responsible for durable Port-call replay; private
effects are never automatically retried by this layer.

Legacy FT and Pool precision metadata has a default wallet entry. The wallet
selects one immutable network context and supplies its trusted fetch driver;
Kit owns endpoint routing, response parsing, Pool-to-FT identity, decimals
lookup, concurrent single-flight and short bounded reuse:

```ts
import {
  createLegacyFtTransferIntentResolver,
  createLegacyPoolIntentResolver,
  createLegacyStablecoinTransferIntentResolver,
  createTbcLegacyMetadataResolver,
} from "@tbc/kit/wallet";

const metadata = createTbcLegacyMetadataResolver({
  network: networkContext,
  fetch: platformFetch,
});
const legacyPoolIntents = createLegacyPoolIntentResolver({
  chainId: networkContext.chainId,
  metadata,
});
const legacyFtTransfers = createLegacyFtTransferIntentResolver({
  chainId: networkContext.chainId,
  metadata,
});
const legacyStablecoinTransfers = createLegacyStablecoinTransferIntentResolver({
  chainId: networkContext.chainId,
  metadata,
});
```

The default cache is scoped to `network.sourceIdentity`, holds at most 32 FT
and 32 Pool identities, and expires after 30 seconds. Failed or mismatched
values are not retained. Name and symbol therefore are not treated as
permanent; prices are not loaded or cached. Two simultaneous Pool decimal reads
retain the existing two-request dependency (`poolinfo`, then exact FT metadata),
while a warm FT identity can reduce it to the Pool read only. Mainnet and
Testnet instances cannot share results. Advanced wallets may still inject
`getFtInfo` or `resolvePoolFtDecimals`, but no wallet needs to rewrite the
default chain loader. Request amounts, accounts, grants, UTXOs and spendability
are never cached by this metadata service.

Associated transaction preparation/result validation is also shared without
moving any secret or native signing authority into Kit:

```ts
import { createLegacyAssociatedTransactionService } from "@tbc/kit/wallet";

const associatedTransactions = createLegacyAssociatedTransactionService({
  journal: walletDurableAssociatedJournal,
});

// In the wallet-private, already approved Signer path only:
const request = await associatedTransactions.readRequest(operationDigest);
const result = await walletPrivateNativeSigner(request);
await associatedTransactions.complete(operationDigest, result);
```

The journal is a wallet/platform durable adapter. Kit validates canonical
identity on every read, preserves the historical 32-child/33-result bound, and
exposes no scalar or private-key parameter. Native unlock, custody, secret
clearing, approval receipt validation and Signer/Host binding remain wallet
responsibilities. Pool operations keep their previous sign/send ownership;
metadata is not approval, signing authority or a spendability decision.

The Legacy native controller consumes these resolvers for the historical
FT/Stablecoin display-amount DTOs. FT transfer supports false/true/default
`broadcastEnabled`; the fixed two-step FT-deposit batch stays sign-only:

```ts
const legacyController = createTbcKitLegacyWebViewNativeController({
  navigation,
  chainId,
  network: networkContext,
  platform,
  walletVersion,
  handlers,
  bitcoinMessages,
  genericBatch: standardLegacyAdapter,
  multiRoundMerge: {
    // The controller fixes targetUtxoCount to 1; the wallet supplies every
    // finite fee, transaction, refresh and expiry limit for this navigation.
    createLimits: createLegacyMergeLimits,
  },
  transactions: {
    ftCreateIntents: legacyFtCreateIntents,
    ftTransferIntents: legacyFtTransfers,
    stablecoinTransferIntents: legacyStablecoinTransfers,
    poolIntents: legacyPoolIntents,
    readTransactionContext,
    onBatchProgress,
  },
  post,
});

if (legacyController.supportsRequest(message.method, message.params)) {
  await legacyController.acceptPageMessage(serialized);
}
```

Kit owns FT create/transfer, Pool mint/init, both swaps, LP add/remove and
associated-transaction request classification and canonical mapping. Secure
standalone methods and dependent batches enter only through
`standardLegacyAdapter`; there is no direct Legacy signer/crypto fallback.
Transaction calls always enter the shared Standard approval-preparation path.
It preserves exact-grant presentation reuse, permission fallback, canonical
`{txraw}`/`{txid}` results, dependent txid insertion, first-delivery ACK ordering
and result pairing. The wallet still owns verified navigation, a
source-identity-bound current account and permission state, native review UI,
approval/Host evidence, Vault, Signer, stores and the platform channel.
Associated native transaction construction remains wallet-owned. The
controller performs no HTTP request and adds no receipt-ancestry lookup.

Legacy request-list scope and dependent-message mapping are pure helpers on the
same wallet entry. They preserve the existing native/FT/Pool/create scope,
exact canonical intent comparison and dependent `txids` insertion without
performing network, approval, storage, signing or broadcast work:

```ts
import {
  createLegacyBatchRequestScope,
  matchesLegacyBatchRequest,
  withLegacyDependentTxids,
} from "@tbc/kit/wallet";

const scope = createLegacyBatchRequestScope(legacyTransaction, account);
const exact = matchesLegacyBatchRequest(scope, canonicalRequest, ftDecimals);
const message = withLegacyDependentTxids(legacyMessage, signedTxids);
```

`ftDecimals` comes only from wallet-verified FT metadata. These helpers do not
represent consent and cannot decide approval, retain a decision, choose wallet
risk policy, access Host evidence or authorize a Signer. Native presentation,
wallet clock/store, verified navigation, policy and independent approval
material verification remain wallet-owned.

The same wallet entry exposes one fixed two-step dependent-batch coordinator.
It validates the message template before execution, stops after a first-step
business error, derives ordered txids from the finalized raw transactions,
acknowledges the first delivery before starting the dependent message, and
reports the existing 0/2, 1/2 and 2/2 progress states:

```ts
import { createLegacyDependentBatchCoordinator } from "@tbc/kit/wallet";

const batches = createLegacyDependentBatchCoordinator({ onProgress });
const outcome = await batches.run({
  messageTemplate,
  executeFirst,
  executeSecond,
});
```

Execution and ACK are injected wallet callbacks. The coordinator performs no
network, approval, signing, Host-store, presentation or broadcast work and
does not alter request IDs, permission policy or result mapping. The Legacy
facade uses this same coordinator instead of a second dependency algorithm.

Request-list consent uses one session-only, injected state machine from the
same wallet entry. It owns the live batch/operation indexes, exact request
scope, root-decision reuse and Host-delivery/raw-txid/dependent-message binding,
but receives every authority-bearing capability from the wallet:

```ts
import { createLegacyBatchConsentMachine } from "@tbc/kit/wallet";

const batchConsent = createLegacyBatchConsentMachine({
  store: hostEvidenceReader,
  journal: { readIntent: approvalJournal.readIntent },
  releaseFingerprint: kitHostReleaseFingerprint,
  now: walletClock,
  readAccount: readVerifiedNavigationAccount,
  presentRequest: presentNativeRequestList,
  createConflictError: (message) => new WalletApprovalConflict(message),
});
```

The machine is deliberately memory-only: restart creates an empty service and
never revives an earlier request-list approval from SQLite. The wallet still
owns verified navigation, the Host/evidence store and release identity,
Approval Journal decisions and receipts, the trusted clock/account reader,
native presentation, error identity, policy, Vault and Signer. The machine
performs no network, persistence, signing, preparation/prefetch or broadcast.
Its public intent shape accepts a general wallet Approval Journal whose
non-batch permission records legitimately omit one `chainId`; every batch path
continues to reject a missing or mismatched chain at the runtime binding check.

Reusable approval-material parsing and comparison are also available from the
wallet entry. They bind every transaction input, the bounded LP-remove
maintenance recipe and dependent outputs, exact parent/contract material, and
monotonic confirmation changes. The reader helper performs one approval-scoped
single-flight load keyed by the complete binding and input, expires both before
and after the load, and clears failed entries:

```ts
import {
  collectPoolRemoveInputEvidence,
  containsCanonicalEvidence,
  createPoolApprovalMaterialReader,
  matchesCurrentPoolUtxoEvidence,
} from "@tbc/kit/wallet";
```

The wallet supplies the trusted loader and clock. This mechanism performs no
network request itself and is not consent, durable authority, a policy
decision, or a signing capability. Host evidence orchestration, fresh material
loading, final approval policy, UI, Vault and Signer remain wallet-owned.

The wallet entry also exposes `createApprovalHostEvidenceReader` for the
generic authoritative envelope shared by every native approval. The caller
must supply the exact release fingerprint of the Host that owns the evidence
store; there is no bundled-fingerprint default. The reader binds the complete
Port call to its operation/checkpoint, approval state, pending-call membership,
binding and preview, and returns a detached deeply frozen identity:

```ts
const approvalEvidenceReader = createApprovalHostEvidenceReader({
  store: hostEvidenceReader,
  releaseFingerprint: walletHostReleaseFingerprint,
  parseApprovalRequest: assertWalletApprovalRequest,
  createConflictError: (message) => new WalletApprovalConflict(message),
});

// Inside the wallet-owned approval Port, using the exact Host call identity:
const hostEvidence = await approvalEvidenceReader.read(
  call.callId,
  params.binding.bindingHash,
);
const actionEvidence = assertWalletActionApprovalEvidence(hostEvidence);

// Bind/display only the returned projection. Approval and execution remain
// separate wallet-owned operations.
switch (actionEvidence.kind) {
  case "reviewed-transaction":
    showReviewedTransaction(actionEvidence.request, actionEvidence.preview);
    break;
  case "crypto":
    showCryptoAction(actionEvidence.task.purpose, actionEvidence.preview);
    break;
}
```

The store boundary is deliberately structural: only `readCall(id)` and
`readOperation(id)` returning `unknown | null` are required. A Mobile Host from
a different Core protocol union can be passed directly without a cast or JSON
wrapper; all record shape and identity checks occur inside this reader before
typed approval params are returned.

Protocol parsing and wallet error identity stay injected. Permission, message,
typed-data and transaction interpretation, signer validation, FT/Pool material,
display and risk policy remain wallet-owned and consume the returned exact
payload and memory without a second unbound store read.

`assertWalletActionApprovalEvidence` is a synchronous, read-only projection for
`tbc_signReviewedTransaction`, `tbc_encrypt` and `tbc_decrypt`. It reuses Core's
wallet-action reconstruction to bind the original request, account resolution,
trusted context, review hash, plan hash, approval binding, preview and pending
approval call. It returns only display/binding facts and a non-secret task
summary; it performs no I/O, approval, signing, crypto or execution. Passing a
page-created object directly does not establish authority: callers must pass
the detached envelope returned by their trusted wallet-owned Host reader.

Kit includes the optional historical `window.Turing` WebView
composition for the Baseline-A account/session surface and Bitcoin message
signing. It reuses the existing `/wallet` entry; there is no second npm package
or new public subpath:

```ts
import {
  TBC_KIT_LEGACY_PAGE_BOOTSTRAP_SCRIPT,
  createTbcKitLegacyWebViewNativeController,
} from "@tbc/kit/wallet";

// Inject this only when wallet policy enables Legacy for the verified page.
injectAtDocumentStart(TBC_KIT_LEGACY_PAGE_BOOTSTRAP_SCRIPT);

const legacy = createTbcKitLegacyWebViewNativeController({
  navigation: nativeVerifiedTopFrameNavigation,
  chainId,
  platform: "ios",
  walletVersion,
  handlers: walletOwnedHostDispatchAndAck,
  bitcoinMessages: walletPrivateBitcoinMessagePreparer,
  post: platformWebViewStringChannel.post,
});
legacy.initialize();
```

The controller, not page data, constructs the canonical Provider requests and
the `legacy-bitcoin:<digest>` marker. Its handlers must be registered only by
trusted wallet composition and must retain Host delivery acknowledgment. The
page receives no session object, `handleLegacyRequest`, key material, approval
authority or generic Engine execution capability. It additionally routes the
supported FT, Pool and associated-transaction slices through the trusted
adapters shown above. The associated marker enters only the wallet-private
Legacy Host route; public request data cannot supply a key, scalar or signer
callback.

Legacy remains enabled by default in `createTbcWallet`. To disable it, pass
`legacy: false`, do not inject the Legacy bootstrap, and do not construct the
Legacy controller. The Wallet Standard `tbc:provider` path is independent and
remains available. One public npm package is not a JavaScript-only promise:
Mobile still installs and binds its Rust native transaction module; Kit ships
the facade and helper artifacts, not a replacement for platform native setup.

Secure Legacy requests use the same per-navigation Standard capabilities as
public Provider requests. The controller accepts only the bounded mapper; it
does not accept a second raw signer, associated signer or crypto service:

```ts
import {
  createLegacyStandardWorkflowBatchAdapter,
  createTbcDefaultAssociatedTransactionReviewer,
  createTbcDefaultRawTransactionReviewer,
  createLegacyTbcBalanceReader,
  createTbcKitLegacyWebViewNativeController,
  createTbcStandardWorkflowCapabilities,
} from "@tbc/kit/wallet";

const standard = createTbcStandardWorkflowCapabilities({
  navigation: nativeVerifiedTopFrameNavigation,
  chainId: immutableNetworkContext.chainId,
  account: verifiedAccount,
  networkSourceIdentity: immutableNetworkContext.sourceIdentity,
  readCurrentAuthority,
  rawReviewer: createTbcDefaultRawTransactionReviewer({
    network: immutableNetworkContext,
    fetch: platformFetch,
    materialNative: sharedKeylessEngine,
  }),
  associatedReviewer: createTbcDefaultAssociatedTransactionReviewer({
    network: immutableNetworkContext,
    fetch: platformFetch,
    materialNative: sharedKeylessEngine,
  }),
  privateNative: walletPrivateNativeAdapters,
});
const session = await createTbcWallet({
  // other wallet-owned Ports omitted
  reviewedTransaction: standard.reviewedTransaction,
  crypto: standard.crypto,
}).openSession(verifiedSession);
const genericBatch = createLegacyStandardWorkflowBatchAdapter({
  chainId: immutableNetworkContext.chainId,
  context: verifiedLegacyContext,
  readAccount,
  resolveSendTransaction,
  beginApprovalPreparation: session.beginApprovalPreparation,
  executeWorkflow: session.handleLegacyWorkflowRequest,
  executeAction: session.handleLegacyActionRequest,
});
const balances = createLegacyTbcBalanceReader({
  network: immutableNetworkContext,
  fetch: platformFetch,
});

const legacy = createTbcKitLegacyWebViewNativeController({
  navigation: nativeVerifiedTopFrameNavigation,
  chainId: immutableNetworkContext.chainId,
  network: immutableNetworkContext,
  platform: "ios",
  walletVersion,
  handlers: walletOwnedHostDispatchAndAck,
  genericBatch,
  balances,
  post: platformWebViewStringChannel.post,
});
```

`signTransaction` preserves the historical TBC raw request and two-dimensional
`sigs` result, including FT/NFT/Pool covenant input scripts. Kit strictly parses
every raw transaction, validates the complete input metadata matrix, and binds
the exact raw bytes, prevout scripts, satoshis, origin, chain, account, session
and navigation to a fresh approval before invoking the wallet-private signer.
Before approval it requires the shared transaction preview path to return one
recognized asset-flow preview for every transaction. The review is hashed into
the same approval binding; missing transactions, empty groups/flows and any
unrecognized flow fail before approval. The wallet approval adapter presents
that exact structured review, not just raw hex or a hash. The authority guard
checks the committed origin/account/session/navigation before review and again
after approval immediately before Signer execution. Kit never turns this into
an ambient or reusable raw signer. It is an isolated Legacy maintenance
capability, is not implemented through `signMessage`, and does not broaden the
Standard transaction API.

`createTbcDefaultRawTransactionReviewer` is the shared prevout-trust and
business-decoding boundary. It lazily loads the published TBC transaction
parser only when historical raw signing is actually requested, compares every
caller-provided satoshi value and locking script with current official TXO
material, attaches required FT/NFT/Pool tape and origin material, and produces
the structured asset-flow preview itself. Mobile must not copy a protocol
decoder or mark page fields as recognized. The path performs one batched read
for all signed inputs and, only for covenant inputs, one second batched read for
the deduplicated tape/origin dependencies. Both use the existing idempotent
single-flight/retry policy; no confirmation, raw-transaction or server-decode
read is added. An absent/mismatched/spent prevout, incomplete contract context,
StableCoin flow, explicit nonstandard classification, unknown flow or
unspendable asset flow fails before approval.

Current source additionally checks recognized LOP orders against the Engine's
exact templates and includes committed base/quote assets, owner, volume, price,
fee rate and fee recipient in `preview.transactions[].orderTerms`. These are
decoded contract terms, not proof that a quoted token has a valid issuance.
`materialNative` reuses the same keyless Native/WASM engine as chain-data
preparation; native consumers should inject their platform bridge to avoid a
browser WASM fetch. Without an injected bridge the browser implementation loads
bundled keyless WASM lazily, only when LOP review needs it. Use the paired Native/WASM artifacts. The existing batched TXO-status read budget is unchanged. Generic raw
signing of latest Token/Coin and Token/Token orders remains incomplete; use the
supported standard LOP/Prepared path, and do not treat script recognition alone
as proof of full raw-signing compatibility.

`encrypt` and `decrypt` likewise require a fresh exact-operation approval and
call only the injected wallet-private adapter. The adapter input contains the
normalized message and approval binding, never a private key, scalar, Vault
handle or page-selected callback. `createLegacyWalletPrivateNativeAdapters`
canonicalizes the public request and calls the separate
`tbc_wallet_private_call` ABI exactly once. The public `tbc_engine_call` cannot
route those methods. The platform bridge resolves the scalar only inside the
wallet-private scope and passes it in the ABI's separate 32-byte buffer; Kit,
the page, request JSON and logs do not receive it. The same authority guard is
checked before approval and immediately before crypto execution. Historical
results are `{ encryptedMessage }` and `{ decryptedMessage }`.

`getBalance` returns the TBC balance. It binds the address
to the current verified account and the same immutable network context, then
uses the official idempotent-read API with its existing bounded retry and
single-flight behavior. It performs no confirmation lookup, transaction
decode, approval, signing or POST. The compatibility result is `{ tbc: number }`;
balances that cannot be represented as an exact safe historical number fail
closed instead of losing precision. BTC, EVM, StableCoin and arbitrary-chain
balance aggregation are not added.

Account and network events still originate only from Host/Provider deliveries
for the controller's committed navigation. The controller maps those trusted
events to `TuringAccountChanged` and `TuringNetworkChanged`; a mismatched
session/navigation closes the channel, so stale pages cannot inject or receive
new authority. The current controller routes standalone `signTransaction` and
`signAssociatedTransaction` through the shared adapter to
`tbc_signReviewedTransaction`; standalone encrypt/decrypt map to their Standard
methods. A multi-item `sendBatchRequest` maps to the Standard workflow described
below. It is not limited to the former fixed deposit recipes.

The associated mapper preserves the request shape, not signing authority. The
shared reviewer authenticates external prevouts, recognizes supported asset
flows and binds the complete request, account, material and preview. Core/Host
then use the independent Signer and Engine validation/finalization. Unsupported
templates, missing proofs or incorrect signing roles fail closed; neither a
Legacy flag nor arbitrary unfinished script authorizes spending. Current
Token/Coin holder and administrator profiles have separate material and role
requirements; method presence does not imply every raw script is supported.
The implementation and evidence scope are described in
[issuance and administration](reference/unified-issuance-business.md).

There is no fallback from this controller to the retained old private Native
executor. Retained service exports are historical compatibility code, not an
instruction to wire a second execution path. Preview transaction IDs are not
promised final signed IDs. Sign-only execution does not require the old
associated-operation journal; explicit sending retains its broadcast recovery
boundary. Signing and ECIES are never automatically retried.

For a historical `sendBatchRequest`, create
`createLegacyStandardWorkflowBatchAdapter` for the same immutable verified
navigation/session/network context as the controller. The adapter normalizes
the complete one-to-five item list into one `tbc_signWorkflow`, reads the active
account, reuses the shared Legacy transaction-to-intent mapper, and calls only
the wallet-local `session.handleLegacyWorkflowRequest`. Core reviews and binds
all transaction material, dependencies, message templates, crypto tasks,
account and failure mode before one approval; no `requestApproval` plus
`executeApproved` escape hatch exists. The adapter maps standard ordered step
results back to historical shapes only after completion.

Never expose `handleLegacyWorkflowRequest` or the adapter to page code. A public
workflow cannot select Bitcoin magic; only the wallet-local route authorizes
that profile for the exact internal request identity. Kit contains no private
FT-deposit, P2PKH-deposit or associated-deposit recipe fallback. Any still
reachable application-owned copy requires its own caller migration and device
evidence before deletion. No package upgrade alone proves that an external
wallet has migrated; old-method deletion remains separately authorized.

Mobile still owns the native wrapper, SecureStore/Vault access, account/session
selection, secret clearing and device admission. This package evidence is not
iOS/Android device acceptance or real-chain execution evidence.

Legacy Bitcoin Signed Message compatibility requires an explicit wallet-trusted
digest capability. Bind the wallet's existing implementation at bootstrap; the
callback receives only the normalized message, never a claimed digest, scalar,
key or DApp-selected computation:

```ts
const wallet = createTbcWallet({
  // accounts, approval, signer, storage and network as above
  legacy: {
    bitcoinMessageDigest: async ({ message }) =>
      (await walletPrivateBitcoinMessages.prepare({
        encoding: message.encoding,
        message: message.data,
      })).digest,
  },
});
```

The capability activates only when trusted wallet composition sends the mapped
request through `session.handleLegacyRequest`. Never expose that method or its
session object to page code. The route replaces the external request identity
with an unpredictable, live wallet-local identity, then Core recomputes the
digest from the message and requires equality with an exact lowercase
`legacy-bitcoin:<64-hex>` marker before approval. A page calling the public
Provider or ordinary `session.handleRequest` cannot select Legacy semantics,
even when it supplies the correct marker; that request stays on the Standard
raw-message-byte digest and the Legacy callback is not called.
Approval `operationHash`, the Signer task, recoverable-signature verification
and the result bind the same selected digest. Missing capability, disabled
Legacy, malformed markers, invalid results and mismatches fail before approval
or Signer. The capability does not apply to associated-transaction, FT or Pool
private operation markers.
For this Legacy path, `scheme` is `legacy-bitcoin-message` and the result omits
the Standard `signingPayload`; `envelope` and `canonical` describe only the
approval/display artifact. The trusted capability's verified digest is the sole
value bound to approval and Signer.

```ts
import {
  TBC_KIT_HOST_RELEASE_FINGERPRINT,
  createTbcKitHostEvidenceReader,
  createTbcKitMemoryHostStore,
  createTbcKitSqliteHostStore,
} from "@tbc/kit/sqlite";

const hostStore = createTbcKitSqliteHostStore({
  driver: existingPlatformSqliteDriver,
  // Keep the legacy Host namespace intact. Bind the new namespace to this
  // Kit release and retain it across runtime restarts.
  namespace: `mobile-p0-kit-${TBC_KIT_HOST_RELEASE_FINGERPRINT.slice(0, 8)}`,
  // The /sqlite entry is packaged separately from /wallet, so configure its
  // internal Core with the same trusted wallet primitive.
  sha256: platformSha256,
});
const hostEvidence = createTbcKitHostEvidenceReader(hostStore);

// A verified WebView sign-only session may instead keep its Host journal in
// memory. The same evidence reader works, but process-restart recovery does not.
const liveHostStore = createTbcKitMemoryHostStore({ sha256: platformSha256 });
const liveHostEvidence = createTbcKitHostEvidenceReader(liveHostStore);

const session = await wallet.openSession({
  authority: verifiedAuthoritySource,
  signOnly: { hostStore: liveHostStore },
});
```

The `/sqlite` entry bundles the same Host Store implementation and frozen Core
release as `/wallet`. Pass its opaque result as `storage.hostStore`; do not
instantiate that store from a separately installed `@tbc-wallet/host`. The
platform may reuse its existing SQLite driver and physical database, but it
must use a new namespace for the Kit runtime. Existing legacy namespaces and
journals stay byte-for-byte intact and remain recoverable only by their owning
legacy runtime. Kit never rewrites, relabels, imports, or silently resumes
records from another release fingerprint.

`createTbcKitHostEvidenceReader` is the supported approval/Signer evidence
surface for the Kit journal. It returns a frozen object exposing only
`readOperation`, `readCall`, and `readDelivery`. The reader shares the exact
store namespace and release schema, but cannot write transitions, complete
calls, acquire leases, or drive recovery. Wallet approval code should use this
reader instead of casting the opaque store or importing an internal Host type.
The published declaration closure is self-contained inside `@tbc/kit`; wallet
consumers do not install or import any `@tbc-wallet/*` workspace package.
Use `createTbcKitMemoryHostStore` only when loss of the live page/session also
ends the operation, such as DApp-owned sign-only requests. Wallet-owned submit,
broadcast reconciliation, and any operation promised across process loss must
remain on `createTbcKitSqliteHostStore`; the memory factory is not a recovery
substitute.

Existing wallet code moves both `@tbc-wallet/core` and the
`@tbc-wallet/host` root to `@tbc/kit/wallet`; SQLite driver/store imports move
from `@tbc-wallet/host/sqlite` to `@tbc/kit/sqlite`:

```ts
import {
  TWS_RELEASE,
  TWS_RELEASE_FINGERPRINT,
  createTwsCore,
  createTwsHost,
  type TwsHostPorts,
  type TwsHostStore,
} from "@tbc/kit/wallet";
import {
  createSqliteTwsHostStore,
  type TwsSqliteDriver,
} from "@tbc/kit/sqlite";
```

These exports are not wrappers over separately installed Core or Host
packages. Their declarations match the bundled Core and Host runtime. Consumers must not install a second Core/Host
runtime, alias a release fingerprint, or cast records between releases.

Before replacing an older Host runtime, the wallet must fail closed if the old
namespace contains a nonterminal operation, active lease, delivery route,
approval/Signer obligation, or broadcast obligation. Historical namespaces
and product journals remain read-only and are never relabelled or rewritten.
Rollback is package-only until the first operation under the new runtime; after
that point, each obligation must be recovered or terminalized by the runtime
that created it before reverting.

`@tbc/kit/wallet` and `@tbc/kit/sqlite` are public subpaths over one private
same-release Core/Host runtime per ESM module graph or CommonJS module cache.
This preserves Core's unforgeable in-memory checkpoint ownership when a store
created from `/sqlite` is passed to `/wallet`; it does not expose that mechanism
to DApp code. Canonical hashes are recomputed from validated canonical bytes on
every call and are not retained in a process-wide memoization cache. Configure the wallet entry with
`configureTbcKitSha256Backend`, and pass the same backend to every Kit store
factory used with it. Do both before the first operation. If omitted, Kit uses
the portable JavaScript SHA-256 implementation. Configuration is a trusted
wallet bootstrap capability, not DApp data or a Host Port. Core verifies three
public SHA-256 vectors, exact 32-byte output, and non-mutation of those startup
inputs before installation; every later invocation still checks the output
type/length and propagates failures, while the trusted backend remains
responsible for never mutating call inputs.
The `/wallet` runtime defers the DOM-only Wallet Standard registration module
until `register()` runs in a real browser environment. React Native/Hermes can
import the same entry and use Host sessions without defining `Event`, `window`,
or `document`; the feature test inspects those optional properties through
`globalThis` and contains no bare optional-global reference. Browser
registration remains available when those globals exist.

The unified default network owns API decoding, native/FT selection, FT ancestry,
Pool material preparation and canonical snapshots for its selected immutable
Mainnet or Testnet context. A normal wallet does not
provide selector, ancestry or snapshot-builder callbacks. The bundled keyless
WASM implements `preparePoolNft`, `prepareAssetAncestry`, and
`legacyPoolPreview`, `inspectTokenReceipt`, and `inspectNftReceipt`; it has no
ambient imports and exposes no key/signing API.
Every Pool read uses the context's exact API origin and P2PKH profile. Source
identity partitions retained snapshots; custom endpoint changes require a new
context/runtime rather than silently reusing old material.

`inspectTokenReceipt` is called only by the read-only `verifyTransfer` fungible-asset path.
It is a lightweight keyless parser that identifies canonical FT/StableCoin Code/Tape
outputs and compares them with trusted official API metadata, recipient and
quantity expectations. It is not the SDK's full `TokenValidator`, and it is
not used by transaction construction, approval, signing or broadcast. The
full validator resolves parents and ancestors and verifies conservation and
lineage; adding that network-dependent validator to this receipt hot path
would change both its trust boundary and request graph, so there is no
equivalent lightweight Engine/WASM replacement at present.

When a wallet already owns its production Pool material source, pass that same
source as `defaultNetwork.poolMaterial`. To render LP approval without loading
the selected Pool proof again, create one
`createPoolSnapshotMaterialRetention()` and pass its `remember` callback as
`rememberPoolSnapshotMaterial`; the approval adapter reads from that same
retention object. Retention is short-lived and requires the exact operation
kind, snapshot hash, chain, and input. A mismatch or expiry returns no material,
so approval must fall back to a fresh trusted read or fail closed. It is not a
balance, spendability, permission, or cross-snapshot cache.

Every platform Port adapter receives the original business params plus a
deeply frozen Host call envelope containing `version`, the durable `callId`,
`operation`, and `params`. It is the second argument for Approval, Signer,
storage, clock, entropy and direct custom-network callbacks. The advanced
default-network broadcast callback retains its existing `(params, client)` pair and
receives the envelope as the third argument to `submit` and `reconcile`.
Platform adapters should journal that real `callId`; they must not synthesize
an identity or scan storage to guess which effect is being resumed. Existing
callbacks with fewer arguments remain source-compatible.

`openSession({ authority })` accepts a complete wallet-platform authority
source for verified WebView or extension sessions. Kit validates its initial
profile, chain, active accounts, context and Provider Session, then pins the
authority identity while allowing only the source's normal Provider Session
compare-and-swap to advance it. Navigation, origin, session or other external
authority changes invalidate the old Kit session and its in-flight work.
Injected authority cannot be combined with `origin` or `sessionId`, and an
explicitly unavailable authority fails closed instead of falling back to a
synthetic `remote` context.

For a DApp-built transaction, `prepareTbcTransaction` produces a proposal
from the same chain-data, policy, and Rust Engine inputs that the wallet later
re-resolves and verifies before approval. Use `wallet.signProposal` or
`wallet.sendProposal` on a connected client. Dependent bundles commit parsed
zero-prev-txid inputs through typed `deferredInputs`; ambiguous mappings fail
closed. `prepareTbcWorkflow` and `wallet.signPreparedWorkflow` provide the
sign-only Prepared Workflow path. Proposal observation time may precede the
wallet's fresh snapshot, but all parent and contract material must still match
the wallet's independently rebuilt plan exactly.

Native wallets can import `TBC_TESTNET_PROFILE`, the four-method backend
types, `createNativeTbcEngineBackend`, and `createTbcEngine` from the existing
`@tbc/kit/engine` entry. These are the same bundled Engine facade and frozen
network profile used by this Kit release. The platform must still supply its
installed Native Rust `call(method, canonicalInput)` bridge; Kit does not
replace that bridge, custody, or signing with its browser WASM backend.

The React Native `/wallet` module graph does not contain the Node file loader,
any `node:` builtin, or a non-literal dynamic import. The Node loader is a
separate `/engine` conditional implementation; Metro therefore parses only the
portable fetch/native-adapter graph. Mobile must continue injecting its Native
Engine and must not attempt to load the package WASM through React Native fetch.

On Node 22+, the no-options `createTbcEngine()` path lazily reads the installed
package's `file:` WASM asset on the first operation through the Node-conditioned
entry. It needs neither a custom backend nor a network fetch, in both ESM and
CommonJS. An explicitly supplied `wasm.fetch` or `wasm.url` remains authoritative.

When a browser bundler relocates JavaScript, copy both files under
`artifacts/wasm/` to the served assets and pass their URLs through
`createTbcEngine({ wasm: { url } })` and
`createLazyBundledWasmTbcKeylessEngine({ url })`. Construction remains inert;
the first operation performs the lazy fetch. Package-relative default URLs are
resolved at runtime rather than declared as eager bundler assets, so importing
unrelated root APIs does not copy either WASM file into the application build.

The package root also exports the explicit read-only `verifyTransfer` helper
for a DApp backend to compare a trusted order expectation with one transaction.
It supports native TBC, FT, stablecoin, NFT, and LP rather
than only the native coin:

Current source additionally supports `asset: { kind: "stablecoin", contractId }`
for both historical StableCoin and `tbc20-stablecoin`. This requires the matching
new keyless binary; it is not included in frozen Kit/200. The ID is the
official API `stablecoin_id` (issuer SOURCE), not the mutable SDK object's latest
mint transaction ID. One decode and one metadata read are sufficient, followed
by one local inspection; no ancestry walk or extra lock-maturity query is added.
`matchedOutputs[].lockTime` reports the raw lock value, **not** a guarantee that
the output is mature, unspent, unfrozen or spendable. Receipt amounts sum matching
outputs, including change/self-transfer outputs; they are not net balance gains.

Kit also accepts `asset: { kind: "lp", contractId: poolCreationTxid }`
for current AMM LP and historical Pool2 LP. The ID is the Pool **creation**
transaction, not the underlying FT ID or the latest Pool state transaction.
This needs the matching Keyless `inspectLpReceipt` implementation and is not
included in frozen Kit. Only the target transaction decode and the
Pool creation raw are read; existing shared full-template decoders bind the
LP to the Pool, recipient controller, amount, and lock field. No recipient
public key, current UTXO list, underlying FT metadata or ancestry walk is needed.
Within one verifier the last eight immutable Pool raws are reused and concurrent
reads are shared; failures are evicted. Target transaction confirmation state
is read afresh. `queries.transactionRaw` counts origin read requests started by
that call; a cache hit is zero (transport retries remain transport-level).

LP amounts are canonical integer shares: `amount.atomic` is optional and the
result returns `actualAtomic` with `denomination: "atomic"`. It deliberately
does not return `decimals` or `actualDisplay`: the new LP Tape does not encode
display precision, and an underlying FT's precision is not LP precision.
For display, use a separately established LP convention with the existing exact
formatting helpers. A matched receipt is not a claim that its LP is still
unspent, unlocked, redeemable, or newly gained rather than self-transfer/change.

```ts
import { createTbcClient } from "@tbc/kit";

const tbc = createTbcClient({
  network: "mainnet", // or "testnet"
  api: { fetch }, // optional baseUrl/allowedOrigins for a compatible API
});
const receipt = await tbc.verifyTransfer({
  txid,
  recipient: { address: order.recipient },
  asset: { kind: "ft", contractId: order.contractId },
  amount: { mode: "exact", atomic: order.amountAtomic },
  minimumConfirmations: "1",
});

if (receipt.content.status === "matched" && receipt.policy.status === "satisfied") {
  await markOrderPaidOnce(order.id, txid);
}
```

The call inherits the client's network and HTTP API configuration. Built-in
presets are `https://api.turingbitchain.io` for mainnet and
`https://api.tbcdev.org` for testnet; a compatible HTTPS API can be explicitly
overridden. RPC configuration remains separate and is never guessed. TBC uses
6 decimals; FT decimals come only from the trusted contract metadata.
All public JSON quantities are canonical decimal integer strings in atomic
units. `formatTbcAtomicAmount` and `parseTbcDisplayAmount` convert display text
without floating point or rounding and reject excess precision. Omitting
`amount` means the actual quantity is returned with `expectation:
"not-checked"`; it is never reported as an amount match. NFT binds the unique
contract ID to trusted collection-slot metadata, the locally parsed canonical
hold script, and indexed recipient history. It is always exactly one item, so
the NFT option deliberately has no fungible amount field.

Content, node observation, and confirmation policy are separate results. The
current receipt lookup requires explicit valid `confirmations` in decode:
`"0"` means mempool and positive values mean confirmed. Missing or malformed
confirmation metadata returns `observation.status: "invalid-response"` and
cannot satisfy even a zero-confirmation policy. The receipt path does not infer
zero or query `mempooltxs`; `queries.mempool` is zero. This describes the receipt
path, not every other transaction-status helper. Requests ask conforming fetch
implementations to reject redirects and also validate a provided final
`response.url` against the configured HTTPS origin allowlist, covering React
Native fetch implementations that may handle the redirect option differently.
NFT history is read in pages of 100, stops as soon as the target txid is found,
and has a hard five-page budget. If the target is absent but the covered
history is incomplete, the result is `unavailable` with
`NFT_HISTORY_INCOMPLETE`, never a mismatch.

A historical matching output remains a receipt even after it is spent; this API
is not a balance query. Self-transfers and change require the backend's own
trusted order binding. The result is trusted-node evidence plus local raw-byte
consistency checks, not SPV proof, full-node consensus, finality, or protection
against double bookkeeping. The backend must bind the expected asset,
recipient and quantity to its own order and atomically prevent the same txid
from satisfying multiple orders. See the runnable
[`examples/receipt-verification`](../examples/receipt-verification/README.md).

Optional platform archives provide the keyless Native library, C header and
module map; see [native resource delivery](reference/platform-resource-delivery.md). Its ten operation
names are `preparePoolNft`, `prepareAssetAncestry`, `legacyPoolPreview`,
`inspectTokenReceipt`, `inspectNftReceipt`, `prepareReviewedStage`,
`finalizeReviewedStage`, `inspectAmmMaterial`, `inspectLopMaterial`, and
`inspectTokenMaterial`, matching `TBC_KEYLESS_OPERATIONS`. LP receipt inspection
is a phase of `inspectAmmMaterial`, not another ABI operation. These are shared
keyless computation and validation helpers; custody and signing remain
platform-owned. Use the corresponding tested Native/WASM pair. Independent
RN/Swift/Kotlin calculation evidence does not mean an existing wallet App has
been upgraded or that its transaction latency has been measured.

See [supported functionality](../SUPPORT.md) for operation boundaries.
For platform entry points and installation, see [`docs/reference/distribution-and-platform-integration.md`](reference/distribution-and-platform-integration.md).
