import assert from "node:assert/strict";

globalThis.window = new EventTarget();
globalThis.document = {};

const [{ createTbcClient }, { createTbcWallet }] = await Promise.all([
  import("@tbc/kit"),
  import("@tbc/kit/wallet"),
]);

const CHAIN_ID = "tbc:testnet";
const ORIGIN = "https://wallet-standard.tbc-kit.invalid";
const PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

function permission(address) {
  return {
    id: "multi-wallet-tbc-accounts",
    parentCapability: "tbc_accounts",
    invoker: ORIGIN,
    date: Date.parse("2026-09-17T00:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [CHAIN_ID] },
      { type: "restrictAccounts", value: [`${CHAIN_ID}:${address}`] },
      { type: "restrictMethods", value: ["tbc_accounts"] },
    ],
  };
}

function createExampleWallet(productId, address) {
  const forbidden = async () => {
    throw new Error("Unexpected wallet Port call");
  };
  return createTbcWallet({
    productId,
    // The same display name is intentional: selection must not route by name.
    name: "Example Wallet",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    accounts: {
      current: async () => [{
        accountId: `${CHAIN_ID}:${address}`,
        address,
        chainId: CHAIN_ID,
        publicKey: PUBLIC_KEY,
      }],
    },
    approval: {
      request: async (params) => ({
        status: "approved",
        approvalId: "multi-wallet-approval",
        approvalToken: "multi-wallet-approval-token",
        bindingHash: params.binding.bindingHash,
        approvedAt: "2026-09-17T00:00:01Z",
        expiresAt: params.binding.payload.expiresAt,
      }),
    },
    signer: { sign: forbidden },
    storage: {
      loadPermissions: async () => ({ revision: "0", permissions: [permission(address)] }),
      commitPermissions: async (params) => ({
        revisions: params.changes.map((change) => ({
          scope: change.scope,
          revision: "1",
        })),
      }),
    },
    network: {
      resolveChainData: forbidden,
      resolvePolicy: forbidden,
      broadcastSubmit: forbidden,
      broadcastReconcile: forbidden,
    },
    legacy: false,
    clock: () => "2026-09-17T00:00:01Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
}

const client = createTbcClient({
  network: CHAIN_ID,
  walletCatalog: [
    {
      productId: "org.example.alpha-wallet",
      name: "Alpha Wallet",
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      homepageUrl: "https://alpha.example/",
      installUrl: "https://alpha.example/install",
    },
    {
      productId: "org.example.beta-wallet",
      name: "Beta Wallet",
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

const changes = [];
const unsubscribe = client.subscribeWalletOptions((options) => {
  changes.push(options.map(({ status, productId }) => ({ status, productId })));
});

const alphaRuntime = createExampleWallet(
  "org.example.alpha-wallet",
  "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
);
const betaRuntime = createExampleWallet(
  "org.example.beta-wallet",
  "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP",
);
// Controlled example only. Real wallets obtain this source from their trusted
// extension/WebView transport, never from page-provided origin or metadata.
async function registerExample(runtime, address, sessionId) {
  const context = { sessionId, transport: 'remote', origin: ORIGIN, topOrigin: ORIGIN,
    frame: 'top', createdAt: '2026-09-17T00:00:00Z' };
  const currentSession = { version: '1.0', scope: { walletProfile: 'tbc-kit-wallet', sessionId },
    state: { version: '1.0', sessionId, revision: '0', connected: true, activeChainId: CHAIN_ID, activeAccountIds: [`${CHAIN_ID}:${address}`] } };
  const session = await runtime.openSession({ authority: {
    read: async () => structuredClone({ currentContext: context, currentSession }),
    compareAndSwapSession: async () => { throw new Error('Unexpected fixture mutation'); },
  } });
  await runtime.register(session);
  return session;
}
const alphaSession = await registerExample(alphaRuntime, '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', 'alpha-demo');
const betaSession = await registerExample(betaRuntime, '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP', 'beta-demo');

const options = client.walletOptions();
assert.deepEqual(
  options.map(({ status, productId }) => [status, productId]),
  [
    ["detected", "org.example.alpha-wallet"],
    ["detected", "org.example.beta-wallet"],
    ["not-detected", "org.example.guide-wallet"],
  ],
);

const alphaChoice = options[0];
const betaChoice = options[1];
assert.equal(alphaChoice.status, "detected");
assert.equal(betaChoice.status, "detected");
assert.notEqual(alphaChoice.wallet.provider, betaChoice.wallet.provider);

const alpha = await client.connect({ wallet: alphaChoice.wallet });
const beta = await client.connect({ wallet: betaChoice.wallet });
assert.equal(alpha.account, "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH");
assert.equal(beta.account, "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP");
await assert.rejects(
  client.connect({ walletName: "Example Wallet" }),
  /Multiple TBC wallets.*descriptor/,
);

unsubscribe();
alphaSession.close(); betaSession.close();
console.log(JSON.stringify({
  detected: options.filter(({ status }) => status === "detected").length,
  notDetected: options.filter(({ status }) => status === "not-detected").length,
  sameDisplayNameIsolated: true,
  subscriptionNotifications: changes.length,
}));
