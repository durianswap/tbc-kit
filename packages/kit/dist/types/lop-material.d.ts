import { type ChainDataRequirement } from "./internal/core/index.js";
import type { TestnetClient, TestnetTip } from "./testnet-client.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { NftTransactionMaterial as Parent } from "./nft-material.js";
type Point = Readonly<{
    txid: string;
    vout: number;
}>;
type Standard = "tbc20-standard" | "tbc20-stablecoin";
/** Fresh availability plus bounded immutable ancestry. Rust supplies exact Code
 * recognition; its planner independently authenticates identity and signatures.
 * No broadcast, database, secret, recursive history walk or fee-parent scan. */
export declare function resolveLopMaterial(input: Readonly<{
    requirement: ChainDataRequirement;
    address: string;
    ownerScript: string;
    client: TestnetClient;
    native: PoolMaterialNativeProviderInput;
    minimumConfirmations: string;
    maxInputs: number;
    readHistory: (txid: string) => Promise<Parent>;
    readDecoded: (txid: string) => Promise<Parent>;
    hasHistory?: (txid: string) => boolean;
}>): Promise<{
    tip: TestnetTip | undefined;
    utxos: Readonly<Readonly<{
        txid: string;
        vout: number;
    }> & {
        satoshis: string;
        scriptPubKey: string;
        classification: string;
        contractId?: string;
        confirmations?: string;
    }>[];
    parents: Parent[];
    contracts: Readonly<{
        contractId: string;
        family: string;
        protocolVersion: string;
        standardId: Standard;
        templateRevision: string;
        creationTxid: string;
        genesisOutpoint: Point;
        currentOutpoint: Point;
        indexedFungible: {
            codeScript: string;
            tapeScript: string;
            totalSupply: string;
        };
    }>[];
}>;
export {};
//# sourceMappingURL=lop-material.d.ts.map