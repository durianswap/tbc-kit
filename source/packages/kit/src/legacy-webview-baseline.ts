export const LEGACY_BASELINE_A_METHODS = Object.freeze([
  "connect",
  "disconnect",
  "isConnected",
  "getPubKey",
  "getAddress",
  "getNetwork",
  "getInfo",
] as const);

export type LegacyBaselineAMethod = (typeof LEGACY_BASELINE_A_METHODS)[number];

export interface LegacyMappingContext {
  readonly chainId: string;
  readonly address?: string;
  readonly platform?: "ios" | "android";
  readonly walletVersion?: string;
}

export interface LegacyBaselineARequest {
  readonly method: LegacyBaselineAMethod;
  readonly params: unknown;
  readonly chainId: string;
  readonly address?: string;
}

export type CanonicalBaselineARequest = Readonly<{
  method:
    | "wallet_requestPermissions"
    | "tbc_disconnect"
    | "tbc_accounts"
    | "tbc_getAccount"
    | "tbc_chainId";
  params:
    | readonly []
    | Readonly<{ address: string }>
    | readonly [
        Readonly<{
          tbc_accounts: Readonly<{
            chains: readonly string[];
            maxAccounts: 1;
          }>;
          tbc_accountMetadata: Readonly<{
            chains: readonly string[];
          }>;
          tbc_signTransaction: Readonly<{
            chains: readonly string[];
          }>;
          tbc_signWorkflow: Readonly<{
            chains: readonly string[];
          }>;
          tbc_signMessage: Readonly<{
            chains: readonly string[];
          }>;
        }>,
      ];
}>;

const NO_PARAMS = Object.freeze([]) as readonly [];

export function mapLegacyRequest(
  input: LegacyBaselineARequest,
): CanonicalBaselineARequest | undefined {
  switch (input.method) {
    case "connect":
      return Object.freeze({
        method: "wallet_requestPermissions",
        params: Object.freeze([
          Object.freeze({
            tbc_accounts: Object.freeze({
              chains: Object.freeze([input.chainId]),
              maxAccounts: 1,
            }),
            tbc_accountMetadata: Object.freeze({
              chains: Object.freeze([input.chainId]),
            }),
            // Legacy wallets authorize their transaction surface when the
            // user connects. Keeping this in the same exact-origin approval
            // prevents a second permission sheet after the first batch
            // review; every actual transaction still has its own approval
            // binding and Signer validation.
            tbc_signTransaction: Object.freeze({
              chains: Object.freeze([input.chainId]),
            }),
            // Generic Legacy batches are executed by one Standard workflow.
            // Grant the workflow capability in this same exact-origin connect
            // approval so the later business approval is not preceded by a
            // second permission sheet.
            tbc_signWorkflow: Object.freeze({
              chains: Object.freeze([input.chainId]),
            }),
            tbc_crypto: Object.freeze({
              chains: Object.freeze([input.chainId]),
            }),
            // Durian authenticates the freshly connected account immediately
            // with Bitcoin-magic signMessage. Authorizing that capability in
            // the same exact-origin connect sheet avoids a guaranteed 4100;
            // the message itself still has a separately bound approval and
            // Signer task.
            tbc_signMessage: Object.freeze({
              chains: Object.freeze([input.chainId]),
            }),
          }),
        ] as const),
      });
    case "disconnect":
      return Object.freeze({ method: "tbc_disconnect", params: NO_PARAMS });
    case "isConnected":
    case "getAddress":
      return Object.freeze({ method: "tbc_accounts", params: NO_PARAMS });
    case "getNetwork":
      return Object.freeze({ method: "tbc_chainId", params: NO_PARAMS });
    case "getPubKey":
      if (input.address === undefined) {
        throw new Error("User not connected");
      }
      return Object.freeze({
        method: "tbc_getAccount",
        params: Object.freeze({
          address: input.address,
        }),
      });
    case "getInfo":
      return undefined;
  }
}

function firstAddress(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first: unknown = value[0];
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

export function mapLegacyResult(
  method: LegacyBaselineAMethod,
  result: unknown,
  context: LegacyMappingContext,
): unknown {
  switch (method) {
    case "connect":
    case "getAddress": {
      const address = firstAddress(result);
      return address === undefined
        ? Object.freeze({ error: "User not connected" })
        : Object.freeze({ tbcAddress: address });
    }
    case "isConnected":
      return firstAddress(result) !== undefined;
    case "getPubKey": {
      if (result === null || typeof result !== "object") {
        return Object.freeze({ error: "User not connected" });
      }
      const publicKey = Reflect.get(result, "publicKey");
      return typeof publicKey === "string" && publicKey.length > 0
        ? Object.freeze({ tbcPubKey: publicKey })
        : Object.freeze({ error: "User not connected" });
    }
    case "getNetwork":
      return result === context.chainId
        ? Object.freeze({ network: "tbc", type: "testnet" })
        : Object.freeze({ error: "Unsupported legacy operation" });
    case "getInfo":
      return Object.freeze({
        name: "Turing",
        platform: context.platform,
        version: context.walletVersion,
      });
    case "disconnect":
      return true;
  }
}
