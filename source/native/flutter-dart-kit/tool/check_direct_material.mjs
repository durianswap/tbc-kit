// No network or funded signing. Historical NFT uses public scalar-one fixtures.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {frozenOracle,repo,canonical,hash,sha} from './frozen_oracle.mjs';
import {createWasmTbcEngineBackend} from '../../../release/kit-contract173-20261014-c/package/dist/esm/engine.js';
const out=resolve(process.argv[2]);await mkdir(out); // Evidence is append-only.
const wasm=await readFile(join(repo,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm'));
const candidate=await createWasmTbcEngineBackend(wasm),o=await frozenOracle();
const call=async(method,input)=>JSON.parse(await candidate.call(method,canonical(input)));
const rehash=m=>{m.snapshot.snapshotHash=hash(m.snapshot.payload);return m;};
const clone=v=>JSON.parse(JSON.stringify(v));
const checks=[];
async function compare(name,full,reduced){
 const old=await o.call('plan',full),next=await call('plan',reduced);
 assert.equal(next.ok,true,JSON.stringify(next.error));
 assert.deepEqual(next.result.plan.payload.transactions,old.plan.payload.transactions);
 assert.deepEqual(next.result.plan.payload.signingTasks,old.plan.payload.signingTasks);
 const validated=await call('validate',{...reduced,plan:next.result.plan,phase:'plan'});
 assert.equal(validated.result?.valid,true,JSON.stringify(validated.error));
 checks.push({name,oldParents:full.snapshot.payload.parents.length,newParents:reduced.snapshot.payload.parents.length,sameTransactions:true,sameSigningTasks:true,planValidated:true});
 return next.result.plan;
}
const live=JSON.parse(await readFile(join(repo,'release/direct-material-20261015-b/run-2.json'))).material;
const oldLive=JSON.parse(await readFile(join(repo,'release/direct-material-20261015-b/run-1.json'))).material;
await compare('historical-stablecoin-live-material',oldLive,live);
const capture=JSON.parse(await readFile(join(repo,'release/sdk-stablecoin-kit-20261015-a/capture.json'))),stableReads=[];
const resolverSource=await build({entryPoints:[join(repo,'packages/kit/src/default-chain-data.ts')],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {createDefaultTbcChainDataResolver}=await import('data:text/javascript;base64,'+Buffer.from(resolverSource.outputFiles[0].contents).toString('base64'));
const client=o.api.createTestnetClient({baseUrl:'https://api.tbcdev.org',allowedOrigins:['https://api.tbcdev.org'],fetch:async(url,init)=>{
 assert.equal(init?.method??'GET','GET');const path=new URL(url).pathname;stableReads.push(path);assert(capture.responses[path],path);
 return new Response(JSON.stringify({code:200,data:capture.responses[path].data}));
}});
const stableResolver=createDefaultTbcChainDataResolver({accounts:{current:async()=>[capture.account]},client,materialNative:o.keyless,
 now:()=>Date.parse(capture.snapshot.payload.capturedAt),snapshotId:()=>capture.snapshot.payload.snapshotId,confirmationPolicy:{minConfirmations:'0'}});
const stableSnapshot=await stableResolver.resolve({version:'1.0',chainId:capture.account.chainId,accountId:capture.account.accountId,requirement:{intentType:capture.request.intent.type,includeAncestry:true,contractIds:[capture.request.intent.contractId],assets:[{kind:'native'},{kind:'stablecoin',contractId:capture.request.intent.contractId,minimumAmount:'10'}]}},capture.account);
assert(stableSnapshot.payload,JSON.stringify({result:stableSnapshot,reads:stableReads}));assert.equal(stableReads.length,9);assert.equal(stableSnapshot.payload.parents.length,5);
// Every supplied direct proof / issuance anchor is still necessary.
for(const parent of live.snapshot.payload.parents){
 const bad=clone(live);bad.snapshot.payload.parents=bad.snapshot.payload.parents.filter(p=>p.txid!==parent.txid);rehash(bad);
 assert.equal((await call('plan',bad)).ok,false,'missing stablecoin parent accepted');
}
for(const field of ['scriptPubKey','satoshis']){
 const bad=clone(live),u=bad.snapshot.payload.utxos.find(u=>u.classification==='stablecoin');
 assert(u);u[field]=field==='scriptPubKey'?'51':'501';rehash(bad);
 assert.equal((await call('plan',bad)).ok,false,'changed stablecoin spend accepted');
}
const source=JSON.parse(await readFile(join(repo,'native/flutter-dart-kit/test/fixtures/nft-signing.json')));
const built=await build({entryPoints:[join(repo,'packages/kit/src/nft-material.ts')],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {resolveNftMaterial}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
const inspect=raw=>{const t=o.api.inspectTbcTransaction(raw).transaction;return {txid:o.api.turingTransactionId(raw),rawTransaction:raw,inputs:t.inputs.map(i=>({txid:i.txid,vout:i.vout})),outputs:t.outputs.map((v,vout)=>({vout,satoshis:String(v.satoshis),scriptPubKey:Buffer.from(v.scriptPubKey).toString('hex')}))};};
for(const version of ['v0','v1','v2']){
 const sample=clone(source.cases.find(c=>c.name===`historical-nft-${version}-descendant`));
 let material=clone(sample.audit.material);
 for(let depth=2;depth<=5;depth++){
  const signed=await o.sign('bounded-nft-'+version+'-'+depth,material.request,material.snapshot,material.policy);
  const tx=signed.result.transactions[0],p=inspect(tx.rawTransaction),payload=material.snapshot.payload;
  payload.parents.push({txid:tx.txid,rawTransaction:tx.rawTransaction});
  for(const u of payload.utxos.filter(u=>u.classification==='nft')){u.txid=tx.txid;u.scriptPubKey=p.outputs[u.vout].scriptPubKey;}
  payload.contracts[0].currentOutpoint={txid:tx.txid,vout:0};rehash(material);
  const id=material.request.intent.contractId,mint=inspect(payload.parents.find(p=>p.txid===id).rawTransaction);
  const keep=new Set([id,mint.inputs[0].txid,tx.txid,p.inputs[0].txid]);
  const reduced=clone(material);reduced.snapshot.payload.parents=reduced.snapshot.payload.parents.filter(p=>keep.has(p.txid));rehash(reduced);
  await compare(`historical-nft-${version}-depth-${depth}`,material,reduced);
  assert.equal(reduced.snapshot.payload.parents.length,4);
  const reads=[],byId=new Map(payload.parents.map(p=>[p.txid,inspect(p.rawTransaction)]));
  const resolved=await resolveNftMaterial({kind:'nft',contractId:id,ownerScript:p.outputs[1].scriptPubKey.slice(0,50),minimumConfirmations:'0',tipHeight:Promise.resolve(1000n),
   api:{nftUtxosByScriptHash:async()=>({utxos:[{txid:tx.txid,index:'0',value:'200',height:'990',nft_id:id,collection_id:mint.inputs[0].txid}]}),txoStatus:async()=>({txos:[{txid:tx.txid,index:'1',value:'100',spent:false}]})},
   readHistory:async id=>{reads.push(id);assert(byId.has(id));return byId.get(id);},readDecoded:async()=>{throw Error('unnecessary decode');}});
  assert.deepEqual(new Set(resolved.parents.map(p=>p.txid)),keep);assert.equal(reads.length,4);
  const bad=clone(reduced);bad.snapshot.payload.parents=bad.snapshot.payload.parents.filter(v=>v.txid!==p.inputs[0].txid);rehash(bad);
  assert.equal((await call('plan',bad)).ok,false,'missing NFT direct ancestor accepted');
  if(depth===5)await writeFile(join(out,`nft-${version}.json`),JSON.stringify({sample,full:material,reduced,expectedPlan:(await call('plan',reduced)).result.plan}));
 }
}
await writeFile(join(out,'stablecoin.json'),JSON.stringify({full:oldLive,reduced:live,expectedPlan:(await call('plan',live)).result.plan}));
const report={wasmSha256:sha(wasm),baselineWasmSha256:o.wasmSha256,networkRequests:0,broadcasts:0,checks,missingStablecoinParentsRejected:live.snapshot.payload.parents.length,changedSpendRejected:2,missingNftDirectAncestorsRejected:12};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
