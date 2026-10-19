import assert from "node:assert/strict";
import test from "node:test";

import {
  createLegacyBatchRequestScope,
  createLegacyPoolIntentResolver,
  matchesLegacyBatchRequest,
  withLegacyDependentTxids,
} from "../dist/esm/wallet.js";

const CHAIN_ID = "tbc:testnet";
const SOURCE = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const RECIPIENT = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
const CONTRACT_ID = "cd".repeat(32);

test("Legacy batch scopes bind native and trusted-decimal FT requests", () => {
  const native = createLegacyBatchRequestScope({
    flag: "P2PKH",
    address: RECIPIENT,
    satoshis: 1000,
    broadcastEnabled: false,
  }, SOURCE);
  assert.deepEqual(native, {
    source: SOURCE,
    recipient: RECIPIENT,
    kind: "native",
    amount: "1000",
    attachedTbcAtomic: "0",
    feeCapAtomic: "1000",
  });
  assert.equal(matchesLegacyBatchRequest(native, {
    version: "1.0",
    chainId: CHAIN_ID,
    from: SOURCE,
    intent: { version: "1.0", type: "tbc.transfer", to: RECIPIENT, amount: "1000" },
  }), true);

  const ft = createLegacyBatchRequestScope({
    flag: "FT_TRANSFER",
    ft_contract_address: CONTRACT_ID.toUpperCase(),
    address: RECIPIENT,
    ft_amount: "2.5",
    tbc_amount: "0.01",
    broadcastEnabled: false,
  }, SOURCE);
  assert.deepEqual(ft, {
    source: SOURCE,
    recipient: RECIPIENT,
    kind: "ft",
    contractId: CONTRACT_ID,
    amount: "2.5",
    attachedTbcAtomic: "10000",
    feeCapAtomic: "10000",
  });
  const canonical = {
    version: "1.0",
    chainId: CHAIN_ID,
    from: SOURCE,
    intent: {
      version: "1.0",
      type: "tbc.ft.transfer",
      to: RECIPIENT,
      contractId: CONTRACT_ID,
      amount: "2500000",
      attachedTbcAmount: "10000",
    },
  };
  assert.equal(matchesLegacyBatchRequest(ft, canonical, 6), true);
  assert.equal(matchesLegacyBatchRequest(ft, {
    ...canonical,
    intent: { ...canonical.intent, amount: "2500001" },
  }, 6), false);
  assert.throws(() => matchesLegacyBatchRequest(ft, canonical), /Invalid Legacy FT transfer/u);
});

test("Legacy batch scopes retain exact Pool and create intents without I/O", async () => {
  const pool = createLegacyPoolIntentResolver({
    chainId: CHAIN_ID,
    resolvePoolFtDecimals: async () => 6,
  });
  const add = await pool.resolve({
    flag: "POOLNFT_LP_INCREASE",
    nft_contract_address: CONTRACT_ID,
    address: RECIPIENT,
    tbc_amount: "2",
    poolNFT_version: 2,
    broadcastEnabled: false,
  }, SOURCE);
  const addScope = createLegacyBatchRequestScope(add, SOURCE);
  assert.equal(addScope.kind, "pool-add");
  assert.equal(addScope.amount, "2000000");
  assert.equal(matchesLegacyBatchRequest(addScope, add), true);
  assert.equal(matchesLegacyBatchRequest(addScope, {
    ...add,
    intent: { ...add.intent, minFtAmount: "2" },
  }), false);

  const remove = await pool.resolve({
    flag: "POOLNFT_LP_CONSUME",
    nft_contract_address: CONTRACT_ID,
    address: RECIPIENT,
    ft_amount: "2.5",
    poolNFT_version: 2,
    broadcastEnabled: false,
  }, SOURCE);
  const removeScope = createLegacyBatchRequestScope(remove, SOURCE);
  assert.equal(removeScope.kind, "pool-remove");
  assert.equal(removeScope.amount, "2500000");
  assert.equal(matchesLegacyBatchRequest(removeScope, remove), true);

  const mint = await pool.resolve({
    flag: "POOLNFT_MINT",
    ft_contract_address: CONTRACT_ID,
    poolNFT_version: 2,
    serverProvider_tag: "durian",
    serviceFeeRate: 35,
    with_lock: true,
    pubKeyLock: [`02${"11".repeat(32)}`],
    lpCostAddress: SOURCE,
    lpCostAmount: 1,
    lpPlan: 2,
    broadcastEnabled: false,
  }, SOURCE);
  const mintScope = createLegacyBatchRequestScope(mint, SOURCE);
  assert.equal(mintScope.kind, "pool-mint");
  assert.equal(mintScope.transactionCount, 2);
  assert.equal(matchesLegacyBatchRequest(mintScope, mint), true);

  const initialize = await pool.resolve({
    flag: "POOLNFT_INIT",
    nft_contract_address: CONTRACT_ID,
    address: RECIPIENT,
    tbc_amount: "2",
    ft_amount: "3",
    poolNFT_version: 2,
    lockTime: 0,
    broadcastEnabled: false,
  }, SOURCE);
  const initializeScope = createLegacyBatchRequestScope(initialize, SOURCE);
  assert.equal(initializeScope.kind, "pool-initialize");
  assert.equal(initializeScope.transactionCount, 1);
  assert.equal(initializeScope.recipient, RECIPIENT);
  assert.equal(matchesLegacyBatchRequest(initializeScope, initialize), true);

  const create = {
    version: "1.0",
    chainId: CHAIN_ID,
    from: SOURCE,
    intent: {
      version: "1.0",
      type: "tbc.ft.create",
      name: "Test",
      symbol: "T",
      decimals: 6,
      initialSupply: "2000000",
    },
  };
  const createScope = createLegacyBatchRequestScope(create, SOURCE);
  assert.equal(createScope.kind, "ft-create");
  assert.equal(createScope.method, "tbc_sendTransaction");
  assert.equal(createScope.transactionCount, 2);
  assert.equal(matchesLegacyBatchRequest(createScope, create), true);
});

test("Legacy dependent message replaces or appends only the txids field", () => {
  assert.deepEqual(withLegacyDependentTxids({
    message: JSON.stringify({ purpose: "deposit" }),
    encoding: "utf8",
  }, ["aa", "bb"]), {
    message: JSON.stringify({ purpose: "deposit", txids: ["aa", "bb"] }),
    encoding: "utf8",
  });
  assert.deepEqual(withLegacyDependentTxids({
    message: JSON.stringify({ txids: ["old"], purpose: "deposit" }),
    encoding: "utf8",
  }, ["new"]), {
    message: JSON.stringify({ txids: ["new"], purpose: "deposit" }),
    encoding: "utf8",
  });
  for (const input of [
    null,
    { message: "[]", encoding: "utf8" },
    { message: "{", encoding: "utf8" },
    { message: JSON.stringify({ txids: "bad" }), encoding: "utf8" },
    { message: JSON.stringify({ purpose: "deposit" }), encoding: "hex" },
    { message: "{\"__proto__\":true}", encoding: "utf8" },
  ]) {
    assert.equal(withLegacyDependentTxids(input, []), undefined);
  }
});

test("Legacy batch scope rejects broadcast, changed source, and unsupported flags", () => {
  const base = {
    flag: "P2PKH",
    address: RECIPIENT,
    satoshis: 1000,
    broadcastEnabled: false,
  };
  assert.throws(() => createLegacyBatchRequestScope({ ...base, broadcastEnabled: true }, SOURCE), /Invalid batch request/u);
  assert.throws(() => createLegacyBatchRequestScope({ ...base, flag: "NFT_CREATE" }, SOURCE), /Unsupported batch request/u);
  const scope = createLegacyBatchRequestScope(base, SOURCE);
  assert.equal(matchesLegacyBatchRequest(scope, {
    version: "1.0",
    chainId: CHAIN_ID,
    from: RECIPIENT,
    intent: { version: "1.0", type: "tbc.transfer", to: RECIPIENT, amount: "1000" },
  }), false);
});
