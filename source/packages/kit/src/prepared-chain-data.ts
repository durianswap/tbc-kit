import type { KitSupportedIntent, KitTransactionRequest } from "./public-types.js";
import { chainDataRequirement } from "@tbc-wallet/core";

interface AssetRequirement {
  readonly kind: "native" | "collection" | "nft" | "ft" | "stablecoin" | "pool" | "ftlp" | "timelock" | "htlc" | "lop";
  readonly contractId?: string;
  readonly contractDependency?: Readonly<{
    relation: "pool-ft" | "pool-lp";
    contractId: string;
  }>;
  readonly minimumAmount?: string;
}

function native(minimumAmount?: string): AssetRequirement {
  return Object.freeze({ kind: "native" as const, ...(minimumAmount === undefined ? {} : { minimumAmount }) });
}

function direct(kind: AssetRequirement["kind"], contractId: string, minimumAmount?: string): AssetRequirement {
  return Object.freeze({ kind, contractId, ...(minimumAmount === undefined ? {} : { minimumAmount }) });
}

function dependent(
  kind: AssetRequirement["kind"],
  relation: "pool-ft" | "pool-lp",
  contractId: string,
  minimumAmount?: string,
): AssetRequirement {
  return Object.freeze({
    kind,
    contractDependency: Object.freeze({ relation, contractId }),
    ...(minimumAmount === undefined ? {} : { minimumAmount }),
  });
}

function required(value: string | undefined, field: string): string {
  if (value === undefined) throw new TypeError(`transaction intent is missing ${field}`);
  return value;
}

/** Exact projection of Core requirements for the intent families exposed by Kit. */
export function preparedChainDataRequirement(request: KitTransactionRequest<KitSupportedIntent>): Readonly<{
  intentType: string;
  includeAncestry: boolean;
  contractIds?: readonly string[];
  nativeAmount?: string;
  lopAssets?: readonly Readonly<{ standard: "tbc20-standard" | "tbc20-stablecoin"; contractId: string; purpose: "identity" | "escrow" }>[];
  collectionSlots?: readonly number[];
  targetOutpoints?: readonly Readonly<{ txid: string; vout: number }>[];
  certificateOutpoint?: Readonly<{ txid: string; vout: number }>;
  inputOutpoints?: readonly Readonly<{ readonly txid: string; readonly vout: number }>[];
  assets: readonly AssetRequirement[];
}> {
  const intent = request.intent;
  if (intent.type === "tbc721.batchTransfer") return chainDataRequirement(request);
  if (intent.type.startsWith("tbc20Lp.") || ["amm.mergeToken", "amm.swap", "amm.addLiquidity", "amm.removeLiquidity", "tbc721.transfer", "tbc20.transfer", "tbc20.merge", "tbc20Stablecoin.transfer", "tbc20Stablecoin.merge"].includes(intent.type)) {
    return chainDataRequirement(request);
  }
  // New AMM/LP DApp and wallet requests use exactly the Core projection.
  // No separate read-selection policy in Prepared or a wallet-specific loader.
  if (intent.type.startsWith("tbc-amm-") || intent.type.startsWith("tbc20-lp-") || intent.type.startsWith("tbc-timelock-") || intent.type.startsWith("tbc-htlc-") || intent.type.startsWith("tbc-lop-")) {
    return chainDataRequirement(request);
  }
  const newStandardInputs = (!intent.type.startsWith("tbc20-standard-") && !intent.type.startsWith("tbc721-standard-") && !intent.type.startsWith("tbc20-stablecoin-")) || request.constraints?.inputOutpoints === undefined ? {} : {
    inputOutpoints: Object.freeze(request.constraints.inputOutpoints.map(({ txid, vout }) => Object.freeze({ txid, vout }))),
  };
  switch (intent.type) {
    case "tbc.transfer":
      return Object.freeze({
        intentType: intent.type,
        includeAncestry: false,
        nativeAmount: intent.amount,
        ...(request.constraints?.inputOutpoints === undefined
          ? {}
          : {
              inputOutpoints: Object.freeze(request.constraints.inputOutpoints.map((outpoint) =>
                Object.freeze({ txid: outpoint.txid, vout: outpoint.vout })
              )),
            }),
        assets: Object.freeze([native(intent.amount)]),
      });
    case "tbc.maintenance.merge":
      return Object.freeze({ intentType: intent.type, includeAncestry: false, assets: Object.freeze([native()]),
        ...(request.constraints?.inputOutpoints === undefined ? {} : {
          inputOutpoints: Object.freeze(request.constraints.inputOutpoints.map(point => Object.freeze({ ...point }))),
        }),
      });
    case "tbc.collection.create":
    case "tbc.ft.create":
      return Object.freeze({ intentType: intent.type, includeAncestry: false, assets: Object.freeze([native()]) });
    case "tbc20-standard-create":
    case "tbc20-stablecoin-create":
    case "tbc721-standard-create-collection":
      return Object.freeze({ intentType: intent.type, includeAncestry: false, ...newStandardInputs, assets: Object.freeze([native()]) });
    case "tbc721-standard-mint":
    case "tbc721-standard-batch-mint": {
      const slots = intent.type === "tbc721-standard-mint" ? [intent.slot] : intent.items.map(item => item.slot);
      if (slots.length < 1 || slots.length > 100 || new Set(slots).size !== slots.length ||
          slots.some(slot => !Number.isSafeInteger(slot) || slot < 1 || slot > 0xffff_ffff)) throw new TypeError("invalid NFT mint slots");
      return Object.freeze({ intentType: intent.type, includeAncestry: true, ...newStandardInputs,
        contractIds: Object.freeze([intent.collectionId]), collectionSlots: Object.freeze(slots),
        assets: Object.freeze([native(), direct("collection", intent.collectionId, String(slots.length))]) });
    }
    case "tbc20-stablecoin-mint":
    case "tbc20-stablecoin-freeze":
    case "tbc20-stablecoin-unfreeze":
      return Object.freeze({ intentType: intent.type, includeAncestry: true, ...newStandardInputs,
        contractIds: Object.freeze([intent.contractId]),
        ...(intent.type === "tbc20-stablecoin-mint"
          ? intent.certificateOutpoint === undefined ? {} : { certificateOutpoint: Object.freeze({ ...intent.certificateOutpoint }) }
          : { targetOutpoints: Object.freeze(intent.targetOutpoints.map(point => Object.freeze({ ...point }))) }),
        assets: Object.freeze([native(), direct("stablecoin", intent.contractId)]) });
    case "tbc721-standard-transfer": {
      const nativeAmount = intent.payment?.amount;
      return Object.freeze({ intentType: intent.type, includeAncestry: true, ...newStandardInputs,
        contractIds: Object.freeze([intent.contractId]), ...(nativeAmount === undefined ? {} : { nativeAmount }),
        assets: Object.freeze([native(nativeAmount), direct("nft", intent.contractId, "1")]) });
    }
    case "tbc.nft.mint":
      return Object.freeze({ intentType: intent.type, includeAncestry: true, contractIds: Object.freeze([intent.collectionId]), assets: Object.freeze([native(), direct("collection", intent.collectionId, "1")]) });
    case "tbc.nft.transfer":
      return Object.freeze({ intentType: intent.type, includeAncestry: true, contractIds: Object.freeze([intent.contractId]), assets: Object.freeze([native(), direct("nft", intent.contractId, "1")]) });
    case "tbc.ft.transfer":
    case "tbc.stablecoin.transfer": {
      const nativeAmount = intent.attachedTbcAmount === undefined || intent.attachedTbcAmount === "0"
        ? undefined
        : intent.attachedTbcAmount;
      return Object.freeze({
        intentType: intent.type,
        includeAncestry: true,
        contractIds: Object.freeze([intent.contractId]),
        ...(nativeAmount === undefined ? {} : { nativeAmount }),
        assets: Object.freeze([native(nativeAmount), direct(intent.type === "tbc.ft.transfer" ? "ft" : "stablecoin", intent.contractId,
          intent.type === "tbc.ft.transfer" && intent.receivers !== undefined
            ? intent.receivers.reduce((total, receiver) => total + BigInt(receiver.amount), 0n).toString()
            : required(intent.amount, "amount"))]),
      });
    }
    case "tbc20-standard-transfer":
    case "tbc20-stablecoin-transfer": {
      const coin = intent.type === "tbc20-stablecoin-transfer";
      let amount = intent.amount;
      if (intent.receivers !== undefined) {
        if (intent.to !== undefined || intent.amount !== undefined || intent.receivers.length < 1 || intent.receivers.length > (coin || intent.payment !== undefined ? 7 : 8)) {
          throw new TypeError("invalid mutually exclusive TBC20 receivers");
        }
        let total = 0n;
        for (const receiver of intent.receivers) {
          if (!/^[1-9][0-9]{0,38}$/u.test(receiver.amount)) throw new TypeError("invalid TBC20 receiver amount");
          total += BigInt(receiver.amount);
        }
        if (total > 36n * ((1n << 63n) - 1n)) throw new TypeError("TBC20 receivers exceed the allocation bound");
        amount = total.toString();
      }
      const nativeAmount = intent.payment?.amount;
      return Object.freeze({
        intentType: intent.type,
        ...newStandardInputs,
        includeAncestry: true,
        contractIds: Object.freeze([intent.contractId]),
        ...(nativeAmount === undefined ? {} : { nativeAmount }),
        assets: Object.freeze([native(nativeAmount), direct(coin ? "stablecoin" : "ft", intent.contractId, required(amount, "amount"))]),
      });
    }
    case "tbc20-standard-merge":
    case "tbc20-stablecoin-merge":
      return Object.freeze({
        intentType: intent.type,
        ...newStandardInputs,
        includeAncestry: true,
        contractIds: Object.freeze([intent.contractId]),
        assets: Object.freeze([native(), direct(intent.type === "tbc20-stablecoin-merge" ? "stablecoin" : "ft", intent.contractId)]),
      });
    case "tbc.ft.merge":
      return Object.freeze({
        intentType: intent.type,
        includeAncestry: true,
        contractIds: Object.freeze([intent.contractId]),
        assets: Object.freeze([native(), direct("ft", intent.contractId)]),
      });
    case "tbc.stablecoin.merge":
      return Object.freeze({
        intentType: intent.type,
        includeAncestry: true,
        contractIds: Object.freeze([intent.contractId]),
        assets: Object.freeze([native(), direct("stablecoin", intent.contractId)]),
      });
    case "tbc.pool.create": {
      if (intent.stage === "mint") {
        const ftContractId = required(intent.ftContractId, "ftContractId");
        return Object.freeze({
          intentType: intent.type,
          includeAncestry: true,
          contractIds: Object.freeze([ftContractId]),
          assets: Object.freeze([native(), direct("ft", ftContractId)]),
        });
      }
      if (intent.stage !== "initialize" || intent.initialLiquidity === undefined) {
        throw new TypeError("prepared Pool create requires mint or initialize stage");
      }
      const poolId = required(intent.poolContractId, "poolContractId");
      return Object.freeze({
        intentType: intent.type,
        includeAncestry: true,
        contractIds: Object.freeze([poolId]),
        nativeAmount: intent.initialLiquidity.tbcAmount,
        assets: Object.freeze([
          native(intent.initialLiquidity.tbcAmount),
          direct("pool", poolId),
          dependent("ft", "pool-ft", poolId, intent.initialLiquidity.ftAmount),
        ]),
      });
    }
    case "tbc.pool.liquidity.add":
      return Object.freeze({
        intentType: intent.type,
        includeAncestry: true,
        contractIds: Object.freeze([intent.poolContractId]),
        nativeAmount: intent.tbcAmount,
        assets: Object.freeze([native(intent.tbcAmount), direct("pool", intent.poolContractId), dependent("ft", "pool-ft", intent.poolContractId)]),
      });
    case "tbc.pool.liquidity.remove":
      return Object.freeze({
        intentType: intent.type,
        includeAncestry: true,
        contractIds: Object.freeze([intent.poolContractId]),
        assets: Object.freeze([native(), direct("pool", intent.poolContractId), dependent("ftlp", "pool-lp", intent.poolContractId, intent.lpAmount)]),
      });
    case "tbc.pool.ft.merge":
      return Object.freeze({
        intentType: intent.type,
        includeAncestry: true,
        contractIds: Object.freeze([intent.poolContractId]),
        assets: Object.freeze([native(), direct("pool", intent.poolContractId), dependent("ft", "pool-ft", intent.poolContractId)]),
      });
    case "tbc.pool.ftlp.merge":
    case "tbc.pool.ftlp.burn":
      return Object.freeze({
        intentType: intent.type,
        includeAncestry: true,
        contractIds: Object.freeze([intent.poolContractId]),
        assets: Object.freeze([native(), direct("pool", intent.poolContractId), dependent("ftlp", "pool-lp", intent.poolContractId)]),
      });
    case "tbc.pool.swap.exactTbcForToken":
      return Object.freeze({
        intentType: intent.type,
        includeAncestry: true,
        contractIds: Object.freeze([intent.poolContractId]),
        nativeAmount: intent.tbcAmount,
        assets: Object.freeze([native(intent.tbcAmount), direct("pool", intent.poolContractId), dependent("ft", "pool-ft", intent.poolContractId)]),
      });
    case "tbc.pool.swap.exactTokenForTbc":
      return Object.freeze({
        intentType: intent.type,
        includeAncestry: true,
        contractIds: Object.freeze([intent.poolContractId]),
        assets: Object.freeze([native(), direct("pool", intent.poolContractId), dependent("ft", "pool-ft", intent.poolContractId, intent.ftAmount)]),
      });
    default:
      throw new TypeError("unsupported prepared transaction intent");
  }
}
