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
/** Read-only routing/display decode; Engine independently authenticates the
 * complete parent, owner and height in the approval-bound transaction plan. */
export declare function inspectTimelockCode(script: string): Readonly<{
    ownerHash: string;
    lockHeight: number;
}>;
/** Reads only selected deposits and their unique direct parents. No native fee
 * index, metadata, grandparent walk, signing or broadcast is needed to unlock. */
export declare function resolveTimelockMaterial(input: Readonly<{
    api: TbcOfficialApiClient;
    address: string;
    ownerScript: string;
    inputOutpoints: readonly Point[];
    minimumConfirmations: string;
    readHistory: (txid: string) => Promise<Parent>;
    readDecoded: (txid: string) => Promise<Parent>;
}>): Promise<Readonly<{
    tip: TestnetTip;
    utxos: readonly Readonly<{
        confirmations?: string;
        txid: any;
        vout: number;
        satoshis: any;
        scriptPubKey: string;
        classification: "timelock";
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
//# sourceMappingURL=timelock-material.d.ts.map