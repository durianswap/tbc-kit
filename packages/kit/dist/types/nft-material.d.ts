import type { TbcOfficialApiClient } from "./official-api.js";
export declare const TBC721_TEMPLATE_REVISION = "a97688ec62777b01e93c8486e0505b56701f48dc8cf7947637ece57fe88df104";
export interface NftTransactionMaterial {
    readonly txid: string;
    readonly rawTransaction: string;
    readonly inputs: readonly Readonly<{
        txid: string;
        vout: number;
    }>[];
    readonly outputs: readonly Readonly<{
        vout: number;
        satoshis: string;
        scriptPubKey: string;
    }>[];
    readonly confirmations?: string;
}
export declare class NftMaterialUnavailableError extends Error {
    constructor(message: string);
}
export declare function resolveNftMaterial(input: Readonly<{
    kind: "collection" | "nft";
    contractId: string;
    ownerScript: string;
    api: TbcOfficialApiClient;
    readHistory: (txid: string) => Promise<NftTransactionMaterial>;
    readDecoded: (txid: string) => Promise<NftTransactionMaterial>;
    tipHeight: Promise<bigint | undefined>;
    minimumConfirmations: string | undefined;
    standardId?: "tbc721-standard";
    collectionSlots?: readonly number[];
}>): Promise<Readonly<{
    utxos: Readonly<{
        confirmations?: string;
        txid: string;
        vout: number;
        satoshis: string;
        scriptPubKey: string;
        classification: "nft" | "collection-slot";
        contractId: string;
    }>[];
    parents: NftTransactionMaterial[];
    contracts: Readonly<{
        creationTxid: string;
        currentOutpoint: Readonly<{
            txid: string;
            vout: number;
        }>;
        standardId?: "tbc721-standard";
        templateRevision?: "a97688ec62777b01e93c8486e0505b56701f48dc8cf7947637ece57fe88df104";
        genesisOutpoint?: Readonly<{
            txid: string;
            vout: 0;
        }>;
        contractId: string;
        family: "collection" | "nft";
        protocolVersion: "tbc721" | "2.0";
    }>[];
}>>;
//# sourceMappingURL=nft-material.d.ts.map