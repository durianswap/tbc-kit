import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const built = await build({ stdin: { contents: `export * from './packages/kit/src/nft-mint-job.ts';
  export {nftMintPreparationResource} from './packages/kit/src/nft-mint-job-wallet.ts';
  export {hashCanonical} from './packages/core/src/hash.ts';`, resolveDir: root, loader: 'ts' },
  alias: { '@tbc-wallet/core': `${root}packages/core/src/index.ts` }, bundle: true, write: false,
  format: 'esm', platform: 'node', logLevel: 'silent' });
const url = new URL('../src/.nft-mint-job-test.mjs', import.meta.url).href;
const hook = registerHooks({ resolve(s,c,n) { return s===url ? {url,shortCircuit:true} : n(s,c); },
  load(s,c,n) { return s===url ? {source:built.outputFiles[0].text,format:'module',shortCircuit:true} : n(s,c); } });
const { createTbcNftMintJobOrchestrator, createTbcNftMintJobScope, hashCanonical, nftMintPreparationResource } = await import(url);
hook.deregister();
const NOW = Date.parse('2026-10-27T00:00:00Z');
const address = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const authority = { chainId:'tbc:testnet', accountId:`tbc:testnet:${address}`, address,
  origin:'https://mint.test',sessionId:'mint-job' };
const input = (count=250) => ({ authority, collectionId:'ab'.repeat(32),
  items:Array.from({length:count},(_,i)=>({slot:i+1,name:`NFT ${i+1}`,symbol:'N',description:'',attributes:[]})),
  limits:{maxTotalFee:'10000',expiresAt:'2026-10-27T00:05:00Z'} });

test('wallet resizing accepts only exact pinned Engine resource errors, not semantic failures',()=>{
  for(const [message,resource] of [
    ['unsigned plan exceeds the serialized byte budget','plan-bytes'],
    ['signing continuation exceeds the serialized byte budget','continuation-bytes'],
    ['unsigned plan exceeds the input budget','inputs'],['unsigned plan exceeds the output budget','outputs'],
  ]) {
    assert.equal(nftMintPreparationResource(Object.assign(new Error(message),{rustCode:'INVALID_PLAN'})),resource);
    assert.equal(nftMintPreparationResource(new Error(message)),undefined);
    assert.equal(nftMintPreparationResource(Object.assign(new Error(message),{rustCode:'INSUFFICIENT_FUNDS'})),undefined);
  }
  assert.equal(nftMintPreparationResource(Object.assign(new Error('NFT ownership mismatch'),{rustCode:'INVALID_PLAN'})),undefined);
});

function harness(options={}) {
  let clock=NOW, approvals=0, begins=0, authorityChecks=0;
  const prepared=[], executed=[], scopeRequests=[];
  const context={readOnlySnapshot:true};
  const adapter={
    async begin(scope) { begins++; options.begin?.(scope); if(options.failBegin) throw Error('read failure'); return context; },
    async approve(request) {
      approvals++; scopeRequests.push(request); options.approve?.(request);
      return {status:options.reject?'rejected':'approved',scopeHash:options.wrongConsent?'ff'.repeat(32):request.scopeHash,
        ...(options.reject?{}:{approvalId:'job',approvedAt:new Date(clock).toISOString(),expiresAt:request.scope.limits.expiresAt})};
    },
    async assertAuthority() { if(++authorityChecks===options.failAuthorityAt) throw Error('account changed'); },
    async prepare(request) {
      assert.equal(request.context,context); prepared.push(request);
      if(options.failPrepare) throw Error('semantic error, not resource excess');
      if(options.prepare) return options.prepare(request);
      const count=request.request.intent.items.length;
      if(options.capacity && count>options.capacity) return {status:'resource-limit',resource:'inputs'};
      if(request.offset) assert.equal(request.continuation.previousOffset,executed.at(-1).offset,'reuse finalized change without refetch');
      return {status:'ready',request:options.mutateRequest?.(request.request)??request.request,
        planHash:hashCanonical(request.request),totalFee:String(count*2),transactionCount:count,
        serializedPlanBytes:count*(options.bytesPerItem??100),prepared:{opaquePlan:true}};
    },
    async execute(request) {
      executed.push(request); assert.equal(approvals,1); assert.equal(request.context,context);
      assert.equal(request.scopeHash,scopeRequests[0].scopeHash);
      if(options.throwExecute) throw Error('transport disconnected');
      options.execute?.(request);
      clock+=options.executionMs??0;
      const transactions=request.batch.request.intent.items.map((i,index)=>({txid:hashCanonical({slot:i.slot}),fee:'2',
        status:options.uncertainAt===index?'uncertain':options.uncertainAt!==undefined && index>options.uncertainAt?'not-submitted':'accepted'}));
      return {status:options.uncertainAt===undefined?'complete':'uncertain',transactions,
        continuation:{previousOffset:request.offset},...(options.uncertainAt===undefined?{}:{recoveryId:'pending-host-operation'}),
        ...(options.executionResult?.({request,transactions})??{})};
    },
  };
  const orchestrator=createTbcNftMintJobOrchestrator(adapter,{now:()=>clock,...(options.executionBatchSize===undefined?{}:{executionBatchSize:options.executionBatchSize})});
  return {run:(value=input())=>orchestrator.run(value),prepared,executed,scopeRequests,
    get approvals(){return approvals},get begins(){return begins}};
}

test('job expiry uses shared UTC validation including real dates and milliseconds',()=>{
  for(const expiresAt of ['2026-02-30T00:00:00Z','2026-10-27T00:05:00+08:00','2026-10-27T00:05:00.1234Z']) {
    const value=input(1);value.limits.expiresAt=expiresAt;
    assert.throws(()=>createTbcNftMintJobScope(value));
  }
  const value=input(1);value.limits.expiresAt='2026-10-27T00:05:00.123Z';
  assert.equal(createTbcNftMintJobScope(value).limits.expiresAt,value.limits.expiresAt);
});

test('250 items become 100/100/50 with one consent, one material scope and remaining fee',async()=>{
  const h=harness(), result=await h.run();
  assert.equal(result.status,'complete'); assert.equal(result.minted,250);assert.equal(result.confirmedSubmissionFee,'500');
  assert.equal(h.approvals,1);assert.equal(h.begins,1);
  assert.deepEqual(h.executed.map(s=>s.batch.transactionCount),[100,100,50]);
  assert.deepEqual(h.prepared.map(s=>s.request.constraints.maxFee),['10000','9800','9600']);
  const scope=h.scopeRequests[0].scope;
  assert.equal(scope.items.length,250);assert.ok(scope.items.every(i=>i.to===address));
  assert.ok(Object.isFrozen(scope.items[0]));assert.equal(result.scopeHash,hashCanonical(scope));
});

test('bounded executor working set completes 101 items with one consent and no reread',async()=>{
  const h=harness({executionBatchSize:10}),r=await h.run(input(101));
  assert.equal(r.status,'complete');assert.equal(r.minted,101);
  assert.equal(h.approvals,1);assert.equal(h.begins,1);
  assert.deepEqual(h.executed.map(b=>b.batch.transactionCount),[10,10,10,10,10,10,10,10,10,10,1]);
  assert.equal(h.scopeRequests[0].scope.limits.maxItemsPerBatch,100);
  const smaller=input(7);smaller.limits.maxItemsPerBatch=3;
  const narrow=harness({executionBatchSize:10});await narrow.run(smaller);
  assert.deepEqual(narrow.executed.map(b=>b.batch.transactionCount),[3,3,1]);
});

test('working set budgeting never extends expiry or retries a submitted prefix',async()=>{
  const h=harness({executionBatchSize:10,executionMs:160000}),r=await h.run(input(101));
  assert.equal(r.status,'partial');assert.equal(r.reason,'expired');assert.equal(r.minted,20);
  assert.equal(h.executed.length,2);assert.equal(h.begins,1);assert.equal(h.approvals,1);
});

test('known resource excess reduces local batches without repeated approval or begin',async()=>{
  for(const options of [{capacity:30},{bytesPerItem:1000}]) {
    const h=harness(options), value=input(105);
    if(options.bytesPerItem) value.limits.maxPlanBytes=30_000;
    const result=await h.run(value);
    assert.equal(result.minted,105);assert.equal(h.approvals,1);assert.equal(h.begins,1);
    assert.deepEqual(h.executed.map(s=>s.batch.transactionCount),[25,25,25,25,5]);
    assert.deepEqual(h.prepared.slice(0,3).map(s=>s.request.intent.items.length),[100,50,25]);
  }
});

test('semantic prepare errors never become smaller batch retries',async()=>{
  const h=harness({failPrepare:true}),r=await h.run();
  assert.equal(r.reason,'preparation-failed');assert.equal(h.prepared.length,1);assert.equal(h.executed.length,0);
});

test('caller mutation after run starts cannot change approved items, amounts or limits',async()=>{
  const value=input(102),h=harness({approve(){value.items[0].name='replaced';value.items[101].to=address;value.limits.maxTotalFee='999999';}});
  const result=await h.run(value);assert.equal(result.minted,102);
  assert.equal(h.scopeRequests[0].scope.items[0].name,'NFT 1');assert.equal(h.scopeRequests[0].scope.limits.maxTotalFee,'10000');
});

test('invalid late items and duplicate slots fail before reads and approval',async()=>{
  for(const mutate of [v=>v.items[210].symbol=' ',v=>v.items[210].slot=1,v=>v.items[210].to='bad',
    v=>v.limits.maxItemsPerBatch=101,v=>v.items.push(...input(2000).items)]) {
    const value=input(),h=harness();mutate(value);await assert.rejects(h.run(value));
    assert.equal(h.begins,0);assert.equal(h.approvals,0);assert.equal(h.executed.length,0);
  }
});

test('rejection and failed initial read never sign; malformed consent is rejected',async()=>{
  const rejected=harness({reject:true}),r=await rejected.run();assert.equal(r.reason,'rejected');assert.equal(rejected.executed.length,0);
  const failed=harness({failBegin:true});assert.equal((await failed.run()).reason,'preparation-failed');assert.equal(failed.executed.length,0);
  const wrong=harness({wrongConsent:true});await assert.rejects(wrong.run(),/binding mismatch/);assert.equal(wrong.executed.length,0);
});

test('remaining total fee, total plan bytes and an oversized single item stop before execute',async()=>{
  const value=input();value.limits.maxTotalFee='250';const fee=harness();
  const r=await fee.run(value);assert.equal(r.reason,'fee-budget');assert.equal(r.minted,100);assert.equal(fee.executed.length,1);
  const total=input();total.limits.maxPlanBytes=10_000;total.limits.maxTotalPlanBytes=15_000;
  const h=harness();assert.equal((await h.run(total)).reason,'resource-limit');assert.equal(h.executed.length,1);
  const large=harness({capacity:0,bytesPerItem:5*1024*1024});
  assert.equal((await large.run(input(1))).reason,'resource-limit');assert.equal(large.executed.length,0);
});

test('changing any prepared item or fee request cannot escape the consent',async()=>{
  for(const mutate of [r=>({...r,from:'1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP'}),
    r=>({...r,constraints:{...r.constraints,maxFee:'99999'}}),
    r=>({...r,intent:{...r.intent,items:r.intent.items.map((i,n)=>n===0?{...i,name:'changed'}:i)}})]) {
    const h=harness({mutateRequest:mutate});await assert.rejects(h.run(),/approved job scope/);assert.equal(h.executed.length,0);
  }
});

test('partial cancelled/expired/authority-change jobs retain exactly the completed prefix',async()=>{
  const controller=new AbortController(),cancel=harness({execute(){controller.abort()}});
  const a=await cancel.run({...input(),signal:controller.signal});
  assert.equal(a.reason,'cancelled');assert.equal(a.status,'partial');assert.equal(a.minted,100);assert.equal(cancel.executed.length,1);
  const expire=harness({executionMs:301_000}),b=await expire.run();assert.equal(b.reason,'expired');assert.equal(b.minted,100);
  const changed=harness({failAuthorityAt:4}),c=await changed.run();assert.equal(c.reason,'authority-changed');assert.equal(c.minted,100);
  const during=harness({executionMs:301_000,executionResult(){return{status:'failed',transactions:[]}}});
  const d=await during.run();assert.equal(d.reason,'expired');assert.equal(d.minted,0);
});

test('unknown submission never retries or advances into another batch',async()=>{
  const h=harness({uncertainAt:7}),r=await h.run();assert.equal(r.status,'uncertain');assert.equal(r.minted,7);
  assert.equal(r.confirmedSubmissionFee,'14');assert.equal(r.batches[0].recoveryId,'pending-host-operation');
  assert.equal(h.prepared.length,1);assert.equal(h.executed.length,1);
  const thrown=harness({throwExecute:true}),t=await thrown.run();assert.equal(t.reason,'submission-uncertain');
  assert.equal(thrown.executed.length,1);assert.equal(t.batches[0].status,'uncertain');
});

test('malformed post-effect replies preserve earlier completed batches and stop uncertain',async()=>{
  for (const change of [transactions=>transactions.map(t=>({...t,fee:'99999'})),
    transactions=>transactions.map((t,i)=>i===1?{...t,txid:transactions[0].txid}:t)]) {
    const h=harness({executionResult({request,transactions}) {
      return {status:'complete',transactions:request.offset?change(transactions):transactions,recoveryId:'reconcile-exact-operation'};
    }});
    const result=await h.run();assert.equal(result.status,'uncertain');assert.equal(result.minted,100);
    assert.equal(result.batches[1].recoveryId,'reconcile-exact-operation');assert.equal(h.executed.length,2);
  }
});

test('parallel read starts during approval; one orchestrator cannot overlap two jobs',async()=>{
  let release,started=false;
  const gate=new Promise(resolve=>{release=resolve});
  const h=harness({begin(){started=true;},approve(){assert.equal(started,false);}});
  // begin is microtask queued intentionally so approval UI can show immediately.
  await h.run(input(1));assert.equal(started,true);
  let active;
  const held=createTbcNftMintJobOrchestrator({async begin(){return{}},async assertAuthority(){},
    async approve({scopeHash}){active=scopeHash;await gate;return{status:'rejected',scopeHash}},
    async prepare(){throw Error('must not prepare')},async execute(){throw Error('must not execute')}},{now:()=>NOW});
  const pending=held.run(input(1));await Promise.resolve();await Promise.resolve();
  await assert.rejects(held.run(input(1)),/already active/);release();assert.equal((await pending).reason,'rejected');assert.ok(active);
});
