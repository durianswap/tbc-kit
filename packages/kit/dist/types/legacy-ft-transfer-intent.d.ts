import { type TbcFtContractMetadata, type TbcLegacyMetadataResolver } from "./legacy-metadata.js";
export interface LegacyFtContractMetadata {
    readonly contractId: string;
    readonly decimals: number;
    readonly name: string;
    readonly symbol: string;
}
export interface LegacyFtTransferIntentResolver {
    readonly resolve: (request: unknown, addressFrom: string, onMetadata?: (decimals: number) => void) => Promise<Readonly<Record<string, unknown>>>;
}
export declare function legacyDisplayAmount(value: unknown, allowZero: boolean): string;
export declare function legacyAtomicAmount(value: string, decimals: number): string;
export declare function resolveLegacyFtTransferIntent(input: Readonly<{
    chainId: string;
    request: unknown;
    addressFrom: string;
    decimals: number;
    currentStandard?: boolean;
}>): Readonly<Record<string, unknown>>;
export declare function createLegacyFtTransferIntentResolver(options: {
    readonly chainId: string;
    /** Advanced loader override. Prefer `metadata` for the bounded default path. */
    readonly getFtInfo?: (contractId: string) => Promise<LegacyFtContractMetadata>;
    readonly metadata?: Pick<TbcLegacyMetadataResolver, "network" | "getFtInfo">;
    /** Exact local Code-template inspection over the same authenticated metadata read. */
    readonly resolveCurrentStandard?: (metadata: TbcFtContractMetadata) => Promise<boolean>;
    readonly cacheTtlMs?: number;
    readonly maxCacheEntries?: number;
    readonly now?: () => number;
}): LegacyFtTransferIntentResolver;
//# sourceMappingURL=legacy-ft-transfer-intent.d.ts.map