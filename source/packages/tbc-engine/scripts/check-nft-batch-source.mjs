// Public synthetic keys and controlled reads only. Exercise current source
// Provider/Host/Engine, not a prepared snapshot masquerading as a public read.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const rust = join(root, 'packages/tbc-engine/rust');
const temporary = mkdtempSync(join(tmpdir(), 'tbc-nft-batch-'));
const require = createRequire(join(root, 'packages/kit/package.json'));
const tbc = require('tbc-lib-js'); // Independent script VM, never a production dependency.
const now = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
const scalar = '01'.padStart(64, '0');
const counters = { cases: 0, inputs: 0, tamperRejections: 0 };

async function main() {
  const prefix = join(temporary, 'fixture');
  execFileSync('cargo', ['test', '--offline', '--locked', '-p', 'tbc-engine-core', '--test',
    'tbc721_public', 'shared_nft_batch'], { cwd: rust, stdio: 'pipe', timeout: 60_000,
    env: { ...process.env, NFT_BATCH_REPORT: prefix } });
  const jobOnly = process.env.NFT_BATCH_INCLUDE_MINT_JOB === '1';
  const includeMint = process.env.NFT_BATCH_INCLUDE_MINT_100 === '1' || jobOnly;
  if (includeMint) execFileSync('cargo', ['test', '--release', '--offline', '--locked', '-p', 'tbc-engine-core', '--test',
    'tbc721_public', 'public_nft_hundred'], { cwd: rust, stdio: 'pipe', timeout: 180_000,
    env: { ...process.env, NFT_MINT_BATCH_REPORT: `${prefix}-mint-100.json` } });
  if (jobOnly) console.log('NFT_MINT_JOB_FIXTURE_READY');
  execFileSync('cargo', ['build', '--offline', '--locked', '--release', '-p', 'tbc-engine-wasm',
    '-p', 'tbc-keyless-wasm', '--target', 'wasm32-unknown-unknown'], { cwd: rust, stdio: 'pipe', timeout: 60_000,
    env: { ...process.env, RUSTFLAGS: '--cfg getrandom_backend="unsupported"' } });
  const bundled = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
    export { createDefaultTbcNetwork } from './packages/kit/src/default-network.ts';
    export { createTbcNetworkContext } from './packages/kit/src/network-context.ts';
    export { prepareTbcTransaction } from './packages/kit/src/prepared.ts';
    export { preparedChainDataRequirement } from './packages/kit/src/prepared-chain-data.ts';
    export { createTbcWallet } from './packages/kit/src/wallet-runtime.ts';
    export { createTbcClient } from './packages/kit/src/client.ts';
    export { createTbcNftMintJobScope, createTbcNftMintJobOrchestrator } from './packages/kit/src/nft-mint-job.ts';
    export { createApprovalHostEvidenceReader } from './packages/kit/src/approval-host-evidence.ts';
    export { projectTbcApprovalPresentation } from './packages/kit/src/approval-presentation.ts';
    export { createMemoryTwsHostStore } from './packages/host/src/index.ts';
    export { chainDataRequirement } from './packages/core/src/reducers/chain-data-requirements.ts';
    export { hashCanonical, assertValidTws } from './packages/core/src/index.ts';
    export { TWS_RELEASE_FINGERPRINT } from './packages/core/src/release.ts';
    export { createTbcEngine } from './packages/tbc-engine/src/facade.ts';
    export { createWasmTbcEngineBackend } from './packages/tbc-engine/src/wasm.ts';
    export { createWasmTbcKeylessEngine } from './packages/kit/src/keyless.ts';
  ` }, alias: { '@tbc-wallet/core': `${root}packages/core/src/index.ts`,
    '@tbc-wallet/host': `${root}packages/host/src/index.ts`, '@tbc-wallet/provider': `${root}packages/provider/src/index.ts`,
    '@tbc-wallet/provider/in-memory': `${root}packages/provider/src/in-memory.ts` },
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' });
  const url = new URL('../../../packages/kit/src/.nft-batch-source-check.mjs', import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) { return specifier === url ? { url, shortCircuit: true } : next(specifier, context); },
    load(value, context, next) { return value === url ? { source: bundled.outputFiles[0].text, format: 'module', shortCircuit: true } : next(value, context); },
  });
  const kit = await import(url); hooks.deregister();
  const engine = kit.createTbcEngine({ backend: await kit.createWasmTbcEngineBackend(readFileSync(join(rust,
    'target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm'))) });
  const keyless = await kit.createWasmTbcKeylessEngine(readFileSync(join(rust,
    'target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm')));

  function verify(report, transactions) {
    const parents = new Map(report.parents.map(p => [p.txid, new tbc.Transaction(p.rawTransaction)]));
    for (const signed of transactions) {
      const tx = new tbc.Transaction(signed.rawTransaction); assert.equal(tx.id, signed.txid);
      let value = 0;
      tx.inputs.forEach((input, index) => {
        input.output = parents.get(input.prevTxId.toString('hex'))?.outputs[input.outputIndex];
        assert.ok(input.output, 'all signed parents must already be available'); value += input.output.satoshis;
        const result = tx.verifyScript(index); assert.equal(result.success, true, result.error); counters.inputs++;
      });
      assert.ok(value - tx.outputs.reduce((sum, o) => sum + o.satoshis, 0) >=
        Math.max(80, Math.ceil(signed.rawTransaction.length / 2 * 80 / 1000)));
      const changed = new tbc.Transaction(signed.rawTransaction);
      changed.inputs[0].output = tx.inputs[0].output; changed.outputs.at(-1).satoshis++;
      assert.equal(changed.verifyScript(0).success, false); counters.tamperRejections++;
      parents.set(tx.id, tx);
    }
    if (report.input.request.intent.transfers && !report.input.request.intent.transfers[0].payment && transactions.length === 2) {
      const second = new tbc.Transaction(transactions[1].rawTransaction);
      assert.equal(second.inputs[2].prevTxId.toString('hex'), transactions[0].txid);
      assert.equal(second.inputs[2].outputIndex, 3);
    }
  }

  const rows = [];
  for (const profile of jobOnly ? ['mint-100'] : ['current', 'mixed', 'collections', 'funding-current', 'funding-mixed', ...(includeMint ? ['mint-100'] : [])]) {
    const minting = profile === 'mint-100';
    const report = JSON.parse(readFileSync(`${prefix}-${profile}.json`, 'utf8'));
    verify(report, report.transactions); // Native output independently validated first.
    const source = report.input.snapshot.payload;
    const account = { ...source.account, chainId: 'tbc:testnet', accountId: `tbc:testnet:${source.account.address}` }, address = account.address;
    const request = { ...report.input.request, chainId: account.chainId, constraints: { maxFee: report.input.request.constraints.maxFee,
      expiresAt: new Date(Date.parse(now) + 120_000).toISOString() } };
    assert.deepEqual(kit.chainDataRequirement(request), kit.preparedChainDataRequirement(request));
    const rawMap = new Map(report.parents.map(p => [p.txid, p.rawTransaction]));
    const codeIndexes = new Map(source.contracts.map(contract => {
      const tx = new tbc.Transaction(rawMap.get(contract.currentOutpoint.txid));
      const script = tx.outputs[contract.currentOutpoint.vout].script.toBuffer();
      return [createHash('sha256').update(script).digest().reverse().toString('hex'), contract];
    }));
    function network(beforeRead = () => {}, corrupt = false) {
      const trace = []; let sequence = 0, inFlight = 0, parallel = 0;
      const value = kit.createDefaultTbcNetwork({ network: kit.createTbcNetworkContext({ network: 'testnet' }),
        accounts: { current: async () => [account] }, poolNative: keyless, now: () => Date.parse(now),
        snapshotId: async () => `batch-${++sequence}`,
        poolMaterial: { async resolveLiquidityAdd() { throw new Error('Unrelated Pool read'); } },
        fetch: async (input, init) => {
          beforeRead(); const url = new URL(String(input)); const path = url.pathname;
          assert.equal(url.origin, 'https://api.tbcdev.org'); assert.equal(init?.method ?? 'GET', 'GET'); trace.push(path);
          inFlight++; parallel = Math.max(parallel, inFlight); await Promise.resolve(); inFlight--;
          let data;
          if (path === `/api/tbc/utxo/address/${address}`) data = { utxos: source.utxos.filter(u => u.classification === 'native')
            .map(u => ({ txid: u.txid, index: u.vout, value: u.satoshis, height: 99 })) };
          else if (minting && path.startsWith('/api/tbc/utxo/scriptpubkeyhash/')) {
            const id=request.intent.collectionId, collection=new tbc.Transaction(rawMap.get(id));
            data = {utxos:collection.outputs.flatMap((out,index)=> index>0 && out.satoshis===100
              ? [{txid:id,index,value:'100',height:99}] : [])};
          }
          else if (path.startsWith('/api/tbc/nft/utxo/scriptpubkeyhash/')) {
            const record = codeIndexes.get(path.split('/').at(-1)); assert.ok(record, 'unexpected NFT index');
            data = { utxos: [{ txid: record.currentOutpoint.txid, index: record.currentOutpoint.vout,
              nft_id: corrupt ? 'ee'.repeat(32) : record.contractId,
              collection_id: new tbc.Transaction(rawMap.get(record.contractId)).inputs[0].prevTxId.toString('hex'), value: '200', height: 99 }] };
          } else if (path.startsWith('/api/tbc/txraw/txid/')) {
            const raw = rawMap.get(path.split('/').at(-1)); assert.ok(raw, 'unexpected parent read'); data = { txraw: raw };
          } else throw new Error(`Unexpected read: ${path}`);
          return new Response(JSON.stringify({ code: '200', data }), { status: 200, headers: { 'content-type': 'application/json' } });
        } });
      return { value, trace, get parallel() { return parallel; } };
    }
    for (const mode of jobOnly ? [] : minting ? ['prefetch'] : profile.startsWith('funding') ? ['prefetch', 'prepared'] : ['prefetch', 'prepared', 'reject', 'bad-index']) {
      let approvals = 0, signatures = 0, finalized = 0, plan;
      const live = network(() => assert.equal(approvals, 0, 'extra read after approval'), mode === 'bad-index');
      const dapp = mode === 'prepared' ? network() : undefined;
      const params = dapp ? await kit.prepareTbcTransaction({ request, network: dapp.value, engine }) : request;
      const store = kit.createMemoryTwsHostStore({ now: () => Date.parse(now) });
      const evidenceReader = kit.createApprovalHostEvidenceReader({ store, releaseFingerprint: kit.TWS_RELEASE_FINGERPRINT,
        parseApprovalRequest(v) { kit.assertValidTws('approvalRequestParams', v); return v; } });
      const permissions = ['tbc_accounts', 'tbc_signTransaction'].map(capability => ({ id: `offline-${capability}`,
        parentCapability: capability, invoker: 'https://wallet.test', date: Date.parse(now), caveats: [
          { type: 'restrictChains', value: [account.chainId] }, { type: 'restrictAccounts', value: [account.accountId] },
          { type: 'restrictMethods', value: [capability] }] }));
      const traced = Object.fromEntries(['normalizeRequest', 'plan', 'validate', 'finalize'].map(method => [method, async v => {
        const result = await engine[method](v); if (method === 'plan') plan = result.plan; if (method === 'finalize') finalized++; return result;
      }]));
      const wallet = kit.createTbcWallet({ legacy: false, engine: traced, accounts: { current: async () => [account] }, network: live.value,
        capabilities: { version: '1.0', scopes: [{ chainId: account.chainId, intents: ['tbc.transfer', request.intent.type], profiles: ['core'] }] },
        approval: { async request(approval, call) {
          approvals++; assert.equal(approval.binding.payload.operationHash, plan.planHash);
          const evidence = await evidenceReader.read(call.callId, approval.binding.bindingHash);
          const presentation = kit.projectTbcApprovalPresentation(evidence);
          assert.equal(presentation.trust, 'binding-verified'); assert.deepEqual(presentation.businessTerms.value, request.intent);
          const items = request.intent.transfers ?? request.intent.items;
          const nft = approval.preview.assetFlows.filter(f => f.kind === 'nft'); assert.equal(nft.length, items.length);
          assert.deepEqual(nft.map(f => [f.contractId, f.to, f.amount]), items.map(i => [i.contractId, i.to ?? address, '1']));
          assert.deepEqual(approval.preview.assetFlows.filter(f => f.kind === 'native' && f.direction === 'send').map(f => [f.to,f.amount]),
            items.flatMap(i => i.payment ? [[i.payment.to,i.payment.amount]] : []));
          if (mode === 'reject') return { status: 'rejected' };
          return { status: 'approved', approvalId: 'offline-batch', approvalToken: 'offline-batch-token',
            bindingHash: approval.binding.bindingHash, approvedAt: now, expiresAt: approval.binding.payload.expiresAt };
        } }, signer: { async sign(input) {
          assert.equal(approvals, 1); signatures++;
          return { taskId: input.task.taskId, signatureEncoding: 'compact64',
            signature: secp256k1.sign(input.task.digest, scalar, { prehash: false, lowS: true }).toCompactHex() };
        } }, storage: { async loadPermissions() { return { revision: '0', permissions }; },
          async commitPermissions() { throw new Error('Unexpected permission commit'); } }, clock: () => now,
        randomBytes: length => Uint8Array.from({ length }, (_, i) => i) });
      const session = await wallet.openSession({ origin: 'https://wallet.test', sessionId: `batch-${profile}-${mode}`, execution: { hostStore: store } });
      try {
        let result, error;
        try {
          if (mode === 'prepared') result = await session.provider.request({ method: 'tbc_signPreparedTransaction', params });
          else if (mode === 'prefetch') {
            const exact = { id: `prefetch-${profile}`, method: 'tbc_signTransaction', params };
            const preparation = session.prefetchRequest(exact); assert.equal(await preparation.ready, 'ready', JSON.stringify(await preparation.diagnostic));
            assert.equal(approvals, 0); assert.equal(signatures, 0);
            const response = (await session.handleRequest(exact)).response; assert.equal(response.error, undefined); result = response.result;
          } else result = await session.provider.request({ method: 'tbc_signTransaction', params });
        } catch (e) { error = e; }
        if (mode === 'reject' || mode === 'bad-index') {
          assert.ok(error, `${mode} was accepted`); assert.equal(signatures, 0); assert.equal(finalized, 0);
          assert.equal(approvals, mode === 'reject' ? 1 : 0);
        } else {
          if (error) throw error;
          assert.equal(approvals, 1); assert.equal(signatures, report.transactions.reduce((n,t) => n + new tbc.Transaction(t.rawTransaction).inputs.length, 0));
          assert.equal(result.transactions.length, report.transactions.length);
          verify(report, result.transactions);
          const expectedReads = minting ? 3 : profile === 'collections' ? 7 : 6;
          assert.equal(live.trace.length, expectedReads, JSON.stringify(live.trace));
          assert.equal(new Set(live.trace).size, expectedReads, 'duplicate material read');
          assert.ok(live.parallel >= 2, 'NFT preparation lost parallel reads');
          if (dapp) { assert.equal(dapp.trace.length, expectedReads); assert.equal(new Set(dapp.trace).size, expectedReads); }
        }
        rows.push({ profile, mode, reads: live.trace.length, approvals, signatures }); counters.cases++;
      } finally { await session.close(); }
    }
    if (jobOnly) {
      const scenario=process.env.NFT_MINT_JOB_SCENARIO??'complete';
      assert.ok(['complete','reject','bad-credential','partial-reject','uncertain','resize'].includes(scenario));
      const itemCount=scenario==='complete'?250:3;
      let maxPlanBytes;
      if(scenario==='resize') {
        const sizes=[];
        for(const count of [1,3]) {
          const small={...report.input.request,intent:{...report.input.request.intent,
            items:report.input.request.intent.items.slice(0,count).map(i=>({...i,to:address}))}};
          const normalized=await engine.normalizeRequest({version:'1.0',request:small});
          const planned=await engine.plan({...report.input,...normalized});
          sizes.push(new TextEncoder().encode(JSON.stringify(planned.plan)).length);
        }
        maxPlanBytes=sizes[0]+2048;assert.ok(sizes[1]>maxPlanBytes);
      }
      const live=network(), store=kit.createMemoryTwsHostStore({now:()=>Date.parse(now)});
      let uiApprovals=0, connectionApprovals=0, formalCredentials=0, signatures=0, broadcasts=0, reviewedItems=0;
      const signed=[], batchCounts=[], preparedCounts=[];
      const jobEngine={...engine,async plan(p){preparedCounts.push(p.request.intent.items.length);return engine.plan(p)}};
      const permissions=['tbc_accounts','tbc_sendTransaction'].map(capability=>({id:`job-${capability}`,
        parentCapability:capability,invoker:'https://wallet.test',date:Date.parse(now),caveats:[
          {type:'restrictChains',value:[account.chainId]},{type:'restrictAccounts',value:[account.accountId]},
          {type:'restrictMethods',value:[capability]}]}));
      const wallet=kit.createTbcWallet({legacy:false,engine:jobEngine,accounts:{current:async()=>[account]},
        capabilities:{version:'1.0',scopes:[{chainId:account.chainId,intents:['tbc.transfer','tbc721-standard-batch-mint'],profiles:['core']}]},
        network:{...live.value,async broadcastSubmit(params) {
          // Controlled terminal only. Production Host, Engine and the ordered
          // broadcaster path run; no POST reaches a network or real funds.
          broadcasts++;
          if(broadcasts===2 && scenario==='uncertain') throw Error('controlled unknown transport');
          if(broadcasts===2 && scenario==='partial-reject') return {txid:params.transaction.txid,status:'rejected'};
          verify({...report,parents:[...report.parents,...signed]},[params.transaction]);
          signed.push(params.transaction);
          return {txid:params.transaction.txid,status:'accepted'};
        },async broadcastReconcile(params){return {transactions:params.txids.map(txid=>({txid,status:signed.some(tx=>tx.txid===txid)?'known':'unknown'}))}}},
        approval:{async request(params){
          assert.equal(params.binding.payload.operationKind,'permission','Unexpected second transaction approval UI');connectionApprovals++;
          return {status:'approved',approvalId:'job-connect',approvalToken:'connect-credential',bindingHash:params.binding.bindingHash,
            approvedAt:now,expiresAt:params.binding.payload.expiresAt};
        }},
        nftMintJob:{
          async approve({scope,scopeHash}) {uiApprovals++;assert.equal(scope.items.length,itemCount);
            if(scenario==='reject') return {status:'rejected',scopeHash};
            return {status:'approved',scopeHash,approvalId:'one-job',approvedAt:now,expiresAt:scope.limits.expiresAt}},
          async authorizeBatch({scope,scopeHash,params}) {
            assert.equal(uiApprovals,1);assert.equal(scopeHash,kit.hashCanonical(scope));formalCredentials++;
            const count=params.preview.transactionCount;batchCounts.push(count);
            assert.deepEqual(params.preview.assetFlows.filter(f=>f.kind==='nft').map(f=>[f.to,f.amount]),
              scope.items.slice(reviewedItems,reviewedItems+count).map(i=>[i.to,'1']));reviewedItems+=count;
            return {status:'approved',approvalId:`one-job-${formalCredentials}`,approvalToken:'job-credential',bindingHash:scenario==='bad-credential'?'ee'.repeat(32):params.binding.bindingHash,
              approvedAt:now,expiresAt:params.binding.payload.expiresAt};
          },
        },signer:{async sign(p){signatures++;return{taskId:p.task.taskId,signatureEncoding:'compact64',
          signature:secp256k1.sign(p.task.digest,scalar,{prehash:false,lowS:true}).toCompactHex()}}},
        storage:{async loadPermissions(){return{revision:'0',permissions}},async commitPermissions(params){
          return{revisions:params.changes.map(change=>({scope:change.scope,revision:'1'}))};
        }},
        clock:()=>now,randomBytes:n=>Uint8Array.from({length:n},(_,i)=>i)});
      const session=await wallet.openSession({origin:'https://wallet.test',sessionId:'mint-whole-job',execution:{hostStore:store}});
      try {
        const client=await kit.createTbcClient({network:'testnet',provider:session.provider}).connect();
        assert.equal(connectionApprovals,1);
        const jobStarted=performance.now();
        const result=await client.tbc721.batchMint({
          collectionId:request.intent.collectionId,items:Array.from({length:itemCount},(_,i)=>({...request.intent.items[0],slot:i+1})),
          // This test includes independent VM work per controlled submission;
          // consent is explicitly ten minutes, not renewed by later batches.
          limits:{maxTotalFee:'100000',expiresAt:new Date(Date.parse(now)+600_000).toISOString(),
            ...(maxPlanBytes?{maxPlanBytes}:{})}});
        console.log('NFT_MINT_JOB_RESULT',JSON.stringify({status:result.status,reason:result.reason,minted:result.minted,
          batches:result.batches.map(b=>({count:b.count,status:b.status,submitted:b.transactions.length})),formalCredentials,signatures,broadcasts,
          sourceHarnessElapsedMs:Math.round(performance.now()-jobStarted)}));
        assert.equal(uiApprovals,1);
        if(scenario==='complete') {
          assert.equal(result.status,'complete',result.reason);assert.equal(result.minted,250);
          assert.deepEqual(batchCounts,[100,100,50]);assert.equal(formalCredentials,3);assert.equal(signatures,500);assert.equal(broadcasts,250);
        } else if(scenario==='resize') {
          assert.equal(result.status,'complete',result.reason);assert.equal(result.minted,3);
          assert.deepEqual(batchCounts,[1,1,1]);assert.deepEqual(preparedCounts,[3,1,1,1]);
          assert.equal(formalCredentials,3);assert.equal(signatures,6);assert.equal(broadcasts,3);
        } else if(scenario==='reject'||scenario==='bad-credential') {
          assert.equal(result.status,'stopped');assert.equal(result.minted,0);assert.equal(signatures,0);assert.equal(broadcasts,0);
        } else {
          assert.equal(result.status,scenario==='uncertain'?'uncertain':'partial');assert.equal(result.minted,1);assert.equal(broadcasts,2);
          assert.equal(result.batches.length,1);assert.ok(result.batches[0].recoveryId);assert.equal(formalCredentials,1);
        }
        // Reject may return while its non-authorizing parallel material read drains.
        for(let i=0;i<16;i++) await Promise.resolve();
        assert.equal(live.trace.length,3,JSON.stringify(live.trace));assert.equal(new Set(live.trace).size,3);
        rows.push({profile:`mint-job-${itemCount}`,mode:`public-client-provider-wallet-${scenario}`,reads:live.trace.length,approvals:uiApprovals,formalCredentials,signatures,batchCounts,controlledSubmissions:broadcasts});counters.cases++;
      } finally {await session.close()}
    }
  }
  const calls = [];
  const client = await kit.createTbcClient({ network: 'testnet', provider: {
    async request(call) { calls.push(call); return call.method === 'tbc_requestAccounts' ? ['1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH'] : {}; },
    on() {}, removeListener() {}, destroy() {},
  } }).connect();
  const transfers = [{ contractId: 'aa'.repeat(32), to: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH' }];
  await client.tbc721.batchTransfer({ transfers, constraints: { maxFee: '1000' } });
  assert.equal(calls.at(-1).method, 'tbc_sendTransaction');
  assert.deepEqual(calls.at(-1).params.intent, { type: 'tbc721.batchTransfer', version: '1.0', transfers });
  console.log(JSON.stringify({ result: 'NFT_BATCH_SOURCE_PASS', ...counters, rows, actualNetworkRequests: 0, broadcasts: 0 }));
}
try { await main(); }
catch (error) { console.error(`NFT_BATCH_SOURCE_FAIL ${error?.code ?? ''} ${String(error?.message ?? 'unknown').slice(0, 900)}`); process.exitCode = 1; }
finally { rmSync(temporary, { recursive: true, force: true }); }
