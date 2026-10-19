import type { KitSupportedIntent } from "./public-types.js";

/** Library support only, not an automatic wallet declaration or installed
 * platform claim. Wallet composition must declare only its integrated paths.
 * No Engine/WASM, API request, mutable state or account authority is loaded. */
export const TBC_KIT_WALLET_INTENTS = Object.freeze([
  "tbc.transfer", "tbc.maintenance.merge",
  "tbc20.transfer", "tbc20.merge", "tbc20Stablecoin.transfer", "tbc20Stablecoin.merge", "tbc721.transfer",
  "amm.swap", "amm.addLiquidity", "amm.removeLiquidity", "amm.mergeToken",
  "tbc20Lp.transfer", "tbc20Lp.lock", "tbc20Lp.unlock", "tbc20Lp.merge", "tbc20Lp.burn",
  "tbc20-standard-create", "tbc20-standard-transfer", "tbc20-standard-merge",
  "tbc721-standard-create-collection", "tbc721-standard-mint", "tbc721-standard-batch-mint", "tbc721-standard-transfer",
  "tbc20-stablecoin-create", "tbc20-stablecoin-mint", "tbc20-stablecoin-freeze", "tbc20-stablecoin-unfreeze",
  "tbc20-stablecoin-transfer", "tbc20-stablecoin-merge",
  "tbc-amm-create", "tbc-amm-swap", "tbc-amm-add-liquidity", "tbc-amm-remove-liquidity",
  "tbc20-lp-transfer", "tbc20-lp-lock", "tbc20-lp-unlock", "tbc20-lp-merge",
  "tbc-timelock-lock", "tbc-timelock-unlock", "tbc-htlc-lock", "tbc-htlc-claim", "tbc-htlc-refund",
  "tbc-lop-create", "tbc-lop-cancel", "tbc-lop-match",
  "tbc.collection.create", "tbc.nft.transfer", "tbc.ft.transfer", "tbc.ft.merge", "tbc.stablecoin.transfer", "tbc.stablecoin.merge",
  "tbc.pool.liquidity.add", "tbc.pool.liquidity.remove", "tbc.pool.ft.merge", "tbc.pool.ftlp.merge", "tbc.pool.ftlp.burn",
  "tbc.pool.swap.exactTbcForToken", "tbc.pool.swap.exactTokenForTbc",
] as const satisfies readonly KitSupportedIntent["type"][]);

/** Template support of unified holder/maintenance operations. Conditions such
 * as amount range, lock maturity and controller roles still apply. Recognition
 * does not prove origin, ownership, unspentness or wallet authorization. This
 * table is descriptive only: actual routing is independently verified by Engine. */
export const TBC_KIT_UNIFIED_TEMPLATE_SUPPORT = Object.freeze({
  "tbc20-standard": Object.freeze(["tbc20.transfer", "tbc20.merge"] as const),
  "historical-ft-v4": Object.freeze(["tbc20.transfer", "tbc20.merge"] as const),
  "tbc20-stablecoin": Object.freeze(["tbc20Stablecoin.transfer", "tbc20Stablecoin.merge"] as const),
  "historical-stablecoin-v4": Object.freeze(["tbc20Stablecoin.transfer", "tbc20Stablecoin.merge"] as const),
  "tbc721-standard": Object.freeze(["tbc721.transfer"] as const),
  "historical-nft": Object.freeze(["tbc721.transfer"] as const),
  "tbc-amm": Object.freeze(["amm.swap", "amm.addLiquidity", "amm.removeLiquidity",
    "tbc20Lp.transfer", "tbc20Lp.lock", "tbc20Lp.unlock", "tbc20Lp.merge"] as const),
  "historical-pool2": Object.freeze(["amm.swap", "amm.addLiquidity", "amm.removeLiquidity",
    "amm.mergeToken", "tbc20Lp.merge", "tbc20Lp.burn"] as const),
});
