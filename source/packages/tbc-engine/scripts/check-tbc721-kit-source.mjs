#!/usr/bin/env node
// Current Kit/Core/Host + current source WASM. Public scalar 1, synthetic
// funding/index responses only. HTTP POST /txo/status is a read, not broadcast.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const rust = fileURLToPath(new URL("../rust/", import.meta.url));
const fixture = JSON.parse(readFileSync(`${rust}fixtures/tbc721-standard-proof.json`, "utf8"));
// Shared wallet prefetch expiry intentionally uses wall time; synthetic
// snapshot time must be current rather than a frozen, already expired date.
const NOW = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
const scalar = "01".padStart(64, "0");
const check = (condition, label) => { if (!condition) throw new Error(label); };

async function main() {
  check(process.argv.length === 2, "No arguments accepted");
  const compiled = spawnSync("cargo", ["build", "--offline", "--locked", "--release", "-p", "tbc-engine-wasm", "-p", "tbc-keyless-wasm", "--target", "wasm32-unknown-unknown"], {
    cwd: rust, env: { ...process.env, RUSTFLAGS: '--cfg getrandom_backend="unsupported"' },
    encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  check(!compiled.error && compiled.status === 0, "Source WASM build failed; output withheld");
  const bundled = await build({
    stdin: { contents: `
      export { createDefaultTbcNetwork } from './packages/kit/src/default-network.ts';
      export { createTbcNetworkContext } from './packages/kit/src/network-context.ts';
      export { prepareTbcTransaction, prepareTbcWorkflow } from './packages/kit/src/prepared.ts';
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
  // Client lazily resolves platform assets relative to import.meta.url. A
  // file-shaped virtual module preserves that behavior without writing dist.
  const virtualUrl = new URL("../../../packages/kit/src/.tbc721-source-check.mjs", import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) { return specifier === virtualUrl ? { url: virtualUrl, shortCircuit: true } : next(specifier, context); },
    load(url, context, next) { return url === virtualUrl ? { source: bundled.outputFiles[0].text, format: "module", shortCircuit: true } : next(url, context); },
  });
  const kit = await import(virtualUrl);
  hooks.deregister();
  const officialEngine = kit.createTbcEngine({ backend: await kit.createWasmTbcEngineBackend(
    readFileSync(`${rust}target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm`)) });
  const keyless = await kit.createWasmTbcKeylessEngine(readFileSync(`${rust}target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm`));
  const parse = raw => ({ raw, ...kit.inspectTbcTransaction(raw) });
  const collection = parse(fixture.vectors[0].grandparentRaw);
  const genesis = parse(fixture.vectors[0].parentRaw);
  const ancestor = parse(fixture.vectors[1].parentRaw);
  const current = parse(fixture.vectors[1].signedRaw);
  const raws = new Map([collection, genesis, ancestor, current].map(t => [t.txid, t.raw]));
  const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
  const account = { chainId: "tbc:testnet", address, accountId: `tbc:testnet:${address}`, publicKey: fixture.vectors[0].publicKeyHex };
  const metadata = { name: "New NFT", symbol: "N", description: "public synthetic", attributes: [{ traitType: "live", value: false }] };
  const intents = [
    { type: "tbc721-standard-create-collection", version: "1.0", name: "Collection", description: "offline", supply: "3", media: { kind: "uri", uri: "ipfs://synthetic" } },
    { type: "tbc721-standard-mint", version: "1.0", collectionId: collection.txid, slot: 1, ...metadata },
    { type: "tbc721-standard-batch-mint", version: "1.0", collectionId: collection.txid, items: [{ slot: 1, ...metadata }, { slot: 3, ...metadata }] },
    { type: "tbc721-standard-transfer", version: "1.0", contractId: genesis.txid, to: address },
    { type: "tbc721-standard-transfer", version: "1.0", contractId: genesis.txid, to: address, payment: { to: address, amount: "1234" } },
  ];
  const checks = [];
  intents.push(...intents.slice(3).map(intent=>({...intent,type:'tbc721.transfer'})));
  const largeMediaBytes = Buffer.alloc(70_000, 42);
  const largeMedia = { kind: 'base64', mediaType: 'image/png', data: largeMediaBytes.toString('base64'),
    sha256: createHash('sha256').update(largeMediaBytes).digest('hex') };
  // Exercise both normal and Prepared Provider/approval/signing boundaries,
  // not only the Rust planner. Existing small-media read budgets stay intact.
  intents.push({ ...intents[0], media: largeMedia }, { ...intents[1], media: largeMedia });
  function setup(intent, hooks = {}) {
    const transfer = intent.type === "tbc721-standard-transfer" || intent.type === "tbc721.transfer";
    const funding = transfer ? current : collection;
    const feeVout = transfer ? 3 : 4;
    const trace = [];
    let sequence = 0;
    const fetch = async (input, init) => {
      hooks.beforeRead?.();
      const url = new URL(String(input)); const path = url.pathname;
      check(url.origin === "https://api.tbcdev.org", "Unexpected network source");
      const method = init?.method ?? "GET";
      check(method === "GET" || (method === "POST" && path === "/api/tbc/txo/status"), "Broadcast or unexpected POST forbidden");
      trace.push({ method, path, body: method === "POST" ? JSON.parse(init.body) : undefined });
      let data;
      if (path === "/api/tbc/nodeinfo") data = { blocks: 100, bestblockhash: "aa".repeat(32) };
      else if (path === `/api/tbc/utxo/address/${address}`) data = { utxos: hooks.nativeFunding ?? [{ txid: funding.txid, index: feeVout,
        value: funding.transaction.outputs[feeVout].satoshis.toString(), height: 99 }] };
      else if (path.startsWith("/api/tbc/utxo/scriptpubkeyhash/")) data = { utxos: hooks.missingSlots ? [] : [1, 3].map(vout => ({ txid: collection.txid, index: vout, value: "100", height: 99 })) };
      else if (path.startsWith("/api/tbc/nft/utxo/scriptpubkeyhash/")) data = { utxos: [{ txid: current.txid, index: 0, nft_id: genesis.txid, collection_id: collection.txid, value: "200", height: 99 }] };
      else if (path === "/api/tbc/txo/status") {
        const body = JSON.parse(init.body);
        data = { txos: body.txos.map(point => ({ txid: point.txid, index: String(point.index), value: "100", spent: hooks.spent === true, height: "99" })) };
      } else if (path.startsWith("/api/tbc/txraw/txid/")) {
        const id = path.slice("/api/tbc/txraw/txid/".length);
        check(raws.has(id), "Unknown ancestor request");
        if (transfer) check(id !== collection.txid, "Unnecessary full NFT lineage read");
        data = { txraw: raws.get(id) };
      } else throw new Error("Unexpected API read endpoint");
      return new Response(JSON.stringify({ code: "200", data }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const network = kit.createDefaultTbcNetwork({ network: kit.createTbcNetworkContext({ network: "testnet" }),
      poolNative:keyless,
      accounts: { current: async () => [account] }, fetch, now: () => Date.parse(NOW), snapshotId: () => `nft-source-${++sequence}`,
      poolMaterial: { async resolveLiquidityAdd() { throw new Error("Unrelated Pool path"); } },
    });
    return { network, trace };
  }
  for (const intent of intents) {
    const request = { version: "1.0", chainId: account.chainId, from: address, intent, constraints: { maxFee: intent.media?.kind === 'base64' ? "20000" : "5000" } };
    check(JSON.stringify(kit.chainDataRequirement(request)) === JSON.stringify(kit.preparedChainDataRequirement(request)), "Ordinary/Prepared requirement projection differs");
    // Default floor is zero; Code and Hold come from the same authenticated
    // parent. Neither nodeInfo nor an independent Hold-status GET is needed.
    const expectedReads = intent.type.endsWith("create-collection") ? 1 : intent.type.endsWith("transfer") ? 5 : 3;
    for (const preparedMode of [false, true]) {
      const label = `${intent.type}${intent.payment ? "+payment" : ""}${intent.media?.kind === 'base64' ? '+70KB-media' : ''}/${preparedMode ? "prepared" : "ordinary"}`;
      let approvals = 0, signatures = 0, finalizations = 0, latestPlan;
      const walletNetwork = setup(intent, { beforeRead() { check(approvals === 0, `${label}: read after approval`); } });
      const dappNetwork = preparedMode ? setup(intent) : undefined;
      const params = preparedMode ? await kit.prepareTbcTransaction({ request, network: dappNetwork.network, engine: officialEngine }) : request;
      const engine = Object.fromEntries(["normalizeRequest", "plan", "validate", "finalize"].map(method => [method, async input => {
        const result = await officialEngine[method](input);
        if (method === "plan") latestPlan = result.plan;
        if (method === "finalize") finalizations++;
        return result;
      }]));
      const permissions = ["tbc_accounts", "tbc_signTransaction"].map(capability => ({ id: `offline-${capability}`, parentCapability: capability,
        invoker: "https://wallet.test", date: Date.parse(NOW), caveats: [
          { type: "restrictChains", value: [account.chainId] }, { type: "restrictAccounts", value: [account.accountId] }, { type: "restrictMethods", value: [capability] },
        ] }));
      const hostStore = kit.createMemoryTwsHostStore({ now: () => Date.parse(NOW) });
      const evidenceReader = kit.createApprovalHostEvidenceReader({ store: hostStore, releaseFingerprint: kit.TWS_RELEASE_FINGERPRINT,
        parseApprovalRequest(value) { kit.assertValidTws("approvalRequestParams", value); return value; } });
      const runtime = kit.createTbcWallet({ legacy: false, accounts: { current: async () => [account] }, engine,
        capabilities: { version: "1.0", scopes: [{ chainId: account.chainId, intents: ["tbc.transfer", ...new Set(intents.map(i => i.type))], profiles: ["core"] }] },
        approval: { async request(approval, call) {
          approvals++; check(approval.binding.payload.operationHash === latestPlan.planHash, `${label}: approval not bound to Engine plan`);
          const evidence = await evidenceReader.read(call.callId, approval.binding.bindingHash);
          const presentation = kit.projectTbcApprovalPresentation(evidence);
          check(presentation.trust === "binding-verified" && presentation.businessType.value === intent.type &&
            kit.hashCanonical(presentation.businessTerms.value) === kit.hashCanonical(intent), `${label}: unified presentation lost bound intent`);
          const sends = approval.preview.assetFlows.filter(flow => flow.kind === "nft");
          if (!intent.type.endsWith("create-collection")) check(sends.length === (intent.items?.length ?? 1) && sends.every(flow => flow.amount === "1" && flow.to === address), `${label}: NFT preview lost recipients/quantities`);
          if (intent.payment) check(approval.preview.assetFlows.some(flow => flow.kind === "native" && flow.direction === "send" && flow.amount === "1234" && flow.to === address), `${label}: missing atomic payment review`);
          return { status: "approved", approvalId: "offline-nft", approvalToken: "offline-nft-token", bindingHash: approval.binding.bindingHash,
            approvedAt: NOW, expiresAt: approval.binding.payload.expiresAt };
        } },
        signer: { async sign(input) {
          check(approvals === 1, `${label}: signer without single approval`); signatures++;
          return { taskId: input.task.taskId, signatureEncoding: "compact64", signature: secp256k1.sign(input.task.digest, scalar, { prehash: false, lowS: true }).toCompactHex() };
        } },
        storage: { async loadPermissions() { return { revision: "0", permissions }; }, async commitPermissions(input) { return { revisions: input.changes.map(c => ({ scope: c.scope, revision: "1" })) }; } },
        network: walletNetwork.network, clock: () => NOW, randomBytes: length => Uint8Array.from({ length }, (_, i) => i),
      });
      let ids = 0;
      const session = await runtime.openSession({ origin: "https://wallet.test", sessionId: `nft-${checks.length}`, requestIdFactory: () => `offline-${++ids}`,
        execution: { hostStore } });
      try {
        let result;
        if (preparedMode) result = await session.provider.request({ method: "tbc_signPreparedTransaction", params });
        else {
          // The wallet has shown its non-authorizing loading UI before calling
          // this hook. Prefetch itself must never approve, sign, or persist.
          const exact = { id: `prefetch-${++ids}`, method: "tbc_signTransaction", params };
          const preparation = session.prefetchRequest(exact);
          const ready = await preparation.ready;
          const diagnostic = await preparation.diagnostic;
          check(ready === "ready", `${label}: shared prefetch ${ready}/${diagnostic.stage}/${diagnostic.category}`);
          check(approvals === 0 && signatures === 0 && finalizations === 0, `${label}: prefetch authorized execution`);
          const response = (await session.handleRequest(exact)).response;
          check(response.error === undefined, `${label}: prefetch execution failed (${response.error?.code ?? ""})`);
          result = response.result;
        }
        check(approvals === 1 && signatures > 0, `${label}: incomplete approval/signing`);
        check(walletNetwork.trace.length === expectedReads, `${label}: wallet read count ${walletNetwork.trace.length}, expected ${expectedReads}: ${JSON.stringify(walletNetwork.trace.map(r => r.path))}`);
        check(new Set(walletNetwork.trace.map(r => r.path)).size === expectedReads, `${label}: duplicate read`);
        check((dappNetwork?.trace.length ?? 0) === (preparedMode ? expectedReads : 0), `${label}: DApp read count`);
        check(result.transactions.length === (intent.items?.length ?? 1) && finalizations === result.transactions.length, `${label}: bundle/signing continuation mismatch`);
        for (const tx of result.transactions) check(kit.inspectTbcTransaction(tx.rawTransaction).txid === tx.txid, `${label}: final raw/txid mismatch`);
        if (intent.items) {
          const child = kit.inspectTbcTransaction(result.transactions[1].rawTransaction).transaction;
          check(child.inputs[1].txid === result.transactions[0].txid && child.inputs[1].vout === 3, "Batch fee input did not follow signed parent");
        }
        checks.push(`${label}:reads=${expectedReads},approval=${approvals},signatures=${signatures}`);
        if (preparedMode && intent.type.endsWith("transfer") && !intent.payment) {
          const tampered = structuredClone(params);
          tampered.proposal.payload.evidence.contracts[0].genesisOutpoint.txid = "ee".repeat(32);
          tampered.proposal.proposalHash = kit.hashCanonical(tampered.proposal.payload);
          kit.assertValidTws("preparedTransactionRequest", tampered);
          approvals = 0; signatures = 0;
          let rejection;
          try { await session.provider.request({ method: "tbc_signPreparedTransaction", params: tampered }); } catch (error) { rejection = error; }
          check(rejection !== undefined && approvals === 0 && signatures === 0, "Rehashed false NFT identity reached approval/signing");
        }
      } finally { await session.close(); }
    }
  }
  // A real two-step workflow must retain exact NFT slots, share the snapshot,
  // and bind the subsequent message to the completed transaction IDs.
  for (const { intent, separateSteps, duplicateFunding, preparedMode } of [
    ...intents.slice(1, 3).map(intent => ({ intent })),
    { intent: intents[2], separateSteps: true },
    { intent: intents[2], separateSteps: true, preparedMode: true },
    { intent: intents[2], separateSteps: true, duplicateFunding: true },
    { intent: intents[5] },
    { intent: intents[5], preparedMode: true },
  ]) {
    const unifiedTransfer=intent.type==='tbc721.transfer';
    let approvals = 0, signatures = 0;
    const stages = [];
    const funds = ["ee", "dd"].map(byte => ({ txid: byte.repeat(32), index: 0, value: "20000", height: 99 }));
    const run = setup(intent, { ...(separateSteps ? { nativeFunding: funds } : {}),
      beforeRead() { check(approvals === 0, "NFT workflow read after approval"); } });
    const permissions = ["tbc_accounts", "tbc_signWorkflow", "tbc_signTransaction", "tbc_signMessage"].map(capability => ({ id: `workflow-${capability}`, parentCapability: capability,
      invoker: "https://wallet.test", date: Date.parse(NOW), caveats: [
        { type: "restrictChains", value: [account.chainId] }, { type: "restrictAccounts", value: [account.accountId] }, { type: "restrictMethods", value: [capability] },
      ] }));
    const tracedEngine = Object.fromEntries(["normalizeRequest", "plan", "validate", "finalize"].map(method => [method, async input => {
      stages.push(method);
      try { return await officialEngine[method](input); }
      catch (error) { stages.push(`${error.code ?? "engine"}:${error.message}`); throw error; }
    }]));
    const runtime = kit.createTbcWallet({ legacy: false, accounts: { current: async () => [account] }, engine: tracedEngine,
      capabilities:{version:'1.0',scopes:[{chainId:account.chainId,intents:['tbc.transfer',...new Set(intents.map(i=>i.type))],profiles:['core']}]},
      approval: { async request(input) {
        approvals++; check(input.binding.payload.operationKind === "workflow", "NFT workflow approval kind");
        return { status: "approved", approvalId: "nft-workflow", approvalToken: "nft-workflow-token", bindingHash: input.binding.bindingHash,
          approvedAt: NOW, expiresAt: input.binding.payload.expiresAt };
      } },
      signer: { async sign(input) {
        check(approvals === 1, "NFT workflow signer without one approval"); signatures++;
        const signed = secp256k1.sign(input.task.digest, scalar, { prehash: false, lowS: true });
        const recoverable = input.task.signatureEncoding === "compact65-recoverable";
        return { taskId: input.task.taskId, signatureEncoding: input.task.signatureEncoding,
          signature: `${recoverable ? (31 + signed.recovery).toString(16) : ""}${signed.toCompactHex()}` };
      } },
      storage: { async loadPermissions() { return { revision: "0", permissions }; }, async commitPermissions() { throw new Error("Unexpected NFT workflow permission commit"); } },
      network: run.network, clock: () => NOW, randomBytes: length => Uint8Array.from({ length }, (_, i) => i),
    });
    const session = await runtime.openSession({ origin: "https://wallet.test", sessionId: `nft-workflow-${intent.items ? "batch" : "single"}` });
    try {
      const transactionSteps = separateSteps ? intent.items.map((item, index) => ({
        id: `mint-${index}`, kind: "transaction", dependsOn: [],
        intent: { type: "tbc721-standard-mint", version: "1.0", collectionId: intent.collectionId, ...item },
        constraints: { maxFee: "5000", inputOutpoints: [
          { txid: collection.txid, vout: item.slot }, { txid: funds[duplicateFunding ? 0 : index].txid, vout: 0 },
        ] },
      })) : [{ id: unifiedTransfer ? "transfer" : "mint", kind: "transaction", dependsOn: [], intent, constraints: { maxFee: "5000" } }];
      const boundStep = transactionSteps.at(-1).id;
      const params = {
        version: "1.0", chainId: account.chainId, from: address,
        expiresAt: new Date(Date.parse(NOW) + 120_000).toISOString().replace(/\.\d{3}Z$/u, "Z"), maxTotalFee: "5000",
        steps: [
          ...transactionSteps,
          { id: "receipt", kind: "message", dependsOn: [boundStep], message: { encoding: "utf8", data: JSON.stringify({ txids: [] }) },
            bindings: [{ target: "txids", source: { stepId: boundStep, output: "transactionIds" } }] },
        ],
      };
      if (duplicateFunding) {
        const duplicateDapp = setup(intent, { nativeFunding: funds });
        let duplicateRejected;
        try { await kit.prepareTbcWorkflow({ request: params, network: duplicateDapp.network, engine: officialEngine }); }
        catch (error) { duplicateRejected = error; }
        check(duplicateRejected?.message.includes("same input outpoint"), "Parallel DApp reads removed duplicate funding rejection");
        let rejected;
        try { await session.provider.request({ method: "tbc_signWorkflow", params }); } catch (error) { rejected = error; }
        check(rejected !== undefined && approvals === 0 && signatures === 0 && stages.filter(stage => stage === "plan").length === 2,
          "Two mint steps sharing one fee input were not rejected before approval");
        continue;
      }
      const dapp = preparedMode ? setup(intent, separateSteps ? { nativeFunding: funds } : {}) : undefined;
      let dappEngineActive = false;
      const sequentialDappEngine = Object.fromEntries(["normalizeRequest", "plan", "validate", "finalize"].map(method => [method, async input => {
        check(!dappEngineActive, "DApp preparation concurrently entered Engine");
        dappEngineActive = true;
        try { await Promise.resolve(); return await officialEngine[method](input); }
        finally { dappEngineActive = false; }
      }]));
      const prepared = preparedMode ? await kit.prepareTbcWorkflow({ request: params, network: dapp.network, engine: sequentialDappEngine }) : params;
      const result = await session.provider.request({ method: preparedMode ? "tbc_signPreparedWorkflow" : "tbc_signWorkflow", params: prepared });
      const minted = result.steps.find(step => step.id === boundStep)?.result;
      const receipt = result.steps.find(step => step.id === "receipt")?.result;
      check(minted?.transactions.length === (separateSteps ? 1 : intent.items?.length ?? 1) && receipt?.signature, "NFT workflow incomplete");
      if (separateSteps) {
        for (const [index, step] of transactionSteps.entries()) {
          const signed = result.steps.find(entry => entry.id === step.id)?.result?.transactions?.[0];
          check(signed !== undefined, "Missing independent mint result");
          const inputs = kit.inspectTbcTransaction(signed.rawTransaction).transaction.inputs;
          check(inputs.length === 2 && inputs.some(input => input.txid === funds[index].txid && input.vout === 0) &&
            inputs.some(input => input.txid === collection.txid && input.vout === intent.items[index].slot), "Independent mint input boundary changed");
        }
      }
      check(JSON.stringify(JSON.parse(receipt.envelope.message.data).txids) === JSON.stringify(minted.transactions.map(tx => tx.txid)), "NFT workflow message binding lost signed IDs");
      const expectedReads=unifiedTransfer?5:3;
      check(approvals === 1 && signatures === (unifiedTransfer ? 4 : intent.items ? 5 : 3) && run.trace.length === expectedReads, "NFT workflow read/signature budget");
      if (preparedMode) check(dapp.trace.length === expectedReads, `Prepared NFT read budget: ${dapp.trace.length}, expected ${expectedReads}`);
      if (preparedMode) {
        const before = dapp.trace.length;
        await kit.prepareTbcWorkflow({ request: params, network: dapp.network, engine: sequentialDappEngine });
        const fresh = dapp.trace.slice(before);
        check(fresh.length === 2 && fresh.every(row => !row.path.includes('/txraw/')) &&
          fresh.some(row => row.path.includes('/utxo/address/')) &&
          fresh.some(row => row.path.includes('/utxo/scriptpubkeyhash/')),
          "Prepared workflow retained mutable state across calls");
      }
      checks.push(`${intent.type}/${separateSteps ? "independent-mints" : "workflow"}${preparedMode ? "-prepared" : ""}:reads=${expectedReads},approval=1,signatures=${signatures}`);
    } catch (error) {
      throw new Error(`${intent.type}/workflow failed: reads=${run.trace.length}, approvals=${approvals}, signatures=${signatures}, stages=${stages.join(",")}, error=${error.code ?? ""} ${error.message}`);
    } finally { await session.close(); }
  }
  // Failures drain only the bounded read preparation, never start plans or
  // signatures. Invalid outer workflows must fail before any Engine/HTTP work.
  {
    const workflow = { version: '1.0', chainId: account.chainId, from: address, maxTotalFee: '5000',
      steps: [1,3].map((slot,index) => ({id:`bounded-${index}`,kind:'transaction',dependsOn:[],
        intent:{...intents[1],slot},constraints:{maxFee:'5000'}})) };
    let reads=0,plans=0,normalizes=0,settled=false,releaseRead,announceStarted;
    const started=new Promise(resolve=>{announceStarted=resolve;});
    const engine={...officialEngine,async normalizeRequest(input){normalizes++;return officialEngine.normalizeRequest(input);},
      async plan(){plans++;throw new Error('No plan allowed after read failure');}};
    const network={async resolveChainData(){
      reads++;
      if(reads===1)throw new Error('expected first read failure');
      return new Promise(resolve=>{releaseRead=resolve;announceStarted();});
    },async resolvePolicy(){throw new Error('No policy expected');}};
    const pending=kit.prepareTbcWorkflow({request:workflow,engine,network}).then(
      ()=>{settled=true;throw new Error('Failure was swallowed');},error=>{settled=true;return error;});
    await started;await Promise.resolve();
    check(!settled&&plans===0&&reads===2&&normalizes===2,'Read preparation did not drain or was not parallel');
    const payload={};releaseRead({payload,snapshotHash:kit.hashCanonical(payload)});
    const error=await pending;
    check(error.message==='expected first read failure'&&plans===0,'Failed preparation changed failure ordering or started planning');
    let malformed;
    try {await kit.prepareTbcWorkflow({request:{...workflow,steps:Array.from({length:6},(_,i)=>({...workflow.steps[0],id:`too-many-${i}`}))},engine,network});}
    catch(error){malformed=error;}
    check(malformed!==undefined&&reads===2&&normalizes===2,'Unbounded workflow entered Engine/HTTP');
  }
  // Named client helpers remain mere protocol dispatch; they do not grow a
  // second builder, network loader, or signer in the DApp entry point.
  const calls = [];
  const client = await kit.createTbcClient({ network: "testnet", provider: {
    async request(call) { calls.push(call); return call.method === "tbc_requestAccounts" ? [address] : {}; },
    on() {}, removeListener() {}, destroy() {},
  } }).connect();
  for (const [method, intent] of [["createCollection", intents[0]], ["mint", intents[1]], ["batchMint", intents[2]], ["transfer", intents[3]]]) {
    const { type, version, ...params } = intent;
    await client.tbc721[method]({ ...params, constraints: { maxFee: "5000" } });
    check(calls.at(-1).method === "tbc_sendTransaction" && calls.at(-1).params.intent.type === (method==='transfer'?'tbc721.transfer':type), "Named helper changed execution channel");
  }
  // Collection index lag needs one status call for the exact missing slots;
  // positive unknowns or unrelated available slots must not substitute for them.
  const mint = intents[2];
  for (const spent of [false, true]) {
    const run = setup(mint, { missingSlots: true, spent });
    const requirement = kit.chainDataRequirement({ intent: mint });
    const result = await run.network.resolveChainData({ version: "1.0", chainId: account.chainId, accountId: account.accountId, requirement });
    const status = run.trace.filter(r => r.method === "POST");
    check(status.length === 1 && JSON.stringify(status[0].body.txos) === JSON.stringify([1, 3].map(index => ({ txid: collection.txid, index }))), "Slot fallback read broadened");
    check(spent ? result.portError?.name === "CONFLICT" : !!result.snapshotHash, "Slot fallback spend state incorrect");
  }
  const cached = setup(intents[3]);
  const cachedParams = { version: "1.0", chainId: account.chainId, accountId: account.accountId, requirement: kit.chainDataRequirement({ intent: intents[3] }) };
  check(!!(await cached.network.resolveChainData(cachedParams)).snapshotHash, "Initial NFT snapshot failed");
  const first = cached.trace.length;
  check(!!(await cached.network.resolveChainData(cachedParams)).snapshotHash, "Cached NFT snapshot failed");
  check(cached.trace.slice(first).every(read => !read.path.includes("/txraw/")), "Immutable NFT raw cache was not reused");
  check(cached.trace.slice(first).length === 2 && cached.trace.slice(first).some(read => read.path.includes("/utxo/address/")) &&
    cached.trace.slice(first).some(read => read.path.includes("/nft/utxo/")), "Cache incorrectly replaced live spend-state reads");
  for (const name of ["testnet", "mainnet"]) {
    let reads = 0;
    const network = kit.createDefaultTbcNetwork({ network: kit.createTbcNetworkContext({ network: name }), accounts: { current: async () => [] },
      fetch: async () => { reads++; throw new Error("Policy must be read-free"); }, now: () => Date.parse(NOW),
      poolMaterial: { async resolveLiquidityAdd() { throw new Error("Unrelated Pool path"); } },
    });
    for (const intent of intents) {
      const request = { version: "1.0", chainId: `tbc:${name}`, from: address, intent };
      const params = { version: "1.0", request, requestHash: kit.hashCanonical(request), snapshotHash: "aa".repeat(32) };
      const policy = await network.resolvePolicy(params);
      if (intent.type === 'tbc721.transfer') {
        check(!!policy.portError && reads === 0,'Unified NFT policy must require a material binding');
        continue;
      }
      check(policy.payload?.dustThreshold === "42" && policy.payload.contractPolicies.length === 2 && reads === 0, "NFT policy drift/read");
      const wrong = { ...request, chainId: name === "testnet" ? "tbc:mainnet" : "tbc:testnet" };
      check((await network.resolvePolicy({ ...params, request: wrong, requestHash: kit.hashCanonical(wrong) })).portError?.name === "UNAUTHORIZED", "Cross-network policy accepted");
    }
  }
  console.log(`TBC721_KIT_SOURCE_PASS ${checks.join(" ")}; ${checks.length} Host cases; missing/spent slots checked; broadcast=0; source only`);
}
try { await main(); }
catch (error) {
  // Never print data URL stack, raw transactions, or arbitrary Port payloads.
  console.error(`TBC721_KIT_SOURCE_FAIL ${error?.code ?? ""} ${String(error?.message ?? "unknown").slice(0, 400)}`);
  process.exitCode = 1;
}
