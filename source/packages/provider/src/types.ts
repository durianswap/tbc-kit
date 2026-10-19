import type {
  TbcSignReviewedTransactionRequest,
  TbcEncryptRequest,
  TbcDecryptRequest,
  TbcEncryptResult,
  TbcDecryptResult,
  TbcAccountsChangedEvent,
  TbcAccountsResult,
  TbcCapabilitiesChangedEvent,
  TbcChainChangedEvent,
  TbcChainIdResult,
  TbcConnectEvent,
  TbcDisconnectEvent,
  TbcGetAccountParams,
  TbcGetAccountResult,
  TbcGetCapabilitiesParams,
  TbcGetCapabilitiesResult,
  TbcJsonRpcId,
  TbcJsonRpcRequest,
  TbcJsonRpcResponse,
  TbcMessageRequest,
  TbcMessageSignature,
  TbcNonEmptyPermissionArray,
  TbcNullResult,
  TbcPermissionArray,
  TbcPermissionsChangedEvent,
  TbcPreparedTransactionRequest,
  TbcPreparedWorkflowRequest,
  TbcRequestAccountsResult,
  TbcRequestPermissionsParams,
  TbcSignedTransactionBundle,
  TbcSubmittedTransactionBundle,
  TbcSwitchChainParams,
  TbcTransactionRequest,
  TbcTypedDataRequest,
  TbcTypedDataSignature,
  TbcWorkflowRequest,
  TbcWorkflowResult,
  TbcWorkflowSendResult,
} from "./protocol-types.js";

export const TBC_PROVIDER_METHODS = Object.freeze([
  "tbc_chainId",
  "tbc_accounts",
  "tbc_requestAccounts",
  "tbc_getAccount",
  "tbc_getCapabilities",
  "tbc_switchChain",
  "tbc_signMessage",
  "tbc_signTypedData",
  "tbc_signTransaction",
  "tbc_signPreparedTransaction",
  "tbc_sendTransaction",
  "tbc_sendPreparedTransaction",
  "tbc_signReviewedTransaction",
  "tbc_encrypt",
  "tbc_decrypt",
  "tbc_signWorkflow",
  "tbc_signPreparedWorkflow",
  "tbc_sendWorkflow",
  "tbc_sendPreparedWorkflow",
  "wallet_getPermissions",
  "wallet_requestPermissions",
  "tbc_disconnect",
] as const);

export const TBC_PROVIDER_EVENTS = Object.freeze([
  "connect",
  "disconnect",
  "chainChanged",
  "accountsChanged",
  "permissionsChanged",
  "capabilitiesChanged",
] as const);

export type TbcProviderMethod = (typeof TBC_PROVIDER_METHODS)[number];
export type TbcProviderEventName = (typeof TBC_PROVIDER_EVENTS)[number];
export type TbcNoParams = readonly [];

export interface TbcProviderMethodMap {
  readonly tbc_signReviewedTransaction: { readonly params: TbcSignReviewedTransactionRequest; readonly result: TbcSignedTransactionBundle };
  readonly tbc_encrypt: { readonly params: TbcEncryptRequest; readonly result: TbcEncryptResult };
  readonly tbc_decrypt: { readonly params: TbcDecryptRequest; readonly result: TbcDecryptResult };
  readonly tbc_chainId: {
    readonly params: TbcNoParams;
    readonly result: TbcChainIdResult;
  };
  readonly tbc_accounts: {
    readonly params: TbcNoParams;
    readonly result: TbcAccountsResult;
  };
  readonly tbc_requestAccounts: {
    readonly params: TbcNoParams;
    readonly result: TbcRequestAccountsResult;
  };
  readonly tbc_getAccount: {
    readonly params: TbcGetAccountParams;
    readonly result: TbcGetAccountResult;
  };
  readonly tbc_getCapabilities: {
    readonly params: TbcGetCapabilitiesParams;
    readonly result: TbcGetCapabilitiesResult;
  };
  readonly tbc_switchChain: {
    readonly params: TbcSwitchChainParams;
    readonly result: TbcNullResult;
  };
  readonly tbc_signMessage: {
    readonly params: TbcMessageRequest;
    readonly result: TbcMessageSignature;
  };
  readonly tbc_signTypedData: {
    readonly params: TbcTypedDataRequest;
    readonly result: TbcTypedDataSignature;
  };
  readonly tbc_signTransaction: {
    readonly params: TbcTransactionRequest;
    readonly result: TbcSignedTransactionBundle;
  };
  readonly tbc_signPreparedTransaction: {
    readonly params: TbcPreparedTransactionRequest;
    readonly result: TbcSignedTransactionBundle;
  };
  readonly tbc_sendTransaction: {
    readonly params: TbcTransactionRequest;
    readonly result: TbcSubmittedTransactionBundle;
  };
  readonly tbc_sendPreparedTransaction: {
    readonly params: TbcPreparedTransactionRequest;
    readonly result: TbcSubmittedTransactionBundle;
  };
  readonly tbc_signWorkflow: {
    readonly params: TbcWorkflowRequest;
    readonly result: TbcWorkflowResult;
  };
  readonly tbc_signPreparedWorkflow: {
    readonly params: TbcPreparedWorkflowRequest;
    readonly result: TbcWorkflowResult;
  };
  readonly tbc_sendWorkflow: {
    readonly params: TbcWorkflowRequest;
    readonly result: TbcWorkflowSendResult;
  };
  readonly tbc_sendPreparedWorkflow: {
    readonly params: TbcPreparedWorkflowRequest;
    readonly result: TbcWorkflowSendResult;
  };
  readonly wallet_getPermissions: {
    readonly params: TbcNoParams;
    readonly result: TbcPermissionArray;
  };
  readonly wallet_requestPermissions: {
    readonly params: TbcRequestPermissionsParams;
    readonly result: TbcNonEmptyPermissionArray;
  };
  readonly tbc_disconnect: {
    readonly params: TbcNoParams;
    readonly result: TbcNullResult;
  };
}

export interface TbcProviderEventMap {
  readonly connect: TbcConnectEvent;
  readonly disconnect: TbcDisconnectEvent;
  readonly chainChanged: TbcChainChangedEvent;
  readonly accountsChanged: TbcAccountsChangedEvent;
  readonly permissionsChanged: TbcPermissionsChangedEvent;
  readonly capabilitiesChanged: TbcCapabilitiesChangedEvent;
}

type KnownRequestArguments<M extends TbcProviderMethod> =
  TbcProviderMethodMap[M]["params"] extends TbcNoParams
    ? Readonly<{ method: M; params?: TbcNoParams }>
    : Readonly<{ method: M; params: TbcProviderMethodMap[M]["params"] }>;

export type TbcProviderRequestArguments<M extends string = string> =
  M extends TbcProviderMethod
    ? KnownRequestArguments<M>
    : Readonly<{
        method: M;
        params?: readonly unknown[] | Readonly<Record<string, unknown>>;
      }>;

export type TbcProviderRequestResult<M extends string> =
  M extends TbcProviderMethod ? TbcProviderMethodMap[M]["result"] : unknown;

export type TbcProviderEvent = {
  readonly [E in TbcProviderEventName]: Readonly<{
    name: E;
    payload: TbcProviderEventMap[E];
  }>;
}[TbcProviderEventName];

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

export interface TbcProviderRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
}

export interface TbcProvider {
  request<const M extends string>(
    args: Readonly<{ method: M }> &
      Omit<TbcProviderRequestArguments<NoInfer<M>>, "method">,
    options?: TbcProviderRequestOptions,
  ): Promise<TbcProviderRequestResult<M>>;

  on<const E extends string>(
    event: E,
    listener: E extends TbcProviderEventName
      ? (payload: TbcProviderEventMap[NoInfer<E>]) => void
      : (...args: unknown[]) => void,
  ): this;

  removeListener<const E extends string>(
    event: E,
    listener: E extends TbcProviderEventName
      ? (payload: TbcProviderEventMap[NoInfer<E>]) => void
      : (...args: unknown[]) => void,
  ): this;

  destroy(): Promise<void>;
}

export interface TbcProviderOptions {
  readonly transport: TbcProviderTransport;
  readonly requestIdFactory?: () => TbcJsonRpcId;
}
