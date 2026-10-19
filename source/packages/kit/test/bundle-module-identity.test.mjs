import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function observe(format, side) {
  const extension = format === "esm" ? "js" : "cjs";
  const walletPath = resolve(packageRoot, `dist/${format}/wallet.${extension}`);
  const sqlitePath = resolve(packageRoot, `dist/${format}/sqlite.${extension}`);
  const load = format === "esm"
    ? `
      const { configureTbcKitSha256Backend, createTbcWallet } =
        await import(${JSON.stringify(pathToFileURL(walletPath).href)});
      const { createTbcKitMemoryHostStore } =
        await import(${JSON.stringify(pathToFileURL(sqlitePath).href)});
    `
    : `
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const { configureTbcKitSha256Backend, createTbcWallet } =
        require(${JSON.stringify(walletPath)});
      const { createTbcKitMemoryHostStore } =
        require(${JSON.stringify(sqlitePath)});
    `;
  const script = `
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    ${load}
    const chainId = "tbc:testnet";
    const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
    const accountId = \`${"${chainId}:${address}"}\`;
    const origin = "https://dev.durianswap.org";
    const account = {
      accountId,
      chainId,
      address,
      publicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    };
    let calls = 0;
    let bytes = 0;
    const sha256 = (input) => {
      calls += 1;
      bytes += input.length;
      return new Uint8Array(createHash("sha256").update(input).digest());
    };
    configureTbcKitSha256Backend(sha256);
    const hostStore = ${JSON.stringify(side)} === "external"
      ? createTbcKitMemoryHostStore({ sha256 })
      : undefined;
    const forbidden = async () => { throw new Error("unexpected approval, signer, network, or POST"); };
    const wallet = createTbcWallet({
      accounts: { current: async () => [account] },
      approval: { request: forbidden },
      signer: { sign: forbidden },
      storage: {
        ...(hostStore === undefined ? {} : { hostStore }),
        loadPermissions: async () => ({
          revision: "0",
          permissions: [{
            id: "accounts-read",
            parentCapability: "tbc_accounts",
            invoker: origin,
            date: Date.parse("2026-09-17T00:00:00Z"),
            caveats: [
              { type: "restrictChains", value: [chainId] },
              { type: "restrictAccounts", value: [accountId] },
              { type: "restrictMethods", value: ["tbc_accounts"] },
            ],
          }],
        }),
        commitPermissions: forbidden,
      },
      network: {
        resolveChainData: forbidden,
        resolvePolicy: forbidden,
        broadcastSubmit: forbidden,
        broadcastReconcile: forbidden,
      },
      clock: () => "2026-09-17T00:00:10Z",
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    const session = await wallet.openSession({ origin, sessionId: "bundle-identity" });
    const samples = [];
    for (let index = 0; index < 3; index += 1) {
      calls = 0;
      bytes = 0;
      const delivery = await session.handleRequest({
        id: \`accounts-${"${index}"}\`,
        method: "tbc_accounts",
        params: [],
      });
      assert.ok(!("error" in delivery.response));
      assert.deepEqual(delivery.response.result, [address]);
      samples.push({ calls, bytes });
    }
    session.close();
    console.log(JSON.stringify(samples));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${format}/${side}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("wallet and sqlite public entries share one private Core identity", () => {
  for (const format of ["esm", "cjs"]) {
    const internal = observe(format, "internal");
    const external = observe(format, "external");
    assert.deepEqual(
      external,
      internal,
      `${format}: a /sqlite store must retain /wallet checkpoint ownership and SHA-256 backend identity`,
    );
    assert.deepEqual(internal, [
      // Frozen platform-slim.20261010.3 baseline, before JS deduplication.
      // Keep the exact check count and serialized-byte budget on both sides.
      { calls: 38, bytes: 23_558 },
      { calls: 38, bytes: 23_558 },
      { calls: 38, bytes: 23_558 },
    ]);
  }
});
