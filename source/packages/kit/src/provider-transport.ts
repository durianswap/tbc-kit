import {
  assertTbcProviderEvent as assertBundledProviderEvent,
  assertTbcProviderRequest as assertBundledProviderRequest,
  assertTbcTransportDelivery as assertBundledTransportDelivery,
  createTbcProvider as createBundledProvider,
  type TbcProviderMethodMap as BundledProviderMethodMap,
  type TbcProviderEventMap as BundledProviderEventMap,
  type TbcProviderOptions as BundledProviderOptions,
} from "@tbc-wallet/provider";

/** JSON-RPC identity accepted by the Provider schema bundled into this Kit. */
export type TbcJsonRpcId = string | number;

export type TbcJsonRpcParams =
  | readonly unknown[]
  | Readonly<Record<string, unknown>>;

export interface TbcJsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: TbcJsonRpcId;
  readonly method: string;
  readonly params?: TbcJsonRpcParams;
}

export interface TbcProviderError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type TbcJsonRpcResponse =
  | Readonly<{
      jsonrpc: "2.0";
      id: TbcJsonRpcId;
      result: unknown;
    }>
  | Readonly<{
      jsonrpc: "2.0";
      id: TbcJsonRpcId | null;
      error: TbcProviderError;
    }>;

/**
 * Provider events exposed to wallet-native routing. Payloads stay structural;
 * the bundled validator below still enforces the exact schema at runtime.
 */
export type TbcProviderEvent =
  | Readonly<{
      name: "connect";
      payload: Readonly<{ chainId: string }>;
    }>
  | Readonly<{
      name: "disconnect";
      payload: Readonly<{ code: 4900; message: string; data?: unknown }>;
    }>
  | Readonly<{ name: "chainChanged"; payload: string }>
  | Readonly<{ name: "accountsChanged"; payload: readonly string[] }>
  | Readonly<{ name: "permissionsChanged"; payload: readonly unknown[] }>
  | Readonly<{
      name: "capabilitiesChanged";
      payload: Readonly<Record<string, unknown>>;
    }>;

export interface TbcTransportDelivery {
  readonly deliveryId: string;
  readonly response: TbcJsonRpcResponse;
  readonly events: readonly TbcProviderEvent[];
}

export type TbcTransportCloseReason =
  | "TRANSPORT_CLOSED"
  | "NAVIGATION_CHANGED"
  | "ORIGIN_CHANGED"
  | "SESSION_REVOKED";

export type TbcTransportSignal =
  | Readonly<{ type: "event"; event: TbcProviderEvent }>
  | Readonly<{ type: "close"; reason: TbcTransportCloseReason }>;

export interface TbcProviderTransport {
  readonly send: (request: TbcJsonRpcRequest) => Promise<TbcTransportDelivery>;
  readonly subscribe: (
    listener: (signal: TbcTransportSignal) => void,
  ) => () => void;
  readonly cancel?: (
    requestId: TbcJsonRpcId,
    reason: "REQUEST_ABORTED",
  ) => void | Promise<void>;
  readonly close?: () => void | Promise<void>;
}

export interface TbcAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  readonly addEventListener: (type: "abort", listener: () => void) => void;
  readonly removeEventListener: (type: "abort", listener: () => void) => void;
}

export interface TbcProviderRequestOptions {
  readonly signal?: TbcAbortSignal;
}

type NoParamsRequest<M extends string> = Readonly<{
  method: M;
  params?: readonly [];
}>;

type ParamsRequest<M extends keyof BundledProviderMethodMap> = Readonly<{
  method: M;
  params: BundledProviderMethodMap[M]["params"];
}>;

type KnownResult<M extends keyof BundledProviderMethodMap> =
  BundledProviderMethodMap[M]["result"];

/**
 * Typed public Provider without declaration-identity coupling to a separately
 * installed private Provider package. Concrete overloads keep known-method
 * inference while remaining structurally assignable from Wallet Standard.
 */
export interface TbcProvider {
  request(
    args: NoParamsRequest<"tbc_chainId">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_chainId">>;
  request(
    args: NoParamsRequest<"tbc_accounts">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_accounts">>;
  request(
    args: NoParamsRequest<"tbc_requestAccounts">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_requestAccounts">>;
  request(
    args: ParamsRequest<"tbc_getAccount">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_getAccount">>;
  request(
    args: ParamsRequest<"tbc_getCapabilities">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_getCapabilities">>;
  request(
    args: ParamsRequest<"tbc_switchChain">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_switchChain">>;
  request(
    args: ParamsRequest<"tbc_signMessage">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_signMessage">>;
  request(
    args: ParamsRequest<"tbc_signTypedData">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_signTypedData">>;
  request(
    args: ParamsRequest<"tbc_signTransaction">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_signTransaction">>;
  request(
    args: Readonly<{
      method: "tbc_signTransaction";
      /** Runtime remains exact; this admits same-release Kit business intents. */
      params: TbcJsonRpcParams;
    }>,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_signTransaction">>;
  request(
    args: ParamsRequest<"tbc_signPreparedTransaction">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_signPreparedTransaction">>;
  request(
    args: ParamsRequest<"tbc_sendTransaction">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_sendTransaction">>;
  request(
    args: ParamsRequest<"tbc_sendPreparedTransaction">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_sendPreparedTransaction">>;
  request(
    args: ParamsRequest<"tbc_signWorkflow">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_signWorkflow">>;
  request(
    args: ParamsRequest<"tbc_signPreparedWorkflow">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_signPreparedWorkflow">>;
  request(
    args: NoParamsRequest<"wallet_getPermissions">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"wallet_getPermissions">>;
  request(
    args: ParamsRequest<"wallet_requestPermissions">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"wallet_requestPermissions">>;
  request(
    args: NoParamsRequest<"tbc_disconnect">,
    options?: TbcProviderRequestOptions,
  ): Promise<KnownResult<"tbc_disconnect">>;
  request(
    args: Readonly<{
      method: string;
      params?: TbcJsonRpcParams;
    }>,
    options?: TbcProviderRequestOptions,
  ): Promise<unknown>;

  on(
    event: "connect",
    listener: (payload: BundledProviderEventMap["connect"]) => void,
  ): this;
  on(
    event: "disconnect",
    listener: (payload: BundledProviderEventMap["disconnect"]) => void,
  ): this;
  on(
    event: "chainChanged",
    listener: (payload: BundledProviderEventMap["chainChanged"]) => void,
  ): this;
  on(
    event: "accountsChanged",
    listener: (payload: BundledProviderEventMap["accountsChanged"]) => void,
  ): this;
  on(
    event: "permissionsChanged",
    listener: (payload: BundledProviderEventMap["permissionsChanged"]) => void,
  ): this;
  on(
    event: "capabilitiesChanged",
    listener: (payload: BundledProviderEventMap["capabilitiesChanged"]) => void,
  ): this;
  on(event: string, listener: (...args: never[]) => void): this;

  removeListener(
    event: "connect",
    listener: (payload: BundledProviderEventMap["connect"]) => void,
  ): this;
  removeListener(
    event: "disconnect",
    listener: (payload: BundledProviderEventMap["disconnect"]) => void,
  ): this;
  removeListener(
    event: "chainChanged",
    listener: (payload: BundledProviderEventMap["chainChanged"]) => void,
  ): this;
  removeListener(
    event: "accountsChanged",
    listener: (payload: BundledProviderEventMap["accountsChanged"]) => void,
  ): this;
  removeListener(
    event: "permissionsChanged",
    listener: (payload: BundledProviderEventMap["permissionsChanged"]) => void,
  ): this;
  removeListener(
    event: "capabilitiesChanged",
    listener: (payload: BundledProviderEventMap["capabilitiesChanged"]) => void,
  ): this;
  removeListener(event: string, listener: (...args: never[]) => void): this;
  destroy(): Promise<void>;
}

export interface TbcProviderOptions {
  readonly transport: TbcProviderTransport;
  readonly requestIdFactory?: () => TbcJsonRpcId;
}

/** Create the strict Provider whose schema and transport ship in this Kit. */
export function createTbcProvider(options: TbcProviderOptions): TbcProvider {
  return createBundledProvider(
    options as unknown as BundledProviderOptions,
  ) as unknown as TbcProvider;
}

/** Validate with the exact Provider schema bundled into this Kit release. */
export function assertTbcProviderRequest(value: unknown): TbcJsonRpcRequest {
  return assertBundledProviderRequest(value) as TbcJsonRpcRequest;
}

/** Validate with the exact Provider schema bundled into this Kit release. */
export function assertTbcProviderEvent(value: unknown): TbcProviderEvent {
  return assertBundledProviderEvent(value) as TbcProviderEvent;
}

/** Validate and detach a Provider delivery using this Kit's bundled schema. */
export function assertTbcTransportDelivery(
  value: unknown,
  method?: string,
): TbcTransportDelivery {
  return assertBundledTransportDelivery(value, method) as TbcTransportDelivery;
}
