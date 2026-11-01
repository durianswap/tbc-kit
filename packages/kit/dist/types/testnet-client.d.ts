import { type KitRequestLedger } from "./request-ledger.js";
import { type TbcOfficialApiClient } from "./official-api.js";
import { inspectTbcTransaction } from "./testnet-validation.js";
export { isTestnetNodeError, TestnetNodeError } from "./testnet-validation.js";
export { OFFICIAL_TBC_TESTNET_API_ORIGIN } from "./network-context.js";
export interface TestnetTip {
    readonly height: string;
    readonly hash: string;
    /** Node-reported median for this same tip; never the device clock. */
    readonly medianTimePast?: string;
}
export interface TestnetUtxo {
    readonly txid: string;
    readonly vout: number;
    readonly satoshis: string;
    readonly height: string;
}
export interface TestnetLookupTransaction {
    readonly txid: string;
    readonly rawTransaction: string;
    /** Fresh confirmation count returned by the decode endpoint. */
    readonly confirmations: string;
    readonly inputs: readonly Readonly<{
        readonly txid: string;
        readonly vout: number;
    }>[];
    readonly outputs: readonly Readonly<{
        readonly vout: number;
        readonly satoshis: string;
        readonly scriptPubKey: string;
        readonly addresses: readonly string[];
    }>[];
}
export interface TestnetRawTransaction extends TestnetLookupTransaction {
    readonly confirmations: string;
}
export interface TestnetFtInfo {
    readonly contractId: string;
    readonly codeScript: string;
    readonly tapeScript: string;
    readonly totalSupply: string;
    readonly decimals: number;
    readonly name: string;
    readonly symbol: string;
}
type FtMetadataProfile = Readonly<{
    standard: "tbc20-standard";
    resolveStandard?: never;
}> | Readonly<{
    standard?: never;
    /** Local template inspection only. Receives normalized hex from this
     * metadata response; must not fetch or treat the response as authority. */
    resolveStandard: (codeScript: string) => "tbc20-standard" | undefined | Promise<"tbc20-standard" | undefined>;
}>;
export interface TestnetFtUtxo {
    readonly txid: string;
    readonly vout: number;
    readonly satoshis: string;
    readonly ftAmount: string;
    /** Fresh index height; zero represents the node's mempool sentinel. */
    readonly height?: string;
}
export interface TestnetStablecoinInfo extends TestnetStablecoinMetadata {
    readonly contractId: string;
    /** Current issuance index, not an instruction to download its history. */
    readonly stateTxid: string;
    readonly stateVout: number;
}
export type TestnetStablecoinUtxo = TestnetFtUtxo;
/** Trusted API metadata for receipts; not a historical validation proof. */
export interface TestnetStablecoinMetadata extends TestnetFtInfo {
}
export interface TestnetNftInfo {
    readonly contractId: string;
    readonly collectionId: string;
    readonly tokenId: string;
    readonly holder: string;
    readonly transferCount: number;
}
export interface TestnetNftHistoryEntry {
    readonly txid: string;
    /** null only for the indexed genesis/mint row, which has no prior holder. */
    readonly sender: string | null;
    readonly recipient: string;
}
export interface TestnetNftHistoryResult {
    readonly entries: readonly TestnetNftHistoryEntry[];
    readonly historyCount: number;
    readonly pages: number;
    /** Partial means the bounded request budget ended before all history was covered. */
    readonly coverage: "complete" | "partial";
}
export interface TestnetTransactionStatus {
    readonly txid: string;
    readonly status: "unknown" | "mempool" | "confirmed" | "rejected";
    readonly confirmations?: string;
}
export interface TestnetBatchBroadcastItem {
    readonly txid: string;
    readonly status: "accepted" | "rejected" | "unknown";
    readonly reason?: string;
}
export interface TestnetClient {
    /** Same-origin named API surface, sharing this client's transport and ledger. */
    readonly api?: TbcOfficialApiClient;
    readonly preflightBroadcast: (rawTransaction: string) => Promise<void>;
    readonly getUtxos: (address: string, consolidation?: Readonly<{
        limit: number;
    }>) => Promise<Readonly<{
        tip: TestnetTip;
        utxos: readonly TestnetUtxo[];
    }>>;
    /** Fresh native index without a chain-tip query. No confirmation claim. */
    readonly getNativeUtxos?: (address: string, consolidation?: Readonly<{
        limit: number;
    }>) => Promise<readonly TestnetUtxo[]>;
    readonly getTip?: () => Promise<TestnetTip>;
    readonly getRawTransaction: (txid: string) => Promise<TestnetRawTransaction>;
    /** One decode query with local txid/output proof; null means the node did not find it. */
    readonly lookupRawTransaction: (txid: string) => Promise<TestnetLookupTransaction | null>;
    /** Immutable historical proof bytes only; supplies no confirmation/UTXO state. */
    readonly getRawTransactionBytes?: (txid: string) => Promise<string>;
    readonly getNativeUtxoParent?: (utxo: TestnetUtxo, tip: TestnetTip, address: string) => Promise<TestnetRawTransaction>;
    /** Metadata only, never proof of an asset's template or Genesis identity.
     * Omit options to preserve historical FT metadata limits. */
    readonly getFtInfo: (contractId: string, options?: FtMetadataProfile) => Promise<TestnetFtInfo>;
    readonly getFtUtxos: (address: string, contractId: string) => Promise<readonly TestnetFtUtxo[]>;
    readonly getStablecoinInfo: (contractId: string) => Promise<TestnetStablecoinInfo>;
    readonly getStablecoinMetadata: (contractId: string) => Promise<TestnetStablecoinMetadata>;
    readonly getStablecoinUtxos: (address: string, contractId: string) => Promise<readonly TestnetStablecoinUtxo[]>;
    readonly getNftInfo: (contractId: string) => Promise<TestnetNftInfo>;
    readonly getNftHistory: (address: string, contractId: string, targetTxid?: string) => Promise<TestnetNftHistoryResult>;
    readonly broadcast: (rawTransaction: string) => Promise<Readonly<{
        txid: string;
    }>>;
    readonly broadcastBatch: (rawTransactions: readonly string[]) => Promise<readonly TestnetBatchBroadcastItem[]>;
    readonly getTransactionStatus: (txid: string) => Promise<TestnetTransactionStatus>;
}
/** Network-neutral aliases for the shared TBC REST transport. */
export type TbcChainClient = TestnetClient;
export type TbcChainFetch = TestnetFetch;
export type CreateTbcChainClientOptions = CreateTestnetClientOptions;
export declare const TESTNET_BROADCAST_PREFLIGHT: unique symbol;
export type TestnetFetch = typeof globalThis.fetch & Readonly<{
    [TESTNET_BROADCAST_PREFLIGHT]?: (rawTransaction: string) => void | Promise<void>;
}>;
export interface CreateTestnetClientOptions {
    readonly baseUrl: string;
    readonly allowedOrigins?: readonly string[];
    readonly fetch: TestnetFetch;
    readonly maxResponseBytes?: number;
    readonly maxUtxos?: number;
    readonly requestTimeoutMs?: number;
    /** Optional same-request immutable-byte inspector; never caches node metadata. */
    readonly inspectTransaction?: typeof inspectTbcTransaction;
    readonly ledger?: KitRequestLedger;
}
export declare function createTestnetClient(options: CreateTestnetClientOptions): TestnetClient;
export declare const createTbcChainClient: typeof createTestnetClient;
