// Copied into a clean npm consumer: only public installed Kit imports.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import * as client from '@tbc/kit';
import * as wallet from '@tbc/kit/wallet';
import * as engine from '@tbc/kit/engine';
const require=createRequire(import.meta.url),packageRoot=join(import.meta.dirname,'node_modules/@tbc/kit');
for(const name of ['@tbc/kit','@tbc/kit/wallet','@tbc/kit/engine','@tbc/kit/api','@tbc/kit/rpc','@tbc/kit/sqlite','@tbc/kit/testing'])assert(Object.keys(require(name)).length>0,name);
const sha=b=>createHash('sha256').update(b).digest('hex');
const provenance=JSON.parse(await readFile(join(packageRoot,'artifacts/provenance.json')));
assert.equal(wallet.TWS_RELEASE_FINGERPRINT,provenance.protocolFingerprint);
for(const a of provenance.artifacts)assert.equal(sha(await readFile(join(packageRoot,a.path))),a.sha256);
const backend=await engine.createWasmTbcEngineBackend(await readFile(join(packageRoot,'artifacts/wasm/tbc_engine_wasm.wasm')));
const keyless=await wallet.createWasmTbcKeylessEngine(await readFile(join(packageRoot,'artifacts/wasm/tbc_keyless_wasm.wasm')));
const call=async(method,input)=>{const r=JSON.parse(await backend.call(method,JSON.stringify(input)));assert.equal(r.ok,true,JSON.stringify(r.error));return r.result;};
const f=JSON.parse(await readFile(process.argv[2])),extra=JSON.parse(await readFile(process.argv[3]));
const evidence=[];
for(const s of [...f.cases,...extra.cases]){
 const trace=[];
 const network=wallet.createDefaultTbcNetwork({network:wallet.createTbcNetworkContext({network:'testnet'}),
  accounts:{current:async()=>[s.account,...s.signingAccounts]},poolNative:keyless,now:()=>Date.parse(s.now),snapshotId:()=>s.snapshotId,
  fetch:async(url,init)=>{assert.equal(init?.method??'GET','GET');const u=new URL(url),path=u.pathname+u.search;
   assert(Object.hasOwn(s.replies,path),'Unexpected packaged GET '+path);trace.push(path);
   return new Response(JSON.stringify({code:200,data:s.replies[path]}));}});
 const query={version:'1.0',chainId:s.account.chainId,accountId:s.account.accountId,requirement:wallet.chainDataRequirement(s.request),
  ...(s.request.signingRoles?{signingRoles:s.request.signingRoles,signingAccounts:s.signingAccounts}:{})};
 const snapshot=await network.chainData.resolve(query,s.account);assert.deepEqual(snapshot,s.audit.material.snapshot,s.name);
 const policy=await network.resolvePolicy({request:s.request,requestHash:s.audit.material.requestHash,snapshotHash:snapshot.snapshotHash});
 assert.deepEqual(policy,s.audit.material.policy);assert.deepEqual([...trace].sort(),[...s.coldTrace].sort());
 trace.length=0;assert.deepEqual(await network.chainData.resolve(query,s.account),snapshot);assert.deepEqual([...trace].sort(),[...s.warmTrace].sort());
 const n=await call('normalizeRequest',{version:'1.0',request:s.request});assert.equal(n.requestHash,s.audit.material.requestHash);
 const material={version:'1.0',...n,snapshot,policy};const {plan}=await call('plan',material);assert.deepEqual(plan,s.audit.plan);
 const binding=s.audit.binding,approval=s.audit.approval;
 assert.equal((await call('validate',{...material,plan,binding,approval,phase:'pre-sign'})).valid,true);
 let final;
 for(const stage of s.audit.stages){
  const input={...material,plan,binding,approval,signatures:stage.signatures,...(stage.continuation?{continuation:stage.continuation}:{})};
  final=await call('finalize',input);assert.deepEqual(final,stage.result);
  assert.equal((await call('validate',{...input,phase:'finalized',...(final.bundle?{bundle:final.bundle}:{pending:final})})).valid,true);
 }
 assert.deepEqual(final.bundle,s.result);
 const prepared=await client.prepareTbcTransaction({request:s.request,engine:Object.fromEntries(['normalizeRequest','plan','validate'].map(m=>[m,i=>call(m,i)])),network:{resolveChainData:async()=>snapshot,resolvePolicy:async()=>policy}});
 assert.deepEqual(prepared,extra.prepared.find(p=>p.name===s.name.replace(/-paged$/,'')).request);
 if(s.kind==='create')assert.equal(client.describeAmmFeePolicy(s.feePolicy).lpFeeBps,s.feePolicy.lpFeeRate);
 evidence.push({name:s.name,coldReads:s.coldTrace.length,warmReads:s.warmTrace.length,transactions:final.bundle.transactions.length});
}
console.log(JSON.stringify({status:'INSTALLED_PACKAGE173_OFFLINE_PASS',cases:evidence.length,publicEntries:7,protocolFingerprint:wallet.TWS_RELEASE_FINGERPRINT,evidence,liveHttp:0,broadcasts:0}));
