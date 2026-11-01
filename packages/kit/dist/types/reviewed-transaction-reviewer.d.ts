import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import { type CreateTbcOfficialApiOptions } from "./official-api.js";
import { type TbcNetworkContext } from "./network-context.js";
import type { TbcAssociatedTransactionReviewer, TbcRawTransactionReviewer, TbcReviewedTransactionRequest } from "./reviewed-transaction-types.js";
type DefaultReviewOptions = Omit<CreateTbcOfficialApiOptions, "baseUrl" | "network" | "allowedOrigins"> & Readonly<{
    network: TbcNetworkContext;
    /** Share the existing platform keyless bridge; browser defaults to lazy WASM. */
    materialNative?: PoolMaterialNativeProviderInput;
}>;
export declare function createTbcDefaultRawTransactionReviewer(options: DefaultReviewOptions): TbcRawTransactionReviewer;
/** Internal shared materializer. No HTTP or witness execution. */
export declare function materializeAssociatedReviewRequest(request: Readonly<Record<string, unknown>>): TbcReviewedTransactionRequest;
/**
 * Default associated reviewer. It deterministically materializes unsigned
 * child transactions, trusts only outputs of the immediately constructed
 * local chain, and delegates every external prevout plus contract dependency
 * to the same official batched reviewer used by raw signing.
 */
export declare function createTbcDefaultAssociatedTransactionReviewer(options: DefaultReviewOptions): TbcAssociatedTransactionReviewer;
export {};
