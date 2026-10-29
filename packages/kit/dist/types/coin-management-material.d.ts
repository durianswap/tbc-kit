import type { TbcOfficialApiClient } from "./official-api.js";
import type { NftTransactionMaterial as TransactionMaterial } from "./nft-material.js";
type Outpoint = Readonly<{
    txid: string;
    vout: number;
}>;
/** Only mutable availability is queried here. All signature/contract authority,
 * amount/lock rules and exact transaction construction remain in the Engine. */
export declare function resolveCoinManagementMaterial(input: Readonly<{
    mint: boolean;
    contractId: string;
    targetOutpoints?: readonly Outpoint[];
    certificateOutpoint?: Outpoint;
    api: TbcOfficialApiClient;
    readHistory: (txid: string) => Promise<TransactionMaterial>;
    readDecoded: (txid: string) => Promise<TransactionMaterial>;
    ancestors: (parent: TransactionMaterial, vout: number) => readonly string[];
    tipHeight: Promise<bigint>;
    minimumConfirmations: string | undefined;
}>): Promise<Readonly<{
    utxos: Readonly<{
        confirmations?: string;
        satoshis: "200" | "100" | "500";
        scriptPubKey: string;
        classification: "stablecoin" | "nft";
        contractId: string;
        txid: string;
        vout: number;
    }>[];
    parents: TransactionMaterial[];
    contracts: Readonly<{
        contractId: string;
        family: "stablecoin";
        protocolVersion: "coin";
        standardId: "tbc20-stablecoin";
        templateRevision: "c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3";
        creationTxid: string;
        genesisOutpoint: Readonly<{
            txid: string;
            vout: 0;
        }>;
        currentOutpoint: Readonly<{
            txid: string;
            vout: number;
        }>;
    }>[];
}>>;
export {};
//# sourceMappingURL=coin-management-material.d.ts.map