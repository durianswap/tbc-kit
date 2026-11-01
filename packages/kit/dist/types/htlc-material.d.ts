import type { TbcOfficialApiClient } from "./official-api.js";
import type { TestnetTip } from "./testnet-client.js";
type Point = Readonly<{
    txid: string;
    vout: number;
}>;
type Parent = Readonly<{
    txid: string;
    rawTransaction: string;
    confirmations?: string;
    outputs: readonly Readonly<{
        vout: number;
        satoshis: string;
        scriptPubKey: string;
    }>[];
}>;
/** Exact routing decode, not signature or hashlock authorization. The Engine
 * separately authenticates parent bytes, roles and the supplied claim proof. */
export declare function inspectHtlcCode(script: string): Readonly<{
    hashlock: string;
    receiverHash: string;
    senderHash: string;
    lockTime: number;
}>;
/** Native HTLC only. Reads exact selected outputs and unique direct parents;
 * never accepts/sends a preimage, scans a funding index, or walks ancestors.
 * txoStatus is a read-only HTTP POST, not a transaction broadcast. */
export declare function resolveHtlcMaterial(input: Readonly<{
    api: TbcOfficialApiClient;
    branch: "claim" | "refund";
    ownerScript: string;
    inputOutpoints: readonly Point[];
    minimumConfirmations: string;
    readHistory: (txid: string) => Promise<Parent>;
    readDecoded: (txid: string) => Promise<Parent>;
}>): Promise<Readonly<{
    tip: TestnetTip | undefined;
    utxos: readonly Readonly<{
        confirmations?: string;
        txid: string;
        vout: number;
        satoshis: string;
        scriptPubKey: string;
        classification: "htlc";
    }>[];
    parents: readonly Readonly<{
        txid: string;
        rawTransaction: string;
        confirmations?: string;
        outputs: readonly Readonly<{
            vout: number;
            satoshis: string;
            scriptPubKey: string;
        }>[];
    }>[];
}>>;
export {};
