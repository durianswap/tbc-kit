import type { TbcJsonRpcId, TbcJsonRpcRequest } from "./protocol-types.js";
import type { TbcProviderEvent, TbcProviderTransport, TbcTransportCloseReason, TbcTransportDelivery } from "./types.js";
export type TbcInMemoryTransportHandler = (request: TbcJsonRpcRequest) => TbcTransportDelivery | Promise<TbcTransportDelivery>;
export interface TbcInMemoryTransportOptions {
    readonly handler: TbcInMemoryTransportHandler;
    readonly onCancel?: (requestId: TbcJsonRpcId, reason: "REQUEST_ABORTED") => void | Promise<void>;
}
export interface TbcInMemoryTransportController {
    readonly transport: TbcProviderTransport;
    readonly emitEvent: (event: TbcProviderEvent) => void;
    readonly close: (reason?: TbcTransportCloseReason) => void;
}
export declare function createInMemoryTransport(options: TbcInMemoryTransportOptions): TbcInMemoryTransportController;
