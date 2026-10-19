/** Shared local recognition. No network, custody, account or approval authority. */
export type TbcFungibleContractMaterial = Readonly<{
  codeScript: string; codeSatoshis: number;
  tapeScript: string; tapeSatoshis: number;
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
export type TbcFungibleContractIdentity = Identity & (
  | Readonly<{ family: "tbc20"; generation: "current"; protocol: "tbc20-standard"; standardId: "tbc20-standard" }>
  | Readonly<{ family: "tbc20Stablecoin"; generation: "current"; protocol: "tbc20-stablecoin"; standardId: "tbc20-stablecoin" }>
  | Readonly<{ family: "tbc20"; generation: "historical"; protocol: "legacy-ft" | "legacy-tbc20"; standardId?: never }>
  | Readonly<{ family: "tbc20Stablecoin"; generation: "historical"; protocol: "legacy-stablecoin"; standardId?: never }>
);
export type IdentifyTbcFungibleContractsOptions = Readonly<{
  /** Reuse the caller's existing keyless Native/WASM engine; never auto-initialize one. */
  engine: Readonly<{ execute(operation: string, requestJson: string): Promise<string> }>;
}>;
const MATERIAL_KEYS = ["codeScript", "codeSatoshis", "tapeScript", "tapeSatoshis"];
export type TbcFungibleOriginHint = Readonly<{
  family: "tbc20" | "tbc20Stablecoin";
  generation: "current" | "historical";
  verification: "origin-template";
  assetIdentityVerified: false;
}>;
export type TbcNftOriginHint = Readonly<Omit<TbcFungibleOriginHint, "family"> & { family: "tbc721" }>;
export type TbcPoolOriginHint = Readonly<Omit<TbcFungibleOriginHint, "family"> & { family: "amm" }>;

/** Read-selection hint from the immutable genesis/issuer already required by
 * construction. This does not validate holder inputs, their version or locks.
 * Reuses the supplied keyless codec, never starts another Engine or HTTP read. */
export async function identifyTbcFungibleOrigin(
  contractId: string, rawTransaction: string, options: IdentifyTbcFungibleContractsOptions,
): Promise<TbcFungibleOriginHint> {
  return identifyOrigin(contractId, rawTransaction, options, "fungible") as Promise<TbcFungibleOriginHint>;
}

/** Same immutable-material boundary as fungible identification; no HTTP or authority. */
export async function identifyTbcNftOrigin(
  contractId: string, rawTransaction: string, options: IdentifyTbcFungibleContractsOptions,
): Promise<TbcNftOriginHint> {
  return identifyOrigin(contractId, rawTransaction, options, "nft") as Promise<TbcNftOriginHint>;
}

/** Exact Pool Code/Tape recognition from mandatory immutable creation bytes. */
export async function identifyTbcPoolOrigin(contractId: string, rawTransaction: string,
  options: IdentifyTbcFungibleContractsOptions): Promise<TbcPoolOriginHint> {
  return identifyOrigin(contractId, rawTransaction, options, "pool") as Promise<TbcPoolOriginHint>;
}

async function identifyOrigin(contractId: string, rawTransaction: string,
  options: IdentifyTbcFungibleContractsOptions, kind: "fungible" | "nft" | "pool"): Promise<TbcFungibleOriginHint | TbcNftOriginHint | TbcPoolOriginHint> {
  if (typeof contractId !== "string" || !/^[0-9a-f]{64}$/u.test(contractId) || typeof rawTransaction !== "string" ||
      rawTransaction.length === 0 || rawTransaction.length > 2 * 1_048_576 || !/^(?:[0-9a-f]{2})+$/u.test(rawTransaction)) {
    throw new TypeError("Invalid contract origin material");
  }
  const value: unknown = JSON.parse(await options.engine.execute(kind === "pool" ? "inspectAmmMaterial" : "inspectTokenMaterial",
    JSON.stringify(kind === "pool" ? {phase:"identifyPoolOrigin",pool:{txid:contractId,rawTransaction}}
      : { phase: kind === "nft" ? "identifyNftOrigin" : "identifyOrigin", contractId, rawTransaction })));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid contract origin hint");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || (kind === "pool" ? row.family !== "amm" : kind === "nft" ? row.family !== "tbc721" : row.family !== "tbc20" && row.family !== "tbc20Stablecoin") ||
      (row.generation !== "current" && row.generation !== "historical") || row.verification !== "origin-template" || row.assetIdentityVerified !== false) {
    throw new TypeError("Invalid contract origin hint");
  }
  return Object.freeze(row) as TbcFungibleOriginHint | TbcNftOriginHint | TbcPoolOriginHint;
}
function material(input: TbcFungibleContractMaterial): TbcFungibleContractMaterial {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid contract material");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== MATERIAL_KEYS.length || MATERIAL_KEYS.some(key =>
    descriptors[key] === undefined || !("value" in descriptors[key]!))) throw new TypeError("Contract material must contain only data fields");
  const snapshot = Object.fromEntries(MATERIAL_KEYS.map(key => [key, descriptors[key]!.value]));
  for (const key of ["codeScript", "tapeScript"]) {
    const script = snapshot[key];
    if (typeof script !== "string" || script.length > 131_072 || !/^(?:[0-9a-f]{2})*$/u.test(script)) throw new TypeError("Invalid contract script");
  }
  for (const key of ["codeSatoshis", "tapeSatoshis"]) {
    const value = snapshot[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid contract output value");
  }
  return snapshot as TbcFungibleContractMaterial;
}
function identity(value: unknown): TbcFungibleContractIdentity | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid contract identity");
  const row = value as Record<string, unknown>;
  const version = row.protocolVersion;
  const current = row.generation === "current";
  const token = row.protocol === "tbc20-standard" || row.protocol === "legacy-ft" || row.protocol === "legacy-tbc20";
  const versions = row.protocol === "legacy-ft" ? [1, 2, 3, 4] : row.protocol === "legacy-stablecoin" ? [2, 3, 4] : [1];
  if (!["tbc20-standard", "tbc20-stablecoin", "legacy-ft", "legacy-tbc20", "legacy-stablecoin"].includes(String(row.protocol)) ||
      !["current", "historical"].includes(String(row.generation)) || row.family !== (token ? "tbc20" : "tbc20Stablecoin") ||
      current !== (row.protocol === "tbc20-standard" || row.protocol === "tbc20-stablecoin") ||
      (current ? row.standardId !== row.protocol : row.standardId !== undefined) ||
      typeof version !== "number" || !versions.includes(version) ||
      typeof row.codeIdentity !== "string" || !/^(?:[0-9a-f]{2}){33,37}$/u.test(row.codeIdentity) ||
      typeof row.balanceRaw !== "string" || !/^(0|[1-9][0-9]{0,20})$/u.test(row.balanceRaw) || BigInt(row.balanceRaw) > 6n * ((1n << 64n) - 1n) ||
      row.verification !== "exact-template" || row.assetIdentityVerified !== false) throw new TypeError("Inconsistent contract identity");
  return Object.freeze({ family: row.family, generation: row.generation, protocol: row.protocol, protocolVersion: version,
    ...(current ? { standardId: row.standardId } : {}), codeIdentity: row.codeIdentity, balanceRaw: row.balanceRaw,
    verification: "exact-template", assetIdentityVerified: false }) as TbcFungibleContractIdentity;
}

/** Identify adjacent Code/Tape pairs using the shared exact Rust codecs.
 * Null is unrecognized, NEVER an ordinary/safe asset or permission to retry.
 * A recognized historical template may still lack a supported builder.
 * Caller must authenticate adjacency, origin and spend authority separately.
 * Snapshot and deduplicate before awaiting; no mutable or cross-network cache. */
export async function identifyTbcFungibleContracts(
  pairs: readonly TbcFungibleContractMaterial[], options: IdentifyTbcFungibleContractsOptions,
): Promise<readonly (TbcFungibleContractIdentity | null)[]> {
  if (!Array.isArray(pairs) || pairs.length === 0 || pairs.length > 256) throw new TypeError("Contract identification batch bound exceeded");
  const snapshot = pairs.map(material);
  const keys = snapshot.map(p => JSON.stringify(p));
  const unique = [...new Map(snapshot.map((p, i) => [keys[i]!, p])).entries()];
  const request = JSON.stringify({ phase: "identifyPairs", pairs: unique.map(([, p]) => p) });
  if (request.length > 8 * 1_048_576) throw new TypeError("Contract identification request exceeds byte bound");
  const result = JSON.parse(await options.engine.execute("inspectTokenMaterial", request)) as unknown;
  if (result === null || typeof result !== "object" || Array.isArray(result) ||
      !Array.isArray((result as Record<string, unknown>).identities)) throw new TypeError("Invalid contract identification result");
  const identities = (result as { identities: unknown[] }).identities;
  if (identities.length !== unique.length) throw new TypeError("Contract identification result length mismatch");
  const byKey = new Map(unique.map(([key], index) => [key, identity(identities[index])]));
  return Object.freeze(keys.map(key => byKey.get(key)!));
}
