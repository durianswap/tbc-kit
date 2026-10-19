/**
 * Kit-owned migration contract for historical wallet services.
 *
 * This is an inventory of retained Legacy-to-Kit seams, including explicitly
 * blocked issuance retained pending removal approval. It is not a wallet
 * capability declaration: "canonical" describes routing ownership only. It is
 * intentionally declarative: it does not construct a second executor, read
 * network state, approve, sign, broadcast, or persist recovery state. Legacy
 * callers remain responsible for DTO/result/error/event mapping only.
 */

export type TbcKitLegacyMigrationId =
  | "ft-mint"
  | "ft-transfer"
  | "pool-signing";

export type TbcKitLegacyMigrationStatus = "canonical" | "compatibility" | "blocked";

export type TbcKitLegacyMigrationContractEntry = Readonly<{
  readonly id: TbcKitLegacyMigrationId;
  /** Historical surface(s) that may still be supplied by a wallet. */
  readonly legacySurface: string;
  /** One Kit-owned entry point; this is never a Legacy service constructor. */
  readonly canonicalEntrypoint: string;
  /** Where approval, private execution, and recovery remain owned. */
  readonly executionBoundary: "Kit Standard workflow" | "Kit Pool material" | "Kit Chain Data";
  readonly status: TbcKitLegacyMigrationStatus;
  readonly legacyRole: "DTO/result/error/event mapping" | "explicit fallback adapter";
}>;

export const TBC_KIT_LEGACY_MIGRATION_CONTRACT = Object.freeze([
  {
    id: "ft-mint",
    legacySurface: "LegacyFtMintService.prepare/sign/read/review; FT_MINT",
    canonicalEntrypoint: "createLegacyFtCreateIntentResolver → tbc.ft.create → rejected (historical issuance disabled)",
    executionBoundary: "Kit Standard workflow",
    status: "blocked",
    legacyRole: "DTO/result/error/event mapping",
  },
  {
    id: "ft-transfer",
    legacySurface: "LegacyFtTransferService.prepare/sign/read/review; FT_TRANSFER",
    canonicalEntrypoint: "createLegacyFtTransferIntentResolver → tbc.ft.transfer → tbc_signTransaction",
    executionBoundary: "Kit Standard workflow",
    status: "canonical",
    legacyRole: "DTO/result/error/event mapping",
  },
  {
    id: "pool-signing",
    legacySurface: "LegacyPoolSigningService.prepare/sign/read/review; existing-pool/LP flags only (creation blocked)",
    canonicalEntrypoint: "createLegacyPoolIntentResolver → PoolMaterialSource.resolve* → tbc_signTransaction",
    executionBoundary: "Kit Pool material",
    status: "canonical",
    legacyRole: "DTO/result/error/event mapping",
  },
] as const satisfies readonly TbcKitLegacyMigrationContractEntry[]);

export type TbcKitLegacyMigrationContract =
  typeof TBC_KIT_LEGACY_MIGRATION_CONTRACT;
