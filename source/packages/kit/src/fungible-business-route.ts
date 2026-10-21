import type {
  CoinMergeIntent, CoinTransferIntent, FtMergeIntent, FtTransferIntent,
  StablecoinMergeIntent, StablecoinTransferIntent, Tbc20StandardMergeIntent,
  Tbc20StandardTransferIntent,
} from "./public-types.js";
import { identifyTbcFungibleContracts, type IdentifyTbcFungibleContractsOptions,
  type TbcFungibleContractIdentity, type TbcFungibleContractMaterial } from "./contract-identification.js";

/** Internal shared lowering step. Not a new Provider RPC or an authorization. */
export type FungibleBusinessOperation = Readonly<{
  family: "tbc20" | "tbc20Stablecoin";
  contractId: string;
}> & (
  | Readonly<{ operation: "merge" }>
  | (Readonly<{ operation: "transfer"; payment?: Readonly<{ to: string; amount: string }> }> & (
      | Readonly<{ to: string; amount: string; receivers?: never }>
      | Readonly<{ receivers: readonly Readonly<{ to: string; amount: string }>[]; to?: never; amount?: never }>
    ))
);
type Intent = CoinMergeIntent | CoinTransferIntent | FtMergeIntent | FtTransferIntent |
  StablecoinMergeIntent | StablecoinTransferIntent | Tbc20StandardMergeIntent | Tbc20StandardTransferIntent;

function payment(value: Readonly<{ to: string; amount: string }>) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Reflect.ownKeys(value).length !== 2 || typeof value.to !== "string" || value.to.length === 0 ||
      typeof value.amount !== "string" || !/^[1-9][0-9]{0,38}$/u.test(value.amount)) throw new TypeError("Invalid business receiver");
  return Object.freeze({ to: value.to, amount: value.amount });
}
function snapshot(input: FungibleBusinessOperation): FungibleBusinessOperation {
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
      !["tbc20", "tbc20Stablecoin"].includes(input.family) || typeof input.contractId !== "string" || !/^[0-9a-f]{64}$/u.test(input.contractId)) throw new TypeError("Invalid fungible business target");
  const keys = Reflect.ownKeys(input);
  if (input.operation === "merge") {
    if (keys.length !== 3) throw new TypeError("Merge does not accept transfer fields");
    return Object.freeze({ family: input.family, contractId: input.contractId, operation: "merge" });
  }
  if (input.operation !== "transfer" || keys.some(k => typeof k !== "string" || !["family", "contractId", "operation", "to", "amount", "receivers", "payment"].includes(k))) {
    throw new TypeError("Unsupported fungible business operation");
  }
  const recipients = input.receivers === undefined
    ? payment({ to: input.to, amount: input.amount })
    : (() => {
        if (input.to !== undefined || input.amount !== undefined || !Array.isArray(input.receivers) || input.receivers.length === 0 || input.receivers.length > 8) throw new TypeError("Invalid business receivers");
        return { receivers: Object.freeze(input.receivers.map(payment)) };
      })();
  return Object.freeze({ family: input.family, contractId: input.contractId, operation: "transfer", ...recipients,
    ...(input.payment === undefined ? {} : { payment: payment(input.payment) }) });
}

/** Existing transaction material only. This chooses a concrete builder intent,
 * not permission to sign it. Caller must bind contractId to its authentic
 * origin, and downstream Engine must independently validate all material.
 * Do this BEFORE request normalization/approval; never replace an approved
 * request or reuse its hash after lowering. No retry, network or cache here. */
export async function resolveFungibleBusinessIntent(
  operation: FungibleBusinessOperation,
  material: readonly TbcFungibleContractMaterial[],
  options: IdentifyTbcFungibleContractsOptions,
): Promise<Readonly<{ intent: Intent; recognition: TbcFungibleContractIdentity }>> {
  const input = snapshot(operation);
  const identities = await identifyTbcFungibleContracts(material, options);
  const first = identities[0];
  if (first === null || first === undefined || first.family !== input.family) throw new Error("Fungible business template is unknown or family differs");
  if (identities.some(row => row === null || row.family !== first.family || row.generation !== first.generation ||
      row.protocol !== first.protocol || row.protocolVersion !== first.protocolVersion || row.codeIdentity !== first.codeIdentity)) {
    throw new Error("Fungible business material contains conflicting contract identities");
  }
  // Engine ancestry reconstruction currently supports historical FT/StableCoin
  // V4, not every version recognized for inspection/receipts.
  if (first.generation === "historical" && (first.protocolVersion !== 4 || !["legacy-ft", "legacy-stablecoin"].includes(first.protocol))) {
    throw new Error("Recognized historical fungible template has no supported business builder");
  }
  let intent: Intent;
  if (input.operation === "merge") {
    const type = first.generation === "current"
      ? first.family === "tbc20" ? "tbc20-standard-merge" : "tbc20-stablecoin-merge"
      : first.family === "tbc20" ? "tbc.ft.merge" : "tbc.stablecoin.merge";
    intent = { type, version: "1.0", contractId: input.contractId };
  } else if (first.generation === "current") {
    if (first.family === "tbc20Stablecoin" && input.receivers !== undefined && input.receivers.length > 7) throw new Error("Current Coin receiver bound exceeded");
    const type = first.family === "tbc20" ? "tbc20-standard-transfer" : "tbc20-stablecoin-transfer";
    intent = { type, version: "1.0", contractId: input.contractId,
      ...(input.receivers === undefined ? { to: input.to, amount: input.amount } : { receivers: input.receivers }),
      ...(input.payment === undefined ? {} : { payment: input.payment }) } as Intent;
  } else {
    if (first.family === "tbc20" && input.receivers !== undefined && input.receivers.length > 1) {
      if (input.receivers.length > 5 || input.payment !== undefined) throw new Error("Historical FT supports at most five receivers without an attached payment");
      return Object.freeze({ intent: Object.freeze({ type: "tbc.ft.transfer", version: "1.0", contractId: input.contractId,
        receivers: input.receivers }), recognition: first });
    }
    const receiver = input.receivers === undefined ? { to: input.to, amount: input.amount } : input.receivers[0]!;
    if (input.receivers !== undefined && input.receivers.length !== 1) throw new Error("Historical fungible builder does not support multiple receivers");
    if (input.payment !== undefined && input.payment.to !== receiver.to) throw new Error("Historical attached TBC recipient must equal the token recipient");
    intent = { type: first.family === "tbc20" ? "tbc.ft.transfer" : "tbc.stablecoin.transfer", version: "1.0", contractId: input.contractId,
      to: receiver.to, amount: receiver.amount,
      ...(input.payment === undefined ? {} : { attachedTbcAmount: input.payment.amount }) };
  }
  return Object.freeze({ intent: Object.freeze(intent), recognition: first });
}
