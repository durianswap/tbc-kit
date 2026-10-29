import type { TbcProviderRpcError } from "./types.js";
export declare class ProviderRpcError extends Error implements TbcProviderRpcError {
    readonly code: number;
    readonly data?: unknown;
    constructor(code: number, message: string, data?: unknown);
}
export declare function internalProviderError(message?: string): ProviderRpcError;
export declare function disconnectedProviderError(): ProviderRpcError;
export declare function abortedProviderError(): ProviderRpcError;
//# sourceMappingURL=errors.d.ts.map