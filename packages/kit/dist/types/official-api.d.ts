import { TbcHttpTransport, TbcJsonObject, TbcJsonValue, TbcRequestOptions, TbcTransportOptions } from "./network-transport.js";
export declare const TBC_API_MAINNET_ORIGIN = "https://api.turingbitchain.io";
export declare const TBC_API_TESTNET_ORIGIN = "https://api.tbcdev.org";
export type TbcDecimalInteger = string;
export type TbcAtomicAmount = string;
export type TbcApiRecord = TbcJsonObject;
export type TbcApiList = readonly TbcJsonValue[];
export interface TbcApiHealth {
    readonly status: string;
    readonly tip_height: TbcDecimalInteger;
    readonly synced: boolean;
    readonly mempool_size: TbcDecimalInteger;
}
export interface TbcApiNodeInfo {
    readonly chain: string;
    readonly blocks: TbcDecimalInteger;
    readonly headers: TbcDecimalInteger;
    readonly bestblockhash: string;
    readonly mediantime?: TbcDecimalInteger;
}
export interface TbcApiRawTransaction {
    readonly txraw: string;
}
export interface TbcApiBroadcastResult {
    readonly txid: string;
}
export interface TbcApiBroadcastBatchResult {
    readonly success: TbcDecimalInteger;
    readonly failed: TbcDecimalInteger;
    readonly results?: readonly (Readonly<{
        readonly txid?: string;
        readonly error?: string;
    }> | string)[];
}
export interface TbcApiUtxo {
    readonly txid: string;
    readonly index: TbcDecimalInteger;
    readonly value: TbcAtomicAmount;
    readonly height?: TbcDecimalInteger;
}
export interface TbcApiUtxoList {
    readonly utxos: readonly TbcApiUtxo[];
    readonly next_cursor?: string;
}
export interface TbcApiTbc20Utxo {
    readonly txid: string;
    readonly index: TbcDecimalInteger;
    readonly ft_value?: TbcAtomicAmount;
    readonly balance?: TbcAtomicAmount;
    readonly tbc_value?: TbcAtomicAmount;
    readonly value?: TbcAtomicAmount;
    /** Documented LP endpoint names; canonical aliases above remain available. */
    readonly lp_balance?: TbcAtomicAmount;
    readonly tbc_balance?: TbcAtomicAmount;
    readonly height?: TbcDecimalInteger;
    readonly lock_time?: TbcDecimalInteger;
}
export interface TbcApiTbc20UtxoList {
    readonly utxos: readonly TbcApiTbc20Utxo[];
    readonly next_cursor?: string;
}
export interface TbcApiPoolInfo {
    readonly ft_a_partial_hash: string;
    readonly ft_contract_id: string;
    readonly ft_lp_partial_hash: string;
    readonly lp_balance: TbcAtomicAmount;
    readonly pool_code_script: string;
    readonly service_fee_rate: TbcDecimalInteger;
    readonly service_provider: string;
    readonly tbc_balance: TbcAtomicAmount;
    readonly token_balance: TbcAtomicAmount;
    readonly txid: string;
    readonly value: TbcAtomicAmount;
    readonly version: TbcDecimalInteger;
    readonly vout: TbcDecimalInteger;
}
export interface TbcApiTxoStatusInput {
    readonly txid: string;
    readonly index: number;
}
export interface TbcApiTxoStatus {
    readonly txid: string;
    readonly index: TbcDecimalInteger;
    readonly spent: boolean;
    readonly value: TbcAtomicAmount;
    readonly height?: TbcDecimalInteger;
    readonly scriptPubKey?: string;
}
export interface TbcApiTxoStatusResult {
    readonly txos: readonly TbcApiTxoStatus[];
}
export declare class TbcApiError extends Error {
    readonly code: string;
    readonly data?: TbcJsonValue;
    constructor(code: string, message: string, data?: TbcJsonValue);
}
export declare const TBC_OFFICIAL_API_ENDPOINTS: readonly [{
    readonly method: "health";
    readonly http: "GET";
    readonly path: "api/tbc/health";
    readonly section: "health";
    readonly effect: "read";
}, {
    readonly method: "chainState";
    readonly http: "GET";
    readonly path: "api/tbc/chainstate";
    readonly section: "chain";
    readonly effect: "read";
}, {
    readonly method: "nodeInfo";
    readonly http: "GET";
    readonly path: "api/tbc/nodeinfo";
    readonly section: "chain";
    readonly effect: "read";
}, {
    readonly method: "blockByHash";
    readonly http: "GET";
    readonly path: "api/tbc/blockByHash/hash/{hash}";
    readonly section: "block";
    readonly effect: "read";
}, {
    readonly method: "blockByHeight";
    readonly http: "GET";
    readonly path: "api/tbc/blockByHeight/height/{height}";
    readonly section: "block";
    readonly effect: "read";
}, {
    readonly method: "recentBlocks";
    readonly http: "GET";
    readonly path: "api/tbc/recentblocks/start/{start}/end/{end}";
    readonly section: "block";
    readonly effect: "read";
}, {
    readonly method: "transactionsByBlockHash";
    readonly http: "GET";
    readonly path: "api/tbc/txbyblockhash/blockhash/{blockhash}/start/{start}/end/{end}";
    readonly section: "block";
    readonly effect: "read";
}, {
    readonly method: "transactionsByBlockHeight";
    readonly http: "GET";
    readonly path: "api/tbc/txbyblockheight/height/{height}/start/{start}/end/{end}";
    readonly section: "block";
    readonly effect: "read";
}, {
    readonly method: "decodeTransaction";
    readonly http: "GET";
    readonly path: "api/tbc/decode/txid/{txid}";
    readonly section: "transaction";
    readonly effect: "read";
}, {
    readonly method: "rawTransaction";
    readonly http: "GET";
    readonly path: "api/tbc/txraw/txid/{txid}";
    readonly section: "transaction";
    readonly effect: "read";
}, {
    readonly method: "broadcastTransaction";
    readonly http: "POST";
    readonly path: "api/tbc/broadcasttx";
    readonly section: "transaction";
    readonly effect: "write";
}, {
    readonly method: "broadcastTransactions";
    readonly http: "POST";
    readonly path: "api/tbc/broadcasttxs";
    readonly section: "transaction";
    readonly effect: "write";
}, {
    readonly method: "txoStatus";
    readonly http: "POST";
    readonly path: "api/tbc/txo/status";
    readonly section: "transaction";
    readonly effect: "read";
}, {
    readonly method: "mempoolInfo";
    readonly http: "GET";
    readonly path: "api/tbc/mempoolinfo";
    readonly section: "mempool";
    readonly effect: "read";
}, {
    readonly method: "mempoolTransactions";
    readonly http: "GET";
    readonly path: "api/tbc/mempooltxs";
    readonly section: "mempool";
    readonly effect: "read";
}, {
    readonly method: "utxosByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/utxo/address/{address}";
    readonly section: "utxo";
    readonly query: readonly ["limit", "after", "target"];
    readonly effect: "read";
}, {
    readonly method: "utxosByScriptHash";
    readonly http: "GET";
    readonly path: "api/tbc/utxo/scriptpubkeyhash/{scriptpubkeyhash}";
    readonly section: "utxo";
    readonly query: readonly ["limit", "after", "target"];
    readonly effect: "read";
}, {
    readonly method: "balanceByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/balance/address/{address}";
    readonly section: "address";
    readonly effect: "read";
}, {
    readonly method: "timelockBalanceByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/frozenBalance/address/{address}/piggyBank";
    readonly section: "timelock";
    readonly effect: "read";
}, {
    readonly method: "timelockUtxosByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/frozenUtxo/address/{address}/piggyBank";
    readonly section: "timelock";
    readonly effect: "read";
}, {
    readonly method: "historyByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/history/address/{address}/start/{start}/end/{end}";
    readonly section: "address";
    readonly effect: "read";
}, {
    readonly method: "historyByScriptHash";
    readonly http: "GET";
    readonly path: "api/tbc/history/scriptpubkeyhash/{scriptpubkeyhash}/start/{start}/end/{end}";
    readonly section: "script";
    readonly effect: "read";
}, {
    readonly method: "multisigAddress";
    readonly http: "GET";
    readonly path: "api/tbc/multisig/multisigaddress/address/{address}";
    readonly section: "multisig";
    readonly effect: "read";
}, {
    readonly method: "ftTokenListByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/ft/tokenlist/address/{address}";
    readonly section: "tbc20";
    readonly effect: "read";
}, {
    readonly method: "ftBalanceByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/ft/tokenbalance/address/{address}/contract/{contract_id}";
    readonly section: "tbc20";
    readonly effect: "read";
}, {
    readonly method: "ftHistoryByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/ft/history/address/{address}/contract/{contract_id}/start/{start}/end/{end}";
    readonly section: "tbc20";
    readonly effect: "read";
}, {
    readonly method: "ftAllHistoryByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/ft/allhistory/address/{address}/start/{start}/end/{end}";
    readonly section: "tbc20";
    readonly effect: "read";
}, {
    readonly method: "ftUtxosByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/ft/utxo/address/{address}/contract/{contract_id}";
    readonly section: "tbc20";
    readonly query: readonly ["limit", "after", "target"];
    readonly effect: "read";
}, {
    readonly method: "ftTokenListByCombineScript";
    readonly http: "GET";
    readonly path: "api/tbc/ft/tokenlist/combinescript/{combine_script}";
    readonly section: "tbc20";
    readonly effect: "read";
}, {
    readonly method: "ftBalanceByCombineScript";
    readonly http: "GET";
    readonly path: "api/tbc/ft/tokenbalance/combinescript/{combine_script}/contract/{contract_id}";
    readonly section: "tbc20";
    readonly effect: "read";
}, {
    readonly method: "ftHistoryByCombineScript";
    readonly http: "GET";
    readonly path: "api/tbc/ft/history/combinescript/{combine_script}/contract/{contract_id}/start/{start}/end/{end}";
    readonly section: "tbc20";
    readonly effect: "read";
}, {
    readonly method: "ftAllHistoryByCombineScript";
    readonly http: "GET";
    readonly path: "api/tbc/ft/allhistory/combinescript/{combine_script}/start/{start}/end/{end}";
    readonly section: "tbc20";
    readonly effect: "read";
}, {
    readonly method: "ftUtxosByCombineScript";
    readonly http: "GET";
    readonly path: "api/tbc/ft/utxo/combinescript/{combine_script}/contract/{contract_id}";
    readonly section: "tbc20";
    readonly query: readonly ["limit", "after", "target"];
    readonly effect: "read";
}, {
    readonly method: "ftInfo";
    readonly http: "GET";
    readonly path: "api/tbc/ft/info/contract/{contract_id}";
    readonly section: "tbc20";
    readonly effect: "read";
}, {
    readonly method: "ftDecode";
    readonly http: "GET";
    readonly path: "api/tbc/ft/decode/txid/{txid}";
    readonly section: "tbc20";
    readonly effect: "read";
}, {
    readonly method: "ftRank";
    readonly http: "GET";
    readonly path: "api/tbc/ft/rank/contract/{contract_id}/start/{start}/end/{end}";
    readonly section: "tbc20";
    readonly effect: "read";
}, {
    readonly method: "poolList";
    readonly http: "GET";
    readonly path: "api/tbc/pool/poollist/start/{start}/end/{end}";
    readonly section: "tbc20";
    readonly effect: "read";
}, {
    readonly method: "poolInfo";
    readonly http: "GET";
    readonly path: "api/tbc/pool/poolinfo/poolid/{pool_id}";
    readonly section: "tbc20";
    readonly effect: "read";
}, {
    readonly method: "poolLpUtxosByScriptHash";
    readonly http: "GET";
    readonly path: "api/tbc/pool/lputxo/scriptpubkeyhash/{scriptpubkeyhash}";
    readonly section: "tbc20";
    readonly query: readonly ["limit", "after", "target"];
    readonly effect: "read";
}, {
    readonly method: "stablecoinInfo";
    readonly http: "GET";
    readonly path: "api/tbc/stablecoin/info/stablecoinid/{stablecoin_id}";
    readonly section: "stablecoin";
    readonly effect: "read";
}, {
    readonly method: "stablecoinBalanceByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/stablecoin/tokenbalance/address/{address}/stablecoinid/{stablecoin_id}";
    readonly section: "stablecoin";
    readonly effect: "read";
}, {
    readonly method: "stablecoinBalanceByCombineScript";
    readonly http: "GET";
    readonly path: "api/tbc/stablecoin/tokenbalance/combinescript/{combine_script}/stablecoinid/{stablecoin_id}";
    readonly section: "stablecoin";
    readonly effect: "read";
}, {
    readonly method: "stablecoinUtxosByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/stablecoin/utxo/address/{address}/stablecoinid/{stablecoin_id}";
    readonly section: "stablecoin";
    readonly effect: "read";
}, {
    readonly method: "stablecoinUtxosByCombineScript";
    readonly http: "GET";
    readonly path: "api/tbc/stablecoin/utxo/combinescript/{combine_script}/stablecoinid/{stablecoin_id}";
    readonly section: "stablecoin";
    readonly effect: "read";
}, {
    readonly method: "stablecoinHistoryByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/stablecoin/history/address/{address}/stablecoinid/{stablecoin_id}/start/{start}/end/{end}";
    readonly section: "stablecoin";
    readonly effect: "read";
}, {
    readonly method: "stablecoinHistoryByCombineScript";
    readonly http: "GET";
    readonly path: "api/tbc/stablecoin/history/combinescript/{combine_script}/stablecoinid/{stablecoin_id}/start/{start}/end/{end}";
    readonly section: "stablecoin";
    readonly effect: "read";
}, {
    readonly method: "stablecoinAllHistoryByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/stablecoin/allhistory/address/{address}/start/{start}/end/{end}";
    readonly section: "stablecoin";
    readonly effect: "read";
}, {
    readonly method: "stablecoinAllHistoryByCombineScript";
    readonly http: "GET";
    readonly path: "api/tbc/stablecoin/allhistory/combinescript/{combine_script}/start/{start}/end/{end}";
    readonly section: "stablecoin";
    readonly effect: "read";
}, {
    readonly method: "stablecoinListByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/stablecoin/stablecoinlist/address/{address}";
    readonly section: "stablecoin";
    readonly effect: "read";
}, {
    readonly method: "stablecoinListByCombineScript";
    readonly http: "GET";
    readonly path: "api/tbc/stablecoin/stablecoinlist/combinescript/{combine_script}";
    readonly section: "stablecoin";
    readonly effect: "read";
}, {
    readonly method: "stablecoinDecode";
    readonly http: "GET";
    readonly path: "api/tbc/stablecoin/decode/txid/{txid}";
    readonly section: "stablecoin";
    readonly effect: "read";
}, {
    readonly method: "stablecoinRank";
    readonly http: "GET";
    readonly path: "api/tbc/stablecoin/rank/stablecoinid/{stablecoin_id}/start/{start}/end/{end}";
    readonly section: "stablecoin";
    readonly effect: "read";
}, {
    readonly method: "nftCollectionInfo";
    readonly http: "GET";
    readonly path: "api/tbc/nft/collectioninfo/collectionid/{collection_id}";
    readonly section: "tbc721";
    readonly effect: "read";
}, {
    readonly method: "nftInfo";
    readonly http: "GET";
    readonly path: "api/tbc/nft/nftinfo/nftid/{nftid}";
    readonly section: "tbc721";
    readonly effect: "read";
}, {
    readonly method: "nftUtxosByScriptHash";
    readonly http: "GET";
    readonly path: "api/tbc/nft/utxo/scriptpubkeyhash/{scriptpubkeyhash}";
    readonly section: "tbc721";
    readonly effect: "read";
}, {
    readonly method: "nftCollectionsByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/nft/collectionbyaddress/address/{address}/start/{start}/end/{end}";
    readonly section: "tbc721";
    readonly effect: "read";
}, {
    readonly method: "nftHistoryByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/nft/history/address/{address}/nftid/{nftid}/start/{start}/end/{end}";
    readonly section: "tbc721";
    readonly effect: "read";
}, {
    readonly method: "nftAllHistoryByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/nft/allhistory/address/{address}/start/{start}/end/{end}";
    readonly section: "tbc721";
    readonly effect: "read";
}, {
    readonly method: "nftsByCollection";
    readonly http: "GET";
    readonly path: "api/tbc/nft/nftbycollection/collectionid/{collection_id}/start/{start}/end/{end}";
    readonly section: "tbc721";
    readonly effect: "read";
}, {
    readonly method: "nftsByAddress";
    readonly http: "GET";
    readonly path: "api/tbc/nft/nftbyaddress/address/{address}/start/{start}/end/{end}";
    readonly section: "tbc721";
    readonly effect: "read";
}, {
    readonly method: "nftCollectionList";
    readonly http: "GET";
    readonly path: "api/tbc/nft/collectionlist/start/{start}/end/{end}";
    readonly section: "tbc721";
    readonly effect: "read";
}, {
    readonly method: "nftList";
    readonly http: "GET";
    readonly path: "api/tbc/nft/nftlist/start/{start}/end/{end}";
    readonly section: "tbc721";
    readonly effect: "read";
}];
type PathParameters<Path extends string> = Path extends `${string}{${infer Parameter}}${infer Rest}` ? Parameter | PathParameters<Rest> : never;
type Entry = typeof TBC_OFFICIAL_API_ENDPOINTS[number];
type QueryFor<E extends Entry> = E extends Readonly<{
    query: readonly (infer Q extends string)[];
}> ? Readonly<{
    [Name in Q]?: Name extends "after" | "target" ? string : number;
}> : Readonly<Record<never, never>>;
type ParamsFor<E extends Entry> = Readonly<Record<PathParameters<E["path"]>, string | number>> & QueryFor<E>;
export interface TbcApiPostInputMap {
    readonly broadcastTransaction: Readonly<{
        readonly txraw: string;
    }>;
    readonly broadcastTransactions: readonly Readonly<{
        readonly txraw: string;
    }>[];
    readonly txoStatus: Readonly<{
        readonly txos: readonly TbcApiTxoStatusInput[];
    }>;
}
export interface TbcApiResultMap {
    readonly health: TbcApiHealth;
    readonly nodeInfo: TbcApiNodeInfo;
    readonly rawTransaction: TbcApiRawTransaction;
    readonly broadcastTransaction: TbcApiBroadcastResult;
    readonly broadcastTransactions: TbcApiBroadcastBatchResult;
    readonly txoStatus: TbcApiTxoStatusResult;
    readonly utxosByAddress: TbcApiUtxoList;
    readonly utxosByScriptHash: TbcApiUtxoList;
    readonly timelockUtxosByAddress: TbcApiUtxoList;
    readonly ftUtxosByAddress: TbcApiTbc20UtxoList;
    readonly ftUtxosByCombineScript: TbcApiTbc20UtxoList;
    readonly poolLpUtxosByScriptHash: TbcApiTbc20UtxoList;
    readonly poolInfo: TbcApiPoolInfo;
    readonly recentBlocks: TbcApiList;
    readonly mempoolTransactions: TbcApiList;
}
type ResultFor<M extends Entry["method"]> = M extends keyof TbcApiResultMap ? TbcApiResultMap[M] : TbcApiRecord;
type InputFor<E extends Entry> = E["method"] extends keyof TbcApiPostInputMap ? TbcApiPostInputMap[E["method"]] : ParamsFor<E>;
type CallFor<E extends Entry> = PathParameters<E["path"]> extends never ? E["method"] extends keyof TbcApiPostInputMap ? (input: InputFor<E>, options?: TbcRequestOptions) => Promise<ResultFor<E["method"]>> : (options?: TbcRequestOptions) => Promise<ResultFor<E["method"]>> : (input: InputFor<E>, options?: TbcRequestOptions) => Promise<ResultFor<E["method"]>>;
export type TbcOfficialApiClient = Readonly<{
    [E in Entry as E["method"]]: CallFor<E>;
}> & Readonly<{
    transport: TbcHttpTransport;
}>;
export type CreateTbcOfficialApiOptions = Omit<TbcTransportOptions, "baseUrl"> & Readonly<{
    network?: "mainnet" | "testnet";
    baseUrl?: string;
}>;
export declare function createTbcOfficialApi(options?: CreateTbcOfficialApiOptions): TbcOfficialApiClient;
export {};
//# sourceMappingURL=official-api.d.ts.map