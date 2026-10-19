#!/usr/bin/env node
// Current source Kit/Core/Host + source WASM. Public scalar 1 and invented
// index/funding only. Unexpected endpoints or POST fail; no wallet secrets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { registerHooks, createRequire } from "node:module";
import { build } from "esbuild";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { createWasmDigestSigner } from "../../../native/signer/kernel/wasm/adapter.mjs";
import { loadFrozenCoinHarness } from "./lib/frozen-coin-harness.mjs";
import { createCoinMuSigFixtureSigner } from "./lib/coin-musig-fixture-signer.mjs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const installedConsumer = process.env.TBC_COIN_INSTALLED_CONSUMER;
const frozen = installedConsumer ? await loadFrozenCoinHarness({consumer: installedConsumer,
  archive: process.env.TBC_COIN_INSTALLED_ARCHIVE, source: process.env.TBC_COIN_FIXTURE_SOURCE,
  signerWasm: process.env.TBC_COIN_SOURCE_SIGNER_WASM, expectedVersion: process.env.TBC_COIN_INSTALLED_VERSION}) : undefined;
let unexpectedHttp = 0;
if (frozen) globalThis.fetch = () => { unexpectedHttp++; throw new Error('Unexpected external HTTP in frozen Coin check'); };
const requireFixture = createRequire(new URL('../../kit/package.json', import.meta.url));
const vm = frozen ? requireFixture('tbc-lib-js') : undefined;
if (vm) assert.equal(requireFixture('tbc-lib-js/package.json').version, '1.0.31');
const rust = `${frozen ? resolve(process.env.TBC_COIN_FIXTURE_SOURCE) + '/' : root}packages/tbc-engine/rust/`;
const kernelSigner = process.env.TBC_COIN_SOURCE_SIGNER_WASM
  ? await createWasmDigestSigner(readFileSync(process.env.TBC_COIN_SOURCE_SIGNER_WASM)) : undefined;
async function signDigest(digest, encoding, scalarNumber = 1, input) {
  if(scalarNumber==='musig')return cooperativeSigner.sign(input);
  // Independent oracle remains mandatory when exercising the real Rust Signer.
  const scalarHex = scalarNumber.toString(16).padStart(64, "0");
  const ecdsa = encoding === "schnorr64" ? undefined : secp256k1.sign(digest, scalarHex, { prehash: false, lowS: true });
  const expected = encoding === "schnorr64"
    ? Buffer.from(schnorr.sign(digest, scalarHex, "00".repeat(32))).toString("hex")
    : `${encoding === "compact65-recoverable" ? (31 + ecdsa.recovery).toString(16) : ""}${ecdsa.toCompactHex()}`;
  if (!kernelSigner) return expected;
  const scalar = Uint8Array.from(Buffer.from(scalarHex, "hex"));
  try {
    const signature = await kernelSigner.signDigest(digest, scalar, encoding);
    assert.equal(signature, expected, `Rust/Noble mismatch: ${encoding}`);
    return signature;
  } finally { scalar.fill(0); }
}
const fixture = JSON.parse(readFileSync(`${rust}fixtures/coin-proof.json`, "utf8"));
const NOW = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
const explicitAdmin = process.argv.includes("--admin-role");
const unifiedHolder = process.argv.includes("--unified-holder");
const cooperativeAdmin = process.argv.includes("--musig-admin");
assert.ok(!cooperativeAdmin||(frozen&&explicitAdmin),'MuSig fixture requires pinned installed mode and explicit administrator');
assert.ok(process.argv.slice(2).every(arg => ["--admin-role", "--unified-holder", "--musig-admin"].includes(arg)));
let kit;
if (frozen) kit = frozen.kit;
else {
const compiled = spawnSync("cargo", ["build", "--offline", "--locked", "--release", "-p", "tbc-engine-wasm", "-p", "tbc-keyless-wasm", "--target", "wasm32-unknown-unknown"], {
  cwd: rust, env: { ...process.env, RUSTFLAGS: '--cfg getrandom_backend="unsupported"' },
  encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
});
assert.equal(compiled.status, 0, "Source WASM build failed; raw output withheld");
const bundled = await build({
  stdin: { contents: `
    export { createDefaultTbcNetwork } from './packages/kit/src/default-network.ts';
    export { createTbcNetworkContext } from './packages/kit/src/network-context.ts';
    export { prepareTbcTransaction } from './packages/kit/src/prepared.ts';
    export { prepareTbcWorkflow } from './packages/kit/src/prepared.ts';
    export { preparedChainDataRequirement } from './packages/kit/src/prepared-chain-data.ts';
    export { inspectTbcTransaction } from './packages/kit/src/testnet-validation.ts';
    export { createTbcWallet } from './packages/kit/src/wallet-runtime.ts';
    export { createTbcClient } from './packages/kit/src/client.ts';
    export { createApprovalHostEvidenceReader } from './packages/kit/src/approval-host-evidence.ts';
    export { projectTbcApprovalPresentation } from './packages/kit/src/approval-presentation.ts';
    export { createMemoryTwsHostStore } from './packages/host/src/index.ts';
    export { chainDataRequirement } from './packages/core/src/reducers/chain-data-requirements.ts';
    export { hashCanonical, assertValidTws } from './packages/core/src/index.ts';
    export { TWS_RELEASE_FINGERPRINT } from './packages/core/src/release.ts';
    export { createTbcEngine } from './packages/tbc-engine/src/facade.ts';
    export { createWasmTbcEngineBackend } from './packages/tbc-engine/src/wasm.ts';
    export { createWasmTbcKeylessEngine } from './packages/kit/src/keyless.ts';
  `, resolveDir: root, loader: "ts" },
  alias: { "@tbc-wallet/core": `${root}packages/core/src/index.ts`, "@tbc-wallet/host": `${root}packages/host/src/index.ts`,
    "@tbc-wallet/provider": `${root}packages/provider/src/index.ts`, "@tbc-wallet/provider/in-memory": `${root}packages/provider/src/in-memory.ts` },
  bundle: true, write: false, format: "esm", platform: "node", target: "node22", logLevel: "silent",
});
const virtualUrl = new URL("../../../packages/kit/src/.coin-source-check.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) { return specifier === virtualUrl ? { url: virtualUrl, shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === virtualUrl ? { source: bundled.outputFiles[0].text, format: "module", shortCircuit: true } : next(url, context); },
});
kit = await import(virtualUrl); hooks.deregister();
}
const engine = kit.createTbcEngine({ backend: await kit.createWasmTbcEngineBackend(
  readFileSync(frozen?.wasm ?? `${rust}target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm`)) });
const keyless = unifiedHolder ? await kit.createWasmTbcKeylessEngine(
  readFileSync(frozen?.keyless ?? `${rust}target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm`)) : undefined;
const parse = raw => ({ raw, ...kit.inspectTbcTransaction(raw) });
const issuer = parse(fixture.vectors[0].ancestorsRaw[0]);
const mint = parse(fixture.vectors[0].parentRaw);
const split = parse(fixture.vectors[0].signedRaw);
const funding = parse(JSON.parse(readFileSync(`${rust}fixtures/coin-admin-proof.json`, "utf8")).issuance.grandparentRaw);
const raws = new Map([issuer, mint, split, funding].map(tx => [tx.txid, tx.raw]));
const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const account = { chainId: "tbc:testnet", address, accountId: `tbc:testnet:${address}`, publicKey: fixture.vectors[0].publicKeyHex };
const administrator = { chainId: account.chainId, address: "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP",
  accountId: `${account.chainId}:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP`, publicKey: "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5" };
const cooperativeSigner=cooperativeAdmin?await createCoinMuSigFixtureSigner(process.env.TBC_COIN_MUSIG_SIGNER_SDK,vm,kit.hashCanonical):undefined;
if(cooperativeSigner)Object.assign(administrator,{address:cooperativeSigner.address,
  accountId:`${account.chainId}:${cooperativeSigner.address}`,publicKey:cooperativeSigner.publicKey});
const accounts = explicitAdmin ? [account, administrator] : [account];
const adminScope = intent => explicitAdmin && ["create", "mint", "freeze", "unfreeze"].some(action => intent.type === `tbc20-stablecoin-${action}`)
  ? { signingRoles: [{ role: "coin-admin", accountId: administrator.accountId }] } : {};
const signingAccount = task => {
  const selected = accounts.find(a => a.accountId === task.accountId);
  assert.ok(selected, "No fallback key for unknown role account");
  assert.ok(task.publicKey === selected.publicKey || task.publicKey === selected.publicKey.slice(2));
  return selected === administrator ? cooperativeAdmin?'musig':2 : 1;
};
const transfer = { type: "tbc20-stablecoin-transfer", version: "1.0", contractId: issuer.txid, to: address, amount: "250" };
const intents = [transfer, { type: "tbc20-stablecoin-merge", version: "1.0", contractId: issuer.txid },
  { ...transfer, payment: { to: address, amount: "24" } },
  { type: transfer.type, version: "1.0", contractId: issuer.txid, receivers: [{ to: address, amount: "250" }, { to: address, amount: "300" }] },
  { type: "tbc20-stablecoin-create", version: "1.0", name: "Offline Coin", symbol: "OFF", decimals: 6, initialSupply: "2500000" }];
if (unifiedHolder) intents.push(...intents.slice(0,4).map(intent=>({...intent,
  type:intent.type.endsWith("merge")?"tbc20Stablecoin.merge":"tbc20Stablecoin.transfer"})));
const management = new Map();
function setup(intent, beforeRead = () => {}, nativeCandidates, mutateData = (_path, data) => data) {
  const merge = intent.type.endsWith("merge");
  const create = intent.type.endsWith("create");
  const managed = management.get(intent.type);
  const parent = managed?.parent ?? (create ? funding : merge ? split : mint);
  const assetVouts = merge ? [0, 2] : [3];
  const feeVout = create ? 0 : parent.transaction.outputs.length - 1;
  const trace = []; let sequence = 0;
  const fetch = async (input, init) => {
    beforeRead(); const url = new URL(String(input)); const path = url.pathname;
    assert.equal(url.origin, "https://api.tbcdev.org");
    assert.equal(init?.method ?? "GET", managed && path === "/api/tbc/txo/status" ? "POST" : "GET"); trace.push(path);
    let data;
    if (path === "/api/tbc/nodeinfo") data = { blocks: 100, bestblockhash: "aa".repeat(32), mediantime: 500000101 };
    else if (path === `/api/tbc/utxo/address/${address}`) data = { utxos: nativeCandidates ?? [{ txid: parent.txid, index: feeVout,
      value: parent.transaction.outputs[feeVout].satoshis.toString(), height: 99 }] };
    else if (managed && path === "/api/tbc/txo/status") {
      const body=JSON.parse(init.body);
      data={txos:body.txos.map(point=>{
        const tx=parse(raws.get(point.txid)), out=tx.transaction.outputs[point.index];assert.ok(out);
        return {txid:point.txid,index:String(point.index),value:out.satoshis.toString(),spent:false,height:"99"};
      })};
    } else if (managed && path.startsWith("/api/tbc/utxo/scriptpubkeyhash/")) {
      assert.equal(intent.type,"tbc20-stablecoin-mint");
      data={utxos:[{txid:managed.certificate.txid,index:"0",value:"200",height:"99"}]};
    } else if (path.startsWith("/api/tbc/stablecoin/utxo/combinescript/") && path.endsWith(`/stablecoinid/${issuer.txid}`)) {
      data = { utxos: assetVouts.map((index, i) => ({ txid: parent.txid, index, tbc_value: "500", ft_value: merge ? ["250", "750"][i] : "1000", height: 99, lock_time: 0 })) };
    } else if (path.startsWith("/api/tbc/txraw/txid/")) {
      const id = path.split("/").at(-1); assert.ok(raws.has(id), "Unexpected history traversal"); data = { txraw: raws.get(id) };
    } else throw new Error(`Unexpected read (metadata/history/POST forbidden): ${path}`);
    return new Response(JSON.stringify({ code: "200", data: mutateData(path, data) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const network = kit.createDefaultTbcNetwork({ network: kit.createTbcNetworkContext({ network: "testnet" }), accounts: { current: async () => accounts }, fetch,
    ...(keyless === undefined ? {} : {poolNative:keyless}),
    now: () => Date.parse(NOW), snapshotId: () => `coin-${++sequence}`,
    poolMaterial: { async resolveLiquidityAdd() { throw new Error("Unrelated Pool path"); } },
  });
  return { network, trace, parent, assetVouts, feeVout };
}
const checks = [];
const executionRows = [];
let vmInputs = 0, vmTransactions = 0;
function verifyBundle(transactions) {
  if (!vm) return undefined;
  const parents = new Map(raws); let inputs = 0;
  for (const item of transactions) {
    const tx = new vm.Transaction(item.rawTransaction);
    assert.equal(tx.id, item.txid);
    for (const [index, input] of tx.inputs.entries()) {
      const parentId = input.prevTxId.toString('hex');
      assert.ok(parents.has(parentId), 'Independent VM parent missing');
      const parent = new vm.Transaction(parents.get(parentId));
      assert.equal(parent.id, parentId); input.output = parent.outputs[input.outputIndex];
      assert.ok(input.output); assert.equal(tx.verifyScript(index).success, true, 'Independent VM rejected input');
      inputs++;
    }
    parents.set(tx.id, item.rawTransaction); vmTransactions++;
  }
  vmInputs += inputs; return inputs;
}
for (const intent of intents) for (const prepared of [false, true]) {
  const create = intent.type.endsWith("create");
  const managed = management.has(intent.type);
  const request = { version: "1.0", chainId: account.chainId, from: address, intent, ...adminScope(intent), constraints: { maxFee: "5000",
    ...(intent.receivers ? { inputOutpoints: [{ txid: mint.txid, vout: 3 }, { txid: mint.txid, vout: mint.transaction.outputs.length - 1 }] } : {}) } };
  assert.deepEqual(kit.chainDataRequirement(request), kit.preparedChainDataRequirement(request));
  let approvals = 0, signatures = 0, latestPlan;
  const walletNetwork = setup(intent, () => assert.equal(approvals, 0, "Read after approval"));
  const dapp = prepared ? setup(intent) : undefined;
  const params = prepared ? await kit.prepareTbcTransaction({ request, network: dapp.network, engine }) : request;
  const trackedEngine = Object.fromEntries(["normalizeRequest", "plan", "validate", "finalize"].map(method => [method, async input => {
    const result = await engine[method](input); if (method === "plan") latestPlan = result.plan; return result;
  }]));
  const permissions = ["tbc_accounts", "tbc_signTransaction"].map(capability => ({ id: `coin-${capability}`, parentCapability: capability,
    invoker: "https://wallet.test", date: Date.parse(NOW), caveats: [
      { type: "restrictChains", value: [account.chainId] }, { type: "restrictAccounts", value: accounts.map(a => a.accountId) }, { type: "restrictMethods", value: [capability] },
    ] }));
  const hostStore = kit.createMemoryTwsHostStore({ now: () => Date.parse(NOW) });
  const evidenceReader = kit.createApprovalHostEvidenceReader({ store: hostStore, releaseFingerprint: kit.TWS_RELEASE_FINGERPRINT,
    parseApprovalRequest(value) { kit.assertValidTws("approvalRequestParams", value); return value; } });
  const supportedSigningRoles = ["coin-admin"];
  const runtime = kit.createTbcWallet({ legacy: false, accounts: { current: async () => accounts }, engine: trackedEngine,
    capabilities: { version: "1.0", scopes: [{ chainId: account.chainId, intents: [...new Set(["tbc.transfer", ...intents.map(i => i.type)])], profiles: ["core"] }] },
    approval: { supportedSigningRoles, async request(input, call) {
      approvals++; assert.equal(input.binding.payload.operationHash, latestPlan.planHash);
      const presentation = kit.projectTbcApprovalPresentation(await evidenceReader.read(call.callId, input.binding.bindingHash));
      assert.equal(presentation.trust, "binding-verified"); assert.equal(presentation.businessType.value, intent.type);
      if (explicitAdmin && (create || managed)) assert.deepEqual(presentation.signingRoles.value,
        [{ role: "coin-admin", accountId: administrator.accountId }]);
      assert.equal(kit.hashCanonical(presentation.businessTerms.value), kit.hashCanonical(intent));
      assert.ok(input.preview.assetFlows.some(flow => flow.kind === "stablecoin" && (create ? flow.direction === "create" : flow.contractId === intent.contractId)));
      if (managed) {
        const action=presentation.assets.find(asset=>asset.kind==="stablecoin");
        assert.equal(action.direction,intent.type.endsWith("-mint")?"mint":intent.type.endsWith("-unfreeze")?"unlock":"lock");
        assert.equal(presentation.counts.signingTasks.value,intent.type.endsWith("-mint")?3:2);
      }
      if (create) {
        const token = presentation.assets.find(asset => asset.kind === "stablecoin");
        assert.equal(token.symbol.value, "OFF"); assert.equal(token.amount.precision.value, 6); assert.equal(token.amount.display.value, "2.5");
        assert.equal(presentation.counts.transactions.value, 2);
        assert.equal(presentation.counts.signingTasks.value, 4, "Count must include continuation, not only the first fee signature");
      }
      if (intent.payment) assert.ok(input.preview.assetFlows.some(flow => flow.kind === "native" && flow.amount === "24"));
      return { status: "approved", approvalId: "coin", approvalToken: "coin-token", bindingHash: input.binding.bindingHash,
        approvedAt: NOW, expiresAt: input.binding.payload.expiresAt };
    } },
    signer: { async sign(input) {
      assert.equal(approvals, 1); signatures++;
      const scalarNumber = signingAccount(input.task);
      if (input.task.algorithm === "secp256k1-schnorr-bip340") {
        assert.ok(create || managed); assert.equal(input.task.publicKey, (explicitAdmin ? administrator : account).publicKey.slice(2)); assert.equal(input.task.signatureEncoding, "schnorr64");
        return { taskId: input.task.taskId, signatureEncoding: "schnorr64",
          signature: await signDigest(input.task.digest, "schnorr64", scalarNumber, input) };
      }
      assert.equal(input.task.publicKey, account.publicKey);
      return { taskId: input.task.taskId, signatureEncoding: "compact64",
        signature: await signDigest(input.task.digest, "compact64", scalarNumber) };
    } },
    storage: { async loadPermissions() { return { revision: "0", permissions }; }, async commitPermissions() { throw new Error("Unexpected grant write"); } },
    network: walletNetwork.network, clock: () => NOW, randomBytes: length => Uint8Array.from({ length }, (_, i) => i),
  });
  let ids = 0;
  const session = await runtime.openSession({ origin: "https://wallet.test", sessionId: `coin-${checks.length}`,
    requestIdFactory: () => `coin-${++ids}`, execution: { hostStore } });
  try {
    let result;
    if (prepared) result = await session.provider.request({ method: "tbc_signPreparedTransaction", params });
    else {
      const exact = { id: `prefetch-${++ids}`, method: "tbc_signTransaction", params };
      const preparation = session.prefetchRequest(exact);
      assert.equal(await preparation.ready, "ready", JSON.stringify(await preparation.diagnostic));
      assert.equal(approvals + signatures, 0);
      const response = (await session.handleRequest(exact)).response;
      assert.equal(response.error, undefined, JSON.stringify(response.error)); result = response.result;
    }
    assert.equal(approvals, 1); assert.equal(signatures, create ? 4 : intent.type.endsWith("merge") || intent.type.endsWith("-mint") ? 3 : 2);
    const reads = create ? 3 : managed ? intent.type.endsWith("-freeze") ? 5 : 6 : intent.type.endsWith("merge") ? 6 : 5;
    assert.equal(walletNetwork.trace.length, reads); assert.equal(new Set(walletNetwork.trace).size, reads);
    if (prepared) assert.equal(dapp.trace.length, reads);
    assert.equal(result.transactions.length, create ? 2 : 1);
    for (const tx of result.transactions) assert.equal(kit.inspectTbcTransaction(tx.rawTransaction).txid, tx.txid);
    executionRows.push({intent: intent.type, payment: !!intent.payment, receivers: !!intent.receivers,
      entry: prepared ? 'prepared' : 'ordinary', reads, approvals, signatures,
      transactions: result.transactions.length, independentVmInputs: verifyBundle(result.transactions)});
    if (!create && !managed && !intent.payment && !intent.receivers) assert.equal(result.transactions[0].rawTransaction, fixture.vectors[intent.type.endsWith("merge") ? 1 : 0].signedRaw);
    if (prepared && create) {
      const [source, minted]=result.transactions.map(tx=>parse(tx.rawTransaction));
      raws.set(source.txid,source.raw);raws.set(minted.txid,minted.raw);
      management.set("tbc20-stablecoin-freeze",{source,parent:minted,certificate:minted});
      management.set("tbc20-stablecoin-mint",{source,parent:minted,certificate:minted});
      intents.push({type:"tbc20-stablecoin-freeze",version:"1.0",contractId:source.txid,
        targetOutpoints:[{txid:minted.txid,vout:3}],lockTime:"4294967295"},
        {type:"tbc20-stablecoin-mint",version:"1.0",contractId:source.txid,amount:"25",to:address});
    }
    if (prepared && intent.type==="tbc20-stablecoin-freeze") {
      const parent=parse(result.transactions[0].rawTransaction);raws.set(parent.txid,parent.raw);
      management.set("tbc20-stablecoin-unfreeze",{...management.get(intent.type),parent});
      intents.push({type:"tbc20-stablecoin-unfreeze",version:"1.0",contractId:intent.contractId,targetOutpoints:[{txid:parent.txid,vout:0}]});
    }
    checks.push(`${intent.type}${intent.payment ? "+payment" : intent.receivers ? "+receivers" : ""}/${prepared ? "prepared" : "ordinary"}:reads=${reads},approval=1,signatures=${signatures}`);
    if (prepared) {
      const bad = structuredClone(params);
      if (create) {
        const parent = bad.proposal.payload.evidence.parentTransactions[0];
        parent.rawTransaction = parent.rawTransaction.slice(0, -2) + "01";
      }
      else bad.proposal.payload.evidence.contracts[0].genesisOutpoint.txid = mint.txid;
      bad.proposal.proposalHash = kit.hashCanonical(bad.proposal.payload); approvals = 0; signatures = 0;
      await assert.rejects(session.provider.request({ method: "tbc_signPreparedTransaction", params: bad }));
      assert.equal(approvals + signatures, 0, "Rehashed wrong issuer reached signing");
    }
    if (explicitAdmin && (create || managed)) {
      supportedSigningRoles.length = 0; approvals = 0; signatures = 0;
      await assert.rejects(session.provider.request({ method: prepared ? "tbc_signPreparedTransaction" : "tbc_signTransaction", params }));
      assert.equal(approvals + signatures, 0, "Host without role presentation must not approve or sign");
      supportedSigningRoles.push("coin-admin");
    }
  } finally { await session.close(); }
}
const cached = setup(transfer);
const query = { version: "1.0", chainId: account.chainId, accountId: account.accountId, requirement: kit.chainDataRequirement({ intent: transfer }) };
const firstSnapshot = await cached.network.resolveChainData(query);
assert.ok(firstSnapshot.snapshotHash);
assert.equal(firstSnapshot.payload.block.medianTimePast, "500000101");
const before = cached.trace.length;
assert.ok((await cached.network.resolveChainData(query)).snapshotHash);
assert.ok(cached.trace.slice(before).every(path => !path.includes("/txraw/")), "Immutable raw cache lost");
assert.ok(cached.trace.slice(before).some(path => path.includes("/stablecoin/utxo/")), "Cache hid live spend index");
const creation = intents.find(intent=>intent.type==="tbc20-stablecoin-create");
const candidate = { txid: funding.txid, index: 0, value: funding.transaction.outputs[0].satoshis.toString(), height: 99 };
for (const explicit of [false, true]) {
  const created = setup(creation, undefined, [
    { txid: "bb".repeat(32), index: 0, value: explicit ? "2000000" : "24", height: 99 }, candidate,
  ]);
  const requirement = kit.chainDataRequirement({ intent: creation, ...(explicit ? { constraints: { inputOutpoints: [{ txid: funding.txid, vout: 0 }] } } : {}) });
  const query = { version: "1.0", chainId: account.chainId, accountId: account.accountId, requirement };
  const snapshot = await created.network.resolveChainData(query);
  assert.ok(snapshot.snapshotHash); assert.equal(snapshot.payload.utxos.length, 1); assert.equal(snapshot.payload.parents.length, 1);
  assert.equal(snapshot.payload.utxos[0].txid, funding.txid); assert.equal(created.trace.length, 3);
  const count = created.trace.length;
  assert.ok((await created.network.resolveChainData(query)).snapshotHash);
  assert.equal(created.trace.length - count, 2, "Creation must refresh index/tip but reuse immutable parent");
  assert.ok(created.trace.slice(count).every(path => !path.includes("/txraw/")));
}
const wrongFunding = setup(creation, undefined, [{ ...candidate, value: "999001" }]);
const wrongSnapshot = await wrongFunding.network.resolveChainData({ version: "1.0", chainId: account.chainId, accountId: account.accountId,
  requirement: kit.chainDataRequirement({ intent: creation }) });
assert.ok(wrongSnapshot.portError); assert.equal(wrongSnapshot.snapshotHash, undefined, "Wrong parent value became trusted material");
// Management refreshes mutable spend status while reusing immutable raw material.
// A pinned certificate never falls back to automatic selection after failure.
const managedIntent = method => intents.find(i => i.type === `tbc20-stablecoin-${method}`);
const managementQuery = (intent, constraints) => ({ version: "1.0", chainId: account.chainId, accountId: account.accountId,
  requirement: kit.chainDataRequirement({ intent, ...(constraints ? { constraints } : {}) }) });
for (const method of ["create", "mint", "freeze", "unfreeze", ...(unifiedHolder ? ["transfer", "merge"] : [])]) for (const prepared of [false, true]) {
  const holder = method === "transfer" || method === "merge";
  const intent = holder ? intents.find(i => i.type === `tbc20Stablecoin.${method}`) : managedIntent(method);
  let approvals = 0, signatures = 0;
  const run = setup(intent, () => assert.equal(approvals, 0, "Workflow read after approval"));
  const permissions = ["tbc_accounts", "tbc_signWorkflow", "tbc_signTransaction", "tbc_signMessage"].map(capability => ({
    id: `management-${capability}`, parentCapability: capability, invoker: "https://wallet.test", date: Date.parse(NOW),
    caveats: [{ type: "restrictChains", value: [account.chainId] }, { type: "restrictAccounts", value: accounts.map(a => a.accountId) },
      { type: "restrictMethods", value: [capability] }],
  }));
  const supportedSigningRoles = ["coin-admin"];
  const runtime = kit.createTbcWallet({ legacy: false, accounts: { current: async () => accounts }, engine,
    capabilities: { version: "1.0", scopes: [{ chainId: account.chainId, intents: ["tbc.transfer", intent.type], profiles: ["core"] }] },
    approval: { supportedSigningRoles, async request(input) {
      approvals++; assert.equal(input.binding.payload.operationKind, "workflow");
      if (explicitAdmin && !holder) assert.deepEqual(input.preview.signingRoles,
        [{ stepId: "manage", role: "coin-admin", account: administrator }]);
      return { status: "approved", approvalId: "management-workflow", approvalToken: "management-token",
        bindingHash: input.binding.bindingHash, approvedAt: NOW, expiresAt: input.binding.payload.expiresAt };
    } },
    signer: { async sign(input) {
      assert.equal(approvals, 1); const scalarNumber = signingAccount(input.task); signatures++;
      return { taskId: input.task.taskId, signatureEncoding: input.task.signatureEncoding,
        signature: await signDigest(input.task.digest, input.task.signatureEncoding, scalarNumber, input) };
    } },
    storage: { async loadPermissions() { return { revision: "0", permissions }; }, async commitPermissions() { throw new Error("Unexpected workflow permission write"); } },
    network: run.network, clock: () => NOW, randomBytes: length => Uint8Array.from({ length }, (_, i) => i),
  });
  const session = await runtime.openSession({ origin: "https://wallet.test", sessionId: `coin-${method}-workflow-${prepared}` });
  try {
    const request = { version: "1.0", chainId: account.chainId, from: address, maxTotalFee: "5000",
      expiresAt: new Date(Date.parse(NOW) + 120_000).toISOString().replace(/\.\d{3}Z$/u, "Z"),
      steps: [
        { id: "manage", kind: "transaction", dependsOn: [], intent, ...adminScope(intent), constraints: { maxFee: "5000" } },
        { id: "receipt", kind: "message", dependsOn: ["manage"], message: { encoding: "utf8", data: JSON.stringify({ txids: [] }) },
          bindings: [{ target: "txids", source: { stepId: "manage", output: "transactionIds" } }] },
      ],
    };
    const dapp = prepared ? setup(intent) : undefined;
    const params = prepared ? await kit.prepareTbcWorkflow({ request, network: dapp.network, engine }) : request;
    const result = await session.provider.request({ method: prepared ? "tbc_signPreparedWorkflow" : "tbc_signWorkflow", params });
    const txs = result.steps.find(step => step.id === "manage").result.transactions;
    const receipt = result.steps.find(step => step.id === "receipt").result;
    assert.equal(txs.length, method === "create" ? 2 : 1); assert.ok(receipt.signature);
    assert.deepEqual(JSON.parse(receipt.envelope.message.data).txids, txs.map(tx => tx.txid));
    assert.equal(approvals, 1); assert.equal(signatures, method === "create" ? 5 : method === "mint" || method === "merge" ? 4 : 3);
    const reads = method === "create" ? 3 : method === "freeze" || method === "transfer" ? 5 : 6;
    assert.equal(run.trace.length, reads);
    if (prepared) assert.equal(dapp.trace.length, reads);
    executionRows.push({intent: intent.type, entry: prepared ? 'prepared-workflow' : 'workflow',
      reads, approvals, signatures, transactions: txs.length, independentVmInputs: verifyBundle(txs)});
    checks.push(`${intent.type}/workflow${prepared ? "-prepared" : ""}:reads=${reads},approval=1,signatures=${signatures}`);
    if (explicitAdmin && !holder) {
      approvals = 0; signatures = 0;
      const bad = structuredClone(params);
      bad.steps[0].signingRoles[0].role = "pool-controller";
      await assert.rejects(session.provider.request({ method: prepared ? "tbc_signPreparedWorkflow" : "tbc_signWorkflow", params: bad }));
      assert.equal(approvals + signatures, 0);
      supportedSigningRoles.length = 0;
      await assert.rejects(session.provider.request({ method: prepared ? "tbc_signPreparedWorkflow" : "tbc_signWorkflow", params }));
      assert.equal(approvals + signatures, 0, "Workflow role support cannot be inferred from ordinary transaction support");
    }
  } finally { await session.close(); }
}
for (const method of ["mint", "freeze", "unfreeze"]) {
  const intent = managedIntent(method), network = setup(intent), query = managementQuery(intent);
  assert.ok((await network.network.resolveChainData(query)).snapshotHash);
  const count = network.trace.length;
  assert.ok((await network.network.resolveChainData(query)).snapshotHash);
  const repeated = network.trace.slice(count);
  assert.ok(repeated.every(path => !path.includes("/txraw/")), `${method}: immutable cache lost`);
  assert.equal(repeated.filter(path => path === "/api/tbc/txo/status").length, 1);
  assert.equal(repeated.length, method === "mint" ? 4 : 3, "Only index/tip/status may refresh");
}
const mintIntent = managedIntent("mint");
const pinnedIntent = { ...mintIntent, certificateOutpoint: { txid: management.get(mintIntent.type).certificate.txid, vout: 0 } };
const pinned = setup(pinnedIntent);
assert.ok((await pinned.network.resolveChainData(managementQuery(pinnedIntent))).snapshotHash);
assert.equal(pinned.trace.length, 5);
assert.ok(pinned.trace.every(path => !path.includes("/scriptpubkeyhash/")), "Pinned mint reselected a certificate");
const badStatuses = [
  ["spent", rows => rows.map(row => ({ ...row, spent: true }))],
  ["missing", () => []],
  ["duplicate", rows => [rows[0], rows[0]]],
  ["wrong-outpoint", rows => rows.map(row => ({ ...row, txid: "dd".repeat(32) }))],
  ["wrong-value", rows => rows.map(row => ({ ...row, value: "499" }))],
  ["wrong-script", rows => rows.map(row => ({ ...row, scriptPubKey: "51" }))],
  ["future-height", rows => rows.map(row => ({ ...row, height: "101" }))],
];
for (const [name, mutate] of badStatuses) {
  const intent = managedIntent("freeze");
  const network = setup(intent, undefined, undefined, (path, data) => path === "/api/tbc/txo/status" ? { txos: mutate(data.txos) } : data);
  const result = await network.network.resolveChainData(managementQuery(intent));
  assert.ok(result.portError, `${name}: invalid target was accepted`);
  assert.equal(result.snapshotHash, undefined);
}
const unknownHeight = setup(managedIntent("freeze"), undefined, undefined, (path, data) => path === "/api/tbc/txo/status"
  ? { txos: data.txos.map(({ height, ...row }) => row) } : data);
const unknownSnapshot = await unknownHeight.network.resolveChainData(managementQuery(managedIntent("freeze")));
assert.ok(unknownSnapshot.snapshotHash);
assert.ok(unknownSnapshot.payload.utxos.filter(utxo => utxo.classification === "stablecoin").every(utxo => utxo.confirmations === undefined),
  "Missing height must remain unknown, not become zero confirmations");
assert.equal(unknownHeight.trace.length, 5, "Zero floor must not trigger a decoded/history fallback");
const ambiguous = setup(mintIntent, undefined, undefined, (path, data) => path.includes("/scriptpubkeyhash/")
  ? { utxos: [data.utxos[0], data.utxos[0]] } : data);
assert.ok((await ambiguous.network.resolveChainData(managementQuery(mintIntent))).portError);
const spentPin = setup(pinnedIntent, undefined, undefined, (path, data) => path === "/api/tbc/txo/status"
  ? { txos: data.txos.map(row => ({ ...row, spent: true })) } : data);
assert.ok((await spentPin.network.resolveChainData(managementQuery(pinnedIntent))).portError);
assert.ok(spentPin.trace.every(path => !path.includes("/scriptpubkeyhash/")), "Spent pin must fail without reselecting");
const calls = [];
const client = await kit.createTbcClient({ network: "testnet", provider: {
  async request(call) { calls.push(call); return call.method === "tbc_requestAccounts" ? [address] : {}; },
  on() {}, removeListener() {}, destroy() {},
} }).connect();
for (const [method, intent] of [["transfer", transfer], ["merge", intents[1]], ["create", creation],
  ...["mint","freeze","unfreeze"].map(method=>[method,intents.find(i=>i.type===`tbc20-stablecoin-${method}`)])]) {
  const { type, version, ...params } = intent; await client.coin[method]({ ...params, ...adminScope(intent) });
  assert.equal(calls.at(-1).method, "tbc_sendTransaction"); assert.equal(calls.at(-1).params.intent.type, type);
  assert.deepEqual(calls.at(-1).params.signingRoles, adminScope(intent).signingRoles);
  assert.equal(calls.at(-1).params.intent.signingRoles, undefined);
}
for (const name of ["mainnet", "testnet"]) {
  let reads = 0;
  const network = kit.createDefaultTbcNetwork({ network: kit.createTbcNetworkContext({ network: name }),
    accounts: { current: async () => [] }, fetch: async () => { reads++; throw new Error("Policy must be read-free"); },
    poolMaterial: { async resolveLiquidityAdd() { throw new Error("Unrelated Pool path"); } },
  });
  for (const intent of intents) {
    const request = { version: "1.0", chainId: `tbc:${name}`, from: address, intent };
    const params = { version: "1.0", request, requestHash: kit.hashCanonical(request), snapshotHash: "aa".repeat(32) };
    const policy = await network.resolvePolicy(params);
    if (intent.type.startsWith("tbc20Stablecoin.")) {
      assert.ok(policy.portError,"Unified policy requires the exact resolved material binding");
      continue;
    }
    assert.equal(policy.payload?.dustThreshold, "24"); assert.deepEqual(policy.payload.contractPolicies, [{ family: "stablecoin", allowedVersions: ["coin"] }]);
    const wrong = { ...request, chainId: name === "testnet" ? "tbc:mainnet" : "tbc:testnet" };
    assert.equal((await network.resolvePolicy({ ...params, request: wrong, requestHash: kit.hashCanonical(wrong) })).portError?.name, "UNAUTHORIZED");
  }
  assert.equal(reads, 0);
}
if (frozen) {
  assert.equal(unexpectedHttp, 0);
  if(cooperativeSigner){
    const e=cooperativeSigner.evidence();
    assert.equal(e.tasks,24);assert.equal(e.partials,48);assert.equal(e.reuseRejected,48);
    for(const action of ['create','mint','freeze','unfreeze'])assert.deepEqual(
      executionRows.filter(r=>r.intent===`tbc20-stablecoin-${action}`).map(r=>r.entry).sort(),
      ['ordinary','prepared','prepared-workflow','workflow']);
  }
  const harnessSources=Object.fromEntries(['check-coin-kit-source.mjs','lib/frozen-coin-harness.mjs',
    ...(cooperativeSigner?['lib/coin-musig-fixture-signer.mjs']:[])].map(p=>[p,
      createHash('sha256').update(readFileSync(new URL(p,import.meta.url))).digest('hex')]));
  const output = await mkdtemp(join(tmpdir(), 'tbc-coin213-host-'));
  const report = {status: 'PASS_INSTALLED_COIN_HOST_EXECUTION', at: new Date().toISOString(),
    ...frozen.evidence, explicitAdmin, unifiedHolder, cooperativeAdmin, harnessSources,
    ...(cooperativeSigner?{cooperativeSigner:cooperativeSigner.evidence()}:{}),checks, hostCases: checks.length, executionRows,
    independentVm: {version: 'tbc-lib-js@1.0.31', inputs: vmInputs, transactions: vmTransactions,
      interpreterSha256: createHash('sha256').update(readFileSync(requireFixture.resolve('tbc-lib-js/lib/script/interpreter'))).digest('hex')},
    signer: 'local.5 Rust WASM with independent Noble oracle', actualHttp: 0, transactionBroadcastPOST: 0,
    apiMode: 'Synthetic in-memory API; management includes one read-only TXO status POST',
    readAfterApproval: 0, immutableCacheVerified: true, wrongPreparedIssuerRejected: true,
    scope: 'Installed Core/Host/Kit/Engine, public synthetic keys and native-format fixtures. Not real custody, native UI, actual HTTP or chain acceptance.'};
  const body = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(output, 'report.json'), body, {flag: 'wx'});
  console.log(JSON.stringify({status: report.status, hostCases: checks.length, explicitAdmin, unifiedHolder,cooperativeAdmin,
    path: join(output, 'report.json'), sha256: createHash('sha256').update(body).digest('hex')}));
} else console.log(`COIN_KIT_SOURCE_PASS ${checks.join(" ")}; ${checks.length} Host cases; signer=${kernelSigner ? "independent-rust-wasm+Noble-oracle" : "Noble"}; immutable cache; wrong Prepared issuer rejected; transactionBroadcastPOST=0; management uses one read-only status POST`);
