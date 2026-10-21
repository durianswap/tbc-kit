import assert from "node:assert/strict";
import test from "node:test";

import { createLegacyFtTransferIntentResolver } from "../dist/esm/wallet.js";

const CHAIN_ID = "tbc:testnet";
const SOURCE = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const RECIPIENT = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
const CONTRACT_ID = "cd".repeat(32);

const metadata = Object.freeze({
  contractId: CONTRACT_ID,
  decimals: 6,
  name: "Durian Test",
  symbol: "DTEST",
});

test("Legacy FT transfer maps trusted metadata and attached TBC amounts", async () => {
  const reads = [];
  const resolver = createLegacyFtTransferIntentResolver({
    chainId: CHAIN_ID,
    getFtInfo: async (contractId) => {
      reads.push(contractId);
      return metadata;
    },
  });
  const resolved = await resolver.resolve({
    flag: "FT_TRANSFER",
    ft_contract_address: CONTRACT_ID.toUpperCase(),
    address: RECIPIENT,
    ft_amount: "0.25",
    tbc_amount: 0,
    broadcastEnabled: false,
  }, SOURCE);
  assert.match(resolved.clientRequestId, /^legacy-ft-transfer:[0-9a-f]{64}$/u);
  assert.deepEqual(resolved.intent, {
    version: "1.0",
    type: "tbc.ft.transfer",
    contractId: CONTRACT_ID,
    to: RECIPIENT,
    amount: "250000",
  });
  const attached = await resolver.resolve({
    flag: "FT_TRANSFER",
    ft_contract_address: CONTRACT_ID,
    address: RECIPIENT,
    ft_amount: "1.000001",
    tbc_amount: "0.01",
    broadcastEnabled: false,
  }, SOURCE);
  assert.equal(attached.intent.amount, "1000001");
  assert.equal(attached.intent.attachedTbcAmount, "10000");
  assert.deepEqual(reads, [CONTRACT_ID], "validated immutable metadata is bounded and reused");
});

test("Legacy FT current-template mapping reuses one authenticated metadata read", async () => {
  let reads = 0, inspections = 0;
  const resolver = createLegacyFtTransferIntentResolver({
    chainId: CHAIN_ID,
    metadata: {
      network: { chainId: CHAIN_ID },
      async getFtInfo(contractId) {
        reads++;
        return { ...metadata, contractId, codeScript: "51", tapeScript: "6a" };
      },
    },
    async resolveCurrentStandard(info) {
      inspections++;
      assert.equal(info.codeScript, "51");
      assert.equal(info.tapeScript, "6a");
      return true;
    },
  });
  const request = {
    flag: "FT_TRANSFER", ft_contract_address: CONTRACT_ID,
    address: RECIPIENT, ft_amount: "2.5", broadcastEnabled: false,
  };
  const first = await resolver.resolve(request, SOURCE);
  const second = await resolver.resolve({ ...request, ft_amount: "3" }, SOURCE);
  assert.equal(first.intent.type, "tbc20.transfer");
  assert.equal(first.intent.amount, "2500000");
  assert.equal(second.intent.type, "tbc20.transfer");
  assert.equal(reads, 1);
  assert.equal(inspections, 1);
  const attached = await resolver.resolve({ ...request, tbc_amount: "0.01" }, SOURCE);
  assert.deepEqual(attached.intent.payment, { to: RECIPIENT, amount: "10000" });
  assert.equal(attached.intent.attachedTbcAmount, undefined);
  assert.equal(reads, 1);
  assert.equal(inspections, 1);
});

test("Legacy FT historical-template mapping is unchanged and a failed classification is not cached", async () => {
  let reads = 0, inspections = 0;
  const resolver = createLegacyFtTransferIntentResolver({
    chainId: CHAIN_ID,
    metadata: {
      network: { chainId: CHAIN_ID },
      async getFtInfo(contractId) {
        reads++;
        return { ...metadata, contractId, codeScript: "52", tapeScript: "6a" };
      },
    },
    async resolveCurrentStandard() {
      inspections++;
      if (inspections === 1) throw new Error("Native identity unavailable");
      return false;
    },
  });
  const request = {
    flag: "FT_TRANSFER", ft_contract_address: CONTRACT_ID,
    address: RECIPIENT, ft_amount: "1", tbc_amount: "0.01",
    broadcastEnabled: false,
  };
  await assert.rejects(() => resolver.resolve(request, SOURCE), /Native identity unavailable/u);
  const resolved = await resolver.resolve(request, SOURCE);
  assert.equal(resolved.intent.type, "tbc.ft.transfer");
  assert.equal(resolved.intent.attachedTbcAmount, "10000");
  assert.equal(reads, 2);
  assert.equal(inspections, 2);
});

test("Legacy FT transfer never caches a failed metadata identity", async () => {
  let reads = 0;
  const mutable = { ...metadata };
  const resolver = createLegacyFtTransferIntentResolver({
    chainId: CHAIN_ID,
    getFtInfo: async () => {
      reads += 1;
      return reads === 1 ? { ...metadata, contractId: "ef".repeat(32) } : mutable;
    },
  });
  const request = {
    flag: "FT_TRANSFER",
    ft_contract_address: CONTRACT_ID,
    address: RECIPIENT,
    ft_amount: "1",
    broadcastEnabled: false,
  };
  await assert.rejects(() => resolver.resolve(request, SOURCE), /metadata identity mismatch/u);
  const resolved = await resolver.resolve(request, SOURCE);
  assert.equal(resolved.intent.amount, "1000000");
  mutable.decimals = 9;
  let observedDecimals;
  const second = await resolver.resolve({ ...request, ft_amount: "2" }, SOURCE, (value) => {
    observedDecimals = value;
  });
  assert.equal(second.intent.amount, "2000000");
  assert.equal(observedDecimals, 6);
  assert.equal(reads, 2);
});

test("Legacy FT transfer accepts historical broadcast modes and rejects invalid values", async () => {
  const resolver = createLegacyFtTransferIntentResolver({
    chainId: CHAIN_ID,
    getFtInfo: async () => metadata,
  });
  const base = {
    flag: "FT_TRANSFER",
    ft_contract_address: CONTRACT_ID,
    address: RECIPIENT,
    ft_amount: "0.0000001",
    tbc_amount: "0",
    broadcastEnabled: false,
  };
  await assert.rejects(() => resolver.resolve(base, SOURCE), /Invalid Legacy FT transfer/u);
  assert.equal(
    (await resolver.resolve({ ...base, ft_amount: "1", broadcastEnabled: true }, SOURCE)).intent.amount,
    "1000000",
  );
  assert.equal(
    (await resolver.resolve([{ ...base, ft_amount: "2", broadcastEnabled: false }], SOURCE)).intent.amount,
    "2000000",
  );
  const { broadcastEnabled: _broadcastEnabled, ...withoutBroadcast } = base;
  assert.equal(
    (await resolver.resolve({ ...withoutBroadcast, ft_amount: "3" }, SOURCE)).intent.amount,
    "3000000",
  );
  await assert.rejects(
    () => resolver.resolve({ ...base, ft_amount: "1", broadcastEnabled: "yes" }, SOURCE),
    /Invalid Legacy FT transfer/u,
  );
  const mismatched = createLegacyFtTransferIntentResolver({
    chainId: CHAIN_ID,
    getFtInfo: async () => ({ ...metadata, contractId: "ef".repeat(32) }),
  });
  await assert.rejects(() => mismatched.resolve({ ...base, ft_amount: "1" }, SOURCE), /metadata identity mismatch/u);
});

test("Legacy FT transfer rejects invalid source or recipient before metadata lookup", async () => {
  let reads = 0;
  const resolver = createLegacyFtTransferIntentResolver({
    chainId: CHAIN_ID,
    getFtInfo: async () => {
      reads += 1;
      return metadata;
    },
  });
  const request = {
    flag: "FT_TRANSFER",
    ft_contract_address: CONTRACT_ID,
    address: RECIPIENT,
    ft_amount: "1",
    broadcastEnabled: false,
  };
  await assert.rejects(
    () => resolver.resolve(request, "invalid-source"),
    /Invalid TBC Testnet address/u,
  );
  await assert.rejects(
    () => resolver.resolve({ ...request, address: "invalid-recipient" }, SOURCE),
    /Invalid TBC Testnet address/u,
  );
  assert.equal(reads, 0);
});
