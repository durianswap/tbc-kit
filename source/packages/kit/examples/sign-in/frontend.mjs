import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createTbcClient } from "@tbc/kit";
import { createTbcWallet } from "@tbc/kit/wallet";

const CHAIN_ID = "tbc:mainnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const UNRELATED_ADDRESS = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0);
const PUBLIC_KEY = Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex");
const ORIGIN = "https://app.example";
const URI = `${ORIGIN}/login`;

function permission(capability, address) {
  return {
    id: `local-example-${capability}-${address}`,
    parentCapability: capability,
    invoker: ORIGIN,
    date: Date.parse("2026-09-17T01:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [CHAIN_ID] },
      { type: "restrictAccounts", value: [`${CHAIN_ID}:${address}`] },
      { type: "restrictMethods", value: [capability] },
    ],
  };
}

function createLocalWallet(address) {
  const account = {
    accountId: `${CHAIN_ID}:${address}`,
    address,
    chainId: CHAIN_ID,
    publicKey: PUBLIC_KEY,
  };
  const methods = ["tbc_accounts", "tbc_signMessage", "tbc_signTypedData"];
  const runtime = createTbcWallet({
    accounts: { current: async () => [account] },
    approval: {
      async request(params) {
        return {
          status: "approved",
          approvalId: `local-approval-${randomBytes(8).toString("hex")}`,
          approvalToken: randomBytes(24).toString("base64url"),
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-17T01:00:03Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: {
      async sign(params) {
        const signature = secp256k1.sign(params.task.digest, PRIVATE_KEY, {
          prehash: false,
          lowS: true,
        });
        return {
          taskId: params.task.taskId,
          signatureEncoding: "compact65-recoverable",
          signature: `${(31 + signature.recovery).toString(16)}${signature.toCompactHex()}`,
        };
      },
    },
    storage: {
      async loadPermissions() {
        return { revision: "0", permissions: methods.map((method) => permission(method, address)) };
      },
      async commitPermissions(params) {
        return {
          revisions: params.changes.map((change) => ({
            scope: change.scope,
            revision: "1",
          })),
        };
      },
    },
    network: {
      resolveChainData: async () => { throw new Error("Unexpected chain-data request"); },
      resolvePolicy: async () => { throw new Error("Unexpected policy request"); },
      broadcastSubmit: async () => { throw new Error("Unexpected broadcast"); },
      broadcastReconcile: async () => { throw new Error("Unexpected reconciliation"); },
    },
    legacy: false,
    clock: () => "2026-09-17T01:00:03Z",
    randomBytes: (length) => randomBytes(length),
  });
  return { runtime, account };
}

async function connectedWallet(address) {
  const { runtime } = createLocalWallet(address);
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: `local-sign-in-${randomBytes(8).toString("hex")}`,
  });
  const methods = [];
  const provider = {
    async request(request) {
      methods.push(request.method);
      try {
        return await session.provider.request(request);
      } catch (error) {
        throw new Error(`Local wallet ${request.method} failed: ${error.message}`, { cause: error });
      }
    },
    on: (...args) => session.provider.on(...args),
    removeListener: (...args) => session.provider.removeListener(...args),
    destroy: () => session.provider.destroy(),
  };
  const client = createTbcClient({ network: CHAIN_ID, provider });
  return { wallet: await client.connect(), methods, session };
}

export async function runFrontend(backend) {
  const active = await connectedWallet(ADDRESS);
  const message = await active.wallet.signMessage({
    message: { encoding: "utf8", data: "final package behavior" },
  });
  const typed = await active.wallet.signTypedData({
    data: {
      domain: { name: "Local Sign-In Example", chainId: CHAIN_ID, origin: ORIGIN },
      types: { Login: [{ name: "purpose", type: "string" }] },
      primaryType: "Login",
      message: { purpose: "exercise the final tarball" },
    },
  });
  assert.equal(message.scheme, "tbc-message");
  assert.equal(typed.scheme, "tbc-typed-data");

  const issued = await backend("issue", {
    domain: "app.example",
    uri: URI,
    chainId: CHAIN_ID,
    address: ADDRESS,
  });
  const methodsBeforeSignIn = active.methods.length;
  const signed = await active.wallet.signIn(issued.fields);
  assert.equal(active.methods.length, methodsBeforeSignIn + 1);
  assert.equal(active.methods.at(-1), "tbc_signMessage");
  const session = await backend("verify", { attemptId: issued.attemptId, result: signed });
  assert.equal(session.accountId, `${CHAIN_ID}:${ADDRESS}`);
  await assert.rejects(
    backend("verify", { attemptId: issued.attemptId, result: signed }),
    /already consumed or is invalid/,
  );
  assert.deepEqual(await backend("inspect", { attemptId: issued.attemptId }), {
    state: "consumed",
    sessionCount: 1,
  });

  // Security regression: a wallet claiming another address while signing with
  // scalar 1 must fail before the backend consumes that challenge.
  const forgedIssued = await backend("issue", {
    domain: "app.example",
    uri: URI,
    chainId: CHAIN_ID,
    address: UNRELATED_ADDRESS,
  });
  const forgedWallet = await connectedWallet(UNRELATED_ADDRESS);
  const forged = await forgedWallet.wallet.signIn(forgedIssued.fields);
  await assert.rejects(
    backend("verify", { attemptId: forgedIssued.attemptId, result: forged }),
    /public key does not own the claimed address/,
  );
  assert.deepEqual(await backend("inspect", { attemptId: forgedIssued.attemptId }), {
    state: "issued",
    sessionCount: 1,
  });

  assert.deepEqual(active.methods, [
    "tbc_requestAccounts",
    "tbc_signMessage",
    "tbc_signTypedData",
    "tbc_signMessage",
  ]);
  assert.deepEqual(forgedWallet.methods, ["tbc_requestAccounts", "tbc_signMessage"]);
  active.session.close();
  forgedWallet.session.close();
  return {
    standardMessage: message.scheme,
    typedData: typed.scheme,
    signInProviderRequests: active.methods.length - methodsBeforeSignIn,
    challengeState: "consumed",
    replay: "rejected",
    sessionCreatedBy: "backend",
    mismatchedKeyChallengeState: "issued",
  };
}
