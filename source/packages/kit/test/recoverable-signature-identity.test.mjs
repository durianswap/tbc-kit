import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Observe the same dependency instance as the installed bundle; patching a
// workspace copy of noble cannot count calls made by a clean installed copy.
const packageRoot = process.env.TBC_TEST_INSTALLED_KIT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");

function observe(format) {
  const extension = format === "esm" ? "js" : "cjs";
  const walletPath = resolve(packageRoot, `dist/${format}/wallet.${extension}`);
  const load = format === "esm"
    ? `
      const { secp256k1 } = await import("@noble/curves/secp256k1.js");
      const { createTbcWallet, verifyTbcRecoverableSignature } =
        await import(${JSON.stringify(pathToFileURL(walletPath).href)});
    `
    : `
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const { secp256k1 } = require("@noble/curves/secp256k1.js");
      const { createTbcWallet, verifyTbcRecoverableSignature } =
        require(${JSON.stringify(walletPath)});
    `;
  const script = `
    import assert from "node:assert/strict";
    ${load}
    const chainId = "tbc:testnet";
    const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
    const accountId = \`\${chainId}:\${address}\`;
    const origin = "https://dev.durianswap.org";
    const scalar = Uint8Array.from({ length: 32 }, (_, index) =>
      index === 31 ? 1 : 0
    );
    const publicKey = Buffer.from(secp256k1.getPublicKey(scalar, true)).toString("hex");
    const digest = "dcbe45621b28154774991a549de8cd58c72ed87bc7d04e0688e80047071259ab";
    const prototype = secp256k1.Signature.prototype;
    const originalRecovery = prototype.recoverPublicKey;
    let recoveries = 0;
    Object.defineProperty(prototype, "recoverPublicKey", {
      configurable: true,
      writable: true,
      value(...args) {
        recoveries += 1;
        return Reflect.apply(originalRecovery, this, args);
      },
    });
    const permission = (capability) => ({
      id: \`legacy-message-\${capability}\`,
      parentCapability: capability,
      invoker: origin,
      date: Date.parse("2026-09-17T00:00:00Z"),
      caveats: [
        { type: "restrictChains", value: [chainId] },
        { type: "restrictAccounts", value: [accountId] },
        { type: "restrictMethods", value: [capability] },
      ],
    });
    const wallet = createTbcWallet({
      accounts: {
        current: async () => [{ accountId, address, chainId, publicKey }],
      },
      approval: {
        request: async (params) => ({
          status: "approved",
          approvalId: "signature-identity-approval",
          approvalToken: "signature-identity-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-17T00:00:03Z",
          expiresAt: params.binding.payload.expiresAt,
        }),
      },
      signer: {
        sign: async (params) => {
          const signature = secp256k1.sign(params.task.digest, scalar, {
            prehash: false,
            lowS: true,
          });
          const encoded = \`\${(31 + signature.recovery).toString(16)}\${signature.toCompactHex()}\`;
          verifyTbcRecoverableSignature(encoded, params.task.digest, publicKey);
          return {
            taskId: params.task.taskId,
            signatureEncoding: "compact65-recoverable",
            signature: encoded,
          };
        },
      },
      storage: {
        loadPermissions: async () => ({
          revision: "0",
          permissions: [permission("tbc_accounts"), permission("tbc_signMessage")],
        }),
        commitPermissions: async () => { throw new Error("unexpected permission commit"); },
      },
      network: {
        resolveChainData: async () => { throw new Error("unexpected chain data"); },
        resolvePolicy: async () => { throw new Error("unexpected policy"); },
        broadcastSubmit: async () => { throw new Error("unexpected broadcast"); },
        broadcastReconcile: async () => { throw new Error("unexpected reconcile"); },
      },
      legacy: { bitcoinMessageDigest: async () => digest },
      clock: (() => {
        let second = 0;
        return () => \`2026-09-17T00:00:\${String(++second).padStart(2, "0")}Z\`;
      })(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    const session = await wallet.openSession({ origin, sessionId: "signature-identity" });
    const delivery = await session.handleLegacyRequest({
      id: "signature-identity-request",
      method: "tbc_signMessage",
      params: {
        version: "1.0",
        chainId,
        from: address,
        clientRequestId: \`legacy-bitcoin:\${digest}\`,
        message: { encoding: "utf8", data: "legacy-order" },
      },
    });
    assert.equal("error" in delivery.response, false);
    assert.equal(delivery.response.result.digest, digest);
    assert.equal(recoveries, 1);
    session.close();
    console.log(JSON.stringify({ recoveries }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { cwd: packageRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${format}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("wallet Signer and Core share one one-use signature verification slot", () => {
  for (const format of ["esm", "cjs"]) {
    assert.deepEqual(observe(format), { recoveries: 1 }, format);
  }
});
