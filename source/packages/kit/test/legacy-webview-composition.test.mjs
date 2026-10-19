import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

import { hashCanonical } from "@tbc-wallet/core";
const walletModule = process.env.TBC_KIT_WALLET_TEST_MODULE
  ? pathToFileURL(process.env.TBC_KIT_WALLET_TEST_MODULE).href
  : new URL("../dist/esm/wallet.js", import.meta.url).href;
const {
  TBC_KIT_LEGACY_CONTRACT_BUNDLE_SHA256,
  TBC_KIT_LEGACY_CONTRACT_VERSION,
  TBC_KIT_LEGACY_PAGE_BOOTSTRAP_SCRIPT,
  TBC_KIT_LEGACY_WEBVIEW_CHANNEL,
  createTbcNetworkContext,
  createTbcKitLegacyWebViewNativeController,
  createTbcWallet,
} = await import(walletModule);

const chainId = "tbc:testnet";
const address = "1LegacyAddress";
const publicKey = `02${"11".repeat(32)}`;
const signature = "legacy-signature";
const ftRawTransaction =
  `0a00000001${"11".repeat(32)}0000000000ffffffff` +
  "0100000000000000000000000000";
const navigation = Object.freeze({
  webViewInstanceId: "legacy-webview-1",
  sessionId: "legacy-session-1",
  navigationId: "legacy-navigation-1",
  committedUrl: "https://dapp.example/app",
  origin: "https://dapp.example",
  topOrigin: "https://dapp.example",
  frame: "top",
  createdAt: "2026-09-18T00:00:00Z",
});

function pageHarness() {
  const nativePosts = [];
  const pageWindow = new EventTarget();
  const pageDocument = new EventTarget();
  Object.assign(pageWindow, {
    window: pageWindow,
    top: pageWindow,
    ReactNativeWebView: Object.freeze({
      postMessage(serialized) {
        nativePosts.push(serialized);
      },
    }),
  });
  const context = vm.createContext({
    window: pageWindow,
    document: pageDocument,
    CustomEvent,
    Event,
    EventTarget,
    MessageEvent,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    crypto: webcrypto,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(TBC_KIT_LEGACY_PAGE_BOOTSTRAP_SCRIPT, context, {
    timeout: 5_000,
    filename: "tbc-kit-legacy-page-bootstrap.js",
  });
  return { context, nativePosts, pageDocument, pageWindow };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("Kit Legacy page/native remains connected after 2200 sequential reads", async () => {
  const page=pageHarness(),closes=[];let controller,ordinal=0;
  page.pageWindow.ReactNativeWebView=Object.freeze({postMessage(serialized){void controller.acceptPageMessage(serialized);}});
  controller=createTbcKitLegacyWebViewNativeController({navigation,chainId,platform:'ios',walletVersion:'session-audit',
    handlers:{async send(request){assert.equal(request.method,'tbc_chainId');return {deliveryId:(++ordinal).toString(16).padStart(64,'0'),response:{jsonrpc:'2.0',id:request.id,result:chainId},events:[]};},async acknowledgeDelivery(){},async cancel(){},async close(reason){closes.push(reason);}},
    async post(serialized){page.pageWindow.dispatchEvent(new MessageEvent('message',{data:serialized}));},
  });
  controller.initialize();await settle();
  for(let i=0;i<2200;i++)assert.deepEqual(plain(await page.pageWindow.Turing.getNetwork()),{network:'tbc',type:'testnet'});
  assert.equal(page.pageWindow.Turing.isReady,true);assert.deepEqual(closes,[]);
  await controller.close();
});

test("the Kit Legacy page/native composition preserves connect, message, event, and ACK semantics", async () => {
  const page = pageHarness();
  const requests = [];
  const acknowledgments = [];
  const closes = [];
  let deliverySequence = 0;
  let controller;

  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) {
      void controller.acceptPageMessage(serialized);
    },
  });

  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "ios",
    walletVersion: "0.1.0-candidate.52",
    bitcoinMessages: {
      async prepare(input) {
        assert.deepEqual(input, { message: "hello", encoding: "utf8" });
        return Object.freeze({
          ...input,
          digest: "ab".repeat(32),
        });
      },
    },
    handlers: {
      async send(request, authority) {
        assert.deepEqual(authority, navigation);
        requests.push(structuredClone(request));
        deliverySequence += 1;
        const deliveryId = deliverySequence.toString(16).padStart(64, "0");
        if (request.method === "wallet_requestPermissions") {
          return Object.freeze({
            deliveryId,
            response: Object.freeze({ jsonrpc: "2.0", id: request.id, result: [] }),
            events: Object.freeze([]),
          });
        }
        if (request.method === "tbc_accounts") {
          return Object.freeze({
            deliveryId,
            response: Object.freeze({
              jsonrpc: "2.0",
              id: request.id,
              result: Object.freeze([address]),
            }),
            events: Object.freeze([
              Object.freeze({ name: "accountsChanged", payload: Object.freeze([address]) }),
            ]),
          });
        }
        if (request.method === "tbc_signMessage") {
          assert.equal(request.params.clientRequestId, `legacy-bitcoin:${"ab".repeat(32)}`);
          assert.deepEqual(request.params.message, {
            encoding: "utf8",
            data: "hello",
          });
          return Object.freeze({
            deliveryId,
            response: Object.freeze({
              jsonrpc: "2.0",
              id: request.id,
              result: Object.freeze({
                address,
                publicKey,
                signature,
                envelope: Object.freeze({
                  message: Object.freeze({ encoding: "utf8", data: "hello" }),
                }),
              }),
            }),
            events: Object.freeze([]),
          });
        }
        throw new Error(`unexpected method ${request.method}`);
      },
      async acknowledgeDelivery(deliveryId, authority) {
        assert.deepEqual(authority, navigation);
        acknowledgments.push(deliveryId);
      },
      async cancel() {},
      async close(reason, authority) {
        closes.push({ reason, authority });
      },
    },
    async post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });

  assert.equal(page.pageWindow.Turing, undefined);
  controller.initialize();
  await settle();
  const facade = page.pageWindow.Turing;
  assert.equal(Object.isFrozen(facade), true);
  assert.equal(facade.isReady, true);
  assert.equal(TBC_KIT_LEGACY_WEBVIEW_CHANNEL, "legacy-window-turing-webview/1");
  assert.equal(facade.evm, undefined);
  assert.equal(facade.btc, undefined);
  assert.equal(TBC_KIT_LEGACY_CONTRACT_VERSION, "1.0.5");
  assert.equal(
    TBC_KIT_LEGACY_CONTRACT_BUNDLE_SHA256,
    JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../../contracts/legacy-window-turing/v1/manifest.json',import.meta.url),'utf8')).bundleSha256,
  );

  const accountEvents = [];
  facade.on("TuringAccountChanged", (value) => accountEvents.push(value));
  assert.deepEqual(plain(await facade.connect()), { tbcAddress: address });
  await settle();
  assert.deepEqual(Object.keys(requests[0].params[0]).sort(), [
    "tbc_accountMetadata",
    "tbc_accounts",
    "tbc_crypto",
    "tbc_signMessage",
    "tbc_signTransaction",
    "tbc_signWorkflow",
  ]);
  assert.deepEqual(plain(accountEvents), [
    { addresses: { tbcAddress: address } },
  ]);

  assert.deepEqual(
    plain(await facade.signMessage({ message: "hello", encoding: "utf8" })),
    {
      address,
      maddress: address,
      pubkey: publicKey,
      pubKey: publicKey,
      message: "hello",
      sig: signature,
    },
  );
  await settle();
  assert.equal(requests.at(-1).method, "tbc_signMessage");
  assert.deepEqual(acknowledgments, [
    "1".padStart(64, "0"),
    "2".padStart(64, "0"),
    "3".padStart(64, "0"),
    "4".padStart(64, "0"),
  ]);

  assert.deepEqual(
    plain(await facade.signMessage({ message: "hello", encoding: "utf-8" })),
    {
      address,
      maddress: address,
      pubkey: publicKey,
      pubKey: publicKey,
      message: "hello",
      sig: signature,
    },
  );
  await settle();
  assert.deepEqual(requests.at(-1).params.message, {
    encoding: "utf8",
    data: "hello",
  });

  const beforeUnsupported = requests.length;
  assert.deepEqual(
    plain(await facade.sendTransaction({ flag: "P2PKH" })),
    { error: "Unsupported legacy operation" },
  );
  assert.equal(requests.length, beforeUnsupported);

  await controller.close("TRANSPORT_CLOSED");
  assert.deepEqual(closes, [
    { reason: "TRANSPORT_CLOSED", authority: navigation },
  ]);
});

test("partner Legacy policy rejects historical creation before Host dispatch but keeps NFT transfer", async () => {
  const page = pageHarness();
  let controller;
  let hostCalls = 0;
  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) { void controller.acceptPageMessage(serialized); },
  });
  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "android",
    walletVersion: "partner-test",
    allowHistoricalAssetCreation: false,
    transactions: Object.freeze({}),
    handlers: {
      async send() { hostCalls++; throw new Error("historical creation reached Host"); },
      async cancel() {},
      async close() {},
    },
    post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });
  controller.initialize();
  await settle();
  const denied = [
    [{ flag: "FT_MINT" }],
    { flag: "COLLECTION_CREATE" },
    { flag: "NFT_CREATE" },
    [{ flag: "POOLNFT_MINT", broadcastEnabled: false }],
    [{ flag: "POOLNFT_INIT", broadcastEnabled: false }],
  ];
  for (const params of denied) {
    assert.equal(controller.supportsRequest("sendTransaction", params), false);
    assert.deepEqual(plain(await page.pageWindow.Turing.sendTransaction(params)),
      { error: "Unsupported legacy operation" });
  }
  assert.equal(controller.supportsRequest("sendTransaction", { flag: "NFT_TRANSFER" }), true);
  assert.equal(hostCalls, 0);
  await controller.close();
});

test("Kit accepts only the bounded single-item Legacy P2PKH array on the active route", async () => {
  const page = pageHarness();
  const source = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
  const recipient = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
  const accountId = `${chainId}:${source}`;
  const p2pkh = Object.freeze({
    flag: "P2PKH",
    address: recipient,
    satoshis: 25_000,
    broadcastEnabled: false,
  });
  const requests = [];
  let controller;
  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) {
      void controller.acceptPageMessage(serialized);
    },
  });
  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "ios",
    walletVersion: "0.1.0-candidate.98",
    transactions: {
      async readTransactionContext() {
        return Object.freeze({
          address: source,
          permissions: Object.freeze([
            Object.freeze({
              parentCapability: "tbc_signTransaction",
              invoker: navigation.origin,
              caveats: Object.freeze([
                Object.freeze({ type: "restrictChains", value: Object.freeze([chainId]) }),
                Object.freeze({ type: "restrictAccounts", value: Object.freeze([accountId]) }),
                Object.freeze({ type: "restrictMethods", value: Object.freeze(["tbc_signTransaction"]) }),
              ]),
            }),
          ]),
        });
      },
    },
    handlers: {
      async send(request) {
        requests.push(structuredClone(request));
        assert.equal(request.method, "tbc_signTransaction");
        assert.equal(request.params.intent.type, "tbc.transfer");
        assert.equal(request.params.intent.to, recipient);
        assert.equal(request.params.intent.amount, "25000");
        return Object.freeze({
          deliveryId: "9".repeat(64),
          response: Object.freeze({
            jsonrpc: "2.0",
            id: request.id,
            result: Object.freeze({
              transactions: Object.freeze([
                Object.freeze({ rawTransaction: ftRawTransaction }),
              ]),
            }),
          }),
          events: Object.freeze([]),
        });
      },
      async acknowledgeDelivery() {},
      async cancel() {},
      async close() {},
    },
    async post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });
  controller.initialize();
  await settle();

  assert.equal(controller.supportsRequest("sendTransaction", p2pkh), true);
  assert.equal(controller.supportsRequest("sendTransaction", [p2pkh]), true);
  assert.equal(controller.supportsRequest("sendTransaction", []), false);
  assert.equal(controller.supportsRequest("sendTransaction", [p2pkh, p2pkh]), false);
  assert.deepEqual(
    plain(await page.pageWindow.Turing.sendTransaction([p2pkh])),
    { txraw: ftRawTransaction },
  );
  await settle();
  assert.equal(requests.length, 1);
});

test("Legacy P2PKH preserves broadcast and default-broadcast txid semantics", async () => {
  const page = pageHarness();
  const source = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
  const recipient = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
  const accountId = `${chainId}:${source}`;
  const requests = [];
  let controller;
  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) { void controller.acceptPageMessage(serialized); },
  });
  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "ios",
    walletVersion: "0.1.0-candidate.142",
    transactions: {
      async readTransactionContext() {
        return Object.freeze({
          address: source,
          permissions: Object.freeze([Object.freeze({
            parentCapability: "tbc_sendTransaction",
            invoker: navigation.origin,
            caveats: Object.freeze([
              Object.freeze({ type: "restrictChains", value: Object.freeze([chainId]) }),
              Object.freeze({ type: "restrictAccounts", value: Object.freeze([accountId]) }),
              Object.freeze({ type: "restrictMethods", value: Object.freeze(["tbc_sendTransaction"]) }),
            ]),
          })]),
        });
      },
    },
    handlers: {
      async send(request) {
        requests.push(structuredClone(request));
        assert.equal(request.method, "tbc_sendTransaction");
        assert.equal(request.params.constraints.maxFee, "1000");
        return Object.freeze({
          deliveryId: String(request.id).includes("broadcast-true") ? "a".repeat(64) : "b".repeat(64),
          response: Object.freeze({
            jsonrpc: "2.0",
            id: request.id,
            result: Object.freeze({ transactions: Object.freeze([
              Object.freeze({ txid: "ab".repeat(32) }),
            ]) }),
          }),
          events: Object.freeze([]),
        });
      },
      async acknowledgeDelivery() {},
      async cancel() {},
      async close() {},
    },
    async post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });
  controller.initialize();
  await settle();
  const base = Object.freeze({ flag: "P2PKH", address: recipient, satoshis: "25000" });
  assert.deepEqual(
    plain(await page.pageWindow.Turing.sendTransaction({ ...base, broadcastEnabled: true })),
    { txid: "ab".repeat(32) },
  );
  assert.deepEqual(
    plain(await page.pageWindow.Turing.sendTransaction(base)),
    { txid: "ab".repeat(32) },
  );
  assert.equal(requests.length, 2);
});

test("standalone Legacy FT transfer uses the shared transaction route", async () => {
  const page = pageHarness();
  const requests = [];
  const acknowledgments = [];
  const progress = [];
  const resolverCalls = [];
  let deliverySequence = 0;
  let controller;

  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) {
      void controller.acceptPageMessage(serialized);
    },
  });

  const permissions = Object.freeze([
    Object.freeze({
      parentCapability: "tbc_signTransaction",
      invoker: navigation.origin,
      caveats: Object.freeze([
        Object.freeze({ type: "restrictChains", value: Object.freeze([chainId]) }),
        Object.freeze({
          type: "restrictAccounts",
          value: Object.freeze([`${chainId}:${address}`]),
        }),
        Object.freeze({
          type: "restrictMethods",
          value: Object.freeze(["tbc_signTransaction"]),
        }),
      ]),
    }),
  ]);
  const legacyFt = Object.freeze({
    flag: "FT_TRANSFER",
    address: "1Recipient",
    ft_contract_address: "ab".repeat(32),
    ft_amount: "2.5",
    tbc_amount: "0",
    broadcastEnabled: false,
  });

  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "ios",
    walletVersion: "0.1.0-candidate.56",
    bitcoinMessages: {
      async prepare(input) {
        assert.equal(input.encoding, "utf8");
        assert.equal(JSON.parse(input.message).purpose, "deposit");
        assert.equal(JSON.parse(input.message).txids.length, 1);
        return Object.freeze({ ...input, digest: "cd".repeat(32) });
      },
    },
    transactions: {
      ftTransferIntents: {
        async resolve(request, source, onMetadata) {
          resolverCalls.push({ request, source });
          onMetadata?.(6);
          return Object.freeze({
            version: "1.0",
            chainId,
            from: source,
            clientRequestId: `legacy-ft-transfer:${resolverCalls.length}`,
            intent: Object.freeze({
              version: "1.0",
              type: "tbc.ft.transfer",
              contractId: "ab".repeat(32),
              to: "1Recipient",
              amount: "2500000",
            }),
          });
        },
      },
      async readTransactionContext(authority) {
        assert.deepEqual(authority, navigation);
        return Object.freeze({ address, permissions });
      },
      onBatchProgress(value) {
        progress.push(value);
      },
    },
    handlers: {
      async send(request, authority) {
        assert.deepEqual(authority, navigation);
        requests.push(structuredClone(request));
        deliverySequence += 1;
        const deliveryId = deliverySequence.toString(16).padStart(64, "0");
        if (request.method === "tbc_signTransaction") {
          return Object.freeze({
            deliveryId,
            response: Object.freeze({
              jsonrpc: "2.0",
              id: request.id,
              result: Object.freeze({
                transactions: Object.freeze([
                  Object.freeze({ rawTransaction: ftRawTransaction }),
                ]),
              }),
            }),
            events: Object.freeze([]),
          });
        }
        if (request.method === "tbc_signMessage") {
          return Object.freeze({
            deliveryId,
            response: Object.freeze({
              jsonrpc: "2.0",
              id: request.id,
              result: Object.freeze({
                address,
                publicKey,
                signature,
                envelope: Object.freeze({ message: request.params.message }),
              }),
            }),
            events: Object.freeze([]),
          });
        }
        throw new Error(`unexpected method ${request.method}`);
      },
      async acknowledgeDelivery(deliveryId) {
        acknowledgments.push(deliveryId);
      },
      async cancel() {},
      async close() {},
    },
    async post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });

  controller.initialize();
  await settle();
  const facade = page.pageWindow.Turing;
  const batch = [
    { method: "sendTransaction", params: legacyFt },
    {
      method: "signMessage",
      dependsOn: "txids",
      params: {
        message: JSON.stringify({ purpose: "deposit" }),
        encoding: "utf8",
      },
    },
  ];
  assert.equal(controller.supportsRequest("sendTransaction", legacyFt), true);
  assert.equal(controller.supportsRequest("sendBatchRequest", batch), false);
  assert.equal(
    controller.supportsRequest("sendTransaction", {
      flag: "P2PKH",
      broadcastEnabled: false,
    }),
    false,
  );
  assert.deepEqual(plain(await facade.sendTransaction(legacyFt)), {
    txraw: ftRawTransaction,
  });
  await settle();

  const result = plain(await facade.sendBatchRequest(batch));
  await settle();
  assert.deepEqual(result, { error: "Unsupported legacy operation" });
  assert.equal(resolverCalls.length, 1);
  assert.deepEqual(requests.map((request) => request.method), ["tbc_signTransaction"]);
  assert.equal(requests[0].params.constraints.maxFee, "10000");
  assert.deepEqual(progress, []);
  assert.deepEqual(acknowledgments, ["1".padStart(64, "0")]);
});

test("Kit Legacy FT transfer crosses permission commit into one real wallet session transaction", async () => {
  const source = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
  const recipient = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
  const accountId = `${chainId}:${source}`;
  const contractId = "ab".repeat(32);
  const now = "2026-09-18T00:00:10Z";
  const expiresAt = "2026-09-18T00:05:00Z";
  const account = Object.freeze({
    accountId,
    address: source,
    chainId,
    publicKey: `02${"11".repeat(32)}`,
  });
  const permission = (capability) => Object.freeze({
    id: `legacy-ft-session-${capability}`,
    parentCapability: capability,
    invoker: navigation.origin,
    date: Date.parse(navigation.createdAt),
    caveats: Object.freeze([
      Object.freeze({ type: "restrictChains", value: Object.freeze([chainId]) }),
      Object.freeze({ type: "restrictAccounts", value: Object.freeze([accountId]) }),
      Object.freeze({ type: "restrictMethods", value: Object.freeze([capability]) }),
    ]),
  });
  let permissions = Object.freeze([permission("tbc_accounts")]);
  let revision = "0";
  const snapshotPayload = Object.freeze({
    version: "1.0",
    snapshotId: "legacy-ft-session-snapshot",
    chainId,
    block: Object.freeze({ height: "1000", hash: "aa".repeat(32) }),
    capturedAt: now,
    expiresAt,
    account,
    utxos: Object.freeze([
      Object.freeze({
        txid: "33".repeat(32),
        vout: 0,
        satoshis: "1000",
        scriptPubKey: "51",
        confirmations: "1",
        classification: "native",
      }),
      Object.freeze({
        txid: "44".repeat(32),
        vout: 0,
        satoshis: "500",
        scriptPubKey: "51",
        confirmations: "1",
        classification: "ft",
        contractId,
      }),
    ]),
    parents: Object.freeze([]),
    contracts: Object.freeze([]),
  });
  const snapshot = Object.freeze({
    payload: snapshotPayload,
    snapshotHash: hashCanonical(snapshotPayload),
  });
  const policyPayload = Object.freeze({
    version: "1.0",
    policyId: "legacy-ft-session-policy",
    revision: "1",
    chainId,
    feeRateSatPerKb: "80",
    dustThreshold: "24",
    minConfirmations: "0",
    maxBundleTransactions: 32,
    sighashType: 65,
    contractPolicies: Object.freeze([]),
    amountLimits: Object.freeze([Object.freeze({
      scope: "native",
      maximum: "2100000000000000",
    })]),
    expiresAt,
  });
  const policy = Object.freeze({
    payload: policyPayload,
    policyHash: hashCanonical(policyPayload),
  });
  const engineCalls = [];
  const engine = Object.freeze({
    normalizeRequest({ request }) {
      engineCalls.push("normalizeRequest");
      return Object.freeze({ request, requestHash: hashCanonical(request) });
    },
    plan({ requestHash, snapshot: currentSnapshot, policy: currentPolicy }) {
      engineCalls.push("plan");
      const payload = Object.freeze({
        version: "1.0",
        requestHash,
        snapshotHash: currentSnapshot.snapshotHash,
        policyHash: currentPolicy.policyHash,
        chainId,
        accountId,
        expiresAt,
        transactions: Object.freeze([Object.freeze({
          id: "legacy-ft-primary",
          role: "primary",
          dependsOn: Object.freeze([]),
          unsignedTransaction: ftRawTransaction,
          templateHash: "55".repeat(32),
          fee: "80",
        })]),
        signingTasks: Object.freeze([Object.freeze({
          taskId: "legacy-ft-signature",
          purpose: "transaction",
          algorithm: "secp256k1-ecdsa-sha256d",
          digest: "66".repeat(32),
          signatureEncoding: "compact64",
          transactionTemplateId: "legacy-ft-primary",
          inputIndex: 0,
          accountId,
          publicKey: account.publicKey,
          sighashType: 65,
        })]),
        preview: Object.freeze({
          operationKind: "transaction",
          assetFlows: Object.freeze([Object.freeze({
            kind: "ft",
            direction: "send",
            amount: "2500000",
            contractId,
            from: source,
            to: recipient,
          })]),
          totalFee: "80",
          transactionCount: 1,
          contractIds: Object.freeze([contractId]),
          warnings: Object.freeze([]),
          irreversible: true,
        }),
      });
      return Object.freeze({ plan: Object.freeze({ payload, planHash: hashCanonical(payload) }) });
    },
    validate() {
      engineCalls.push("validate");
      return Object.freeze({ valid: true, violations: Object.freeze([]) });
    },
    finalize({ requestHash, approval }) {
      engineCalls.push("finalize");
      return Object.freeze({
        bundle: Object.freeze({
          version: "1.0",
          chainId,
          from: source,
          requestHash,
          approvalId: approval.approvalId,
          transactions: Object.freeze([Object.freeze({
            id: "legacy-ft-primary",
            txid: "77".repeat(32),
            rawTransaction: ftRawTransaction,
            role: "primary",
            dependsOn: Object.freeze([]),
          })]),
          totalFee: "80",
        }),
        validation: Object.freeze({ valid: true, violations: Object.freeze([]) }),
      });
    },
  });
  let approvals = 0;
  let signerCalls = 0;
  let chainDataCalls = 0;
  const runtime = createTbcWallet({
    accounts: { current: async () => Object.freeze([account]) },
    approval: {
      async request(params) {
        approvals += 1;
        return Object.freeze({
          status: "approved",
          approvalId: `legacy-ft-session-approval-${approvals}`,
          approvalToken: `legacy-ft-session-token-${approvals}`,
          bindingHash: params.binding.bindingHash,
          approvedAt: now,
          expiresAt: params.binding.payload.expiresAt,
        });
      },
    },
    signer: {
      async sign(params) {
        signerCalls += 1;
        return Object.freeze({
          taskId: params.task.taskId,
          signatureEncoding: "compact64",
          signature: "88".repeat(64),
        });
      },
    },
    storage: {
      async loadPermissions() {
        return Object.freeze({ revision, permissions });
      },
      async commitPermissions(params) {
        const change = params.changes[0];
        permissions = Object.freeze([...change.permissions]);
        revision = String(BigInt(revision) + 1n);
        return Object.freeze({
          revisions: Object.freeze(params.changes.map(({ scope }) =>
            Object.freeze({ scope, revision }),
          )),
        });
      },
    },
    network: {
      async resolveChainData() {
        chainDataCalls += 1;
        return snapshot;
      },
      async resolvePolicy() { return policy; },
      async broadcastSubmit() { throw new Error("sign-only Legacy FT must not broadcast"); },
      async broadcastReconcile() { throw new Error("sign-only Legacy FT must not reconcile"); },
    },
    engine,
    clock: () => now,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: navigation.origin,
    sessionId: "legacy-ft-real-session",
  });
  const posts = [];
  const requests = [];
  const controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "ios",
    walletVersion: "0.1.0-candidate.98",
    bitcoinMessages: {
      async prepare(input) { return Object.freeze({ ...input, digest: "99".repeat(32) }); },
    },
    transactions: {
      ftTransferIntents: {
        async resolve(_request, from, onMetadata) {
          onMetadata?.(6);
          return Object.freeze({
            version: "1.0",
            chainId,
            from,
            clientRequestId: "legacy-ft-real-session",
            intent: Object.freeze({
              version: "1.0",
              type: "tbc.ft.transfer",
              contractId,
              to: recipient,
              amount: "2500000",
              attachedTbcAmount: "0",
            }),
          });
        },
      },
      async readTransactionContext() {
        return Object.freeze({ address: source, permissions });
      },
    },
    handlers: {
      async send(request) {
        requests.push(structuredClone(request));
        return session.handleRequest(request);
      },
      async acknowledgeDelivery() {},
      async cancel(requestId) { await session.cancelRequest(requestId); },
      async close() { session.close(); },
    },
    async post(serialized) { posts.push(serialized); },
  });
  controller.initialize();
  await controller.acceptPageMessage(JSON.stringify({
    channel: TBC_KIT_LEGACY_WEBVIEW_CHANNEL,
    sessionId: navigation.sessionId,
    navigationId: navigation.navigationId,
    type: "ready",
  }));
  await controller.acceptPageMessage(JSON.stringify({
    channel: TBC_KIT_LEGACY_WEBVIEW_CHANNEL,
    sessionId: navigation.sessionId,
    navigationId: navigation.navigationId,
    type: "request",
    requestId: "legacy-ft-real-session-request",
    method: "sendTransaction",
    params: Object.freeze({
      flag: "FT_TRANSFER",
      address: recipient,
      ft_contract_address: contractId,
      ft_amount: "2.5",
      broadcastEnabled: false,
    }),
  }));

  const response = posts.map(JSON.parse).find(
    (value) => value.requestId === "legacy-ft-real-session-request",
  );
  assert.deepEqual(response.result, { txraw: ftRawTransaction });
  assert.deepEqual(requests.map(({ method }) => method), [
    "wallet_requestPermissions",
    "tbc_signTransaction",
  ]);
  assert.equal(permissions.some(({ parentCapability }) => parentCapability === "tbc_signTransaction"), true);
  assert.equal(approvals, 2, "permission and transaction each retain one explicit approval");
  assert.equal(signerCalls, 1);
  assert.equal(chainDataCalls, 1);
  assert.deepEqual(engineCalls, [
    "normalizeRequest",
    "plan",
    "validate",
    "validate",
    "finalize",
    "validate",
  ]);
  session.close();
});

test("Kit controller owns FT create and all six active Pool Legacy dispatch shapes", async () => {
  const page = pageHarness();
  const requests = [];
  const mapped = [];
  let sequence = 0;
  let controller;
  const permissions = Object.freeze([
    ...["tbc_signTransaction", "tbc_sendTransaction"].map((capability) => Object.freeze({
      parentCapability: capability,
      invoker: navigation.origin,
      caveats: Object.freeze([
        Object.freeze({ type: "restrictChains", value: Object.freeze([chainId]) }),
        Object.freeze({ type: "restrictAccounts", value: Object.freeze([`${chainId}:${address}`]) }),
        Object.freeze({ type: "restrictMethods", value: Object.freeze([capability]) }),
      ]),
    })),
  ]);
  const ftCreate = Object.freeze([
    Object.freeze({ flag: "FT_MINT", ft_data: "{}" }),
  ]);
  const poolCases = [
    Object.freeze([Object.freeze({ flag: "POOLNFT_MINT", broadcastEnabled: false })]),
    Object.freeze([Object.freeze({ flag: "POOLNFT_INIT", broadcastEnabled: false })]),
    Object.freeze({ flag: "POOLNFT_SWAP_TO_TOKEN", broadcastEnabled: false }),
    Object.freeze({ flag: "POOLNFT_SWAP_TO_TBC", broadcastEnabled: false }),
    Object.freeze([Object.freeze({ flag: "POOLNFT_LP_INCREASE", broadcastEnabled: false })]),
    Object.freeze([Object.freeze({ flag: "POOLNFT_LP_CONSUME", broadcastEnabled: false })]),
  ];
  const intentTypes = new Map([
    ["POOLNFT_MINT", "tbc.pool.create"],
    ["POOLNFT_INIT", "tbc.pool.create"],
    ["POOLNFT_SWAP_TO_TOKEN", "tbc.pool.swap.exactTbcForToken"],
    ["POOLNFT_SWAP_TO_TBC", "tbc.pool.swap.exactTokenForTbc"],
    ["POOLNFT_LP_INCREASE", "tbc.pool.liquidity.add"],
    ["POOLNFT_LP_CONSUME", "tbc.pool.liquidity.remove"],
  ]);
  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) {
      void controller.acceptPageMessage(serialized);
    },
  });
  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "ios",
    walletVersion: "0.1.0-candidate.61",
    transactions: {
      ftCreateIntents: {
        async resolve(params, from) {
          mapped.push({ kind: "ft-create", params });
          return Object.freeze({
            version: "1.0",
            chainId,
            from,
            clientRequestId: "controlled-ft-create",
            intent: Object.freeze({ version: "1.0", type: "tbc.ft.create" }),
          });
        },
      },
      poolIntents: {
        async resolve(params, from) {
          mapped.push({ kind: "pool", flag: params.flag });
          return Object.freeze({
            version: "1.0",
            chainId,
            from,
            clientRequestId: `controlled-${params.flag}`,
            intent: Object.freeze({ version: "1.0", type: intentTypes.get(params.flag) }),
          });
        },
      },
      async readTransactionContext() {
        return Object.freeze({ address, permissions });
      },
    },
    handlers: {
      async send(request) {
        requests.push(structuredClone(request));
        sequence += 1;
        const deliveryId = sequence.toString(16).padStart(64, "0");
        const result = request.method === "tbc_sendTransaction"
          ? Object.freeze({
              transactions: Object.freeze([
                Object.freeze({
                  role: "primary",
                  status: "submitted",
                  txid: "bb".repeat(32),
                }),
              ]),
            })
          : Object.freeze({
              transactions: Object.freeze([
                Object.freeze({ rawTransaction: ftRawTransaction }),
              ]),
            });
        return Object.freeze({
          deliveryId,
          response: Object.freeze({ jsonrpc: "2.0", id: request.id, result }),
          events: Object.freeze([]),
        });
      },
      async acknowledgeDelivery() {},
      async cancel() {},
      async close() {},
    },
    async post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });
  controller.initialize();
  await settle();
  assert.equal(controller.supportsRequest("sendTransaction", ftCreate), true);
  for (const params of poolCases) {
    assert.equal(controller.supportsRequest("sendTransaction", params), true);
  }
  for (const params of [
    Object.freeze({ flag: "POOLNFT_MINT", broadcastEnabled: false }),
    Object.freeze({ flag: "POOLNFT_INIT", broadcastEnabled: false }),
    Object.freeze([Object.freeze({ flag: "POOLNFT_SWAP_TO_TOKEN", broadcastEnabled: false })]),
    Object.freeze([Object.freeze({ flag: "POOLNFT_SWAP_TO_TBC", broadcastEnabled: false })]),
  ]) {
    assert.equal(
      controller.supportsRequest("sendTransaction", params),
      false,
      "Legacy input shape must retain the existing Mobile routing boundary",
    );
  }
  assert.deepEqual(plain(await page.pageWindow.Turing.sendTransaction(ftCreate)), {
    txid: "bb".repeat(32),
  });
  for (const params of poolCases) {
    assert.deepEqual(plain(await page.pageWindow.Turing.sendTransaction(params)), {
      txraw: ftRawTransaction,
    });
  }
  await settle();
  assert.deepEqual(requests.map(({ method }) => method), [
    "tbc_sendTransaction",
    ...Array(6).fill("tbc_signTransaction"),
  ]);
  assert.deepEqual(mapped, [
    { kind: "ft-create", params: ftCreate },
    ...poolCases.map((params) => ({
      kind: "pool",
      flag: (Array.isArray(params) ? params[0] : params).flag,
    })),
  ]);
  assert.ok(requests.every(({ params }) => params.constraints.maxFee === "10000"));
});

test("Kit controller reaches NFT and Stablecoin flags while the historical full-merge alias stays unavailable", async () => {
  const page = pageHarness();
  const source = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
  const recipient = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
  const contractId = "44".repeat(32);
  const collectionId = "55".repeat(32);
  const requests = [];
  let sequence = 0;
  let controller;
  const permissions = Object.freeze(
    ["tbc_signTransaction", "tbc_sendTransaction"].map((capability) =>
      Object.freeze({
        parentCapability: capability,
        invoker: navigation.origin,
        caveats: Object.freeze([
          Object.freeze({ type: "restrictChains", value: Object.freeze([chainId]) }),
          Object.freeze({ type: "restrictAccounts", value: Object.freeze([`${chainId}:${source}`]) }),
          Object.freeze({ type: "restrictMethods", value: Object.freeze([capability]) }),
        ]),
      }),
    ),
  );
  const cases = [
    [{
      flag: "COLLECTION_CREATE",
      collection_data: JSON.stringify({
        collectionName: "F4 Collection",
        description: "bounded",
        supply: 2,
        file: "ipfs://f4-collection",
      }),
    }],
    [{
      flag: "NFT_CREATE",
      collection_id: collectionId,
      nft_data: JSON.stringify({
        nftName: "F4 NFT",
        symbol: "F4",
        description: "bounded",
        attributes: "[]",
      }),
      broadcastEnabled: false,
    }],
    [{ flag: "NFT_TRANSFER", nft_contract_address: contractId, address: recipient }],
    [{
      flag: "STABLECOIN_TRANSFER",
      ft_contract_address: contractId,
      address: recipient,
      ft_amount: "1.25",
      broadcastEnabled: true,
    }],
    [{
      flag: "STABLECOIN_TRANSFER",
      ft_contract_address: contractId,
      address: recipient,
      ft_amount: "2.5",
      broadcastEnabled: false,
    }],
    [{ flag: "STABLECOIN_MERGE", ft_contract_address: contractId }],
    [{
      flag: "FT_TRANSFER",
      ft_contract_address: contractId,
      address: recipient,
      ft_amount: "3.5",
    }],
    [{
      flag: "FT_TRANSFER",
      ft_contract_address: contractId,
      address: recipient,
      ft_amount: "4.5",
      broadcastEnabled: false,
    }],
  ];
  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) { void controller.acceptPageMessage(serialized); },
  });
  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "ios",
    walletVersion: "0.1.0-candidate.166",
    transactions: {
      ftTransferIntents: {
        async resolve(params, from, onMetadata) {
          const value = params[0];
          onMetadata?.(6);
          return Object.freeze({
            version: "1.0",
            chainId,
            from,
            clientRequestId: `ft-${value.ft_amount}`,
            intent: Object.freeze({
              version: "1.0",
              type: "tbc.ft.transfer",
              contractId,
              to: recipient,
              amount: value.ft_amount === "3.5" ? "3500000" : "4500000",
            }),
          });
        },
      },
      stablecoinTransferIntents: {
        async resolve(params, from, onMetadata) {
          const value = params[0];
          if (value.ft_amount === "metadata-timeout") {
            throw new Error("The operation was cancelled");
          }
          onMetadata?.(6);
          return Object.freeze({
            version: "1.0",
            chainId,
            from,
            clientRequestId: `stable-${value.ft_amount}`,
            intent: Object.freeze({
              version: "1.0",
              type: "tbc.stablecoin.transfer",
              contractId,
              to: recipient,
              amount: value.ft_amount === "1.25" ? "1250000" : "2500000",
            }),
          });
        },
      },
      async readTransactionContext() {
        return Object.freeze({ address: source, permissions });
      },
    },
    handlers: {
      async send(request) {
        requests.push(structuredClone(request));
        sequence += 1;
        return Object.freeze({
          deliveryId: sequence.toString(16).padStart(64, "0"),
          response: Object.freeze({
            jsonrpc: "2.0",
            id: request.id,
            result: Object.freeze({
              transactions: Object.freeze([
                request.method === "tbc_signTransaction"
                  ? Object.freeze({ rawTransaction: ftRawTransaction })
                  : Object.freeze({ role: "primary", status: "submitted", txid: "66".repeat(32) }),
              ]),
            }),
          }),
          events: Object.freeze([]),
        });
      },
      async acknowledgeDelivery() {},
      async cancel() {},
      async close() {},
    },
    async post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });
  controller.initialize();
  await settle();
  for (const params of cases) {
    assert.equal(controller.supportsRequest("sendTransaction", params), true);
    await page.pageWindow.Turing.sendTransaction(params);
  }
  const metadataFailure = plain(await page.pageWindow.Turing.sendTransaction([{
    flag: "STABLECOIN_TRANSFER",
    ft_contract_address: contractId,
    address: recipient,
    ft_amount: "metadata-timeout",
    broadcastEnabled: false,
  }]));
  assert.deepEqual(metadataFailure, { error: "Stablecoin metadata unavailable" });
  assert.equal(controller.supportsRequest("mergeStableCoinUtxos", contractId), false);
  assert.deepEqual(
    plain(await page.pageWindow.Turing.mergeStableCoinUtxos(contractId)),
    { error: "Unsupported legacy operation" },
  );
  await settle();
  assert.deepEqual(requests.map(({ method }) => method), [
    "tbc_sendTransaction",
    "tbc_signTransaction",
    "tbc_sendTransaction",
    "tbc_sendTransaction",
    "tbc_signTransaction",
    "tbc_sendTransaction",
    "tbc_sendTransaction",
    "tbc_signTransaction",
  ]);
  assert.deepEqual(requests.map(({ params }) => params.intent.type), [
    "tbc.collection.create",
    "tbc.nft.mint",
    "tbc.nft.transfer",
    "tbc.stablecoin.transfer",
    "tbc.stablecoin.transfer",
    "tbc.stablecoin.merge",
    "tbc.ft.transfer",
    "tbc.ft.transfer",
  ]);
  assert.ok(requests.every(({ params }) => params.constraints.maxFee === "10000"));
});

test("historical merge aliases are thin mappings over the bounded public coordinator", async () => {
  const page = pageHarness();
  const source = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
  const contractId = "77".repeat(32);
  const requests = [];
  const policies = [];
  let controller;
  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) { void controller.acceptPageMessage(serialized); },
  });
  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "ios",
    walletVersion: "0.1.0-candidate.167",
    transactions: {
      async readTransactionContext() {
        return Object.freeze({ address: source, permissions: Object.freeze([]) });
      },
    },
    multiRoundMerge: {
      createLimits(input) {
        policies.push(structuredClone(input));
        return Object.freeze({
          maxTransactions: 2,
          maxTotalFee: "100",
          maxIndexRefreshes: 1,
          indexRefreshDelayMs: 0,
          expiresAt: "2026-09-24T00:05:00Z",
        });
      },
    },
    handlers: {
      async send(request) {
        requests.push(structuredClone(request));
        assert.equal(request.method, "tbc_runMultiRoundMerge");
        const kind = request.params.asset.kind;
        const complete = kind === "tbc";
        return Object.freeze({
          deliveryId: String(requests.length).repeat(64),
          response: Object.freeze({
            jsonrpc: "2.0",
            id: request.id,
            result: Object.freeze({
              version: "1.0",
              status: complete ? "complete" : "partial",
              reason: complete ? "target-reached" : "transaction-budget-exhausted",
              scopeHash: "88".repeat(32),
              initialUtxoCount: kind === "tbc" ? 101 : 6,
              finalUtxoCount: complete ? 1 : 2,
              totalFee: "10",
              steps: Object.freeze([]),
              atomic: false,
              progress: Object.freeze([]),
            }),
          }),
          events: Object.freeze([]),
        });
      },
      async acknowledgeDelivery() {},
      async cancel() {},
      async close() {},
    },
    async post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });
  controller.initialize();
  await settle();

  assert.equal(controller.supportsRequest("mergeUtxos", {}), true);
  assert.equal(controller.supportsRequest("mergeFtUtxos", { contract_id: contractId }), true);
  assert.equal(controller.supportsRequest("mergeStableCoinUtxos", { contract_id: contractId }), true);
  const tbc = plain(await page.pageWindow.Turing.mergeUtxos({}));
  const ft = plain(await page.pageWindow.Turing.mergeFtUtxos({ contract_id: contractId }));
  const stablecoin = plain(await page.pageWindow.Turing.mergeStableCoinUtxos({ contract_id: contractId }));
  assert.equal(typeof tbc.duration, "number");
  assert.equal(typeof ft.duration, "number");
  assert.equal(typeof stablecoin.duration, "number");
  delete tbc.duration;
  delete ft.duration;
  delete stablecoin.duration;
  assert.deepEqual(tbc, { success: true });
  assert.deepEqual(ft, { success: false });
  assert.deepEqual(stablecoin, { success: false, successCount: 4 });
  assert.deepEqual(requests.map(({ params }) => ({
    asset: params.asset,
    targetUtxoCount: params.limits.targetUtxoCount,
    maxTransactions: params.limits.maxTransactions,
  })), [
    { asset: { kind: "tbc" }, targetUtxoCount: 1, maxTransactions: 2 },
    { asset: { kind: "ft", contractId }, targetUtxoCount: 1, maxTransactions: 2 },
    { asset: { kind: "stablecoin", contractId }, targetUtxoCount: 1, maxTransactions: 2 },
  ]);
  assert.deepEqual(policies.map(({ method }) => method), [
    "mergeUtxos", "mergeFtUtxos", "mergeStableCoinUtxos",
  ]);
});

test("Legacy LP mapping can hand one capped canonical request to shared Standard preparation", async () => {
  const page = pageHarness();
  const requests = [];
  let controller;
  let sequence = 0;
  const permissions = Object.freeze([Object.freeze({
    parentCapability: "tbc_signTransaction",
    invoker: navigation.origin,
    caveats: Object.freeze([
      Object.freeze({ type: "restrictChains", value: Object.freeze([chainId]) }),
      Object.freeze({ type: "restrictAccounts", value: Object.freeze([`${chainId}:${address}`]) }),
      Object.freeze({ type: "restrictMethods", value: Object.freeze(["tbc_signTransaction"]) }),
    ]),
  })]);
  const intentTypes = new Map([
    ["POOLNFT_LP_INCREASE", "tbc.pool.liquidity.add"],
    ["POOLNFT_LP_CONSUME", "tbc.pool.liquidity.remove"],
  ]);
  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) { void controller.acceptPageMessage(serialized); },
  });
  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "ios",
    walletVersion: "0.1.0-candidate.108",
    transactions: {
      poolIntents: {
        async resolve(params, from) {
          return Object.freeze({
            version: "1.0",
            chainId,
            from,
            clientRequestId: `shared-${params.flag}`,
            intent: Object.freeze({
              version: "1.0",
              type: intentTypes.get(params.flag),
              poolContractId: "22".repeat(32),
              receiver: address,
              ...(params.flag === "POOLNFT_LP_INCREASE"
                ? { tbcAmount: "1000", minimumLpAmount: "1" }
                : { lpAmount: "1000", minimumTbcAmount: "1", minimumFtAmount: "1" }),
            }),
          });
        },
      },
      async readTransactionContext() {
        return Object.freeze({ address, permissions });
      },
    },
    handlers: {
      async send(request) {
        requests.push(structuredClone(request));
        sequence += 1;
        return Object.freeze({
          deliveryId: sequence.toString(16).padStart(64, "0"),
          response: Object.freeze({
            jsonrpc: "2.0",
            id: request.id,
            result: Object.freeze({
              transactions: Object.freeze([Object.freeze({ rawTransaction: ftRawTransaction })]),
            }),
          }),
          events: Object.freeze([]),
        });
      },
      async acknowledgeDelivery() {},
      async cancel() {},
      async close() {},
    },
    async post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });
  controller.initialize();
  await settle();
  for (const flag of ["POOLNFT_LP_INCREASE", "POOLNFT_LP_CONSUME"]) {
    const result = plain(await page.pageWindow.Turing.sendTransaction([
      { flag, broadcastEnabled: false },
    ]));
    assert.deepEqual(result, { txraw: ftRawTransaction });
  }
  await settle();
  assert.deepEqual(requests.map(({ method }) => method), [
    "tbc_signTransaction",
    "tbc_signTransaction",
  ]);
  assert.deepEqual(requests.map(({ params }) => ({
    type: params.intent.type,
    maxFee: params.constraints.maxFee,
  })), [
    { type: "tbc.pool.liquidity.add", maxFee: "10000" },
    { type: "tbc.pool.liquidity.remove", maxFee: "10000" },
  ]);
});

test("standalone Legacy secure methods delegate to the Standard single-operation adapter", async () => {
  const page = pageHarness();
  const executions = [];
  const acknowledgments = [];
  let sequence = 0;
  let rejectNext = false;
  let controller;
  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) { void controller.acceptPageMessage(serialized); },
  });
  const resultByMethod = Object.freeze({
    signTransaction: Object.freeze({ sigs: Object.freeze([Object.freeze(["30aa"])]) }),
    signAssociatedTransaction: Object.freeze({ txraws: Object.freeze([ftRawTransaction]) }),
    encrypt: Object.freeze({ encryptedMessage: "ciphertext" }),
    decrypt: Object.freeze({ decryptedMessage: "plaintext" }),
  });
  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "ios",
    walletVersion: "0.1.0-candidate.109",
    genericBatch: {
      async execute(input) {
        executions.push(structuredClone(input));
        sequence += 1;
        const method = input.requests[0].method;
        return Object.freeze({
          deliveryId: sequence.toString(16).padStart(64, "0"),
          results: Object.freeze([
            rejectNext
              ? Object.freeze({ error: "User cancelled the batch request" })
              : resultByMethod[method],
          ]),
          events: Object.freeze([]),
        });
      },
    },
    handlers: {
      async send() { throw new Error("standalone Standard mapping must not redispatch privately"); },
      async acknowledgeDelivery(deliveryId) { acknowledgments.push(deliveryId); },
      async cancel() {},
      async close() {},
    },
    async post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });
  controller.initialize();
  await settle();
  const raw = Object.freeze({
    txraws: Object.freeze(["0102"]),
    utxos_satoshis: Object.freeze([Object.freeze([])]),
    script_pubkeys: Object.freeze([Object.freeze([])]),
  });
  const associated = Object.freeze({ sourceTxraw: "0102", sourceUtxos: Object.freeze([]) });
  assert.equal(controller.supportsRequest("signTransaction", raw), true);
  assert.equal(controller.supportsRequest("signAssociatedTransaction", associated), true);
  assert.equal(controller.supportsRequest("encrypt", { message: "hello" }), true);
  assert.equal(controller.supportsRequest("decrypt", { encryptedMessage: "ciphertext" }), true);
  assert.deepEqual(plain(await page.pageWindow.Turing.signTransaction(raw)), plain(resultByMethod.signTransaction));
  assert.deepEqual(
    plain(await page.pageWindow.Turing.signAssociatedTransaction(associated)),
    plain(resultByMethod.signAssociatedTransaction),
  );
  assert.deepEqual(
    plain(await page.pageWindow.Turing.encrypt({ message: "hello" })),
    plain(resultByMethod.encrypt),
  );
  assert.deepEqual(
    plain(await page.pageWindow.Turing.decrypt({ encryptedMessage: "ciphertext" })),
    plain(resultByMethod.decrypt),
  );
  rejectNext = true;
  assert.deepEqual(
    plain(await page.pageWindow.Turing.signTransaction(raw)),
    { error: "User cancelled the sign transaction" },
  );
  assert.deepEqual(
    executions.map(({ requests }) => requests.map(({ method }) => method)),
    [
      ["signTransaction"],
      ["signAssociatedTransaction"],
      ["encrypt"],
      ["decrypt"],
      ["signTransaction"],
    ],
  );
  assert.ok(executions.every(({ context, requests }) =>
    context.origin === navigation.origin &&
    context.chainId === chainId &&
    context.sessionId === navigation.sessionId &&
    context.navigationId === navigation.navigationId &&
    requests.length === 1
  ));
  await settle();
  assert.equal(acknowledgments.length, executions.length);
});

test("standalone associated signing is unavailable without the Standard adapter", async () => {
  const page = pageHarness();
  const timeline = [];
  const requests = [];
  let sequence = 0;
  let controller;
  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) {
      void controller.acceptPageMessage(serialized);
    },
  });
  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "ios",
    walletVersion: "0.1.0-candidate.62",
    bitcoinMessages: {
      async prepare(input) {
        const decoded = JSON.parse(input.message);
        assert.equal(decoded.purpose, "associated-deposit");
        assert.equal(decoded.txids.length, 1);
        return Object.freeze({ ...input, digest: "bd".repeat(32) });
      },
    },
    handlers: {
      async send(request) {
        sequence += 1;
        const deliveryId = sequence.toString(16).padStart(64, "0");
        requests.push({ request: structuredClone(request), deliveryId });
        timeline.push(`send:${request.id}:${request.method}`);
        if (request.method === "tbc_accounts") {
          return Object.freeze({
            deliveryId,
            response: Object.freeze({
              jsonrpc: "2.0",
              id: request.id,
              result: Object.freeze([address]),
            }),
            events: Object.freeze([]),
          });
        }
        if (request.method === "tbc_signMessage") {
          return Object.freeze({
            deliveryId,
            response: Object.freeze({
              jsonrpc: "2.0",
              id: request.id,
              result: Object.freeze({
                address,
                publicKey,
                signature,
                envelope: Object.freeze({ message: request.params.message }),
              }),
            }),
            events: Object.freeze([]),
          });
        }
        throw new Error(`unexpected associated method ${request.method}`);
      },
      async acknowledgeDelivery(deliveryId) {
        timeline.push(`ack:${deliveryId}`);
      },
      async cancel() {},
      async close() {},
    },
    async post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });
  controller.initialize();
  await settle();
  const associatedParams = Object.freeze({ sourceTxraw: "0102", sourceUtxos: Object.freeze([]) });
  const batch = Object.freeze([
    Object.freeze({ method: "signAssociatedTransaction", params: associatedParams }),
    Object.freeze({
      method: "signMessage",
      dependsOn: "txids",
      params: Object.freeze({
        message: JSON.stringify({ purpose: "associated-deposit" }),
        encoding: "utf8",
      }),
    }),
  ]);
  assert.equal(controller.supportsRequest("signAssociatedTransaction", associatedParams), false);
  assert.equal(controller.supportsRequest("sendBatchRequest", batch), false);
  assert.deepEqual(
    plain(await page.pageWindow.Turing.signAssociatedTransaction(associatedParams)),
    { error: "Unsupported legacy operation" },
  );
  await settle();
  const result = plain(await page.pageWindow.Turing.sendBatchRequest(batch));
  await settle();
  assert.deepEqual(result, { error: "Unsupported legacy operation" });
  assert.equal(requests.some(({ request }) => request.method === "tbc_signMessage"), false);
});

test("old FT deposit recipe cannot start review preparation without genericBatch", async () => {
  const page = pageHarness();
  let controller;
  let prefetched = 0;
  let cancelled = 0;
  let dispatched = 0;
  const permissions = Object.freeze([
    Object.freeze({
      parentCapability: "tbc_signTransaction",
      invoker: navigation.origin,
      caveats: Object.freeze([
        Object.freeze({ type: "restrictChains", value: Object.freeze([chainId]) }),
        Object.freeze({
          type: "restrictAccounts",
          value: Object.freeze([`${chainId}:${address}`]),
        }),
        Object.freeze({
          type: "restrictMethods",
          value: Object.freeze(["tbc_signTransaction"]),
        }),
      ]),
    }),
  ]);
  const legacyFt = Object.freeze({
    flag: "FT_TRANSFER",
    address: "1Recipient",
    ft_contract_address: "ab".repeat(32),
    ft_amount: "2.5",
    tbc_amount: "0",
    broadcastEnabled: false,
  });
  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) {
      void controller.acceptPageMessage(serialized);
    },
  });
  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "ios",
    walletVersion: "0.1.0-candidate.56",
    bitcoinMessages: {
      async prepare(input) {
        return Object.freeze({ ...input, digest: "ef".repeat(32) });
      },
    },
    transactions: {
      ftTransferIntents: {
        async resolve(_request, source, onMetadata) {
          onMetadata?.(6);
          return Object.freeze({
            version: "1.0",
            chainId,
            from: source,
            intent: Object.freeze({
              version: "1.0",
              type: "tbc.ft.transfer",
              contractId: "ab".repeat(32),
              to: "1Recipient",
              amount: "2500000",
            }),
          });
        },
      },
      async readTransactionContext() {
        return Object.freeze({ address, permissions });
      },
    },
    handlers: {
      async send() {
        dispatched += 1;
        throw new Error("Host dispatch must not run after rejection");
      },
      async cancel() {},
      async close() {},
    },
    async post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });
  controller.initialize();
  await settle();
  const result = await page.pageWindow.Turing.sendBatchRequest([
    { method: "sendTransaction", params: legacyFt },
    {
      method: "signMessage",
      dependsOn: "txids",
      params: {
        message: JSON.stringify({ purpose: "deposit" }),
        encoding: "utf8",
      },
    },
  ]);
  await settle();
  assert.deepEqual(plain(result), { error: "Unsupported legacy operation" });
  assert.equal(prefetched, 0);
  assert.equal(cancelled, 0);
  assert.equal(dispatched, 0);
});

test("old P2PKH dependent recipe cannot dispatch without genericBatch", async () => {
  const page = pageHarness();
  const source = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
  const recipient = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
  const accountId = `${chainId}:${source}`;
  const permissions = Object.freeze([
    Object.freeze({
      parentCapability: "tbc_signTransaction",
      invoker: navigation.origin,
      caveats: Object.freeze([
        Object.freeze({ type: "restrictChains", value: Object.freeze([chainId]) }),
        Object.freeze({ type: "restrictAccounts", value: Object.freeze([accountId]) }),
        Object.freeze({ type: "restrictMethods", value: Object.freeze(["tbc_signTransaction"]) }),
      ]),
    }),
  ]);
  const p2pkh = Object.freeze({
    flag: "P2PKH",
    address: recipient,
    satoshis: 25_000,
    broadcastEnabled: false,
  });
  const batch = Object.freeze([
    Object.freeze({ method: "sendTransaction", params: p2pkh }),
    Object.freeze({
      method: "signMessage",
      dependsOn: "txids",
      params: Object.freeze({
        message: JSON.stringify({ purpose: "buy" }),
        encoding: "utf8",
      }),
    }),
  ]);
  const requests = [];
  const progress = [];
  let visible = 0;
  let prefetched = 0;
  let cancelled = 0;
  let sequence = 0;
  let controller;
  const network = createTbcNetworkContext({ network: "testnet" });
  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) {
      void controller.acceptPageMessage(serialized);
    },
  });
  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    network,
    platform: "ios",
    walletVersion: "0.1.0-candidate.61",
    bitcoinMessages: {
      async prepare(input) {
        const parsed = JSON.parse(input.message);
        assert.equal(parsed.purpose, "buy");
        assert.equal(parsed.txids.length, 1);
        return Object.freeze({ ...input, digest: "fa".repeat(32) });
      },
    },
    transactions: {
      async readTransactionContext() {
        return Object.freeze({
          address: source,
          permissions,
          networkSourceIdentity: network.sourceIdentity,
        });
      },
      onBatchProgress(value) {
        progress.push(value);
      },
    },
    handlers: {
      async send(request) {
        requests.push(structuredClone(request));
        sequence += 1;
        const deliveryId = sequence.toString(16).padStart(64, "0");
        if (request.method === "tbc_signTransaction") {
          return Object.freeze({
            deliveryId,
            response: Object.freeze({
              jsonrpc: "2.0",
              id: request.id,
              result: Object.freeze({
                transactions: Object.freeze([
                  Object.freeze({ rawTransaction: ftRawTransaction }),
                ]),
              }),
            }),
            events: Object.freeze([]),
          });
        }
        if (request.method === "tbc_signMessage") {
          return Object.freeze({
            deliveryId,
            response: Object.freeze({
              jsonrpc: "2.0",
              id: request.id,
              result: Object.freeze({
                address: source,
                publicKey,
                signature,
                envelope: Object.freeze({ message: request.params.message }),
              }),
            }),
            events: Object.freeze([]),
          });
        }
        throw new Error(`unexpected method ${request.method}`);
      },
      async acknowledgeDelivery() {},
      async cancel() {},
      async close() {},
    },
    async post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });
  controller.initialize();
  await settle();
  assert.equal(controller.supportsRequest("sendBatchRequest", batch), false);
  const result = plain(await page.pageWindow.Turing.sendBatchRequest(batch));
  await settle();
  assert.deepEqual(result, { error: "Unsupported legacy operation" });
  assert.deepEqual(requests, []);
  assert.equal(visible, 0);
  assert.equal(prefetched, 0);
  assert.equal(cancelled, 0);
  assert.deepEqual(progress, []);
});

test("generic Legacy adapter delegates the complete mixed batch to one standard workflow", async () => {
  const page = pageHarness();
  const executions = [];
  const acknowledgments = [];
  const providerRequests = [];
  let businessApprovals = 0;
  let controller;
  page.pageWindow.ReactNativeWebView = Object.freeze({
    postMessage(serialized) {
      void controller.acceptPageMessage(serialized);
    },
  });
  controller = createTbcKitLegacyWebViewNativeController({
    navigation,
    chainId,
    platform: "ios",
    walletVersion: "0.1.0-candidate.98",
    // Standalone transaction mapping remains installed; the generic Standard
    // adapter must still own every valid batch, including recipe-shaped ones.
    transactions: {},
    genericBatch: {
      async execute(input) {
        businessApprovals += 1;
        assert.equal(
          Object.hasOwn(providerRequests[0].params[0], "tbc_signWorkflow"),
          true,
          "Legacy connect must authorize the generic workflow in its initial permission approval",
        );
        executions.push(structuredClone(input));
        assert.equal(input.context.origin, navigation.origin);
        assert.equal(input.context.sessionId, navigation.sessionId);
        assert.equal(input.context.navigationId, navigation.navigationId);
        assert.equal(input.context.chainId, chainId);
        return Object.freeze({
          deliveryId: String(executions.length).repeat(64),
          results: Object.freeze(input.requests.map((_request, index) =>
            index === 2 ? { txraw: ftRawTransaction } : { ok: index })),
          events: Object.freeze([]),
        });
      },
    },
    handlers: {
      async send(request) {
        providerRequests.push(structuredClone(request));
        if (request.method === "wallet_requestPermissions") {
          return Object.freeze({
            deliveryId: "a".repeat(64),
            response: Object.freeze({ jsonrpc: "2.0", id: request.id, result: Object.freeze([]) }),
            events: Object.freeze([]),
          });
        }
        if (request.method === "tbc_accounts") {
          return Object.freeze({
            deliveryId: "b".repeat(64),
            response: Object.freeze({ jsonrpc: "2.0", id: request.id, result: Object.freeze([address]) }),
            events: Object.freeze([]),
          });
        }
        throw new Error("generic approved batch must not redispatch per-step Provider approval");
      },
      async acknowledgeDelivery(deliveryId) {
        acknowledgments.push(deliveryId);
      },
      async cancel() {},
      async close() {},
    },
    async post(serialized) {
      page.pageWindow.dispatchEvent(new MessageEvent("message", { data: serialized }));
    },
  });
  controller.initialize();
  await settle();
  assert.deepEqual(plain(await page.pageWindow.Turing.connect()), { tbcAddress: address });
  await settle();
  assert.deepEqual(providerRequests.map(({ method }) => method), [
    "wallet_requestPermissions",
    "tbc_accounts",
  ]);
  assert.deepEqual(Object.keys(providerRequests[0].params[0]).sort(), [
    "tbc_accountMetadata",
    "tbc_accounts",
    "tbc_crypto",
    "tbc_signMessage",
    "tbc_signTransaction",
    "tbc_signWorkflow",
  ]);
  acknowledgments.length = 0;
  const requests = [
    { method: "encrypt", params: { message: "one" } },
    { method: "encrypt", params: { message: "two" } },
    {
      method: "sendTransaction",
      params: { flag: "P2PKH", address: "1Recipient", satoshis: "1", broadcastEnabled: false },
    },
    {
      method: "signMessage",
      dependsOn: "settlement",
      params: { message: JSON.stringify({ order: "42" }), encoding: "utf8" },
    },
    { method: "decrypt", params: { encryptedMessage: "ciphertext" } },
  ];
  assert.equal(controller.supportsRequest("sendBatchRequest", requests), true);
  const result = plain(await page.pageWindow.Turing.sendBatchRequest(requests));
  await settle();
  assert.equal(executions.length, 1);
  assert.equal(businessApprovals, 1);
  assert.deepEqual(acknowledgments, ["1".repeat(64)]);
  assert.equal(executions[0].requestId.length > 0, true);
  assert.equal(executions[0].requests.length, 5);
  assert.deepEqual(result, [{ ok: 0 }, { ok: 1 }, { txraw: ftRawTransaction }, { ok: 3 }, { ok: 4 }]);

  const signing = [
    {
      method: "signTransaction",
      params: { txraws: [], utxos_satoshis: [], script_pubkeys: [] },
    },
    {
      method: "signAssociatedTransaction",
      params: { source: "legacy", inputs: [], outputs: [], txraws: [] },
    },
  ];
  assert.equal(controller.supportsRequest("sendBatchRequest", signing), true);
  const signingResult = plain(await page.pageWindow.Turing.sendBatchRequest(signing));
  await settle();
  assert.equal(executions.length, 2);
  assert.equal(businessApprovals, 2);
  assert.deepEqual(acknowledgments, [
    "1".repeat(64),
    "2".repeat(64),
  ]);
  assert.deepEqual(executions[1].requests.map(({ method }) => method), [
    "signTransaction",
    "signAssociatedTransaction",
  ]);
  assert.deepEqual(signingResult, [{ ok: 0 }, { ok: 1 }]);
});

test("the generated page bootstrap remains byte-stable and capability-limited", () => {
  assert.equal(TBC_KIT_LEGACY_PAGE_BOOTSTRAP_SCRIPT.includes("window.Turing"), false);
  for (const forbidden of [
    "SecureStore",
    "@tbc-wallet/host",
    "legacySignDigest",
    ["private", "Key"].join(""),
    "eval(",
    "new Function",
  ]) {
    assert.equal(TBC_KIT_LEGACY_PAGE_BOOTSTRAP_SCRIPT.includes(forbidden), false);
  }
});
