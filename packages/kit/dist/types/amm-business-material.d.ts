import type { NftTransactionMaterial as TransactionMaterial } from "./nft-material.js";
import type { TbcOfficialApiClient } from "./official-api.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TestnetTip } from "./testnet-client.js";
type Point = Readonly<{
    txid: string;
    vout: number;
}>;
export type AmmMaterialAction = Readonly<{
    kind: "addTbc" | "addFt" | "buy" | "sell" | "remove";
    amount: string;
    initialFtAmount?: string;
}>;
type Utxo = Point & Readonly<{
    satoshis: string;
    scriptPubKey: string;
    contractId: string;
    classification: "pool" | "pool-ft" | "ft" | "ftlp";
    confirmations?: string;
}>;
/** Only mutable API discovery and bounded direct proofs live here. Quotes and
 * contract parsing use the same Rust codec as Engine, with no signing or UI. */
export declare function resolveAmmBusinessMaterial(input: Readonly<{
    contractId: string;
    publicKey: string;
    controllerPublicKey?: string;
    action: AmmMaterialAction;
    api: TbcOfficialApiClient;
    native: PoolMaterialNativeProviderInput;
    readHistory: (txid: string) => Promise<TransactionMaterial>;
    readFtInfo: (id: string) => Promise<Readonly<{
        codeScript: string;
        tapeScript: string;
    }>>;
    readDecoded: (txid: string) => Promise<TransactionMaterial>;
    readTip: () => Promise<TestnetTip>;
    minimumConfirmations: string | undefined;
    inputOutpoints?: readonly Point[];
}>): Promise<{
    utxos: Utxo[];
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
