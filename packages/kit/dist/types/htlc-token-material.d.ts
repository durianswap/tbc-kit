import type { TbcOfficialApiClient } from "./official-api.js";
import type { TestnetTip } from "./testnet-client.js";
import type { NftTransactionMaterial as TransactionMaterial } from "./nft-material.js";
/** Exact Token Code + sibling HTLC availability, sharing the caller's tip and
 * immutable parent cache. No secret argument, funding scan, recursive ancestry,
 * or mint-state lookup. The Engine authenticates identity, Tape and claim proof. */
export declare function resolveHtlcTokenMaterial(input: Readonly<{
    assetStandard: "tbc20-standard" | "tbc20-stablecoin";
    contractId: string;
    templateRevision: string;
    target: Readonly<{
        txid: string;
        vout: number;
    }>;
    branch: "claim" | "refund";
    ownerScript: string;
    minimumConfirmations: string;
    api: TbcOfficialApiClient;
    readTip: () => Promise<TestnetTip>;
    tokenLockTime: (parent: TransactionMaterial) => Promise<number>;
    readIdentity: () => Promise<Readonly<{
        contractId: string;
        codeScript: string;
        tapeScript: string;
        totalSupply: string;
    }>>;
    readHistory: (txid: string) => Promise<TransactionMaterial>;
    readDecoded: (txid: string) => Promise<TransactionMaterial>;
    ancestors: (parent: TransactionMaterial, vout: number) => readonly string[];
}>): Promise<Readonly<{
    utxos: readonly Readonly<{
        confirmations?: string;
        contractId?: string;
        txid: string;
        vout: number;
        satoshis: any;
        scriptPubKey: string;
        classification: "stablecoin" | "ft" | "htlc";
    }>[];
    parents: readonly TransactionMaterial[];
    contracts: readonly Readonly<{
        contractId: string;
        family: "stablecoin" | "ft";
        indexedFungible: {
            codeScript: string;
            tapeScript: string;
            totalSupply: string;
        };
        protocolVersion: "tbc20" | "coin";
        standardId: "tbc20-standard" | "tbc20-stablecoin";
        templateRevision: string;
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
