/**
 * Neutral native capability boundary for canonical Pool material.
 *
 * The current bundled/native ABI still calls the LP preview operation
 * `legacyPoolPreview`. That historical name is translated only here; the
 * canonical Pool material path uses `previewLiquidityAdd`.
 */

export const POOL_MATERIAL_NATIVE_OPERATIONS = Object.freeze([
  "preparePoolNft",
  "prepareAssetAncestry",
  "previewLiquidityAdd",
] as const);

export type PoolMaterialNativeOperation =
  (typeof POOL_MATERIAL_NATIVE_OPERATIONS)[number];

export interface PoolMaterialNativeProvider {
  readonly protocolInfo: () => Promise<string>;
  readonly execute: (
    operation: PoolMaterialNativeOperation,
    requestJson: string,
  ) => Promise<string>;
}

/** Existing platform/native bridge shape accepted only at the compatibility boundary. */
export interface PoolMaterialNativeProviderInput {
  readonly protocolInfo: () => Promise<string>;
  readonly execute: (operation: string, requestJson: string) => Promise<string>;
}

const LEGACY_PREVIEW_OPERATION = "legacyPoolPreview";

function translatedProtocolInfo(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid Pool native protocol info");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as { readonly operations?: unknown }).operations)
  ) {
    throw new Error("Invalid Pool native protocol info");
  }
  const operations = (parsed as { readonly operations: readonly unknown[] })
    .operations
    .map((operation) =>
      operation === LEGACY_PREVIEW_OPERATION
        ? "previewLiquidityAdd"
        : operation,
    );
  return JSON.stringify({
    ...(parsed as Readonly<Record<string, unknown>>),
    operations: [...new Set(operations)],
  });
}

/**
 * Adapts the current wallet/native ABI once, before canonical Pool material
 * resolution. No HTTP, Port, authority, signing or durable state is involved.
 */
export function createPoolMaterialNativeProvider(
  input: PoolMaterialNativeProviderInput,
): PoolMaterialNativeProvider {
  return Object.freeze({
    async protocolInfo() {
      return translatedProtocolInfo(await input.protocolInfo());
    },
    execute(operation: PoolMaterialNativeOperation, requestJson: string) {
      return input.execute(
        operation === "previewLiquidityAdd"
          ? LEGACY_PREVIEW_OPERATION
          : operation,
        requestJson,
      );
    },
  });
}
