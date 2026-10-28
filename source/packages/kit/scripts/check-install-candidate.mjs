// Install the exact local tarball in an isolated consumer, never a Mobile tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const [tarArgument, expectedVersion, expectedSha] = process.argv.slice(2);
assert.ok(tarArgument && expectedVersion && /^[a-f0-9]{64}$/u.test(expectedSha ?? ""),
  "usage: node check-install-candidate.mjs TAR VERSION SHA256");
const tar = resolve(tarArgument);
assert.equal(createHash("sha256").update(await readFile(tar)).digest("hex"), expectedSha);
const consumer = await mkdtemp(resolve(tmpdir(), "tbc-kit-install-gate-"));
await writeFile(resolve(consumer, "package.json"), JSON.stringify({
  name: "kit-installation-gate", version: "1.0.0", private: true, type: "module",
}));
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tar], {
  cwd: consumer, stdio: "inherit", timeout: 180000,
});
const installed = resolve(consumer, "node_modules/@tbc/kit");
const manifest = JSON.parse(await readFile(resolve(installed, "package.json"), "utf8"));
assert.equal(manifest.version, expectedVersion);
const provenance = JSON.parse(await readFile(resolve(installed, "artifacts/provenance.json"), "utf8"));
const installedWallet = await import(resolve(installed, "dist/esm/wallet.js"));
assert.equal(provenance.package, `@tbc/kit@${expectedVersion}`);
assert.equal(provenance.protocolFingerprint, installedWallet.TWS_RELEASE_FINGERPRINT);
for (const artifact of provenance.artifacts) {
  const digest = createHash("sha256")
    .update(await readFile(resolve(installed, artifact.path)))
    .digest("hex");
  assert.equal(digest, artifact.sha256, artifact.path);
}
const subpaths = [".", "./wallet", "./engine", "./rpc", "./api", "./sqlite", "./testing"];
// Frozen seven-entry packages remain valid; new multisig is an opt-in eighth
// entry, not a changed root/wallet/partner contract.
if (Object.hasOwn(manifest.exports, "./multisig")) subpaths.push("./multisig");
assert.deepEqual(Object.keys(manifest.exports).sort(), [...subpaths].sort());
async function checkTargets(value) {
  if (typeof value === "string") {
    assert.ok(value.startsWith("./dist/"));
    await readFile(resolve(installed, value));
  } else {
    for (const nested of Object.values(value)) await checkTargets(nested);
  }
}
await checkTargets(manifest.exports);
// Check the complete packaged declaration closure, not only declarations
// reachable from the small public-type consumer fixture.
async function checkDeclarations(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await checkDeclarations(path);
    else if (entry.name.endsWith(".d.ts")) {
      assert.doesNotMatch(await readFile(path, "utf8"), /from ["']@tbc-wallet\//u, path);
    }
  }
}
await checkDeclarations(resolve(installed, "dist/types"));
for (const condition of [undefined, "browser", "react-native"]) {
  const expected = condition === "react-native"
    ? { ".": "dist/esm/index.native.js", "./wallet": "dist/esm/wallet.js", "./engine": "dist/esm/engine.js", "./rpc": "dist/esm/rpc.js", "./api": "dist/esm/api.js", "./sqlite": "dist/esm/sqlite.js", "./testing": "dist/esm/testing.js" }
    : condition === "browser"
      ? { ".": "dist/esm/index.js", "./wallet": "dist/esm/wallet.js", "./engine": "dist/esm/engine.js", "./rpc": "dist/esm/rpc.js", "./api": "dist/esm/api.js", "./sqlite": "dist/esm/sqlite.js", "./testing": "dist/esm/testing.js" }
      : { ".": "dist/esm/index.node.js", "./wallet": "dist/esm/wallet.node.js", "./engine": "dist/esm/engine.node.js", "./rpc": "dist/esm/rpc.js", "./api": "dist/esm/api.js", "./sqlite": "dist/esm/sqlite.js", "./testing": "dist/esm/testing.js" };
  if (subpaths.includes("./multisig")) expected["./multisig"] = "dist/esm/multisig.js";
  const code = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const conditioned = ${condition !== undefined};
    const expected = ${JSON.stringify(expected)};
    for (const path of ${JSON.stringify(subpaths)}) {
      const name = path === '.' ? '@tbc/kit' : '@tbc/kit' + path.slice(1);
      const esm = await import(name);
      assert.ok(Object.keys(esm).length > 0, name);
      assert.ok(import.meta.resolve(name).endsWith('/' + expected[path]), name + ' -> ' + import.meta.resolve(name));
      if (!conditioned) {
        assert.deepEqual(Object.keys(require(name)).sort(), Object.keys(esm).sort(), name);
        const cjs = path === '.' ? 'index' : path.slice(2);
        assert.ok(require.resolve(name).endsWith('/dist/cjs/' + cjs + '.cjs'), name);
      }
    }
    if (!conditioned) {
      const input = { version: '1.0', request: { version: '1.0',
        chainId: 'tbc:testnet',
        from: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
        intent: { version: '1.0', type: 'tbc.transfer',
          to: '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP', amount: '1000' } } };
      const esmEngine = await import('@tbc/kit/engine');
      const cjsEngine = require('@tbc/kit/engine');
      const esmNormalized = await esmEngine.createTbcEngine().normalizeRequest(input);
      const cjsNormalized = await cjsEngine.createTbcEngine().normalizeRequest(input);
      assert.equal(esmNormalized.requestHash, cjsNormalized.requestHash);
      assert.equal(esmNormalized.request.intent.type, 'tbc.transfer');
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error('Node Keyless must load locally, not over HTTP'); };
      try {
        for (const entry of [await import('@tbc/kit'), await import('@tbc/kit/wallet'), require('@tbc/kit'), require('@tbc/kit/wallet')]) {
          const keyless = entry.createLazyBundledWasmTbcKeylessEngine();
          const [first, second] = await Promise.all([keyless.protocolInfo(), keyless.protocolInfo()]);
          assert.equal(first, second);
          assert.ok(JSON.parse(first).operations.includes('inspectTokenMaterial'));
          await assert.rejects(keyless.execute('sign', '{}'), /KEYLESS_OPERATION_UNAVAILABLE/);
        }
      } finally { globalThis.fetch = previousFetch; }
    }
    const wallet = await import('@tbc/kit/wallet');
    const root = await import('@tbc/kit');
    assert.equal(typeof root.composeTbcWorkflow, 'function');
    assert.equal(typeof root.createTimelockReader, 'function');
    assert.equal(typeof root.createTbc721Reader, 'function');
    const api = await import('@tbc/kit/api');
    assert.equal(typeof api.createTimelockReader, 'function');
    assert.equal(typeof api.createTbc721Reader, 'function');
    const timelock = api.createTimelockReader({ api: {
      nodeInfo() { throw new Error('Reader construction must not fetch'); },
      timelockUtxosByAddress() { throw new Error('Reader construction must not fetch'); },
      rawTransaction() { throw new Error('Reader construction must not fetch'); },
    } });
    assert.equal(typeof timelock.listDeposits, 'function');
    assert.deepEqual(wallet.TBC_KIT_LEGACY_MIGRATION_CONTRACT.map(x => x.id),
      ['ft-mint', 'ft-transfer', 'pool-signing']);
    assert.equal(typeof wallet.createPoolMaterialLoader, 'function');
    assert.equal(typeof wallet.createPoolMaterialNativeProvider, 'function');
    assert.equal(typeof wallet.createPoolSnapshotMaterialRetention, 'function');
    const retained = wallet.createPoolSnapshotMaterialRetention();
    assert.equal(typeof retained.readSwapTbcForToken, 'function');
    assert.equal(typeof retained.readSwapTokenForTbc, 'function');
    assert.equal(typeof wallet.createTbcMultiRoundMergeOrchestrator, 'function');
    assert.equal(typeof wallet.hashTbcMultiRoundMergeState, 'function');
    assert.equal(typeof wallet.projectTbcApprovalPreparation, 'function');
    assert.equal(typeof wallet.projectTbcApprovalPresentation, 'function');
    const sqlite = await import('@tbc/kit/sqlite');
    assert.equal(wallet.TWS_RELEASE_FINGERPRINT, sqlite.TBC_KIT_HOST_RELEASE_FINGERPRINT);
  `;
  execFileSync(process.execPath, [
    ...(condition ? [`--conditions=${condition}`] : []), "--input-type=module", "-e", code,
  ], { cwd: consumer, stdio: "inherit", timeout: 60000 });
}
// Compile against installed declarations, with no workspace package aliases.
await writeFile(resolve(consumer, "consumer.ts"), `
import { createTbcWallet, createLegacyStandardWorkflowBatchAdapter,
  createTbcMultiRoundMergeOrchestrator,
  createPoolMaterialLoader, createPoolMaterialNativeProvider,
  createPoolSnapshotMaterialRetention,
  projectTbcApprovalPreparation, projectTbcApprovalPresentation,
  TBC_KIT_LEGACY_MIGRATION_CONTRACT,
  type StandardApprovalPreparationHandle,
  type TbcApprovalPresentation } from '@tbc/kit/wallet';
import * as root from '@tbc/kit';
import * as engine from '@tbc/kit/engine';
import * as sqlite from '@tbc/kit/sqlite';
import * as api from '@tbc/kit/api';
import * as rpc from '@tbc/kit/rpc';
import * as testing from '@tbc/kit/testing';
type Session = Awaited<ReturnType<ReturnType<typeof createTbcWallet>['openSession']>>;
type Input = Parameters<Session['handleLegacyWorkflowRequest']>[0];
declare const session: Session;
declare const input: Input;
declare const handle: StandardApprovalPreparationHandle;
declare const connected: root.TbcConnectedWallet;
declare const preparedNetwork: Parameters<typeof root.prepareTbcTransaction>[0]['network'];
declare const transactionEngine: Parameters<typeof root.prepareTbcTransaction>[0]['engine'];
declare const nftItems: root.Tbc721MintJobInput['items'];
declare const nftLimits: root.TbcNftMintJobLimits;
const nftJob: Promise<root.TbcNftMintJobResult> = connected.tbc721.batchMint({
  collectionId: '21'.repeat(32), items: nftItems, limits: nftLimits,
});
void nftJob.then(result => result.minted);
void session.runNftMintJob({ collectionId: '21'.repeat(32), items: nftItems, limits: nftLimits });
void connected.tbc721.batchMint({ collectionId: '21'.repeat(32), items: nftItems });
void connected.tbc721.batchTransfer({ transfers: [{ contractId: '21'.repeat(32), to: connected.account }] });
void root.createTbcClient({ network: 'testnet' }).tbc721.getMintStatus({ collectionId: '21'.repeat(32), address: connected.account });
void session.handleLegacyWorkflowRequest({ ...input, approvalPreparation: handle });
const stablecoinIntent = {
  type: 'tbc.stablecoin.transfer', version: '1.0', contractId: '21'.repeat(32),
  to: connected.account, amount: '1000000',
} as const;
void connected.stablecoin.transfer({
  contractId: stablecoinIntent.contractId, to: stablecoinIntent.to, amount: stablecoinIntent.amount,
});
void connected.walletBuild.sign({ intent: stablecoinIntent });
void root.prepareTbcTransaction({
  request: { version: '1.0', chainId: connected.chainId, from: connected.account, intent: stablecoinIntent },
  network: preparedNetwork, engine: transactionEngine,
}).then(prepared => connected.wallet.signProposal(prepared));
void connected.maintenance.mergeStablecoin({ contractId: stablecoinIntent.contractId });
const composed = root.composeTbcWorkflow({ steps: [{
  id: 'message', kind: 'message', dependsOn: [],
  message: { encoding: 'utf8', data: 'installed consumer' },
}] as const });
void connected.walletBuild.signWorkflow(composed).then(result => result.steps[0].id);
void connected.walletBuild.sendWorkflow(composed).then(result => result.transactions[0]?.status);
void connected.maintenance.multiRoundMerge({
  asset: { kind: 'tbc' },
  limits: { targetUtxoCount: 1, maxTransactions: 3, maxTotalFee: '5000', expiresAt: new Date().toISOString() },
});
void connected.maintenance.multiRoundMerge({
  asset: { kind: 'stablecoin', contractId: stablecoinIntent.contractId },
  limits: { targetUtxoCount: 1, maxTransactions: 3, maxTotalFee: '5000', expiresAt: new Date().toISOString() },
});
void session.runMultiRoundMerge({
  asset: { kind: 'tbc' },
  limits: { targetUtxoCount: 1, maxTransactions: 3, maxTotalFee: '5000', expiresAt: new Date().toISOString() },
});
void session.runMultiRoundMerge({
  asset: { kind: 'stablecoin', contractId: stablecoinIntent.contractId },
  limits: { targetUtxoCount: 1, maxTransactions: 3, maxTotalFee: '5000', expiresAt: new Date().toISOString() },
});
void session.runMultiRoundMerge({
  asset: { kind: 'pool-ft', poolContractId: '21'.repeat(32) },
  limits: { targetUtxoCount: 1, maxTransactions: 3, maxTotalFee: '5000', expiresAt: new Date().toISOString() },
});
void session.runMultiRoundMerge({
  asset: { kind: 'ftlp', poolContractId: '21'.repeat(32) },
  limits: { targetUtxoCount: 1, maxTransactions: 3, maxTotalFee: '5000', expiresAt: new Date().toISOString() },
});
void [root, engine, sqlite, api, rpc, testing, createLegacyStandardWorkflowBatchAdapter,
  createTbcMultiRoundMergeOrchestrator, createPoolMaterialLoader,
  createPoolMaterialNativeProvider, createPoolSnapshotMaterialRetention,
  projectTbcApprovalPreparation, projectTbcApprovalPresentation,
  TBC_KIT_LEGACY_MIGRATION_CONTRACT];
declare const presentation: TbcApprovalPresentation;
void presentation.binding.status;
`);
execFileSync(process.execPath, [
  resolve(import.meta.dirname, "../../../node_modules/typescript/bin/tsc"),
  "--noEmit", "--strict", "--skipLibCheck", "false", "--target", "ES2022",
  "--module", "NodeNext", "--moduleResolution", "NodeNext", "consumer.ts",
], { cwd: consumer, stdio: "inherit", timeout: 60000 });

// Compile the two supported consumer profiles independently.  The browser
// DApp fixture imports only root; trusted wallet composition opts into the
// private-authority subpaths explicitly.
await writeFile(resolve(consumer, "dapp-profile.ts"), `
import { composeTbcWorkflow, createTbcClient, type TbcConnectedWallet } from '@tbc/kit';
declare const wallet: TbcConnectedWallet;
const workflow = composeTbcWorkflow({ steps: [{
  id: 'message', kind: 'message', dependsOn: [],
  message: { encoding: 'utf8', data: 'root-only DApp profile' },
}] as const });
void createTbcClient({ network: 'testnet' });
void wallet.walletBuild.signWorkflow(workflow);
void wallet.walletBuild.sendWorkflow(workflow);
void wallet.maintenance.multiRoundMerge({
  asset: { kind: 'stablecoin', contractId: '21'.repeat(32) },
  limits: { targetUtxoCount: 1, maxTransactions: 3, maxTotalFee: '5000', expiresAt: new Date().toISOString() },
});
`);
await writeFile(resolve(consumer, "wallet-profile.ts"), `
import { createTbcClient } from '@tbc/kit';
import { createTbcWallet } from '@tbc/kit/wallet';
import { createTbcEngine } from '@tbc/kit/engine';
import { createTbcKitMemoryHostStore } from '@tbc/kit/sqlite';
void [createTbcClient, createTbcWallet, createTbcEngine, createTbcKitMemoryHostStore];
`);
for (const [profile, customConditions] of [
  ['dapp-profile.ts', []],
  ['wallet-profile.ts', ['--customConditions', 'react-native']],
]) {
  execFileSync(process.execPath, [
    resolve(import.meta.dirname, "../../../node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "false", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", ...customConditions, profile,
  ], { cwd: consumer, stdio: "inherit", timeout: 60000 });
}
execFileSync(process.execPath, [
  resolve(installed, "examples/multi-round-merge/run.mjs"),
], { cwd: consumer, stdio: "inherit", timeout: 60000 });
execFileSync(process.execPath, [
  resolve(installed, "examples/approval-presentation/run.mjs"),
], { cwd: consumer, stdio: "inherit", timeout: 60000 });
await import(resolve(installed, "examples/approval-presentation/host-reader-callback.mjs"));
const nftExample = await import(resolve(installed, "examples/nft-three-step/batch.mjs"));
assert.equal(typeof nftExample.mintNftJob, "function");
assert.equal(typeof nftExample.transferNftBatch, "function");
execFileSync(process.execPath, [
  resolve(installed, "examples/backend-node/run.mjs"),
], { cwd: consumer, stdio: "inherit", timeout: 60000 });
execFileSync(process.execPath, [
  resolve(installed, "examples/backend-node/run.mjs"), "--send",
], { cwd: consumer, stdio: "inherit", timeout: 60000 });
console.log(JSON.stringify({ status: "passed", consumer, tar, version: expectedVersion,
  sha256: expectedSha, gates: ["clean-install", "exports", "ESM/CJS", "RN-condition-resolution",
    "migration-contract", "Host/Core-identity", "packed-provenance", "installed-public-types", "DApp-browser-profile",
    "wallet-RN-profile", "public-entry-node-browser-RN-resolution", "Node-ESM-CJS-package-WASM-load",
    "multi-round-example", "approval-presentation-example", "approval-host-reader-callback-import",
    "backend-sign-example", "backend-explicit-send-example"],
  deviceAcceptance: false }));
