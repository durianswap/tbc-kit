import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const moduleUrl = process.env.TBC_KIT_WALLET_TEST_MODULE
  ? pathToFileURL(process.env.TBC_KIT_WALLET_TEST_MODULE).href
  : new URL("../dist/esm/wallet.js", import.meta.url).href;
const { createTbcWallet, createTbcNetworkContext } = await import(moduleUrl);

const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const publicKey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const account = (chainId) => ({
  accountId: `${chainId}:${address}`, chainId, address, publicKey,
});
const now = "2026-10-08T00:00:00.000Z";

test("wallet-only broadcast recovery keeps historical chain journals separate", async () => {
  const routed = [];
  const calls = [];
  const unexpected = async () => { throw new Error("recovery must not submit or sign"); };
  const networkFor = (chainId) => ({
    network: createTbcNetworkContext({network: chainId === "tbc:mainnet" ? "mainnet" : "testnet"}),
    resolveChainData: unexpected, resolvePolicy: unexpected,
    broadcastSubmit: unexpected, broadcastSubmitBatch: unexpected,
    broadcastReconcile: unexpected,
    listBroadcastRecovery: async (limit) => {
      calls.push(["list", chainId, limit]);
      return [{chainId, state: "uncertain"}];
    },
    recoverBroadcasts: async (txids) => {
      calls.push(["recover", chainId, [...txids]]);
      return {chainId, txids};
    },
  });
  const runtime = createTbcWallet({
    accounts: {current: async () => [account("tbc:testnet")]},
    approval: {request: unexpected}, signer: {sign: unexpected},
    storage: {loadPermissions: unexpected, commitPermissions: unexpected},
    network: {forChain: async (chainId) => {
      routed.push(chainId);
      return networkFor(chainId);
    }},
    clock: () => now,
    randomBytes: length => Uint8Array.from({length}, (_, index) => index),
  });
  const session = await runtime.openSession({origin:"https://partner.example", sessionId:"wallet-recovery-catalog"});
  try {
    assert.deepEqual(await session.listBroadcastRecovery(), [{chainId:"tbc:testnet",state:"uncertain"}]);
    assert.deepEqual(await session.listBroadcastRecoveryForChain("tbc:mainnet", 2),
      [{chainId:"tbc:mainnet",state:"uncertain"}]);
    assert.deepEqual(await session.recoverBroadcastsForChain("tbc:mainnet", ["a".repeat(64)]),
      {chainId:"tbc:mainnet",txids:["a".repeat(64)]});
    assert.deepEqual(await session.recoverBroadcasts(["b".repeat(64)]),
      {chainId:"tbc:testnet",txids:["b".repeat(64)]});
    await assert.rejects(session.listBroadcastRecoveryForChain("tbc:unknown"));
    assert.deepEqual(routed,["tbc:testnet","tbc:mainnet","tbc:unknown"]);
    assert.deepEqual(calls,[
      ["list","tbc:testnet",undefined],
      ["list","tbc:mainnet",2],
      ["recover","tbc:mainnet",["a".repeat(64)]],
      ["recover","tbc:testnet",["b".repeat(64)]],
    ]);
  } finally {
    session.close();
  }
});

test("a wallet-owned network catalog selects the initial account chain without extra reads", async () => {
  const resolved = [];
  let accountReads = 0;
  const unexpected = async () => { throw new Error("unexpected transaction adapter call"); };
  const runtime = createTbcWallet({
    accounts: { current: async () => { accountReads++; return [account("tbc:mainnet")]; } },
    approval: { request: unexpected },
    signer: { sign: unexpected },
    storage: { loadPermissions: unexpected, commitPermissions: unexpected },
    network: { async forChain(chainId) {
      resolved.push(chainId);
      return {
        network: createTbcNetworkContext({ network: "mainnet" }),
        resolveChainData: unexpected,
        resolvePolicy: unexpected,
        broadcastSubmit: unexpected,
        broadcastSubmitBatch: unexpected,
        broadcastReconcile: unexpected,
      };
    } },
    clock: () => now,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: "https://partner.example", sessionId: "mainnet-catalog-start",
  });
  try {
    assert.equal(await session.provider.request({ method: "tbc_chainId" }), "tbc:mainnet");
    assert.deepEqual(resolved, ["tbc:mainnet"]);
    assert.equal(accountReads, 1);
  } finally {
    session.close();
  }
});

test("a wallet-owned network catalog cannot bind a mismatched chain", async () => {
  let warmups = 0;
  const unexpected = async () => { throw new Error("unexpected transaction adapter call"); };
  const runtime = createTbcWallet({
    accounts: { current: async () => [account("tbc:mainnet")] },
    approval: { request: unexpected },
    signer: { sign: unexpected },
    storage: { loadPermissions: unexpected, commitPermissions: unexpected },
    network: { forChain: async () => ({
      network: createTbcNetworkContext({ network: "testnet" }),
      warmup: async () => { warmups++; },
      resolveChainData: unexpected,
      resolvePolicy: unexpected,
      broadcastSubmit: unexpected,
      broadcastSubmitBatch: unexpected,
      broadcastReconcile: unexpected,
    }) },
  });
  await assert.rejects(runtime.openSession({
    origin: "https://partner.example", sessionId: "wrong-network-catalog",
  }));
  assert.equal(warmups, 0);
});

test("a wallet-owned network catalog rejects endpoint fields outside its identity", async () => {
  const unexpected = async () => { throw new Error("unexpected transaction adapter call"); };
  const canonical = createTbcNetworkContext({ network: "mainnet" });
  const runtime = createTbcWallet({
    accounts: { current: async () => [account("tbc:mainnet")] },
    approval: { request: unexpected }, signer: { sign: unexpected },
    storage: { loadPermissions: unexpected, commitPermissions: unexpected },
    network: { forChain: () => ({
      network: { ...canonical, endpoint: { ...canonical.endpoint, apiOrigin: "https://wrong.example" } },
      resolveChainData: unexpected, resolvePolicy: unexpected,
      broadcastSubmit: unexpected, broadcastSubmitBatch: unexpected,
      broadcastReconcile: unexpected,
    }) },
  });
  await assert.rejects(runtime.openSession({
    origin: "https://partner.example", sessionId: "forged-network-context",
  }));
});

test("a fully wallet-owned Kit catalog switches the committed chain without network I/O", async () => {
  const unexpected = async () => { throw new Error("switch must not use a transaction adapter"); };
  const permission = (chainId) => ({
    id:`switch-${chainId}`, parentCapability:"tbc_switchChain",
    invoker:"https://partner.example", date:Date.parse("2026-10-07T00:00:00Z"),
    caveats:[
      {type:"restrictChains",value:[chainId]},
      {type:"restrictAccounts",value:[`${chainId}:${address}`]},
      {type:"restrictMethods",value:["tbc_switchChain"]},
    ],
  });
  const selected = [];
  const runtime = createTbcWallet({
    accounts: {
      current:async()=>[account("tbc:testnet")],
      forChain:async(chainId)=>[account(chainId)],
    },
    approval:{request:async(params)=>({
      status:"approved",approvalId:"switch-review",approvalToken:"switch-token",
      bindingHash:params.binding.bindingHash,approvedAt:now,
      expiresAt:params.binding.payload.expiresAt,
    })},
    signer:{sign:unexpected},
    storage:{loadPermissions:async()=>({revision:"0",permissions:[permission("tbc:mainnet"),permission("tbc:testnet")]}),
      commitPermissions:unexpected},
    network:{forChain:async(chainId)=>{
      selected.push(chainId);
      return {network:createTbcNetworkContext({network:chainId==="tbc:mainnet"?"mainnet":"testnet"}),
        resolveChainData:unexpected,resolvePolicy:unexpected,broadcastSubmit:unexpected,
        broadcastSubmitBatch:unexpected,broadcastReconcile:unexpected};
    }},
    clock:()=>now,randomBytes:length=>Uint8Array.from({length},(_,index)=>index),
  });
  const session=await runtime.openSession({origin:"https://partner.example",sessionId:"kit-catalog-switch"});
  try {
    assert.equal(await session.provider.request({method:"tbc_chainId"}),"tbc:testnet");
    assert.equal(await session.provider.request({method:"tbc_switchChain",params:{chainId:"tbc:mainnet"}}),null);
    assert.equal(await session.provider.request({method:"tbc_chainId"}),"tbc:mainnet");
    assert.equal(await session.provider.request({method:"tbc_switchChain",params:{chainId:"tbc:testnet"}}),null);
    assert.equal(await session.provider.request({method:"tbc_chainId"}),"tbc:testnet");
    assert.deepEqual(selected,["tbc:testnet","tbc:mainnet"],"configured resources are cached, not re-fetched");
  } finally { session.close(); }
});

test("target-chain permission resolution uses wallet inventory, not the active account snapshot", async () => {
  const reads = [];
  const accountQueries = [];
  const commits = [];
  let approvals = 0;
  const unexpected = async () => { throw new Error("unexpected transaction adapter call"); };
  const runtime = createTbcWallet({
    accounts: {
      current: async () => { reads.push("current"); return [account("tbc:testnet")]; },
      forChain: async (chainId) => {
        accountQueries.push(chainId);
        assert.equal(chainId, "tbc:mainnet");
        return [account("tbc:mainnet")];
      },
    },
    approval: { async request(params) {
      approvals++;
      assert.equal(params.binding.payload.operationKind, "permission");
      return {
        status: "approved",
        approvalId: "target-chain-permission",
        approvalToken: "target-chain-token",
        bindingHash: params.binding.bindingHash,
        approvedAt: now,
        expiresAt: params.binding.payload.expiresAt,
      };
    } },
    signer: { sign: unexpected },
    storage: {
      async loadPermissions() { return { revision: "0", permissions: [] }; },
      async commitPermissions(params) {
        commits.push(params);
        return { revisions: params.changes.map((change) => ({ scope: change.scope, revision: "1" })) };
      },
    },
    network: {
      resolveChainData: unexpected,
      resolvePolicy: unexpected,
      broadcastSubmit: unexpected,
      broadcastReconcile: unexpected,
    },
    clock: () => now,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: "https://partner.example",
    sessionId: "target-chain-permission",
  });
  try {
    const result = await session.provider.request({
      method: "wallet_requestPermissions",
      params: [{ tbc_switchChain: { chains: ["tbc:mainnet"] } }],
    });
    assert.ok(Array.isArray(result));
    assert.equal(approvals, 1);
    assert.deepEqual(accountQueries, ["tbc:mainnet"]);
    assert.equal(commits.length, 1);
    const target = commits[0].changes.find((change) => change.scope.chainId === "tbc:mainnet");
    assert.ok(target);
    assert.deepEqual(target.permissions[0].caveats.find((c) => c.type === "restrictAccounts").value,
      ["tbc:mainnet:" + address]);
    assert.equal(reads.length, 1, "target permission must not reread the active account on the hot path");
  } finally {
    session.close();
  }

});

test("a duplicated target-chain account cannot become a permission grant", async () => {
  let approvalRequests = 0;
  let permissionCommits = 0;
  const unexpected = async () => { throw new Error("unexpected transaction adapter call"); };
  const target = account("tbc:mainnet");
  const runtime = createTbcWallet({
    accounts: {
      current: async () => [account("tbc:testnet")],
      forChain: async () => [target, target],
    },
    approval: { async request() { approvalRequests++; throw new Error("duplicate accounts reached approval"); } },
    signer: { sign: unexpected },
    storage: {
      async loadPermissions() { return { revision: "0", permissions: [] }; },
      async commitPermissions() { permissionCommits++; throw new Error("duplicate accounts reached storage"); },
    },
    network: {
      resolveChainData: unexpected,
      resolvePolicy: unexpected,
      broadcastSubmit: unexpected,
      broadcastReconcile: unexpected,
    },
    clock: () => now,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: "https://partner.example", sessionId: "duplicate-target-account",
  });
  try {
    await assert.rejects(session.provider.request({
      method: "wallet_requestPermissions",
      params: [{ tbc_switchChain: { chains: ["tbc:mainnet"] } }],
    }));
    assert.equal(approvalRequests, 0);
    assert.equal(permissionCommits, 0);
  } finally {
    session.close();
  }
});

test("a wallet without committed target-network routing never reports a successful switch", async () => {
  const permission = {
    id: "target-chain-switch",
    parentCapability: "tbc_switchChain",
    invoker: "https://partner.example",
    date: Date.parse("2026-10-07T00:00:00Z"),
    caveats: [
      { type: "restrictChains", value: ["tbc:mainnet"] },
      { type: "restrictAccounts", value: [`tbc:mainnet:${address}`] },
      { type: "restrictMethods", value: ["tbc_switchChain"] },
    ],
  };
  let approvals = 0;
  const unexpected = async () => { throw new Error("unexpected chain or signing callback"); };
  const runtime = createTbcWallet({
    accounts: {
      current: async () => [account("tbc:testnet")],
      forChain: async () => [account("tbc:mainnet")],
    },
    approval: { async request(params) {
      approvals++;
      assert.equal(params.binding.payload.operationKind, "switchChain");
      return {
        status: "approved",
        approvalId: "cross-chain-review",
        approvalToken: "cross-chain-token",
        bindingHash: params.binding.bindingHash,
        approvedAt: now,
        expiresAt: params.binding.payload.expiresAt,
      };
    } },
    signer: { sign: unexpected },
    storage: {
      async loadPermissions() { return { revision: "0", permissions: [permission] }; },
      commitPermissions: unexpected,
    },
    network: {
      resolveChainData: unexpected,
      resolvePolicy: unexpected,
      broadcastSubmit: unexpected,
      broadcastReconcile: unexpected,
    },
    clock: () => now,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: "https://partner.example",
    sessionId: "cross-chain-without-route",
  });
  try {
    await assert.rejects(session.provider.request({
      method: "tbc_switchChain",
      params: { chainId: "tbc:mainnet" },
    }));
    assert.equal(approvals, 1, "the test must reach a genuine approved Core proposal");
    assert.equal(await session.provider.request({ method: "tbc_chainId" }), "tbc:testnet");
  } finally {
    session.close();
  }

  let nativeCommits = 0;
  const nativeAuthority = {
    currentContext: {
      sessionId: "cross-chain-injected",
      navigationId: "first-document",
      transport: "webview",
      origin: "https://partner.example",
      topOrigin: "https://partner.example",
      frame: "top",
      createdAt: now,
    },
    currentSession: {
      version: "1.0",
      scope: { walletProfile: "tbc-kit-wallet", sessionId: "cross-chain-injected" },
      state: {
        version: "1.0",
        sessionId: "cross-chain-injected",
        revision: "0",
        connected: true,
        activeChainId: "tbc:testnet",
        activeAccountIds: [`tbc:testnet:${address}`],
      },
    },
  };
  const injected = await runtime.openSession({
    authority: {
      read: async () => structuredClone(nativeAuthority),
      compareAndSwapSession: async () => {
        nativeCommits++;
        throw new Error("An unprepared target must not reach native CAS");
      },
    },
  });
  try {
    await assert.rejects(injected.provider.request({
      method: "tbc_switchChain",
      params: { chainId: "tbc:mainnet" },
    }));
    assert.equal(approvals, 2);
    assert.equal(nativeCommits, 0);
    assert.equal(await injected.provider.request({ method: "tbc_chainId" }), "tbc:testnet");
  } finally {
    injected.close();
  }
});
