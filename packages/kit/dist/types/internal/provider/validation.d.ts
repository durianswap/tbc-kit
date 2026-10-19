import type { TbcJsonRpcRequest, TbcJsonRpcResponse } from "./protocol-types.js";
import { type TbcProviderEvent, type TbcProviderMethod, type TbcProviderMethodMap, type TbcTransportDelivery } from "./types.js";
export declare const TBC_PROVIDER_MAX_MESSAGE_BYTES: number;
export type TbcProviderValidationKind = "json" | "size" | "request" | "params" | "result" | "response" | "event" | "delivery";
export declare class TbcProviderValidationError extends TypeError {
    readonly code: "TBC_PROVIDER_VALIDATION_FAILED";
    readonly kind: TbcProviderValidationKind;
    constructor(kind: TbcProviderValidationKind);
}
export declare function canonicalTbcMessageBytes(value: unknown): number;
export declare function assertTbcProviderMethodParams<M extends TbcProviderMethod>(method: M, value: unknown): TbcProviderMethodMap[M]["params"];
export declare function assertTbcProviderMethodParams(method: string, value: unknown): readonly unknown[] | Readonly<Record<string, unknown>>;
export declare function assertTbcProviderMethodResult<M extends TbcProviderMethod>(method: M, value: unknown): TbcProviderMethodMap[M]["result"];
export declare function assertTbcProviderMethodResult(method: string, value: unknown): unknown;
export declare function assertTbcProviderRequest(value: unknown): TbcJsonRpcRequest;
export declare function assertTbcProviderResponse(value: unknown, method?: string): TbcJsonRpcResponse;
export declare function assertTbcProviderEvent(value: unknown): TbcProviderEvent;
export declare function assertTbcTransportDelivery(value: unknown, method?: string): TbcTransportDelivery;
