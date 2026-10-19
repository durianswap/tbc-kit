import type { KitProvider } from "./public-types.js";
export interface LegacyKitOptions {
    /** Wallet-trusted Bitcoin Signed Message digest computation. */
    readonly bitcoinMessageDigest?: (input: Readonly<{
        version: "1.0";
        message: Readonly<{
            encoding: "utf8" | "hex" | "base64";
            data: string;
        }>;
    }>) => string | Promise<string>;
    readonly resolveFtDecimals?: (contractId: string) => Promise<number>;
    readonly resolvePoolFtDecimals?: (poolContractId: string) => Promise<number>;
    readonly reviewRequests?: (input: Readonly<{
        account: string;
        chainId: `tbc:${string}`;
        request: unknown;
    }>) => Promise<boolean>;
    readonly now?: () => Date;
    readonly platform?: "ios" | "android";
    readonly walletVersion?: string;
}
export interface LegacyKitFacade {
    readonly enabled: boolean;
    readonly getAddress: () => Promise<string>;
    readonly connect: () => Promise<unknown>;
    readonly disconnect: () => Promise<unknown>;
    readonly isConnected: () => Promise<boolean>;
    readonly getPubKey: () => Promise<unknown>;
    readonly getNetwork: () => Promise<unknown>;
    readonly getInfo: () => Readonly<{
        name: "Turing";
        platform?: "ios" | "android";
        version?: string;
    }>;
    readonly signMessage: (params: unknown) => Promise<unknown>;
    readonly sendBatchRequest: (params: unknown) => Promise<unknown>;
    readonly on: KitProvider["on"];
    readonly removeListener: KitProvider["removeListener"];
    readonly close: () => void;
    readonly sendTransaction: (params: unknown) => Promise<unknown>;
    readonly mergeUtxos: () => Promise<unknown>;
    readonly mergeFtUtxos: (params: unknown) => Promise<unknown>;
}
export declare function createLegacyKitFacade(input: Readonly<{
    provider: KitProvider;
    chainId: `tbc:${string}`;
    /** Wallet-owned active Provider Session chain; never derived from page input. */
    readChainId?: () => `tbc:${string}`;
    /** Detect A -> B -> A changes while Legacy is preparing an operation. */
    readSessionRevision?: () => string;
    enabled: boolean;
    options?: LegacyKitOptions;
    readAccount?: () => Promise<string>;
    requestLegacyMessage?: (params: Readonly<Record<string, unknown>>) => Promise<unknown>;
}>): LegacyKitFacade;
