import type { NftTransactionMaterial as TransactionMaterial } from "./nft-material.js";
import type { TbcOfficialApiClient } from "./official-api.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TestnetTip } from "./testnet-client.js";
type Point = Readonly<{
    txid: string;
    vout: number;
}>;
export declare class UnsupportedPoolOperationError extends Error {
    constructor();
}
type MaterialInput = Readonly<{
    contractId: string;
    readHistory: (txid: string) => Promise<TransactionMaterial>;
}>;
/** Immutable FT anchor only: empty AMM creation does not consume holder FT. */
export declare function resolveAmmCreateMaterial(input: Readonly<{
    contractId: string;
    readIdentity: () => Promise<Readonly<{
        contractId: string;
        codeScript: string;
        tapeScript: string;
        totalSupply: string;
    }>>;
}>): Promise<{
    utxos: never[];
    parents: never[];
    contracts: {
        indexedFungible: {
            codeScript: string;
            tapeScript: string;
            totalSupply: string;
        };
        contractId: string;
        family: string;
        protocolVersion: string;
        standardId: string;
        templateRevision: string;
        creationTxid: string;
        genesisOutpoint: {
            txid: string;
            vout: number;
        };
        currentOutpoint: {
            txid: string;
            vout: number;
        };
    }[];
}>;
/** Index hints select candidates; the shared Rust codec reads actual locks and
 * proof dependencies. Engine planning still authenticates every selected input.
 * No current Pool query, fee-parent raw, recursive ancestry or signing here. */
export declare function resolveLpMaterial(input: MaterialInput & Readonly<{
    intentType: string;
    amount?: string;
    publicKey: string;
    api: TbcOfficialApiClient;
    readFtInfo: (id: string) => Promise<Readonly<{
        codeScript: string;
        tapeScript: string;
    }>>;
    native: PoolMaterialNativeProviderInput;
    readDecoded: (txid: string) => Promise<TransactionMaterial>;
    readTip: () => Promise<TestnetTip>;
    minimumConfirmations: string | undefined;
    inputOutpoints?: readonly Point[];
}>): Promise<{
    utxos: Readonly<Readonly<{
        txid: string;
        vout: number;
    }> & {
        satoshis: string;
        scriptPubKey: string;
        classification: "ftlp";
        contractId: string;
        confirmations?: string;
    }>[];
    parents: TransactionMaterial[];
    contracts: {
        contractId: string;
        indexedPool: {
            ftCodeScript: string;
            ftTapeScript: string;
        };
        family: string;
        protocolVersion: string;
        standardId: string;
        templateRevision: string;
        creationTxid: string;
        genesisOutpoint: {
            txid: string;
            vout: number;
        };
        currentOutpoint: {
            txid: string;
            vout: number;
        };
    }[];
}>;
export {};
