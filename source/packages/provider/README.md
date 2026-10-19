# @tbc-wallet/provider

Platform-neutral, typed Provider SDK for TBC Wallet Standard (TWS) 1.0.

The package exposes an EIP-1193-shaped DApp API while keeping wallet authority,
permissions, accounts, network endpoints, Host Ports, signing, and durable recovery
behind an injected Transport. Runtime version `1.0.0-draft.6.15` implements the frozen
`1.0.0-draft.6` wire protocol.

## Install

```sh
npm install @tbc-wallet/provider @tbc-wallet/core
```

Applications normally obtain a Provider through Wallet Standard discovery. A wallet or
transport package constructs one explicitly:

```ts
import {
  createTbcProvider,
  type TbcProviderMethodMap,
  type TbcProviderTransport,
} from "@tbc-wallet/provider";

declare const transport: TbcProviderTransport;
declare const transfer: TbcProviderMethodMap["tbc_sendTransaction"]["params"];
const provider = createTbcProvider({ transport });

const chainId = await provider.request({ method: "tbc_chainId" });
const submitted = await provider.request({
  method: "tbc_sendTransaction",
  params: transfer,
});
```

Known methods infer their exact generated params and result types. Declared extension
methods retain the generic EIP-1193 shape:

```ts
const extensionResult = await provider.request({
  method: "vendor_example",
  params: { value: "json-only" },
});
```

## Events and lifecycle

```ts
const onChain = (chainId: string) => console.log(chainId);
provider.on("chainChanged", onChain);
provider.removeListener("chainChanged", onChain);

const abort = new AbortController();
const request = provider.request(
  { method: "tbc_requestAccounts" },
  { signal: abort.signal },
);
abort.abort();

await provider.destroy();
```

For each atomic delivery, the request Promise settles before its events are emitted.
Events are then emitted synchronously in the Core-provided array order. Out-of-band
committed events are emitted immediately after validation. Listener iteration is
snapshotted; duplicate listeners follow EventEmitter-compatible add/remove behavior.

Local abort removes only that pending request and forwards the fixed
`REQUEST_ABORTED` reason when the Transport supports cancellation. A late response and
its events are ignored. `destroy()`, a Transport close signal, an ID mismatch, a reused
delivery ID, or malformed delivery permanently closes the Provider and rejects pending
requests.

## Errors

`request()` resolves only a validated RPC `result` and rejects with an immutable
`ProviderRpcError`. It never resolves an `{ error }` object. Registered wire errors retain
their code, message, and JSON data. Unknown adapter failures become a stable `-32603`
error without copying the original exception, endpoint, stack, or payload. A local abort
also uses `-32603` with `data.reason === "REQUEST_ABORTED"`; it does not create a wire
response. Closed or integrity-failed Providers reject with `4900`.

Every request, response, event, and atomic delivery is validated against the frozen TWS
Schema graph and limited to 4 MiB of canonical UTF-8 JSON. The runtime validators are
precompiled and do not use `eval` or `new Function`.

## Transport contract

```ts
interface TbcProviderTransport {
  send(request: TbcJsonRpcRequest): Promise<{
    deliveryId: string;
    response: TbcJsonRpcResponse;
    events: readonly TbcProviderEvent[];
  }>;
  subscribe(listener: (signal: TbcTransportSignal) => void): () => void;
  cancel?(id: TbcJsonRpcId, reason: "REQUEST_ABORTED"): void | Promise<void>;
  close?(): void | Promise<void>;
}
```

The Transport must bind each DApp channel to wallet-created trusted context and a single
authenticated session. DApp params never supply Origin, frame, navigation, account
authority, endpoints, approval state, or signing authority. `deliveryId` identifies one
durable Host completion; it is not a JSON-RPC field or transaction/signature input.

MV3 与 Remote Transport 仍需分别认证。WebView 的平台中立 reference Transport 位于独立
子路径，但生产 Origin 仍必须通过真实 iOS/Android 生命周期和 non-loopback HTTPS
Manifest 门禁。

## WebView reference Transport

`@tbc-wallet/provider/webview` 提供 page/native 两半，不导入 React Native、WebView、DOM、
存储、网络、Host 或 Engine：

```ts
import {
  createTbcWebViewNativeController,
  createTbcWebViewPageTransport,
} from "@tbc-wallet/provider/webview";
```

通道只发送 canonical string，固定 discriminator 为 `tws-webview/1`，整条 envelope 与
嵌入的 Provider 值上限均为 4 MiB。P0 只支持 top frame；Origin、最终 URL、WebView
instance、session、navigation 与时间全部由 native 构建，不接受页面序列化值替换。

Native 侧必须注入 durable `TbcWebViewSessionStore`，delivery 状态固定为
`pending → sent → acknowledged`。相同 bytes 可以只向同一 live session 重放；identity
相同但 bytes 不同会关闭，旧 navigation 的完成永不投递到新页面。完整契约见标准仓库的
`docs/reference/webview-transport-contract.md`。

Native `send` handler 可以返回标准 atomic delivery，或精确的
`{ status: "suppressed", deliveryId }`。前者会严格执行 WebView outbox enqueue → 可选 Host
delivery acknowledgment → post；后者不生成 wire delivery 或 outbox，只调用同一个可选确认
回调来安全退休旧 Authority epoch 的 Host completion。确认回调可能在恢复重放时再次调用，
必须按 delivery identity 幂等。

## In-memory conformance adapter

`@tbc-wallet/provider/in-memory` is deliberately a separate subpath for tests, examples,
and conformance only:

```ts
import { createInMemoryTransport } from "@tbc-wallet/provider/in-memory";

const controller = createInMemoryTransport({
  async handler(request) {
    return {
      deliveryId: "0".repeat(64),
      response: { jsonrpc: "2.0", id: request.id, result: null },
      events: [],
    };
  },
});
```

It has no trusted-channel authentication or durable storage and must not be presented as
a production wallet Transport.

## Portability and boundaries

The root and opt-in WebView subpath are tested in Browser, Worker, Chrome MV3 CSP, React Native/Hermes-oriented
ES2020, Node ESM, and Node CJS environments. It imports no DOM/browser globals, Node
built-ins, timers, network clients, React, Host, Engine, UI, Vault, Keyring, or private
wallet capability. The only runtime dependency is `@tbc-wallet/core` at the matching
Draft runtime version.

The package does not inject `window.Turing`, discover or select wallets, replace EIP-6963,
or expose `execute`, `signAndSend`, raw signing, or trusted context. Wallet discovery is
provided separately by `@tbc-wallet/wallet-standard`.

### Debug artifacts

ESM and CommonJS builds include source maps with file and line mappings, but do
not embed duplicate source text (`sourcesContent: false`). To inspect original
TypeScript while debugging offline, use the source checkout matching the package
build. This changes debug-artifact content only, not the Provider runtime API or
validation policy.
