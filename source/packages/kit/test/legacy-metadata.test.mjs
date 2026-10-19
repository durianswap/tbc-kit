import assert from "node:assert/strict";
import test from "node:test";

import {
  createLegacyFtTransferIntentResolver,
  createLegacyPoolIntentResolver,
  createLegacyStablecoinTransferIntentResolver,
  createTbcLegacyMetadataResolver,
  createTbcNetworkContext,
} from "../dist/esm/wallet.js";

const POOL = "ab".repeat(32);
const FT = "cd".repeat(32);
const FT_TWO = "ef".repeat(32);
const STABLECOIN = "12".repeat(32);
const SOURCE = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const RECIPIENT = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";

function envelope(data) {
  return new Response(JSON.stringify({ code: "200", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function metadataFetch(origin, calls, generation) {
  return async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, origin);
    calls.push(url.pathname);
    if (url.pathname === `/api/tbc/pool/poolinfo/poolid/${POOL}`) {
      return envelope({ ft_contract_id: FT });
    }
    if (url.pathname === `/api/tbc/ft/info/contract/${FT}`) {
      const currentGeneration = generation();
      return envelope({
        code_script: "01",
        tape_script: "02",
        amount: String(1_000_000 + currentGeneration),
        decimal: 6,
        name: "Token",
        symbol: "T",
      });
    }
    if (url.pathname === `/api/tbc/stablecoin/info/stablecoinid/${STABLECOIN}`) {
      return envelope({
        stablecoin_id: STABLECOIN,
        decimal: 6,
        name: "Stable",
        symbol: "STB",
        utxo: { txid: "34".repeat(32), vout: 0 },
      });
    }
    throw new Error(`unexpected metadata request ${url.pathname}`);
  };
}

test("default metadata resolver single-flights and isolates Mainnet/Testnet source caches", async () => {
  let now = 1_000;
  let mainGeneration = 1;
  let testGeneration = 7;
  const mainCalls = [];
  const testCalls = [];
  const mainnet = createTbcNetworkContext({ network: "mainnet" });
  const testnet = createTbcNetworkContext({ network: "testnet" });
  const main = createTbcLegacyMetadataResolver({
    network: mainnet,
    fetch: metadataFetch(mainnet.endpoint.apiOrigin, mainCalls, () => mainGeneration),
    cacheTtlMs: 100,
    now: () => now,
  });
  const test = createTbcLegacyMetadataResolver({
    network: testnet,
    fetch: metadataFetch(testnet.endpoint.apiOrigin, testCalls, () => testGeneration),
    cacheTtlMs: 100,
    now: () => now,
  });

  const [mainA, mainB, testA, testB] = await Promise.all([
    main.resolvePoolFtDecimals(POOL),
    main.resolvePoolFtDecimals(POOL),
    test.resolvePoolFtDecimals(POOL),
    test.resolvePoolFtDecimals(POOL),
  ]);
  assert.deepEqual([mainA, mainB, testA, testB], [6, 6, 6, 6]);
  assert.deepEqual(mainCalls, [
    `/api/tbc/pool/poolinfo/poolid/${POOL}`,
    `/api/tbc/ft/info/contract/${FT}`,
  ]);
  assert.deepEqual(testCalls, mainCalls);
  assert.notEqual(main.sourceIdentity, test.sourceIdentity);

  await main.resolvePoolFtDecimals(POOL);
  assert.equal(mainCalls.length, 2, "warm bounded reuse adds no GET");
  now += 101;
  mainGeneration = 2;
  const refreshed = await main.getFtInfo(FT);
  assert.equal(refreshed.totalSupply, "1000002");
  assert.equal(mainCalls.length, 3, "the complete API response refreshes after TTL");
});

test("one default metadata source is directly reusable by FT and Pool intent resolvers", async () => {
  const network = createTbcNetworkContext({ network: "testnet" });
  const calls = [];
  const metadata = createTbcLegacyMetadataResolver({
    network,
    fetch: metadataFetch(network.endpoint.apiOrigin, calls, () => 1),
  });
  const ft = createLegacyFtTransferIntentResolver({
    chainId: network.chainId,
    metadata,
  });
  const pool = createLegacyPoolIntentResolver({
    chainId: network.chainId,
    metadata,
    now: () => new Date("2026-09-19T00:00:00Z"),
  });
  const transfer = await ft.resolve({
    flag: "FT_TRANSFER",
    ft_contract_address: FT,
    address: RECIPIENT,
    ft_amount: "1.25",
    tbc_amount: 0,
    broadcastEnabled: false,
  }, SOURCE);
  assert.equal(transfer.intent.amount, "1250000");
  const initialized = await pool.resolve({
    flag: "POOLNFT_INIT",
    nft_contract_address: POOL,
    address: RECIPIENT,
    tbc_amount: "1",
    ft_amount: "2.5",
    poolNFT_version: 2,
    lockTime: 0,
    broadcastEnabled: false,
  }, SOURCE);
  assert.equal(initialized.intent.initialLiquidity.ftAmount, "2500000");
  assert.deepEqual(calls, [
    `/api/tbc/ft/info/contract/${FT}`,
    `/api/tbc/pool/poolinfo/poolid/${POOL}`,
  ], "Pool identity reuses the already loaded FT metadata without a third GET");
});

test("Legacy FT applies current-template metadata bounds before decoding without a second GET", async () => {
  const network = createTbcNetworkContext({ network: "testnet" });
  const calls = [];
  let inspections = 0;
  const symbol = "CURRENT_STANDARD_SYMBOL_123456";
  const fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    return envelope({
      code_script: "51", tape_script: "02", amount: "1000000",
      decimal: 6, name: "Current", symbol,
    });
  };
  const metadata = createTbcLegacyMetadataResolver({
    network, fetch,
    resolveFtStandard: (codeScript) => {
      inspections++;
      assert.equal(codeScript, "51");
      return "tbc20-standard";
    },
  });
  const ft = createLegacyFtTransferIntentResolver({
    chainId: network.chainId, metadata,
    resolveCurrentStandard: async (info) => {
      assert.equal(info.symbol, symbol);
      return info.codeScript === "51";
    },
  });
  const request = {
    flag: "FT_TRANSFER", ft_contract_address: FT, address: RECIPIENT,
    ft_amount: "1", broadcastEnabled: false,
  };
  assert.equal((await ft.resolve(request, SOURCE)).intent.type, "tbc20.transfer");
  assert.equal((await ft.resolve(request, SOURCE)).intent.amount, "1000000");
  assert.deepEqual(calls, [`/api/tbc/ft/info/contract/${FT}`]);
  assert.equal(inspections, 1);

  const historical = createTbcLegacyMetadataResolver({ network, fetch });
  await assert.rejects(() => historical.getFtInfo(FT), /Invalid TBC Testnet text field/u);
});

test("one bounded metadata source maps Legacy Stablecoin display amounts without duplicate reads", async () => {
  const network = createTbcNetworkContext({ network: "testnet" });
  const calls = [];
  const metadata = createTbcLegacyMetadataResolver({
    network,
    fetch: metadataFetch(network.endpoint.apiOrigin, calls, () => 1),
  });
  const stablecoin = createLegacyStablecoinTransferIntentResolver({
    chainId: network.chainId,
    metadata,
  });
  const request = [{
    flag: "STABLECOIN_TRANSFER",
    ft_contract_address: STABLECOIN.toUpperCase(),
    address: RECIPIENT,
    ft_amount: "1.25",
    tbc_amount: "0.000024",
    broadcastEnabled: true,
    domain: "ignored.example",
  }];
  const first = await stablecoin.resolve(request, SOURCE);
  const second = await stablecoin.resolve(structuredClone(request), SOURCE);
  assert.deepEqual(first, second);
  assert.deepEqual(first.intent, {
    version: "1.0",
    type: "tbc.stablecoin.transfer",
    contractId: STABLECOIN,
    to: RECIPIENT,
    amount: "1250000",
    attachedTbcAmount: "24",
  });
  assert.deepEqual(calls, [
    `/api/tbc/stablecoin/info/stablecoinid/${STABLECOIN}`,
  ], "warm Stablecoin decimals add no second GET");
});

test("Legacy Stablecoin mapping rejects hidden fields and invalid decimals before dispatch", async () => {
  const network = createTbcNetworkContext({ network: "testnet" });
  const stablecoin = createLegacyStablecoinTransferIntentResolver({
    chainId: network.chainId,
    resolveDecimals: async () => 6,
  });
  const valid = {
    flag: "STABLECOIN_TRANSFER",
    ft_contract_address: STABLECOIN,
    address: RECIPIENT,
    ft_amount: "1",
  };
  await assert.rejects(
    () => stablecoin.resolve({ ...valid, hidden: true }, SOURCE),
    /Invalid Legacy Stablecoin transfer/u,
  );
  const invalidDecimals = createLegacyStablecoinTransferIntentResolver({
    chainId: network.chainId,
    resolveDecimals: async () => 19,
  });
  await assert.rejects(
    () => invalidDecimals.resolve(valid, SOURCE),
    /Invalid Legacy Stablecoin transfer/u,
  );
});

test("FT transfer retains immutable creation identity after the full-metadata TTL", async () => {
  let now = 1_000;
  let generation = 1;
  const calls = [];
  const network = createTbcNetworkContext({ network: "testnet" });
  const metadata = createTbcLegacyMetadataResolver({
    network,
    fetch: metadataFetch(network.endpoint.apiOrigin, calls, () => generation),
    cacheTtlMs: 100,
    now: () => now,
  });
  const ft = createLegacyFtTransferIntentResolver({
    chainId: network.chainId,
    metadata,
  });
  const request = {
    flag: "FT_TRANSFER",
    ft_contract_address: FT,
    address: RECIPIENT,
    ft_amount: "1.25",
    tbc_amount: 0,
    broadcastEnabled: false,
  };

  assert.equal((await ft.resolve(request, SOURCE)).intent.amount, "1250000");
  now += 101;
  generation = 2;
  assert.equal((await ft.resolve(request, SOURCE)).intent.amount, "1250000");
  assert.equal(
    calls.filter((path) => path === `/api/tbc/ft/info/contract/${FT}`).length,
    1,
    "the same source and creation contract must not re-fetch immutable FT identity",
  );

  const refreshed = await metadata.getFtInfo(FT);
  assert.equal(refreshed.totalSupply, "1000002");
  assert.equal(
    calls.filter((path) => path === `/api/tbc/ft/info/contract/${FT}`).length,
    2,
    "the complete API response remains independently refreshable after its TTL",
  );
});

test("FT creation identity cache is bounded and never retains failed loads", async () => {
  let now = 1_000;
  let firstFtFailure = true;
  const calls = [];
  const network = createTbcNetworkContext({ network: "testnet" });
  const fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    const contractId = url.pathname.split("/").at(-1);
    if (contractId !== FT && contractId !== FT_TWO) {
      throw new Error(`unexpected metadata request ${url.pathname}`);
    }
    if (contractId === FT && firstFtFailure) {
      firstFtFailure = false;
      return envelope({
        code_script: "01",
        tape_script: "02",
        amount: "1000000",
        decimal: 19,
        name: "Token A",
        symbol: "TA",
      });
    }
    return envelope({
      code_script: "01",
      tape_script: "02",
      amount: "1000000",
      decimal: 6,
      name: contractId === FT ? "Token A" : "Token B",
      symbol: contractId === FT ? "TA" : "TB",
    });
  };
  const metadata = createTbcLegacyMetadataResolver({
    network,
    fetch,
    cacheTtlMs: 100,
    maxCacheEntries: 1,
    now: () => now,
  });
  const ft = createLegacyFtTransferIntentResolver({
    chainId: network.chainId,
    metadata,
  });
  const request = (contractId) => ({
    flag: "FT_TRANSFER",
    ft_contract_address: contractId,
    address: RECIPIENT,
    ft_amount: "1",
    broadcastEnabled: false,
  });

  await assert.rejects(() => ft.resolve(request(FT), SOURCE), /decimals/u);
  assert.equal((await ft.resolve(request(FT), SOURCE)).intent.amount, "1000000");
  assert.equal((await ft.resolve(request(FT_TWO), SOURCE)).intent.amount, "1000000");
  now += 101;
  assert.equal((await ft.resolve(request(FT), SOURCE)).intent.amount, "1000000");
  assert.deepEqual(calls, [
    `/api/tbc/ft/info/contract/${FT}`,
    `/api/tbc/ft/info/contract/${FT}`,
    `/api/tbc/ft/info/contract/${FT_TWO}`,
    `/api/tbc/ft/info/contract/${FT}`,
  ]);
});

test("refreshed full metadata cannot mutate an established FT creation identity", async () => {
  let now = 1_000;
  let reads = 0;
  const network = createTbcNetworkContext({ network: "testnet" });
  const metadata = createTbcLegacyMetadataResolver({
    network,
    cacheTtlMs: 100,
    now: () => now,
    fetch: async () => {
      reads += 1;
      return envelope({
        code_script: "01",
        tape_script: "02",
        amount: String(1_000_000 + reads),
        decimal: reads === 1 ? 6 : 9,
        name: "Token",
        symbol: "T",
      });
    },
  });
  const ft = createLegacyFtTransferIntentResolver({
    chainId: network.chainId,
    metadata,
  });
  const request = {
    flag: "FT_TRANSFER",
    ft_contract_address: FT,
    address: RECIPIENT,
    ft_amount: "1",
    broadcastEnabled: false,
  };

  assert.equal((await ft.resolve(request, SOURCE)).intent.amount, "1000000");
  now += 101;
  await assert.rejects(
    () => metadata.getFtInfo(FT),
    /creation metadata identity changed/u,
  );
  assert.equal((await ft.resolve(request, SOURCE)).intent.amount, "1000000");
  assert.equal(reads, 2, "a rejected refresh cannot replace or evict the identity");
});

test("a structural metadata lookalike cannot claim the Kit-private identity cache", async () => {
  let reads = 0;
  const network = createTbcNetworkContext({ network: "testnet" });
  const ft = createLegacyFtTransferIntentResolver({
    chainId: network.chainId,
    metadata: {
      network,
      getFtInfo: async (contractId) => {
        reads += 1;
        return {
          contractId,
          decimals: 6,
          name: "Token",
          symbol: "T",
        };
      },
    },
  });
  const request = {
    flag: "FT_TRANSFER",
    ft_contract_address: FT,
    address: RECIPIENT,
    ft_amount: "1",
    broadcastEnabled: false,
  };

  await ft.resolve(request, SOURCE);
  await ft.resolve(request, SOURCE);
  assert.equal(reads, 2);
});

test("metadata resolver rejects response source changes and network-mismatched consumers", async () => {
  const testnet = createTbcNetworkContext({ network: "testnet" });
  const mainnet = createTbcNetworkContext({ network: "mainnet" });
  const metadata = createTbcLegacyMetadataResolver({
    network: testnet,
    fetch: async () => ({
      ok: true,
      status: 200,
      url: "https://wrong.example/api/tbc/pool",
      async text() { return JSON.stringify({ code: "200", data: { ft_contract_id: FT } }); },
    }),
  });
  await assert.rejects(
    metadata.resolvePoolFtIdentity(POOL),
    /changed source/u,
  );
  assert.throws(
    () => createLegacyFtTransferIntentResolver({
      chainId: mainnet.chainId,
      metadata,
    }),
    /does not match/u,
  );
  assert.throws(
    () => createLegacyPoolIntentResolver({
      chainId: mainnet.chainId,
      metadata,
    }),
    /does not match/u,
  );
});
