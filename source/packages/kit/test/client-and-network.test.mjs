import assert from "node:assert/strict";
import test from "node:test";
import { getWallets } from "@wallet-standard/core";

import { composeTbcWorkflow, createTbcClient, createTbcProvider } from "../dist/esm/index.js";
import { createTbcApiClient, createTestnetClient } from "../dist/esm/api.js";
import { createPoolTransactionInspector } from "../dist/esm/wallet.js";
import { createTbcRpcClient } from "../dist/esm/rpc.js";
import { createRequestLedger } from "../dist/esm/testing.js";

const DISCOVERY_CHAIN = "tbc:testnet";
const BATCH_RAW_ONE = ["0a000000", "01", "00".repeat(32), "00000000", "00", "ffffffff", "01", "8813000000000000", "01", "51", "00000000"].join("");
const BATCH_RAW_TWO = BATCH_RAW_ONE.replace("8813000000000000", "8913000000000000");

function discoveredWallet({ productId, name, address, calls }) {
  const provider = {
    async request(request) {
      calls.push(request.method);
      if (request.method === "tbc_requestAccounts") return [address];
      return { productId, method: request.method };
    },
    on() {}, removeListener() {}, destroy() {},
  };
  return Object.freeze({
    version: "1.0.0",
    name,
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains: Object.freeze([DISCOVERY_CHAIN]),
    accounts: Object.freeze([]),
    features: Object.freeze({
      "tbc:provider": Object.freeze({ version: "1.0.0", productId, provider }),
    }),
  });
}

test("client construction is inert and high-level methods emit canonical intents", async () => {
  const calls = [];
  const provider = {
    async request(request) {
      calls.push(request);
      if (request.method === "tbc_requestAccounts") return ["1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"];
      return { method: request.method, params: request.params };
    },
    on() {}, removeListener() {}, destroy() {},
  };
  const client = createTbcClient({ network: "testnet", provider, requestIdFactory: () => "fixed-request" });
  assert.equal(calls.length, 0);
  const wallet = await client.connect();
  await wallet.sendTbc({ to: "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP", amount: "1000" });
  await wallet.maintenance.mergeTbc();
  await wallet.maintenance.mergeFt({ contractId: "11".repeat(32) });
  await wallet.maintenance.mergeStablecoin({ contractId: "11".repeat(32) });
  await wallet.maintenance.mergePoolFt({ poolContractId: "22".repeat(32) });
  await wallet.maintenance.mergeFtlp({ poolContractId: "22".repeat(32) });
  await wallet.maintenance.burnFtlp({ poolContractId: "22".repeat(32) });
  await wallet.collection.create({ name: "Collection", description: "Canonical", supply: "2", media: { kind: "uri", uri: "ipfs://collection" } });
  await wallet.nft.mint({ collectionId: "33".repeat(32), name: "NFT", symbol: "NFT", description: "Canonical", attributes: [] });
  await wallet.nft.transfer({ contractId: "44".repeat(32), to: wallet.account });
  await wallet.ft.create({ name: "Token", symbol: "TOK", decimals: 6, initialSupply: "1000000" });
  await wallet.ft.transfer({ contractId: "11".repeat(32), to: wallet.account, amount: "1" });
  await wallet.stablecoin.transfer({ contractId: "11".repeat(32), to: wallet.account, amount: "1" });
  await wallet.pool.buy({ poolContractId: "22".repeat(32), receiver: wallet.account, tbcAmount: "1000", minimumFtAmount: "1", constraints: { expiresAt: "2099-09-20T04:00:00Z" } });
  await wallet.pool.sell({ poolContractId: "22".repeat(32), receiver: wallet.account, ftAmount: "1000", minimumTbcAmount: "1", constraints: { expiresAt: "2099-09-20T04:00:00Z" } });
  await wallet.pool.addLiquidity({ poolContractId: "22".repeat(32), receiver: wallet.account, tbcAmount: "1000", minimumLpAmount: "1" });
  await wallet.pool.removeLiquidity({ poolContractId: "22".repeat(32), receiver: wallet.account, lpAmount: "1", minimumTbcAmount: "1", minimumFtAmount: "1" });
  assert.deepEqual(calls.slice(1).map((call) => call.params.intent.type), [
    "tbc.transfer", "tbc.maintenance.merge", "tbc.ft.merge", "tbc.stablecoin.merge", "tbc.pool.ft.merge", "tbc.pool.ftlp.merge", "tbc.pool.ftlp.burn",
    "tbc.collection.create", "tbc.nft.mint", "tbc.nft.transfer",
    "tbc.ft.create", "tbc.ft.transfer", "tbc.stablecoin.transfer",
    "tbc.pool.swap.exactTbcForToken", "tbc.pool.swap.exactTokenForTbc",
    "tbc.pool.liquidity.add", "tbc.pool.liquidity.remove",
  ]);
  assert.ok(calls.slice(1).every((call) => call.method === "tbc_sendTransaction"));
});

test("new-standard wallet-built workflow is public without any Legacy runtime", async () => {
  const calls = [];
  const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
  const provider = {
    async request(request) {
      calls.push(structuredClone(request));
      if (request.method === "tbc_requestAccounts") return [address];
      return {
        version: "1.0", chainId: DISCOVERY_CHAIN, from: address,
        requestHash: "11".repeat(32), workflowPlanHash: "22".repeat(32),
        approvalId: "workflow-approval", failureMode: "atomic", totalFee: "1",
        steps: [{ id: "send", kind: "transaction", result: { transactions: [] } }],
      };
    },
    on() {}, removeListener() {}, destroy() {},
  };
  const wallet = await createTbcClient({
    network: "testnet",
    provider,
    requestIdFactory: () => "standard-workflow-only",
  }).connect();
  const composed = composeTbcWorkflow({
    clientRequestId: "direct-workflow",
    steps: [{
      id: "send",
      kind: "transaction",
      dependsOn: [],
      intent: {
        version: "1.0",
        type: "tbc.transfer",
        to: address,
        amount: "1",
      },
    }],
  });
  assert.ok(Object.isFrozen(composed));
  assert.ok(Object.isFrozen(composed.steps));
  const result = await wallet.walletBuild.signWorkflow(composed);
  assert.equal(result.steps[0].id, "send");
  assert.equal(result.steps[0].kind, "transaction");
  assert.deepEqual(calls[1], {
    method: "tbc_signWorkflow",
    params: {
      version: "1.0",
      chainId: DISCOVERY_CHAIN,
      from: address,
      clientRequestId: "direct-workflow",
      steps: [{
        id: "send",
        kind: "transaction",
        dependsOn: [],
        intent: {
          version: "1.0",
          type: "tbc.transfer",
          to: address,
          amount: "1",
        },
      }],
    },
  });
  await wallet.walletBuild.sendWorkflow(composed);
  assert.equal(calls[2].method, "tbc_sendWorkflow");
  assert.equal(Object.hasOwn(wallet, "legacy"), false);
});

test("official bulk broadcast preserves order and marks a truncated result unknown", async () => {
  let posts = 0;
  const inspector = createPoolTransactionInspector();
  const firstTxid = inspector(BATCH_RAW_ONE).txid;
  const secondTxid = inspector(BATCH_RAW_TWO).txid;
  const client = createTestnetClient({
    baseUrl: "https://api.tbcdev.org",
    fetch: async (_input, init) => {
      posts += 1;
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), [
        { txraw: BATCH_RAW_ONE },
        { txraw: BATCH_RAW_TWO },
      ]);
      return new Response(JSON.stringify({
        code: "400",
        message: "partial failure",
        data: { success: 1, failed: 0, results: [{ txid: firstTxid }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(await client.broadcastBatch([BATCH_RAW_ONE, BATCH_RAW_TWO]), [
    { txid: firstTxid, status: "accepted" },
    { txid: secondTxid, status: "unknown", reason: "TBC batch response omitted this transaction result" },
  ]);
  assert.equal(posts, 1);
});

test("typed workflow composition rejects forward, duplicate, and cyclic dependency shapes before Provider I/O", () => {
  for (const steps of [
    [
      { id: "later", kind: "message", dependsOn: ["missing"], message: { encoding: "utf8", data: "x" } },
    ],
    [
      { id: "same", kind: "message", dependsOn: [], message: { encoding: "utf8", data: "x" } },
      { id: "same", kind: "message", dependsOn: [], message: { encoding: "utf8", data: "y" } },
    ],
    [
      { id: "cycle-a", kind: "message", dependsOn: ["cycle-b"], message: { encoding: "utf8", data: "x" } },
      { id: "cycle-b", kind: "message", dependsOn: ["cycle-a"], message: { encoding: "utf8", data: "y" } },
    ],
  ]) assert.throws(() => composeTbcWorkflow({ steps }), /dependency graph/u);
});

test("DApp multi-round convenience emits one bounded shared request and preserves explicit non-atomic result", async () => {
  const calls = [];
  const provider = {
    async request(request) {
      calls.push(structuredClone(request));
      if (request.method === "tbc_requestAccounts") return ["1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"];
      if (request.method !== "tbc_runMultiRoundMerge") throw new Error("unexpected request");
      return Object.freeze({
        version: "1.0", status: "complete", reason: "already-below-target",
        scopeHash: "ab".repeat(32), initialUtxoCount: 1, finalUtxoCount: 1,
        totalFee: "0", steps: Object.freeze([]), atomic: false,
        progress: Object.freeze([{ phase: "complete", stepIndex: 0, utxoCount: 1,
          targetUtxoCount: 1, transactionCount: 0, totalFee: "0" }]),
      });
    },
    on() {}, removeListener() {}, destroy() {},
  };
  const wallet = await createTbcClient({
    network: "testnet", provider, requestIdFactory: () => "bounded-dapp-merge",
  }).connect();
  const result = await wallet.maintenance.multiRoundMerge({
    asset: { kind: "stablecoin", contractId: "11".repeat(32) },
    limits: {
      targetUtxoCount: 1, maxTransactions: 2, maxTotalFee: "100",
      expiresAt: "2099-09-23T00:05:00Z",
    },
  });
  assert.equal(result.atomic, false);
  assert.equal(result.reason, "already-below-target");
  assert.deepEqual(calls[1], {
    method: "tbc_runMultiRoundMerge",
    params: {
      version: "1.0", chainId: DISCOVERY_CHAIN,
      from: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
      clientRequestId: "bounded-dapp-merge",
      asset: { kind: "stablecoin", contractId: "11".repeat(32) },
      limits: {
        targetUtxoCount: 1, maxTransactions: 2, maxTotalFee: "100",
        expiresAt: "2099-09-23T00:05:00Z",
      },
    },
  });
});

test("NFT hundreds use one job request; ordinary single-plan mint keeps its existing route", async () => {
  const calls=[];
  const provider={async request(request,options){calls.push(structuredClone(request));
    if(request.method==='tbc_requestAccounts') return ['1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH'];
    return {status:'complete',method:request.method};},on(){},removeListener(){},destroy(){}};
  const wallet=await createTbcClient({network:'testnet',provider}).connect();
  const items=Array.from({length:250},(_,i)=>({slot:i+1,name:`NFT ${i}`,symbol:'N',description:'',attributes:[]}));
  const limits={maxTotalFee:'100000',expiresAt:'2099-10-27T00:05:00Z'};
  await wallet.tbc721.batchMint({collectionId:'ab'.repeat(32),items,limits});
  assert.equal(calls.length,2);assert.equal(calls[1].method,'tbc_runNftMintJob');
  assert.deepEqual(calls[1].params.items,items);assert.deepEqual(calls[1].params.limits,limits);
  assert.equal(calls[1].params.chainId,'tbc:testnet');
  assert.throws(()=>wallet.tbc721.batchMint({collectionId:'ab'.repeat(32),items}),/whole-job limits/);
  assert.throws(()=>wallet.tbc721.batchMint({collectionId:'ab'.repeat(32),items,limits,constraints:{maxFee:'10'}}),/whole-job limits/);
  assert.equal(calls.length,2);
  await wallet.tbc721.batchMint({collectionId:'ab'.repeat(32),items:items.slice(0,2),constraints:{maxFee:'1000'}});
  assert.equal(calls.length,3);assert.equal(calls[2].method,'tbc_sendTransaction');
  assert.equal(calls[2].params.intent.type,'tbc721-standard-batch-mint');
});

test("new-standard reviewed signing and crypto helpers use independent methods", async () => {
  const calls = [];
  const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
  const provider = {
    async request(request) {
      calls.push(structuredClone(request));
      if (request.method === "tbc_requestAccounts") return [address];
      return { method: request.method, params: request.params };
    },
    on() {}, removeListener() {}, destroy() {},
  };
  const wallet = await createTbcClient({ network: "testnet", provider }).connect();
  await wallet.wallet.signReviewedTransaction({
    clientRequestId: "reviewed-1",
    request: {
      version: "1.0",
      payload: { format: "raw", transactions: [] },
    },
  });
  await wallet.crypto.encrypt({
    clientRequestId: "encrypt-1",
    message: { encoding: "utf8", data: "hello" },
  });
  await wallet.crypto.decrypt({
    clientRequestId: "decrypt-1",
    ciphertext: Buffer.alloc(85, 3).toString("base64"),
  });
  assert.deepEqual(calls.slice(1).map(({ method, params }) => [method, params.clientRequestId]), [
    ["tbc_signReviewedTransaction", "reviewed-1"],
    ["tbc_encrypt", "encrypt-1"],
    ["tbc_decrypt", "decrypt-1"],
  ]);
  assert.equal(calls.slice(1).some(({ method }) => method.includes("legacy")), false);
});

test("public maintenance and expiring Pool swap methods cross the bundled strict Provider boundary", async () => {
  const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
  const transported = [];
  const provider = createTbcProvider({
    transport: {
      async send(request) {
        transported.push(request);
        const deliveryId = transported.length.toString(16).padStart(64, "0");
        if (request.method === "tbc_requestAccounts") {
          return {
            deliveryId,
            response: { jsonrpc: "2.0", id: request.id, result: [address] },
            events: [],
          };
        }
        return {
          deliveryId,
          response: {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: 4001, message: "Focused transport stop after strict validation." },
          },
          events: [],
        };
      },
      subscribe() {
        return () => undefined;
      },
    },
  });
  const wallet = await createTbcClient({
    network: "testnet",
    provider,
    requestIdFactory: (() => {
      let next = 0;
      return () => `strict-merge-${String(++next)}`;
    })(),
  }).connect();

  const calls = [
    () => wallet.maintenance.mergeTbc(),
    () => wallet.maintenance.mergeFt({ contractId: "11".repeat(32) }),
    () => wallet.maintenance.mergeStablecoin({ contractId: "11".repeat(32) }),
    () => wallet.maintenance.mergePoolFt({ poolContractId: "22".repeat(32) }),
    () => wallet.maintenance.mergeFtlp({ poolContractId: "22".repeat(32) }),
    () => wallet.maintenance.burnFtlp({ poolContractId: "22".repeat(32) }),
    () => wallet.pool.buy({
      poolContractId: "22".repeat(32), receiver: address,
      tbcAmount: "1000", minimumFtAmount: "1",
      constraints: { expiresAt: "2099-09-20T04:00:00Z" },
    }),
    () => wallet.pool.sell({
      poolContractId: "22".repeat(32), receiver: address,
      ftAmount: "1000", minimumTbcAmount: "1",
      constraints: { expiresAt: "2099-09-20T04:00:00Z" },
    }),
  ];
  for (const call of calls) {
    await assert.rejects(call(), (error) => error?.code === 4001);
  }
  assert.deepEqual(
    transported.slice(1).map(({ method, params }) => [method, params.intent.type]),
    [
      ["tbc_sendTransaction", "tbc.maintenance.merge"],
      ["tbc_sendTransaction", "tbc.ft.merge"],
      ["tbc_sendTransaction", "tbc.stablecoin.merge"],
      ["tbc_sendTransaction", "tbc.pool.ft.merge"],
      ["tbc_sendTransaction", "tbc.pool.ftlp.merge"],
      ["tbc_sendTransaction", "tbc.pool.ftlp.burn"],
      ["tbc_sendTransaction", "tbc.pool.swap.exactTbcForToken"],
      ["tbc_sendTransaction", "tbc.pool.swap.exactTokenForTbc"],
    ],
  );

  const beforeMissingExpiry = transported.length;
  assert.throws(
    () => wallet.pool.buy({
      poolContractId: "22".repeat(32), receiver: address,
      tbcAmount: "1000", minimumFtAmount: "1",
    }),
    /Pool swap constraints\.expiresAt is required/u,
  );
  assert.equal(transported.length, beforeMissingExpiry, "missing swap expiry must fail before Transport");

  assert.throws(
    () => wallet.pool.buy({
      poolContractId: "22".repeat(32), receiver: address,
      tbcAmount: "1000", minimumFtAmount: "1",
      constraints: { expiresAt: "2000-01-01T00:00:00Z" },
    }),
    /Pool swap constraints\.expiresAt must be a future UTC time with second or millisecond precision/u,
  );
  assert.equal(transported.length, beforeMissingExpiry, "expired swap must fail before Transport");

  await assert.rejects(wallet.pool.buy({
      poolContractId: "22".repeat(32), receiver: address,
      tbcAmount: "1000", minimumFtAmount: "1",
      constraints: { expiresAt: "2099-09-20T04:00:00.123Z" },
  }), error => error?.code === 4001);
  assert.equal(transported.length, beforeMissingExpiry + 1, "millisecond swap expiry reaches Transport once");

  const beforeInvalid = transported.length;
  await assert.rejects(
    provider.request({
      method: "tbc_sendTransaction",
      params: {
        version: "1.0",
        chainId: DISCOVERY_CHAIN,
        from: address,
        clientRequestId: "invalid-merge-contract",
        intent: { version: "1.0", type: "tbc.ft.merge", contractId: "not-a-contract-id" },
      },
    }),
    (error) => error?.code === -32602,
  );
  assert.equal(transported.length, beforeInvalid);
  await provider.destroy();
});

test("catalog merge and exact descriptor selection isolate same-name wallet instances", async () => {
  const callsA = [];
  const callsA2 = [];
  const callsB = [];
  const walletA = discoveredWallet({
    productId: "org.example.alpha-wallet",
    name: "Shared Display Name",
    address: "alpha-address",
    calls: callsA,
  });
  const walletA2 = discoveredWallet({
    productId: "org.example.alpha-wallet",
    name: "Shared Display Name",
    address: "alpha-second-address",
    calls: callsA2,
  });
  const walletB = discoveredWallet({
    productId: "org.example.beta-wallet",
    name: "Shared Display Name",
    address: "beta-address",
    calls: callsB,
  });
  const client = createTbcClient({
    network: DISCOVERY_CHAIN,
    walletCatalog: [
      {
        productId: "org.example.alpha-wallet",
        name: "Alpha Partner Wallet",
        icon: "data:image/svg+xml;base64,PHN2Zy8+",
        homepageUrl: "https://alpha.example/",
        installUrl: "https://alpha.example/install",
      },
      {
        productId: "org.example.beta-wallet",
        name: "Beta Partner Wallet",
        icon: "data:image/svg+xml;base64,PHN2Zy8+",
        installUrl: "https://beta.example/install",
      },
      {
        productId: "org.example.guide-wallet",
        name: "Guide Wallet",
        icon: "data:image/svg+xml;base64,PHN2Zy8+",
        installUrl: "https://guide.example/install",
      },
    ],
  });
  const snapshots = [];
  const unsubscribe = client.subscribeWalletOptions((options) => snapshots.push(options));
  const registry = getWallets();
  const unregisterA = registry.register(walletA);
  const unregisterA2 = registry.register(walletA2);
  const unregisterB = registry.register(walletB);
  try {
    const choices = client.walletOptions();
    assert.deepEqual(
      choices.map(({ status, productId }) => [status, productId]),
      [
        ["detected", "org.example.alpha-wallet"],
        ["detected", "org.example.alpha-wallet"],
        ["detected", "org.example.beta-wallet"],
        ["not-detected", "org.example.guide-wallet"],
      ],
    );
    assert.equal(choices[3].catalog.installUrl, "https://guide.example/install");
    assert.equal(choices[3].wallet, undefined);
    assert.equal(client.wallets()[0].icon, walletA.icon);
    assert.equal(client.wallets()[1].icon, walletA2.icon);
    assert.equal(client.wallets()[2].icon, walletB.icon);
    await assert.rejects(
      client.connect({ walletName: "Shared Display Name" }),
      /Multiple TBC wallets.*descriptor/,
    );
    await assert.rejects(client.connect(), /Multiple TBC wallets.*descriptor/);

    const [descriptorA, descriptorA2, descriptorB] = client.wallets();
    const connectedA = await client.connect({ wallet: descriptorA });
    assert.equal(await connectedA.request("tbc_getCapabilities").then(({ productId }) => productId), "org.example.alpha-wallet");
    assert.deepEqual(callsA, ["tbc_requestAccounts", "tbc_getCapabilities"]);
    assert.deepEqual(callsA2, []);
    assert.deepEqual(callsB, []);

    const connectedA2 = await client.connect({ wallet: descriptorA2 });
    assert.equal(await connectedA2.request("tbc_getCapabilities").then(({ productId }) => productId), "org.example.alpha-wallet");
    assert.deepEqual(callsA, ["tbc_requestAccounts", "tbc_getCapabilities"]);
    assert.deepEqual(callsA2, ["tbc_requestAccounts", "tbc_getCapabilities"]);
    assert.deepEqual(callsB, []);

    const connectedB = await client.connect({ wallet: descriptorB });
    assert.equal(await connectedB.request("tbc_getCapabilities").then(({ productId }) => productId), "org.example.beta-wallet");
    assert.deepEqual(callsA, ["tbc_requestAccounts", "tbc_getCapabilities"]);
    assert.deepEqual(callsB, ["tbc_requestAccounts", "tbc_getCapabilities"]);

    assert.equal(snapshots.length, 3);
    unregisterA();
    assert.equal(snapshots.length, 4);
    assert.equal(snapshots.at(-1)[0].status, "detected");
    unregisterA2();
    assert.equal(snapshots.length, 5);
    assert.deepEqual(
      snapshots.at(-1).map(({ status, productId }) => [status, productId]),
      [
        ["not-detected", "org.example.alpha-wallet"],
        ["detected", "org.example.beta-wallet"],
        ["not-detected", "org.example.guide-wallet"],
      ],
    );
    unsubscribe();
    unregisterB();
    assert.equal(snapshots.length, 5);
  } finally {
    unsubscribe();
    unregisterA();
    unregisterA2();
    unregisterB();
  }
});

test("wallet catalog rejects duplicate product metadata and executable URL schemes", () => {
  const base = {
    productId: "org.example.wallet",
    name: "Example Wallet",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
  };
  assert.throws(
    () => createTbcClient({ network: "testnet", walletCatalog: [base, base] }),
    /must be unique/,
  );
  assert.throws(
    () => createTbcClient({
      network: "testnet",
      walletCatalog: [{ ...base, installUrl: "javascript:alert(1)" }],
    }),
    /must use HTTPS/,
  );
  assert.throws(
    () => createTbcClient({
      network: "testnet",
      walletCatalog: [{ ...base, icon: "data:text/html;base64,PHNjcmlwdD4=" }],
    }),
    /catalog icon/,
  );
});

test("RPC and API clients perform only explicit calls and ledger same-request duplicates", async () => {
  let fetchCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetch = async (_url, init) => {
    fetchCount += 1;
    await gate;
    const request = init?.body === undefined ? undefined : JSON.parse(init.body);
    return new Response(JSON.stringify(request?.jsonrpc === "1.0"
      ? { jsonrpc: "1.0", id: request.id, result: "ok" }
      : { ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const ledger = createRequestLedger({ enabled: true, now: (() => { let now = 0; return () => ++now; })() });
  const api = createTbcApiClient({ baseUrl: "https://example.test/base", fetch, ledger });
  const rpc = createTbcRpcClient({ url: "https://rpc.example.test", fetch, ledger });
  assert.equal(fetchCount, 0);
  const first = api.getJson("txraw/abc", { category: "txraw", concurrencyGroup: "parents" });
  const duplicate = api.getJson("txraw/abc", { category: "txraw", concurrencyGroup: "parents" });
  const rpcCall = rpc.call("getblockcount", [], { concurrencyGroup: "parents" });
  await Promise.resolve();
  assert.equal(fetchCount, 2);
  release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await duplicate, { ok: true });
  assert.equal(await rpcCall, "ok");
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.counts.txraw, 1);
  assert.equal(snapshot.counts.rpc, 1);
  assert.equal(snapshot.deduplicated, 1);
  assert.equal(snapshot.responseBytes, 51);
  assert.ok(snapshot.requests.filter((entry) => entry.status === "fulfilled").every((entry) => entry.durationMs > 0));
  assert.deepEqual(
    snapshot.requests.filter((entry) => entry.status !== "deduplicated").map((entry) => entry.concurrencyGroup),
    ["parents", "parents"],
  );
});
