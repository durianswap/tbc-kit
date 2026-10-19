import {
  TBC_RPC_METHODS,
  TBC_NODE_SOURCE,
  TbcNodeRpcMethodName,
  TbcNetworkRestrictedRpcMethodName,
  TbcReadRpcMethodName,
  TbcRpcMethodDefinition,
  TbcRpcMethodName,
  TbcWalletRpcMethodName,
} from "./rpc-catalog.js";
import {
  TbcHttpTransport,
  TbcJsonObject,
  TbcJsonValue,
  TbcTransportOptions,
  createTbcHttpTransport,
} from "./network-transport.js";

export type TbcRpcParams = readonly TbcJsonValue[] | Readonly<Record<string, TbcJsonValue>>;
export interface TbcRpcCallOptions {
  readonly signal?: AbortSignal;
  readonly concurrencyGroup?: string;
  readonly retry?: "idempotent-read" | "none";
}

export class TbcRpcError extends Error {
  readonly code: string;
  readonly data?: TbcJsonValue;
  constructor(code: string, message: string, data?: TbcJsonValue) {
    super(message);
    this.name = "TbcRpcError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export interface TbcRpcTransport {
  readonly source: typeof TBC_NODE_SOURCE;
  readonly transport: TbcHttpTransport;
  readonly call: <T extends TbcJsonValue = TbcJsonValue>(
    method: TbcRpcMethodName,
    params?: TbcRpcParams,
    options?: TbcRpcCallOptions,
  ) => Promise<T>;
  readonly callExtension: <T extends TbcJsonValue = TbcJsonValue>(
    method: string,
    params?: TbcRpcParams,
    options?: TbcRpcCallOptions,
  ) => Promise<T>;
}

export type CreateTbcRpcTransportOptions = Omit<TbcTransportOptions, "baseUrl"> & Readonly<{ url: string }>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TbcRpcError("INVALID_RESPONSE", `Invalid ${label}`);
  return value as Record<string, unknown>;
}

export function createTbcRpcTransport(options: CreateTbcRpcTransportOptions): TbcRpcTransport {
  const transport = createTbcHttpTransport({ ...options, baseUrl: options.url, exactBaseUrl: true });
  const definitions = new Map(TBC_RPC_METHODS.map((entry) => [entry.method, entry] as const));
  let nextId = 0;
  async function request<T extends TbcJsonValue>(method: string, params: TbcRpcParams = [], callOptions: TbcRpcCallOptions = {}): Promise<T> {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(method)) throw new TypeError("Invalid TBC RPC method");
    const id = String(++nextId);
    const payload = await transport.requestJson<unknown>("POST", "", { jsonrpc: "1.0", id, method, params }, {
      category: "rpc",
      ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
      ...(callOptions.concurrencyGroup === undefined ? {} : { concurrencyGroup: callOptions.concurrencyGroup }),
      ...(callOptions.retry === undefined ? {} : { retry: callOptions.retry }),
      losslessIntegers: true,
    });
    const envelope = record(payload, "TBC RPC envelope");
    if (String(envelope.id) !== id) throw new TbcRpcError("INVALID_RESPONSE", "TBC RPC response ID mismatch");
    if (envelope.error !== undefined && envelope.error !== null) {
      const error = record(envelope.error, "TBC RPC error");
      throw new TbcRpcError(String(error.code), typeof error.message === "string" ? error.message : "TBC RPC returned an error", error.data as TbcJsonValue | undefined);
    }
    if (!("result" in envelope)) throw new TbcRpcError("INVALID_RESPONSE", "TBC RPC omitted its result");
    return envelope.result as T;
  }
  const call: TbcRpcTransport["call"] = (method, params = [], callOptions = {}) => {
    const definition = definitions.get(method);
    const safeOptions = definition?.effect === "read"
      ? callOptions
      : {
          ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
          ...(callOptions.concurrencyGroup === undefined ? {} : { concurrencyGroup: callOptions.concurrencyGroup }),
          retry: "none" as const,
        };
    return request(method, params, safeOptions);
  };
  return Object.freeze({
    source: TBC_NODE_SOURCE,
    transport,
    call,
    callExtension: request,
  });
}

type DefinitionFor<M extends TbcRpcMethodName> = Extract<TbcRpcMethodDefinition, Readonly<{ method: M }>>;
type OptionalTuple<A extends readonly string[]> = Readonly<{ [K in keyof A]?: TbcJsonValue }>;
type NamedArgument<A extends string> = A extends `${infer Left}|${infer Right}`
  ? Left | NamedArgument<Right>
  : A;
type NamedParameters<A extends readonly string[]> = Readonly<
  Partial<Record<NamedArgument<A[number]>, TbcJsonValue>>
>;
type ResultFor<M extends TbcRpcMethodName> =
  M extends "getblockcount" | "getconnectioncount" | "uptime" | "getnetworkhashps" ? string :
  M extends "getbestblockhash" | "getblockhash" | "sendrawtransaction" | "signmessagewithprivkey" ? string :
  M extends "getdifficulty" ? number :
  M extends "verifychain" | "verifymessage" | "setnetworkactive" | "lockunspent" ? boolean :
  TbcJsonValue;
type NamedCall<D extends TbcRpcMethodDefinition> = D["args"] extends readonly []
  ? (options?: TbcRpcCallOptions) => Promise<ResultFor<D["method"]>>
  : (params?: OptionalTuple<D["args"]> | NamedParameters<D["args"]>, options?: TbcRpcCallOptions) => Promise<ResultFor<D["method"]>>;
type MethodsFor<M extends TbcRpcMethodName> = Readonly<{
  [Name in M]: NamedCall<DefinitionFor<Name>>
}>;

export type TbcPublicReadRpcMethodName = Exclude<
  Extract<TbcNodeRpcMethodName, TbcReadRpcMethodName>,
  TbcNetworkRestrictedRpcMethodName
>;
export type TbcReadRpcClient = MethodsFor<TbcPublicReadRpcMethodName> & Readonly<{
  source: typeof TBC_NODE_SOURCE;
}>;
export type TbcNodeAdminRpcClient = MethodsFor<TbcNodeRpcMethodName> & TbcReadRpcClient;
export type TbcWalletRpcClient = MethodsFor<TbcWalletRpcMethodName> & Readonly<{
  source: typeof TBC_NODE_SOURCE;
}>;

function namedClient<M extends TbcRpcMethodName>(transport: TbcRpcTransport, definitions: readonly TbcRpcMethodDefinition[]): MethodsFor<M> & Readonly<{
  source: typeof TBC_NODE_SOURCE;
}> {
  const methods: Record<string, unknown> = {
    source: transport.source,
  };
  for (const definition of definitions) {
    methods[definition.method] = definition.args.length === 0
      ? (options?: TbcRpcCallOptions) => transport.call(definition.method, [], definition.effect === "read" ? { retry: "idempotent-read", ...options } : options)
      : (params: TbcRpcParams = [], options?: TbcRpcCallOptions) => transport.call(definition.method, params, definition.effect === "read" ? { retry: "idempotent-read", ...options } : options);
  }
  return Object.freeze(methods) as unknown as MethodsFor<M> & Readonly<{
    source: typeof TBC_NODE_SOURCE;
  }>;
}

export function createTbcReadRpcClient(options: CreateTbcRpcTransportOptions): TbcReadRpcClient {
  const transport = createTbcRpcTransport(options);
  return namedClient(
    transport,
    TBC_RPC_METHODS.filter(
      (entry) => entry.profile === "node" && entry.effect === "read" && !("networks" in entry),
    ),
  ) as TbcReadRpcClient;
}

export type TrustedTbcRpcOptions = CreateTbcRpcTransportOptions & Readonly<{ trustedServer: true }>;
function assertTrusted(options: TrustedTbcRpcOptions): void {
  const runtime = globalThis as typeof globalThis & Readonly<{
    document?: unknown;
    navigator?: unknown;
    process?: unknown;
    window?: unknown;
  }>;
  const browserLike =
    runtime.window !== undefined ||
    runtime.document !== undefined ||
    (runtime.navigator !== undefined && runtime.process === undefined);
  if (options.trustedServer !== true || browserLike)
    throw new TypeError("TBC node administration and wallet RPC require a trusted non-browser runtime");
}

export function createTbcNodeAdminRpcClient(options: TrustedTbcRpcOptions): TbcNodeAdminRpcClient {
  assertTrusted(options);
  const transport = createTbcRpcTransport(options);
  return namedClient(transport, TBC_RPC_METHODS.filter((entry) => entry.profile === "node")) as TbcNodeAdminRpcClient;
}

export function createTbcWalletRpcClient(options: TrustedTbcRpcOptions): TbcWalletRpcClient {
  assertTrusted(options);
  const transport = createTbcRpcTransport(options);
  return namedClient(transport, TBC_RPC_METHODS.filter((entry) => entry.profile === "wallet")) as TbcWalletRpcClient;
}

export type { TbcNetworkRestrictedRpcMethodName, TbcNodeRpcMethodName, TbcReadRpcMethodName, TbcRpcMethodDefinition, TbcRpcMethodName, TbcWalletRpcMethodName };
export { TBC_NODE_SOURCE, TBC_RPC_METHODS };
