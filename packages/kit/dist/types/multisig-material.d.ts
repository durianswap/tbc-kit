import type { TbcOfficialApiClient } from "./official-api.js";
import type { MultisigEngine, MultisigGroup, MultisigInput, MultisigToken } from "./multisig.js";
/** An explicitly configured API; no default network, backend service or polling.
 * Mutable UTXO selections are never cached. Immutable raw transactions are
 * deduplicated only inside one resolve call, including shared funding parents.
 */
export declare function createMultisigMaterialLoader(options: Readonly<{
    chainId: "tbc:mainnet" | "tbc:testnet";
    api: TbcOfficialApiClient;
    engine: MultisigEngine;
}>): Readonly<{
    chainId: "tbc:mainnet" | "tbc:testnet";
    /** Bounded selection, not an assertion this is the address's full balance. */
    nativeInputs: (group: MultisigGroup, query?: Readonly<{
        target?: string;
        limit?: number;
    }>) => Promise<readonly Readonly<{
        txid: string;
        vout: number;
        satoshis: string;
        scriptPubKey: string;
    }>[]>;
    resolveToken: (input: Readonly<{
        code: string;
        tape: string;
        selected: readonly Readonly<{
            txid: string;
            vout: number;
            balance: string;
        }>[];
        funding?: MultisigInput;
    }>) => Promise<Readonly<{
        token: MultisigToken;
        funding?: MultisigInput;
    }>>;
    tokenInputs(input: Readonly<{
        group: MultisigGroup;
        contractId: string;
        asset?: "ft" | "legacy-stablecoin";
        target?: string;
        funding?: MultisigInput;
    }>): Promise<Readonly<{
        token: MultisigToken;
        funding?: MultisigInput;
    }>>;
}>;
//# sourceMappingURL=multisig-material.d.ts.map