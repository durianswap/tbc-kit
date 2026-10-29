import { TBC_RPC_METHODS, TBC_NODE_SOURCE, TbcNodeRpcMethodName, TbcNetworkRestrictedRpcMethodName, TbcReadRpcMethodName, TbcRpcMethodDefinition, TbcRpcMethodName, TbcWalletRpcMethodName } from "./rpc-catalog.js";
import { TbcHttpTransport, TbcJsonValue, TbcTransportOptions } from "./network-transport.js";
export type TbcRpcParams = readonly TbcJsonValue[] | Readonly<Record<string, TbcJsonValue>>;
export interface TbcRpcCallOptions {
    readonly signal?: AbortSignal;
    readonly concurrencyGroup?: string;
    readonly retry?: "idempotent-read" | "none";
}
export declare class TbcRpcError extends Error {
    readonly code: string;
    readonly data?: TbcJsonValue;
    constructor(code: string, message: string, data?: TbcJsonValue);
}
export interface TbcRpcTransport {
    readonly source: typeof TBC_NODE_SOURCE;
    readonly transport: TbcHttpTransport;
    readonly call: <T extends TbcJsonValue = TbcJsonValue>(method: TbcRpcMethodName, params?: TbcRpcParams, options?: TbcRpcCallOptions) => Promise<T>;
    readonly callExtension: <T extends TbcJsonValue = TbcJsonValue>(method: string, params?: TbcRpcParams, options?: TbcRpcCallOptions) => Promise<T>;
}
export type CreateTbcRpcTransportOptions = Omit<TbcTransportOptions, "baseUrl"> & Readonly<{
    url: string;
}>;
export declare function createTbcRpcTransport(options: CreateTbcRpcTransportOptions): TbcRpcTransport;
type DefinitionFor<M extends TbcRpcMethodName> = Extract<TbcRpcMethodDefinition, Readonly<{
    method: M;
}>>;
type OptionalTuple<A extends readonly string[]> = Readonly<{
    [K in keyof A]?: TbcJsonValue;
}>;
type NamedArgument<A extends string> = A extends `${infer Left}|${infer Right}` ? Left | NamedArgument<Right> : A;
type NamedParameters<A extends readonly string[]> = Readonly<Partial<Record<NamedArgument<A[number]>, TbcJsonValue>>>;
type ResultFor<M extends TbcRpcMethodName> = M extends "getblockcount" | "getconnectioncount" | "uptime" | "getnetworkhashps" ? string : M extends "getbestblockhash" | "getblockhash" | "sendrawtransaction" | "signmessagewithprivkey" ? string : M extends "getdifficulty" ? number : M extends "verifychain" | "verifymessage" | "setnetworkactive" | "lockunspent" ? boolean : TbcJsonValue;
type NamedCall<D extends TbcRpcMethodDefinition> = D["args"] extends readonly [] ? (options?: TbcRpcCallOptions) => Promise<ResultFor<D["method"]>> : (params?: OptionalTuple<D["args"]> | NamedParameters<D["args"]>, options?: TbcRpcCallOptions) => Promise<ResultFor<D["method"]>>;
type MethodsFor<M extends TbcRpcMethodName> = Readonly<{
    [Name in M]: NamedCall<DefinitionFor<Name>>;
}>;
export type TbcPublicReadRpcMethodName = Exclude<Extract<TbcNodeRpcMethodName, TbcReadRpcMethodName>, TbcNetworkRestrictedRpcMethodName>;
export type TbcReadRpcClient = MethodsFor<TbcPublicReadRpcMethodName> & Readonly<{
    source: typeof TBC_NODE_SOURCE;
}>;
export type TbcNodeAdminRpcClient = MethodsFor<TbcNodeRpcMethodName> & TbcReadRpcClient;
export type TbcWalletRpcClient = MethodsFor<TbcWalletRpcMethodName> & Readonly<{
    source: typeof TBC_NODE_SOURCE;
}>;
export declare function createTbcReadRpcClient(options: CreateTbcRpcTransportOptions): TbcReadRpcClient;
export type TrustedTbcRpcOptions = CreateTbcRpcTransportOptions & Readonly<{
    trustedServer: true;
}>;
export declare function createTbcNodeAdminRpcClient(options: TrustedTbcRpcOptions): TbcNodeAdminRpcClient;
export declare function createTbcWalletRpcClient(options: TrustedTbcRpcOptions): TbcWalletRpcClient;
export type { TbcNetworkRestrictedRpcMethodName, TbcNodeRpcMethodName, TbcReadRpcMethodName, TbcRpcMethodDefinition, TbcRpcMethodName, TbcWalletRpcMethodName };
export { TBC_NODE_SOURCE, TBC_RPC_METHODS };
//# sourceMappingURL=official-rpc.d.ts.map