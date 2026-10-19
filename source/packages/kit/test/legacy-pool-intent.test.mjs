import assert from "node:assert/strict";
import test from "node:test";

import { createLegacyPoolIntentResolver } from "../dist/esm/wallet.js";

const CHAIN_ID = "tbc:testnet";
const SOURCE = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const RECEIVER = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
const POOL_ID = "ab".repeat(32);
const FT_ID = "cd".repeat(32);
const BUY_KEY = `02${"11".repeat(32)}`;
const SELL_KEY = `03${"22".repeat(32)}`;

test("Legacy Pool mint and initialize map independently with exact metadata", async () => {
  const metadataReads = [];
  const resolver = createLegacyPoolIntentResolver({
    chainId: CHAIN_ID,
    resolvePoolFtDecimals: async (contractId) => {
      metadataReads.push(contractId);
      return 6;
    },
  });
  const mint = await resolver.resolve({
    flag: "POOLNFT_MINT",
    ft_contract_address: FT_ID.toUpperCase(),
    poolNFT_version: 2,
    serverProvider_tag: "durian",
    serviceFeeRate: 35,
    with_lock: true,
    pubKeyLock: [BUY_KEY, SELL_KEY],
    lpCostAddress: RECEIVER,
    lpCostAmount: 1,
    lpPlan: 1,
    broadcastEnabled: false,
  }, SOURCE);
  assert.match(mint.clientRequestId, /^legacy-pool-create-mint:[0-9a-f]{64}$/u);
  assert.deepEqual(mint.intent, {
    version: "1.0",
    type: "tbc.pool.create",
    stage: "mint",
    ftContractId: FT_ID,
    lpPlan: 1,
    serviceProviderTag: "durian",
    lock: {
      publicKeys: [BUY_KEY, SELL_KEY],
      costRecipient: RECEIVER,
      costAmount: "1000000",
    },
  });
  const initialize = await resolver.resolve({
    flag: "POOLNFT_INIT",
    nft_contract_address: POOL_ID.toUpperCase(),
    address: RECEIVER,
    tbc_amount: 10,
    ft_amount: 2.5,
    poolNFT_version: 2,
    lockTime: 0,
    broadcastEnabled: false,
  }, SOURCE);
  assert.match(initialize.clientRequestId, /^legacy-pool-create-initialize:[0-9a-f]{64}$/u);
  assert.deepEqual(initialize.intent, {
    version: "1.0",
    type: "tbc.pool.create",
    stage: "initialize",
    poolContractId: POOL_ID,
    initialLiquidity: {
      receiver: RECEIVER,
      tbcAmount: "10000000",
      ftAmount: "2500000",
    },
  });
  assert.deepEqual(metadataReads, [POOL_ID]);
});

test("Legacy Pool LP and swap mapping preserves amounts, truncation, and expiry", async () => {
  const resolver = createLegacyPoolIntentResolver({
    chainId: CHAIN_ID,
    now: () => new Date("2026-09-12T08:00:00.123Z"),
    resolvePoolFtDecimals: async () => 6,
  });
  const add = await resolver.resolve({
    flag: "POOLNFT_LP_INCREASE", nft_contract_address: POOL_ID, address: RECEIVER,
    tbc_amount: "0.001", broadcastEnabled: false,
  }, SOURCE);
  assert.deepEqual(add.intent, {
    version: "1.0", type: "tbc.pool.liquidity.add", poolContractId: POOL_ID,
    receiver: RECEIVER, tbcAmount: "1000", minimumLpAmount: "1",
  });
  const remove = await resolver.resolve({
    flag: "POOLNFT_LP_CONSUME", nft_contract_address: POOL_ID, address: RECEIVER,
    ft_amount: "102.27935199", poolNFT_version: 2, broadcastEnabled: false,
  }, SOURCE);
  assert.equal(remove.intent.lpAmount, "102279351");
  for (const ftAmount of [102.27935132, "102.27935132", "102.279351999"]) {
    const truncated = await resolver.resolve({
      flag: "POOLNFT_LP_CONSUME", nft_contract_address: POOL_ID, address: RECEIVER,
      ft_amount: ftAmount, poolNFT_version: 2, broadcastEnabled: false,
    }, SOURCE);
    assert.equal(truncated.intent.lpAmount, "102279351");
    assert.deepEqual(truncated, await resolver.resolve({
      flag: "POOLNFT_LP_CONSUME", nft_contract_address: POOL_ID, address: RECEIVER,
      ft_amount: "102.279351", poolNFT_version: 2, broadcastEnabled: false,
    }, SOURCE));
  }
  const buy = await resolver.resolve({
    flag: "POOLNFT_SWAP_TO_TOKEN", nft_contract_address: POOL_ID, address: RECEIVER,
    tbc_amount: "0.001", poolNFT_version: 2, lpPlan: 1, broadcastEnabled: false,
  }, SOURCE);
  assert.equal(buy.intent.type, "tbc.pool.swap.exactTbcForToken");
  assert.equal(buy.intent.tbcAmount, "1000");
  assert.deepEqual(buy.constraints, { expiresAt: "2026-09-12T08:05:00Z" });
  const sell = await resolver.resolve({
    flag: "POOLNFT_SWAP_TO_TBC", nft_contract_address: POOL_ID, address: RECEIVER,
    ft_amount: "0.0025", poolNFT_version: 2, broadcastEnabled: false,
  }, SOURCE);
  assert.equal(sell.intent.type, "tbc.pool.swap.exactTokenForTbc");
  assert.equal(sell.intent.ftAmount, "2500");
  assert.deepEqual(sell.constraints, { expiresAt: "2026-09-12T08:05:00Z" });
});

test("Legacy Pool mapping rejects broadcast, hidden fields, invalid policy, and zero output", async () => {
  const resolver = createLegacyPoolIntentResolver({ chainId: CHAIN_ID });
  const add = {
    flag: "POOLNFT_LP_INCREASE", nft_contract_address: POOL_ID, address: RECEIVER,
    tbc_amount: "0.001", broadcastEnabled: false,
  };
  await assert.rejects(() => resolver.resolve({ ...add, broadcastEnabled: true }, SOURCE), /Invalid Legacy Pool LP increase/u);
  await assert.rejects(() => resolver.resolve({ ...add, hidden: true }, SOURCE), /Invalid Legacy Pool LP increase/u);
  await assert.rejects(() => resolver.resolve({ ...add, poolNFT_version: 1 }, SOURCE), /Invalid Legacy Pool LP increase/u);
  await assert.rejects(() => resolver.resolve({ ...add, tbc_amount: "0.0000001" }, SOURCE), /Invalid Legacy Pool LP increase/u);
  await assert.rejects(() => resolver.resolve({ ...add, tbc_amount: "0" }, SOURCE), /Invalid Legacy Pool LP increase/u);
  const remove = {
    flag: "POOLNFT_LP_CONSUME", nft_contract_address: POOL_ID, address: RECEIVER,
    ft_amount: "0.0025", poolNFT_version: 2, broadcastEnabled: false,
  };
  await assert.rejects(() => resolver.resolve({ ...remove, ft_amount: "0.00000099" }, SOURCE), /Invalid Legacy Pool LP consume/u);
  await assert.rejects(() => resolver.resolve({ ...remove, broadcastEnabled: true }, SOURCE), /Invalid Legacy Pool LP consume/u);
  await assert.rejects(() => resolver.resolve({ ...remove, poolNFT_version: 1 }, SOURCE), /Invalid Legacy Pool LP consume/u);
  await assert.rejects(() => resolver.resolve({ ...remove, hidden: true }, SOURCE), /Invalid Legacy Pool LP consume/u);
  const swap = {
    flag: "POOLNFT_SWAP_TO_TOKEN", nft_contract_address: POOL_ID, address: RECEIVER,
    tbc_amount: "0.001", poolNFT_version: 2, broadcastEnabled: false,
  };
  await assert.rejects(() => resolver.resolve({ ...swap, broadcastEnabled: true }, SOURCE), /Invalid Legacy Pool swap/u);
  await assert.rejects(() => resolver.resolve({ ...swap, poolNFT_version: 1 }, SOURCE), /Invalid Legacy Pool swap/u);
  await assert.rejects(() => resolver.resolve({ ...swap, hidden: true }, SOURCE), /Invalid Legacy Pool swap/u);
  const mint = {
    flag: "POOLNFT_MINT", ft_contract_address: FT_ID, poolNFT_version: 2,
    serverProvider_tag: "durian", serviceFeeRate: 36, with_lock: true,
    pubKeyLock: [BUY_KEY], lpCostAddress: RECEIVER, lpCostAmount: 1,
    lpPlan: 1, broadcastEnabled: false,
  };
  await assert.rejects(() => resolver.resolve(mint, SOURCE), /Invalid Legacy Pool mint/u);
});

test("Legacy Pool merge flags map to bounded public merge intents without amount fields", async () => {
  const resolver = createLegacyPoolIntentResolver({ chainId: CHAIN_ID });
  const poolFt = await resolver.resolve({
    flag: "POOLNFT_MERGE",
    nft_contract_address: POOL_ID.toUpperCase(),
    domain: "example.test",
  }, SOURCE);
  const ftlp = await resolver.resolve({
    flag: "FTLP_MERGE",
    nft_contract_address: POOL_ID,
  }, SOURCE);
  assert.deepEqual(poolFt.intent, {
    version: "1.0", type: "tbc.pool.ft.merge", poolContractId: POOL_ID,
  });
  assert.deepEqual(ftlp.intent, {
    version: "1.0", type: "tbc.pool.ftlp.merge", poolContractId: POOL_ID,
  });
  await assert.rejects(
    () => resolver.resolve({ flag: "POOLNFT_MERGE", nft_contract_address: POOL_ID, amount: "1" }, SOURCE),
    /Invalid Legacy Pool FT merge/u,
  );
});

test("Legacy POOLNFT_LP_BURN maps only the Pool identity to whole-input FTLP burn", async () => {
  const resolver = createLegacyPoolIntentResolver({ chainId: CHAIN_ID });
  const burn = await resolver.resolve({
    flag: "POOLNFT_LP_BURN",
    nft_contract_address: POOL_ID.toUpperCase(),
    domain: "example.test",
  }, SOURCE);
  assert.deepEqual(burn.intent, {
    version: "1.0", type: "tbc.pool.ftlp.burn", poolContractId: POOL_ID,
  });
  assert.match(burn.clientRequestId, /^legacy-ftlp-burn:[0-9a-f]{64}$/u);
  await assert.rejects(
    () => resolver.resolve({ flag: "POOLNFT_LP_BURN", nft_contract_address: POOL_ID, amount: "1" }, SOURCE),
    /Invalid Legacy Pool FTLP burn/u,
  );
});
