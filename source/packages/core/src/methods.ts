import { TwsMethodError } from "./errors.js";
import { assertTwsMethodParams } from "./validation.js";

export type TwsMethodPath =
  | "session-read"
  | "permission-read"
  | "account-read"
  | "permission-request"
  | "switch-chain"
  | "message-signing"
  | "sign-transaction"
  | "send-transaction"
  | "sign-workflow"
  | "send-workflow"
  | "wallet-action"
  | "disconnect";

export type TwsMethodCategory = "transaction" | "non-transaction";

export interface TwsMethodDefinition {
  readonly name: string;
  readonly version: "1.0";
  readonly profile: "core" | "defi";
  readonly authorizationMode: string;
  readonly permissions: readonly string[];
  readonly approval: string;
  readonly operationKind: string | null;
  readonly effect: string;
  readonly paramsKind: "none" | "named" | "positional";
  readonly path: TwsMethodPath;
  readonly category: TwsMethodCategory;
}

function method(
  name: string,
  profile: "core" | "defi",
  authorizationMode: string,
  permissions: readonly string[],
  approval: string,
  operationKind: string | null,
  effect: string,
  paramsKind: "none" | "named" | "positional",
  path: TwsMethodPath,
): TwsMethodDefinition {
  return Object.freeze({
    name,
    version: "1.0" as const,
    profile,
    authorizationMode,
    permissions: Object.freeze([...permissions]),
    approval,
    operationKind,
    effect,
    paramsKind,
    path,
    category:
      path === "sign-transaction" || path === "send-transaction"
        ? "transaction"
        : "non-transaction",
  });
}

export const TWS_METHOD_DEFINITIONS = Object.freeze([
  method("tbc_chainId", "core", "public", [], "none", null, "read", "none", "session-read"),
  method("tbc_accounts", "core", "permission-derived", ["tbc_accounts"], "none", null, "read", "none", "account-read"),
  method("tbc_requestAccounts", "core", "grants", ["tbc_accounts"], "permission-prompt", "permission", "permission-grant", "none", "permission-request"),
  method("tbc_getAccount", "core", "requires", ["tbc_accounts", "tbc_accountMetadata"], "none", null, "read", "named", "account-read"),
  method("tbc_getCapabilities", "core", "conditional", ["tbc_accounts"], "none", null, "read", "named", "account-read"),
  method("tbc_switchChain", "core", "requires", ["tbc_switchChain"], "wallet-policy", "switchChain", "wallet-state", "named", "switch-chain"),
  method("tbc_signMessage", "core", "requires", ["tbc_accounts", "tbc_signMessage"], "operation", "message", "signature", "named", "message-signing"),
  method("tbc_signTypedData", "core", "requires", ["tbc_accounts", "tbc_signTypedData"], "operation", "typedData", "signature", "named", "message-signing"),
  method("tbc_signTransaction", "core", "requires", ["tbc_accounts", "tbc_signTransaction"], "operation", "transaction", "signed-transaction", "named", "sign-transaction"),
  method("tbc_signPreparedTransaction", "core", "requires", ["tbc_accounts", "tbc_signTransaction"], "operation", "transaction", "signed-transaction", "named", "sign-transaction"),
  method("tbc_sendTransaction", "core", "requires", ["tbc_accounts", "tbc_sendTransaction"], "operation", "transaction", "broadcast", "named", "send-transaction"),
  method("tbc_sendPreparedTransaction", "core", "requires", ["tbc_accounts", "tbc_sendTransaction"], "operation", "transaction", "broadcast", "named", "send-transaction"),
  method("tbc_signReviewedTransaction", "core", "requires", ["tbc_accounts", "tbc_signTransaction"], "operation", "transaction", "signed-transaction", "named", "wallet-action"),
  method("tbc_encrypt", "core", "requires", ["tbc_accounts", "tbc_crypto"], "operation", "crypto", "private-crypto", "named", "wallet-action"),
  method("tbc_decrypt", "core", "requires", ["tbc_accounts", "tbc_crypto"], "operation", "crypto", "private-crypto", "named", "wallet-action"),
  method("tbc_signWorkflow", "defi", "requires", ["tbc_accounts", "tbc_signWorkflow"], "operation", "workflow", "signed-workflow", "named", "sign-workflow"),
  method("tbc_signPreparedWorkflow", "defi", "requires", ["tbc_accounts", "tbc_signWorkflow"], "operation", "workflow", "signed-workflow", "named", "sign-workflow"),
  method("tbc_sendWorkflow", "defi", "requires", ["tbc_accounts", "tbc_signWorkflow", "tbc_sendTransaction"], "operation", "workflow", "broadcast", "named", "send-workflow"),
  method("tbc_sendPreparedWorkflow", "defi", "requires", ["tbc_accounts", "tbc_signWorkflow", "tbc_sendTransaction"], "operation", "workflow", "broadcast", "named", "send-workflow"),
  method("wallet_getPermissions", "core", "public", [], "none", null, "read", "none", "permission-read"),
  method("wallet_requestPermissions", "core", "grants", ["tbc_accounts", "tbc_accountMetadata", "tbc_switchChain", "tbc_signMessage", "tbc_signTypedData", "tbc_crypto", "tbc_signTransaction", "tbc_sendTransaction", "tbc_signWorkflow"], "permission-prompt", "permission", "permission-grant", "positional", "permission-request"),
  method("tbc_disconnect", "core", "public", [], "none", null, "permission-revoke", "none", "disconnect"),
]);

const METHOD_BY_NAME = new Map(
  TWS_METHOD_DEFINITIONS.map((definition) => [definition.name, definition]),
);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getTwsMethod(name: string): TwsMethodDefinition {
  const definition = METHOD_BY_NAME.get(name);
  if (!definition) {
    throw new TwsMethodError("UNSUPPORTED_METHOD", `Unsupported TWS method: ${name}`);
  }
  return definition;
}

export function assertMethodParams(
  definition: TwsMethodDefinition,
  params: unknown,
): void {
  let valid = false;
  if (definition.paramsKind === "none") {
    valid = Array.isArray(params) && params.length === 0;
  } else if (definition.paramsKind === "positional") {
    valid = Array.isArray(params) && params.length === 1 && isRecord(params[0]);
  } else {
    valid = isRecord(params);
  }

  if (!valid) {
    throw new TwsMethodError(
      "INVALID_METHOD_PARAMS",
      `Invalid params for ${definition.name}`,
    );
  }
  if (definition.paramsKind !== "none") {
    try {
      assertTwsMethodParams(definition.name, params);
    } catch {
      throw new TwsMethodError(
        "INVALID_METHOD_PARAMS",
        `Invalid params for ${definition.name}`,
      );
    }
  }
}
