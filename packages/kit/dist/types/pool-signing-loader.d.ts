import { type inspectTbcTransaction } from "./testnet-validation.js";
import { createTbcOfficialApi } from "./official-api.js";
import type { PoolMaterialNativeProvider } from "./pool-material-native.js";
export interface LegacyPoolSigningNativeEngine {
    readonly execute: (operation: string, requestJson: string) => Promise<string>;
}
export interface LegacyPoolSigningProductionNativeEngine extends LegacyPoolSigningNativeEngine {
    readonly protocolInfo: () => Promise<string>;
}
export type LegacyPoolSigningLoadRequest = Readonly<{
    operation: "increaseLp";
    addressFrom: string;
    contractId: string;
    receiver: string;
    tbcAmount: string;
}>;
/** Wallet-selected native input from this same Chain Data resolve, never a DApp DTO. */
export interface LegacyPoolFunding {
    readonly address: string;
    readonly txid: string;
    readonly vout: number;
    readonly satoshis: string;
    readonly rawTransaction: string;
    readonly tipHeight?: string;
    /** Fresh wallet-owned output heights from the same funding query. */
    readonly indexedHeights?: Readonly<Record<string, string>>;
}
/** Lazy read of the same in-flight wallet funding selection, not a new query. */
export type LegacyPoolFundingSource = LegacyPoolFunding | ((() => Promise<LegacyPoolFunding>) & {
    /** Same verified index, available before the selected fee raw download. */
    readonly readIndex?: () => Promise<Pick<LegacyPoolFunding, "tipHeight" | "indexedHeights"> & Readonly<{
        selectedParentTxid?: string;
    }>>;
    /** Lazy chain height, only for an operation with an actual LP time lock. */
    readonly readTipHeight?: () => Promise<string>;
});
export type LegacyPoolMaterialLoadRequest = LegacyPoolSigningLoadRequest | Readonly<{
    operation: "consumeLp";
    addressFrom: string;
    contractId: string;
    receiver: string;
    lpAmount: string;
}> | Readonly<{
    operation: "swapToToken";
    addressFrom: string;
    contractId: string;
    receiver: string;
    tbcAmount: string;
}> | Readonly<{
    operation: "swapToTbc";
    addressFrom: string;
    contractId: string;
    receiver: string;
    ftAmount: string;
}> | Readonly<{
    operation: "mergePoolFt";
    addressFrom: string;
    contractId: string;
}> | Readonly<{
    operation: "mergeFtlp";
    addressFrom: string;
    contractId: string;
}> | Readonly<{
    operation: "burnFtlp";
    addressFrom: string;
    contractId: string;
}> | Readonly<{
    operation: "indexPoolFt";
    addressFrom: string;
    contractId: string;
}> | Readonly<{
    operation: "indexFtlp";
    addressFrom: string;
    contractId: string;
}>;
/** Canonical Pool material loader; the native operation surface is neutral. */
export declare function createPoolMaterialLoader(options: {
    readonly fetch: typeof globalThis.fetch;
    readonly native: PoolMaterialNativeProvider;
    readonly baseUrl?: string;
    readonly allowedOrigins?: readonly string[];
    /** Public Engine consumes ancestor bytes and constructs its own proof. */
    readonly purpose?: "legacy-signing" | "public-material";
    readonly requestTimeoutMs?: number;
    /** Same-request reader supplied by private composition; identity is still checked here. */
    readonly readRawTransaction?: (txid: string) => Promise<string>;
    /** Historical proof-only input; no live confirmation or ownership claim. */
    readonly readHistoricalTransaction?: (txid: string) => Promise<string>;
    /** Fresh node index metadata only; never supplied by the page or Rust output. */
    readonly observeIndexedHeight?: (txid: string, height: string) => void;
    readonly inspectTransaction?: typeof inspectTbcTransaction;
    readonly funding?: LegacyPoolFundingSource;
    /** Wallet-owned same-preparation read; still normalized and checked below. */
    readonly readPoolInfo?: ReturnType<typeof createTbcOfficialApi>["poolInfo"];
    readonly readFtInfo?: ReturnType<typeof createTbcOfficialApi>["ftInfo"];
}): (request: LegacyPoolMaterialLoadRequest) => Promise<Readonly<Record<string, unknown>>>;
//# sourceMappingURL=pool-signing-loader.d.ts.map