import { TwsEngineError } from "../errors.js";

interface ContractDependency {
  readonly relation: "pool-ft" | "pool-lp";
  readonly contractId: string;
}

interface AssetRequirement {
  readonly kind: "native" | "collection" | "nft" | "ft" | "stablecoin" | "pool" | "ftlp" | "timelock" | "htlc" | "lop";
  readonly contractId?: string;
  readonly contractDependency?: ContractDependency;
  readonly minimumAmount?: string;
}

interface TransactionIntent {
  readonly type: string;
  readonly order?: Readonly<{
    side: "buy" | "sell"; market: "native-token" | "token-token";
    assetA: Readonly<{ standard: "tbc20-standard" | "tbc20-stablecoin"; contractId: string }>;
    assetB?: Readonly<{ standard: "tbc20-standard" | "tbc20-stablecoin"; contractId: string }>;
    saleVolume: string; unitPrice: string;
  }>;
  readonly stage?: "mint" | "initialize";
  readonly amount?: string;
  readonly to?: string;
  readonly receivers?: readonly Readonly<{ to: string; amount: string }>[];
  readonly slot?: number;
  readonly items?: readonly Readonly<{ slot: number }>[];
  readonly transfers?: readonly Readonly<{ contractId: string; to: string; payment?: Readonly<{ to: string; amount: string }> }>[];
  readonly payment?: Readonly<{ to: string; amount: string }>;
  readonly targetOutpoints?: readonly Readonly<{ txid: string; vout: number }>[];
  readonly certificateOutpoint?: Readonly<{ txid: string; vout: number }>;
  readonly attachedTbcAmount?: string;
  readonly collectionId?: string;
  readonly contractId?: string;
  readonly ftContractId?: string;
  readonly assetStandard?: "tbc20-standard" | "tbc20-stablecoin";
  readonly poolContractId?: string;
  readonly tbcAmount?: string;
  readonly ftAmount?: string;
  readonly lpAmount?: string;
  readonly direction?: "tbc-to-ft" | "ft-to-tbc";
  readonly budgetAsset?: "tbc" | "ft";
  readonly initialFtAmount?: string;
  readonly initialLiquidity?: {
    readonly tbcAmount: string;
    readonly ftAmount: string;
  };
}

export interface TransactionRequestLike {
  readonly intent: TransactionIntent;
  readonly constraints?: {
    readonly inputOutpoints?: readonly Readonly<{
      readonly txid: string;
      readonly vout: number;
    }>[];
  };
}

export interface ChainDataRequirement {
  readonly intentType: string;
  readonly includeAncestry: boolean;
  readonly contractIds?: readonly string[];
  readonly nativeAmount?: string;
  /** Identity-only assets must not trigger account balance/UTXO scans. Order
   * of this list is A then B; it is a read plan, never authorization evidence. */
  readonly lopAssets?: readonly Readonly<{ standard: "tbc20-standard" | "tbc20-stablecoin"; contractId: string; purpose: "identity" | "escrow" }>[];
  readonly collectionSlots?: readonly number[];
  readonly targetOutpoints?: readonly Readonly<{ txid: string; vout: number }>[];
  readonly certificateOutpoint?: Readonly<{ txid: string; vout: number }>;
  readonly inputOutpoints?: readonly Readonly<{
    readonly txid: string;
    readonly vout: number;
  }>[];
  readonly assets: readonly AssetRequirement[];
}

function requireString(value: string | undefined, field: string): string {
  if (value === undefined) {
    throw new TwsEngineError(
      "ENGINE_INPUT_INVALID",
      `transaction intent is missing ${field}`,
    );
  }
  return value;
}

function native(minimumAmount?: string): AssetRequirement {
  return Object.freeze({
    kind: "native" as const,
    ...(minimumAmount === undefined ? {} : { minimumAmount }),
  });
}

function direct(
  kind: AssetRequirement["kind"],
  contractId: string,
  minimumAmount?: string,
): AssetRequirement {
  return Object.freeze({
    kind,
    contractId,
    ...(minimumAmount === undefined ? {} : { minimumAmount }),
  });
}

function dependent(
  kind: AssetRequirement["kind"],
  relation: ContractDependency["relation"],
  contractId: string,
  minimumAmount?: string,
): AssetRequirement {
  return Object.freeze({
    kind,
    contractDependency: Object.freeze({ relation, contractId }),
    ...(minimumAmount === undefined ? {} : { minimumAmount }),
  });
}

export function chainDataRequirement(
  request: TransactionRequestLike,
): ChainDataRequirement {
  const intent = request.intent;
  const base = {
    intentType: intent.type,
    assets: [] as AssetRequirement[],
    contractIds: [] as string[],
    nativeAmount: undefined as string | undefined,
    lopAssets: undefined as ChainDataRequirement["lopAssets"],
    collectionSlots: undefined as readonly number[] | undefined,
    includeAncestry: intent.type !== "tbc.transfer" && intent.type !== "tbc.maintenance.merge",
  };

  switch (intent.type) {
    case "tbc-lop-create": {
      const order = intent.order;
      if (!order || !["buy", "sell"].includes(order.side) || !["native-token", "token-token"].includes(order.market) ||
          (order.market === "token-token") !== (order.assetB !== undefined) ||
          !/^[1-9][0-9]{0,18}$/u.test(order.saleVolume) || !/^[1-9][0-9]{0,18}$/u.test(order.unitPrice)) {
        throw new TwsEngineError("ENGINE_INPUT_INVALID", "invalid LOP material terms");
      }
      const assets = [order.assetA, ...(order.assetB === undefined ? [] : [order.assetB])];
      if (assets.some(asset => !asset || !["tbc20-standard", "tbc20-stablecoin"].includes(asset.standard) || !/^[0-9a-f]{64}$/u.test(asset.contractId)) ||
          new Set(assets.map(asset => asset.contractId)).size !== assets.length ||
          BigInt(order.saleVolume) > 0x7fff_ffff_ffff_ffffn || BigInt(order.unitPrice) > 0x7fff_ffff_ffff_ffffn) {
        throw new TwsEngineError("ENGINE_INPUT_INVALID", "invalid LOP material assets or range");
      }
      const nativeSell = order.market === "native-token" && order.side === "sell";
      const selected = nativeSell ? undefined : order.side === "buy" ? order.assetB ?? order.assetA : order.assetA;
      const amount = order.side === "sell" ? BigInt(order.saleVolume) : BigInt(order.saleVolume) * BigInt(order.unitPrice) / 1_000_000n;
      if (amount === 0n || (!nativeSell && amount > 0x7fff_ffff_ffff_ffffn)) throw new TwsEngineError("ENGINE_INPUT_INVALID", "LOP escrow outside spendable range");
      base.nativeAmount = nativeSell ? String(amount) : undefined;
      base.assets.push(native(base.nativeAmount));
      if (selected) base.assets.push(direct(selected.standard === "tbc20-standard" ? "ft" : "stablecoin", selected.contractId, String(amount)));
      base.contractIds.push(...assets.map(asset => asset.contractId));
      base.lopAssets = Object.freeze(assets.map(asset => Object.freeze({ standard: asset.standard, contractId: asset.contractId,
        purpose: asset.contractId === selected?.contractId ? "escrow" as const : "identity" as const })));
      break;
    }
    case "tbc-lop-cancel":
    case "tbc-lop-match": {
      const points = intent.targetOutpoints, count = intent.type === "tbc-lop-cancel" ? 1 : 2;
      if (!points || points.length !== count || points.some(p => !/^[0-9a-f]{64}$/u.test(p.txid) || !Number.isSafeInteger(p.vout) || p.vout < 0 || p.vout > 0xffff_ffff) ||
          new Set(points.map(p => `${p.txid}:${p.vout}`)).size !== count) throw new TwsEngineError("ENGINE_INPUT_INVALID", "LOP requires exact ordered targets");
      base.assets.push(native(), Object.freeze({ kind: "lop" }));
      break;
    }
    case "tbc.transfer":
    case "tbc-timelock-lock":
      base.nativeAmount = requireString(intent.amount, "amount");
      base.assets.push(native(base.nativeAmount));
      base.includeAncestry = false;
      break;
    case "tbc-timelock-unlock":
      base.assets.push(Object.freeze({ kind: "timelock" }));
      break;
    case "tbc-htlc-claim":
    case "tbc-htlc-refund":
    case "tbc-htlc-lock":
      if (intent.assetStandard !== undefined) {
        const contractId = requireString(intent.contractId, "contractId");
        base.contractIds.push(contractId);
        base.assets.push(Object.freeze({ kind: intent.assetStandard === "tbc20-standard" ? "ft" : "stablecoin", contractId,
          ...(intent.type === "tbc-htlc-lock" ? { minimumAmount: requireString(intent.amount, "amount") } : {}) }));
        base.assets.push(native());
        if (intent.type !== "tbc-htlc-lock") base.assets.push(Object.freeze({ kind: "htlc" }));
      } else if (intent.type === "tbc-htlc-lock") {
        base.nativeAmount = requireString(intent.amount, "amount");
        base.assets.push(native(base.nativeAmount)); base.includeAncestry = false;
      } else base.assets.push(Object.freeze({ kind: "htlc" }));
      break;
    case "tbc.maintenance.merge":
      base.assets.push(native());
      base.includeAncestry = false;
      break;
    case "tbc.collection.create":
    case "tbc.ft.create":
    case "tbc20-standard-create":
    case "tbc20-stablecoin-create":
    case "tbc721-standard-create-collection":
      base.assets.push(native());
      base.includeAncestry = false;
      break;
    case "tbc721-standard-mint":
    case "tbc721-standard-batch-mint": {
      const contractId = requireString(intent.collectionId, "collectionId");
      const slots = intent.type === "tbc721-standard-mint" ? [intent.slot!] : intent.items?.map((item) => item.slot);
      if (slots === undefined || slots.length < 1 || slots.length > 100 || new Set(slots).size !== slots.length ||
          slots.some((slot) => !Number.isSafeInteger(slot) || slot < 1 || slot > 0xffff_ffff)) {
        throw new TwsEngineError("ENGINE_INPUT_INVALID", "invalid NFT mint slots");
      }
      base.collectionSlots = Object.freeze(slots);
      base.contractIds.push(contractId);
      base.assets.push(native(), direct("collection", contractId, String(slots.length)));
      break;
    }
    case "tbc20-stablecoin-mint":
    case "tbc20-stablecoin-freeze":
    case "tbc20-stablecoin-unfreeze": {
      const contractId = requireString(intent.contractId, "contractId");
      base.contractIds.push(contractId);
      base.assets.push(native(), direct("stablecoin", contractId));
      break;
    }
    case "tbc721.batchTransfer": {
      const items = intent.transfers;
      if (items === undefined || items.length < 1 || items.length > 100 || new Set(items.map(item => item.contractId)).size !== items.length) {
        throw new TwsEngineError("ENGINE_INPUT_INVALID", "invalid or duplicate NFT batch targets");
      }
      const payments = items.filter(item => item.payment !== undefined);
      if (payments.length > 0) base.nativeAmount = payments.reduce((sum, item) => sum + BigInt(item.payment!.amount), 0n).toString();
      base.assets.push(native(base.nativeAmount));
      for (const item of items) { base.contractIds.push(item.contractId); base.assets.push(direct("nft", item.contractId, "1")); }
      break;
    }
    case "tbc721.transfer":
    case "tbc721-standard-transfer": {
      const contractId = requireString(intent.contractId, "contractId");
      base.nativeAmount = intent.payment?.amount;
      base.contractIds.push(contractId);
      base.assets.push(native(base.nativeAmount), direct("nft", contractId, "1"));
      break;
    }
    case "tbc.nft.mint": {
      const contractId = requireString(intent.collectionId, "collectionId");
      base.contractIds.push(contractId);
      base.assets.push(native(), direct("collection", contractId, "1"));
      break;
    }
    case "tbc.nft.transfer": {
      const contractId = requireString(intent.contractId, "contractId");
      base.contractIds.push(contractId);
      base.assets.push(native(), direct("nft", contractId, "1"));
      break;
    }
    case "tbc20-standard-transfer":
    case "tbc20.transfer":
    case "tbc20Stablecoin.transfer":
    case "tbc20-stablecoin-transfer": {
      const coin = intent.type === "tbc20-stablecoin-transfer" || intent.type === "tbc20Stablecoin.transfer";
      const contractId = requireString(intent.contractId, "contractId");
      let amount = requireString(intent.receivers === undefined ? intent.amount : "0", "amount");
      if (intent.receivers !== undefined) {
        if (intent.to !== undefined || intent.amount !== undefined || intent.receivers.length < 1 || intent.receivers.length > (coin || intent.payment !== undefined ? 7 : 8)) {
          throw new TwsEngineError("ENGINE_INPUT_INVALID", "invalid mutually exclusive TBC20 receivers");
        }
        let total = 0n;
        for (const receiver of intent.receivers) {
          if (!/^[1-9][0-9]{0,38}$/u.test(receiver.amount)) throw new TwsEngineError("ENGINE_INPUT_INVALID", "invalid TBC20 receiver amount");
          total += BigInt(receiver.amount);
        }
        if (total > 36n * ((1n << 63n) - 1n)) throw new TwsEngineError("ENGINE_INPUT_INVALID", "TBC20 receivers exceed the allocation bound");
        amount = total.toString();
      }
      base.contractIds.push(contractId);
      base.nativeAmount = intent.payment?.amount;
      base.assets.push(native(base.nativeAmount), direct(coin ? "stablecoin" : "ft", contractId, amount));
      break;
    }
    case "tbc.ft.transfer":
    case "tbc.stablecoin.transfer": {
      const contractId = requireString(intent.contractId, "contractId");
      const amount = intent.type === "tbc.ft.transfer" && intent.receivers !== undefined
        ? intent.receivers.reduce((total, receiver) => total + BigInt(receiver.amount), 0n).toString()
        : requireString(intent.amount, "amount");
      const attached = intent.attachedTbcAmount;
      base.contractIds.push(contractId);
      base.nativeAmount = attached === undefined || attached === "0" ? undefined : attached;
      base.assets.push(
        native(base.nativeAmount),
        direct(intent.type === "tbc.ft.transfer" ? "ft" : "stablecoin", contractId, amount),
      );
      break;
    }
    case "tbc.ft.merge":
    case "tbc20.merge":
    case "tbc20-standard-merge": {
      const contractId = requireString(intent.contractId, "contractId");
      base.contractIds.push(contractId);
      base.assets.push(native(), direct("ft", contractId));
      break;
    }
    case "tbc.stablecoin.merge":
    case "tbc20Stablecoin.merge":
    case "tbc20-stablecoin-merge": {
      const contractId = requireString(intent.contractId, "contractId");
      base.contractIds.push(contractId);
      base.assets.push(native(), direct("stablecoin", contractId));
      break;
    }
    case "tbc-amm-create": {
      base.contractIds.push(requireString(intent.ftContractId, "ftContractId"));
      // Read immutable FT genesis/source identity, not the creator's FT balance.
      // Empty Pool creation consumes only native funding.
      base.assets.push(native());
      break;
    }
    case "amm.addLiquidity":
    case "tbc-amm-add-liquidity": {
      const poolId = requireString(intent.poolContractId, "poolContractId");
      const amount = requireString(intent.amount, "amount");
      base.contractIds.push(poolId);
      if (intent.budgetAsset !== "tbc" && intent.budgetAsset !== "ft")
        throw new TwsEngineError("ENGINE_INPUT_INVALID", "AMM budgetAsset is invalid");
      const nativeAmount = intent.budgetAsset === "tbc" ? amount : undefined;
      const ftAmount = intent.budgetAsset === "ft" ? amount : intent.initialFtAmount;
      if (nativeAmount !== undefined) base.nativeAmount = nativeAmount;
      base.assets.push(native(nativeAmount), direct("pool", poolId), dependent("ft", "pool-ft", poolId, ftAmount));
      break;
    }
    case "amm.removeLiquidity":
    case "tbc-amm-remove-liquidity": {
      const poolId = requireString(intent.poolContractId, "poolContractId");
      base.contractIds.push(poolId);
      base.assets.push(native(), direct("pool", poolId), dependent("ftlp", "pool-lp", poolId, requireString(intent.lpAmount, "lpAmount")));
      break;
    }
    case "amm.swap":
    case "tbc-amm-swap": {
      const poolId = requireString(intent.poolContractId, "poolContractId");
      const amount = requireString(intent.amount, "amount");
      if (intent.direction !== "tbc-to-ft" && intent.direction !== "ft-to-tbc")
        throw new TwsEngineError("ENGINE_INPUT_INVALID", "AMM swap direction is invalid");
      base.contractIds.push(poolId);
      const buy = intent.direction === "tbc-to-ft";
      if (buy) base.nativeAmount = amount;
      base.assets.push(native(buy ? amount : undefined), direct("pool", poolId));
      // The Pool requirement supplies Pool-owned FT; only sells need holder FT.
      if (!buy) base.assets.push(dependent("ft", "pool-ft", poolId, amount));
      break;
    }
    case "tbc20Lp.transfer":
    case "tbc20Lp.lock":
    case "tbc20Lp.merge":
    case "tbc20Lp.unlock":
    case "tbc20Lp.burn":
    case "tbc20-lp-transfer":
    case "tbc20-lp-lock":
    case "tbc20-lp-merge":
    case "tbc20-lp-unlock": {
      const poolId = requireString(intent.poolContractId, "poolContractId");
      const amount = ["tbc20-lp-transfer", "tbc20-lp-lock", "tbc20Lp.transfer", "tbc20Lp.lock"].includes(intent.type)
        ? requireString(intent.amount, "amount") : undefined;
      base.contractIds.push(poolId);
      // LP holder transactions bind immutable genesis identity and LP ancestry.
      // They do not consume the current Pool or require its mutable reserves.
      base.assets.push(native(), direct("ftlp", poolId, amount));
      break;
    }
    case "tbc.pool.create": {
      if (intent.stage === "mint") {
        const contractId = requireString(intent.ftContractId, "ftContractId");
        base.contractIds.push(contractId);
        base.assets.push(native(), direct("ft", contractId));
        break;
      }
      const liquidity = intent.initialLiquidity;
      if (liquidity === undefined) {
        throw new TwsEngineError(
          "ENGINE_INPUT_INVALID",
          "pool create intent is missing initialLiquidity",
        );
      }
      if (intent.stage === "initialize") {
        const poolId = requireString(intent.poolContractId, "poolContractId");
        base.contractIds.push(poolId);
        base.nativeAmount = liquidity.tbcAmount;
        base.assets.push(
          native(liquidity.tbcAmount),
          direct("pool", poolId),
          dependent("ft", "pool-ft", poolId, liquidity.ftAmount),
        );
        break;
      }
      const contractId = requireString(intent.ftContractId, "ftContractId");
      base.contractIds.push(contractId);
      base.nativeAmount = liquidity.tbcAmount;
      base.assets.push(
        native(liquidity.tbcAmount),
        direct("ft", contractId, liquidity.ftAmount),
      );
      break;
    }
    case "tbc.pool.liquidity.add": {
      const poolId = requireString(intent.poolContractId, "poolContractId");
      const amount = requireString(intent.tbcAmount, "tbcAmount");
      base.contractIds.push(poolId);
      base.nativeAmount = amount;
      base.assets.push(
        native(amount),
        direct("pool", poolId),
        dependent("ft", "pool-ft", poolId),
      );
      break;
    }
    case "tbc.pool.liquidity.remove": {
      const poolId = requireString(intent.poolContractId, "poolContractId");
      base.contractIds.push(poolId);
      base.assets.push(
        native(),
        direct("pool", poolId),
        dependent(
          "ftlp",
          "pool-lp",
          poolId,
          requireString(intent.lpAmount, "lpAmount"),
        ),
      );
      break;
    }
    case "tbc.pool.liquidity.close": {
      const poolId = requireString(intent.poolContractId, "poolContractId");
      base.contractIds.push(poolId);
      base.assets.push(
        native(),
        direct("pool", poolId),
        dependent("ftlp", "pool-lp", poolId),
      );
      break;
    }
    case "amm.mergeToken":
    case "tbc.pool.ft.merge": {
      const poolId = requireString(intent.poolContractId, "poolContractId");
      base.contractIds.push(poolId);
      base.assets.push(
        native(),
        direct("pool", poolId),
        dependent("ft", "pool-ft", poolId),
      );
      break;
    }
    case "tbc.pool.ftlp.merge":
    case "tbc.pool.ftlp.burn": {
      const poolId = requireString(intent.poolContractId, "poolContractId");
      base.contractIds.push(poolId);
      base.assets.push(
        native(),
        direct("pool", poolId),
        dependent("ftlp", "pool-lp", poolId),
      );
      break;
    }
    case "tbc.pool.swap.exactTbcForToken": {
      const poolId = requireString(intent.poolContractId, "poolContractId");
      const amount = requireString(intent.tbcAmount, "tbcAmount");
      base.contractIds.push(poolId);
      base.nativeAmount = amount;
      base.assets.push(
        native(amount),
        direct("pool", poolId),
        dependent("ft", "pool-ft", poolId),
      );
      break;
    }
    case "tbc.pool.swap.exactTokenForTbc": {
      const poolId = requireString(intent.poolContractId, "poolContractId");
      base.contractIds.push(poolId);
      base.assets.push(
        native(),
        direct("pool", poolId),
        dependent(
          "ft",
          "pool-ft",
          poolId,
          requireString(intent.ftAmount, "ftAmount"),
        ),
      );
      break;
    }
    default:
      throw new TwsEngineError(
        "ENGINE_INPUT_INVALID",
        `unsupported transaction intent for chain-data resolution: ${intent.type}`,
      );
  }

  return Object.freeze({
    intentType: base.intentType,
    includeAncestry: base.includeAncestry,
    ...(base.contractIds.length === 0
      ? {}
      : { contractIds: Object.freeze([...new Set(base.contractIds)]) }),
    ...(base.nativeAmount === undefined ? {} : { nativeAmount: base.nativeAmount }),
    ...(base.lopAssets === undefined ? {} : { lopAssets: base.lopAssets }),
    ...(base.collectionSlots === undefined ? {} : { collectionSlots: base.collectionSlots }),
    ...(intent.type === "tbc721.batchTransfer" && request.constraints?.inputOutpoints !== undefined
      ? { inputOutpoints: Object.freeze(request.constraints.inputOutpoints.map(point => Object.freeze({ ...point }))) } : {}),
    ...(intent.targetOutpoints === undefined ? {} : { targetOutpoints: Object.freeze(intent.targetOutpoints.map(point => Object.freeze({ ...point }))) }),
    ...(intent.certificateOutpoint === undefined ? {} : { certificateOutpoint: Object.freeze({ ...intent.certificateOutpoint }) }),
    ...((!["tbc.maintenance.merge", "amm.mergeToken", "tbc20Lp.transfer", "tbc20Lp.lock", "tbc20Lp.unlock", "tbc20Lp.merge", "tbc20Lp.burn", "amm.swap", "amm.addLiquidity", "amm.removeLiquidity", "tbc721.transfer", "tbc20.transfer", "tbc20.merge", "tbc20Stablecoin.transfer", "tbc20Stablecoin.merge", "tbc.transfer", "tbc-timelock-lock", "tbc-timelock-unlock", "tbc-htlc-lock", "tbc-htlc-claim", "tbc-htlc-refund", "tbc-lop-create", "tbc-lop-cancel", "tbc-lop-match", "tbc20-standard-create", "tbc20-standard-transfer", "tbc20-standard-merge", "tbc20-stablecoin-create", "tbc20-stablecoin-transfer", "tbc20-stablecoin-merge", "tbc20-stablecoin-mint", "tbc20-stablecoin-freeze", "tbc20-stablecoin-unfreeze", "tbc20-lp-transfer", "tbc20-lp-merge", "tbc20-lp-lock", "tbc20-lp-unlock", "tbc-amm-create", "tbc-amm-add-liquidity", "tbc-amm-remove-liquidity", "tbc-amm-swap"].includes(intent.type) && !intent.type.startsWith("tbc721-standard-")) || request.constraints?.inputOutpoints === undefined
      ? {}
      : {
          inputOutpoints: Object.freeze(request.constraints.inputOutpoints.map((outpoint) =>
            Object.freeze({ txid: outpoint.txid, vout: outpoint.vout })
          )),
        }),
    assets: Object.freeze(base.assets),
  });
}

function assetKey(asset: AssetRequirement): string {
  return JSON.stringify([
    asset.kind,
    asset.contractId ?? null,
    asset.contractDependency?.relation ?? null,
    asset.contractDependency?.contractId ?? null,
  ]);
}

export function workflowChainDataRequirement(
  requests: readonly TransactionRequestLike[],
): ChainDataRequirement {
  if (requests.length === 0) {
    throw new TwsEngineError(
      "ENGINE_INPUT_INVALID",
      "workflow has no transaction intent",
    );
  }
  const requirements = requests.map(chainDataRequirement);
  // Message/crypto steps have already been separated by the workflow reducer.
  // With one transaction there is nothing to aggregate: preserve all exact
  // selection fields (including NFT mint slots) without another projection.
  if (requirements.length === 1) return requirements[0]!;
  if (requirements.some(item => item.intentType.startsWith("tbc-lop-"))) {
    throw new TwsEngineError("ENGINE_INPUT_INVALID", "LOP composition requires per-step material resolution; aggregate cannot discard ordered targets or asset purposes");
  }
  if (requirements.some(item => ["tbc20-stablecoin-mint", "tbc20-stablecoin-freeze", "tbc20-stablecoin-unfreeze"].includes(item.intentType))) {
    // Do not silently discard exact targets/certificate pins in the generic
    // material union. Multi-business management needs dependency-aware merging.
    throw new TwsEngineError("ENGINE_INPUT_INVALID", "Coin management multi-transaction material composition is not available yet");
  }
  const contractIds = [
    ...new Set(requirements.flatMap((item) => item.contractIds ?? [])),
  ];
  // One collection can supply several independent mint steps. Reuse the same
  // bounded slot loader; this is only the read requirement, not a rewrite of
  // the approved steps, their input constraints, or their signed outputs.
  const collectionSlots = contractIds.length === 1 && requirements.every((item) => item.collectionSlots !== undefined)
    ? requirements.flatMap((item) => item.collectionSlots!)
    : undefined;
  if (collectionSlots !== undefined && (collectionSlots.length > 100 || new Set(collectionSlots).size !== collectionSlots.length)) {
    throw new TwsEngineError("ENGINE_INPUT_INVALID", "workflow mint slots are duplicated or exceed the material budget");
  }
  const assets = new Map<string, AssetRequirement>();
  for (const requirement of requirements) {
    for (const asset of requirement.assets) {
      const key = assetKey(asset);
      const previous = assets.get(key);
      if (previous === undefined) {
        assets.set(key, asset);
      } else if (
        previous.minimumAmount !== undefined &&
        asset.minimumAmount !== undefined
      ) {
        assets.set(
          key,
          Object.freeze({
            ...previous,
            minimumAmount: String(
              BigInt(previous.minimumAmount) + BigInt(asset.minimumAmount),
            ),
          }),
        );
      }
    }
  }
  const nativeAmount = requirements.reduce(
    (sum, item) =>
      sum + (item.nativeAmount === undefined ? 0n : BigInt(item.nativeAmount)),
    0n,
  );
  const inputOutpoints = new Map<string, Readonly<{ readonly txid: string; readonly vout: number }>>();
  for (const requirement of requirements) {
    for (const outpoint of requirement.inputOutpoints ?? []) {
      inputOutpoints.set(`${outpoint.txid}:${outpoint.vout}`, outpoint);
    }
  }
  if (inputOutpoints.size > 128) {
    throw new TwsEngineError(
      "ENGINE_INPUT_INVALID",
      "workflow requests more than 128 explicit input outpoints",
    );
  }
  return Object.freeze({
    intentType: collectionSlots === undefined ? requirements[0]!.intentType : "tbc721-standard-batch-mint",
    ...(collectionSlots === undefined ? {} : { collectionSlots: Object.freeze(collectionSlots) }),
    includeAncestry: requirements.some((item) => item.includeAncestry),
    ...(contractIds.length === 0
      ? {}
      : { contractIds: Object.freeze(contractIds) }),
    ...(nativeAmount === 0n ? {} : { nativeAmount: String(nativeAmount) }),
    ...(inputOutpoints.size === 0 || (collectionSlots !== undefined && requirements.some((item) => item.inputOutpoints === undefined))
      ? {}
      : { inputOutpoints: Object.freeze([...inputOutpoints.values()]) }),
    assets: Object.freeze([...assets.values()]),
  });
}
