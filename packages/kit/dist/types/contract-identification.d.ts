/** Shared local recognition. No network, custody, account or approval authority. */
export type TbcFungibleContractMaterial = Readonly<{
    codeScript: string;
    codeSatoshis: number;
    tapeScript: string;
    tapeSatoshis: number;
}>;
type Identity = Readonly<{
    protocolVersion: number;
    /** SDK SHA256 midstate + ScriptNum code length; NOT txid or SHA256(Code). */
    codeIdentity: string;
    balanceRaw: string;
    verification: "exact-template";
    /** Recognition does not authenticate origin, ancestry, unspentness or permissions. */
    assetIdentityVerified: false;
}>;
export type TbcFungibleContractIdentity = Identity & (Readonly<{
    family: "tbc20";
    generation: "current";
    protocol: "tbc20-standard";
    standardId: "tbc20-standard";
}> | Readonly<{
    family: "tbc20Stablecoin";
    generation: "current";
    protocol: "tbc20-stablecoin";
    standardId: "tbc20-stablecoin";
}> | Readonly<{
    family: "tbc20";
    generation: "historical";
    protocol: "legacy-ft" | "legacy-tbc20";
    standardId?: never;
}> | Readonly<{
    family: "tbc20Stablecoin";
    generation: "historical";
    protocol: "legacy-stablecoin";
    standardId?: never;
}>);
export type IdentifyTbcFungibleContractsOptions = Readonly<{
    /** Reuse the caller's existing keyless Native/WASM engine; never auto-initialize one. */
    engine: Readonly<{
        execute(operation: string, requestJson: string): Promise<string>;
    }>;
}>;
export type TbcFungibleOriginHint = Readonly<{
    family: "tbc20" | "tbc20Stablecoin";
    generation: "current" | "historical";
    verification: "origin-template";
    assetIdentityVerified: false;
}>;
export type TbcNftOriginHint = Readonly<Omit<TbcFungibleOriginHint, "family"> & {
    family: "tbc721";
}>;
export type TbcPoolOriginHint = Readonly<Omit<TbcFungibleOriginHint, "family"> & {
    family: "amm";
}>;
/** Read-selection hint from the immutable genesis/issuer already required by
 * construction. This does not validate holder inputs, their version or locks.
 * Reuses the supplied keyless codec, never starts another Engine or HTTP read. */
export declare function identifyTbcFungibleOrigin(contractId: string, rawTransaction: string, options: IdentifyTbcFungibleContractsOptions): Promise<TbcFungibleOriginHint>;
/** Same immutable-material boundary as fungible identification; no HTTP or authority. */
export declare function identifyTbcNftOrigin(contractId: string, rawTransaction: string, options: IdentifyTbcFungibleContractsOptions): Promise<TbcNftOriginHint>;
/** Exact Pool Code/Tape recognition from mandatory immutable creation bytes. */
export declare function identifyTbcPoolOrigin(contractId: string, rawTransaction: string, options: IdentifyTbcFungibleContractsOptions): Promise<TbcPoolOriginHint>;
/** Identify adjacent Code/Tape pairs using the shared exact Rust codecs.
 * Null is unrecognized, NEVER an ordinary/safe asset or permission to retry.
 * A recognized historical template may still lack a supported builder.
 * Caller must authenticate adjacency, origin and spend authority separately.
 * Snapshot and deduplicate before awaiting; no mutable or cross-network cache. */
export declare function identifyTbcFungibleContracts(pairs: readonly TbcFungibleContractMaterial[], options: IdentifyTbcFungibleContractsOptions): Promise<readonly (TbcFungibleContractIdentity | null)[]>;
export {};
