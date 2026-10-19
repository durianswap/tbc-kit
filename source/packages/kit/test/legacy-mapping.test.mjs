import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const testingModule = process.env.TBC_KIT_TESTING_TEST_MODULE
  ? pathToFileURL(process.env.TBC_KIT_TESTING_TEST_MODULE).href
  : new URL("../dist/esm/testing.js", import.meta.url).href;
const { createLegacyKitFacade } = await import(testingModule);
import { turingTransactionId } from "../dist/esm/api.js";

const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";

test("Legacy facade follows the wallet-owned chain and fences an account-read race", async () => {
  let chainId = "tbc:testnet";
  const calls = [];
  const provider = {
    async request(request) {
      calls.push(request);
      if (request.method === "tbc_chainId") return chainId;
      return { transactions: [{ role: "primary", status: "submitted", txid: "ab".repeat(32) }] };
    },
    on() {}, removeListener() {}, destroy() {},
  };
  const facade = createLegacyKitFacade({
    provider, chainId: "tbc:testnet", readChainId: () => chainId,
    enabled: true, readAccount: async () => ADDRESS,
  });
  await facade.sendTransaction({ flag: "P2PKH", address: ADDRESS, satoshis: 1000 });
  chainId = "tbc:mainnet";
  await facade.sendTransaction({ flag: "P2PKH", address: ADDRESS, satoshis: 1000 });
  assert.deepEqual(calls.filter(({ method }) => method === "tbc_sendTransaction")
    .map(({ params }) => params.chainId), ["tbc:testnet", "tbc:mainnet"]);
  assert.deepEqual(await facade.getNetwork(), { network: "tbc", type: "mainnet" });
  facade.close();

  let resolveAccount;
  const pendingAccount = new Promise((resolve) => { resolveAccount = resolve; });
  chainId = "tbc:testnet";
  const racing = createLegacyKitFacade({
    provider, chainId: "tbc:testnet", readChainId: () => chainId,
    enabled: true, readAccount: () => pendingAccount,
  });
  const before = calls.length;
  const pending = racing.sendTransaction({ flag: "P2PKH", address: ADDRESS, satoshis: 1000 });
  chainId = "tbc:mainnet";
  resolveAccount(ADDRESS);
  await assert.rejects(pending, /authority changed/u);
  assert.equal(calls.length, before, "raced request must not reach Provider");
  racing.close();

  let revision = "0";
  let releaseMetadata;
  const metadata = new Promise((resolve) => { releaseMetadata = resolve; });
  let metadataStarted;
  const enteredMetadata = new Promise((resolve) => { metadataStarted = resolve; });
  const aba = createLegacyKitFacade({
    provider, chainId: "tbc:testnet", readChainId: () => chainId,
    readSessionRevision: () => revision,
    enabled: true, readAccount: async () => ADDRESS,
    options: { resolveFtDecimals: () => { metadataStarted(); return metadata; } },
  });
  chainId = "tbc:testnet";
  const prior = calls.length;
  const prepared = aba.sendTransaction({
    flag: "FT_TRANSFER", ft_contract_address: "11".repeat(32),
    address: ADDRESS, ft_amount: "1", broadcastEnabled: false,
  });
  await enteredMetadata;
  chainId = "tbc:mainnet"; revision = "1";
  chainId = "tbc:testnet"; revision = "2";
  releaseMetadata(6);
  assert.match((await prepared).error, /authority changed/u);
  assert.equal(calls.length, prior, "A-B-A switch must not submit a prepared old-view request");
  aba.close();
});

function harness(options = {}) {
  const calls = [];
  const provider = {
    async request(request) { calls.push(request); return { ok: true }; },
    on() {}, removeListener() {}, destroy() {},
  };
  return {
    calls,
    facade: createLegacyKitFacade({
      provider,
      chainId: CHAIN_ID,
      enabled: true,
      readAccount: async () => ADDRESS,
      options,
    }),
  };
}

test("request-list rejection precedes metadata, planning, signing, and broadcast", async () => {
  let metadataReads = 0;
  const { facade, calls } = harness({
    reviewRequests: async () => false,
    resolveFtDecimals: async () => { metadataReads += 1; return 6; },
  });
  await assert.rejects(() => facade.sendTransaction({
    flag: "FT_TRANSFER",
    ft_contract_address: "11".repeat(32),
    address: ADDRESS,
    ft_amount: "1",
    broadcastEnabled: false,
  }), /cancelled/u);
  assert.equal(metadataReads, 0);
  assert.equal(calls.length, 0);
});

test("Legacy TBC, FT, Pool swap, and LP map into the common Provider path", async () => {
  const { facade, calls } = harness({
    reviewRequests: async () => true,
    resolveFtDecimals: async () => 6,
    resolvePoolFtDecimals: async () => 6,
    now: () => new Date("2026-09-17T00:00:00Z"),
  });
  await facade.sendTransaction({ flag: "P2PKH", address: ADDRESS, satoshis: 1000, broadcastEnabled: false });
  await facade.sendTransaction({
    flag: "FT_MINT",
    ft_data: JSON.stringify({ name: "Token", symbol: "TOK", amount: 1, decimal: 6 }),
  });
  await facade.sendTransaction({
    flag: "FT_TRANSFER", ft_contract_address: "11".repeat(32), address: ADDRESS,
    ft_amount: "1.25", broadcastEnabled: false,
  });
  await facade.sendTransaction({
    flag: "POOLNFT_SWAP_TO_TOKEN", nft_contract_address: "22".repeat(32), address: ADDRESS,
    tbc_amount: "0.001", poolNFT_version: 2, broadcastEnabled: false,
  });
  await facade.sendTransaction({
    flag: "POOLNFT_SWAP_TO_TBC", nft_contract_address: "22".repeat(32), address: ADDRESS,
    ft_amount: "0.25", poolNFT_version: 2, broadcastEnabled: false,
  });
  await facade.sendTransaction({
    flag: "POOLNFT_LP_INCREASE", nft_contract_address: "22".repeat(32), address: ADDRESS,
    tbc_amount: "0.001", poolNFT_version: 2, broadcastEnabled: false,
  });
  await facade.sendTransaction({
    flag: "POOLNFT_LP_CONSUME", nft_contract_address: "22".repeat(32), address: ADDRESS,
    ft_amount: "0.0025009", poolNFT_version: 2, broadcastEnabled: false,
  });
  assert.deepEqual(calls.map((call) => call.method), [
    "tbc_signTransaction", "tbc_sendTransaction", "tbc_signTransaction",
    "tbc_signTransaction", "tbc_signTransaction", "tbc_signTransaction", "tbc_signTransaction",
  ]);
  assert.deepEqual(calls.map((call) => call.params.intent.type), [
    "tbc.transfer", "tbc.ft.create", "tbc.ft.transfer",
    "tbc.pool.swap.exactTbcForToken", "tbc.pool.swap.exactTokenForTbc",
    "tbc.pool.liquidity.add", "tbc.pool.liquidity.remove",
  ]);
  assert.equal(calls.at(-1).params.intent.lpAmount, "2500");
  assert.equal(calls[3].params.constraints.expiresAt, "2026-09-17T00:05:00.000Z");
});

test("Legacy merge entry points use canonical public maintenance intents and always broadcast", async () => {
  const { facade, calls } = harness({ reviewRequests: async () => true });
  const ftContractId = "11".repeat(32);
  const poolContractId = "22".repeat(32);
  await facade.mergeUtxos();
  await facade.mergeFtUtxos({ ft_contract_address: ftContractId.toUpperCase() });
  await facade.sendTransaction({ flag: "FT_MERGE", ft_contract_address: ftContractId, domain: "example.test" });
  await facade.sendTransaction({ flag: "POOLNFT_MERGE", nft_contract_address: poolContractId });
  await facade.sendTransaction({ flag: "FTLP_MERGE", nft_contract_address: poolContractId, domain: "example.test" });
  await facade.sendTransaction({ flag: "POOLNFT_LP_BURN", nft_contract_address: poolContractId });
  assert.deepEqual(calls.map((call) => call.method), Array(6).fill("tbc_sendTransaction"));
  assert.deepEqual(calls.map((call) => call.params.intent), [
    { version: "1.0", type: "tbc.maintenance.merge" },
    { version: "1.0", type: "tbc.ft.merge", contractId: ftContractId },
    { version: "1.0", type: "tbc.ft.merge", contractId: ftContractId },
    { version: "1.0", type: "tbc.pool.ft.merge", poolContractId },
    { version: "1.0", type: "tbc.pool.ftlp.merge", poolContractId },
    { version: "1.0", type: "tbc.pool.ftlp.burn", poolContractId },
  ]);
});

test("Legacy preserves historical results, business errors, dependent txids, and session close", async () => {
  const raw = `0a00000001${"00".repeat(32)}0000000000ffffffff01e803000000000000015100000000`;
  let signedMessage;
  const provider = {
    async request(request) {
      if (request.method === "tbc_signTransaction") {
        return { transactions: [{ role: "primary", status: "signed", rawTransaction: raw }] };
      }
      if (request.method === "tbc_signMessage") {
        assert.match(
          request.params.clientRequestId,
          /^legacy-bitcoin:[0-9a-f]{64}$/u,
        );
        signedMessage = request.params.message.data;
        return { address: ADDRESS, publicKey: `02${"11".repeat(32)}`, signature: "controlled-signature" };
      }
      return [];
    },
    on() {}, removeListener() {}, destroy() {},
  };
  const facade = createLegacyKitFacade({
    provider,
    chainId: CHAIN_ID,
    enabled: true,
    readAccount: async () => ADDRESS,
    options: { bitcoinMessageDigest: async () => "ab".repeat(32) },
  });
  assert.deepEqual(await facade.sendTransaction({ flag: "P2PKH", address: ADDRESS, satoshis: 1000, broadcastEnabled: false }), { txraw: raw });
  const batch = await facade.sendBatchRequest([
    { method: "sendTransaction", params: { flag: "P2PKH", address: ADDRESS, satoshis: 1000, broadcastEnabled: false } },
    { method: "signMessage", dependsOn: "txids", params: { encoding: "utf8", message: JSON.stringify({ purpose: "deposit" }) } },
  ]);
  assert.equal(batch[0].txraw, raw);
  assert.deepEqual(JSON.parse(signedMessage), { purpose: "deposit", txids: [turingTransactionId(raw)] });
  assert.equal(batch[1].message, signedMessage);
  facade.close();
  await assert.rejects(() => facade.getAddress(), /session closed/u);

  const rejected = createLegacyKitFacade({
    provider: { ...provider, async request() { const error = new Error("rejected"); error.code = 4001; throw error; } },
    chainId: CHAIN_ID, enabled: true, readAccount: async () => ADDRESS,
  });
  assert.deepEqual(await rejected.sendTransaction({ flag: "P2PKH", address: ADDRESS, satoshis: 1000, broadcastEnabled: false }), { error: "User cancelled the transaction" });
});
