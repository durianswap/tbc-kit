// Compare the default planners using ONE shared read-only observation. No signer.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const repo=resolve(import.meta.dirname,'..');
const [candidateArg]=process.argv.slice(2);assert(candidateArg,'CANDIDATE_PACKAGE_ROOT');
const tbc=createRequire(join(repo,'source/package.json'))('tbc-lib-js');
const address='164nB7hUpDSx3neWu293wKqW1sRNBg1e3X',chainId='tbc:testnet';
const collectionId='e7f266c86c6b8981fcfdcd377c15d03f1218202dd7466600a42bed16fb9f86ad';
const cache=new Map(),trace=[],results=[];
const readFetch=async(url,init)=>{
  const u=new URL(String(url)),method=init?.method??'GET';
  assert(u.origin==='https://api.tbcdev.org'&&(method==='GET'||method==='POST'&&u.pathname==='/api/tbc/txo/status'),'Read-only transport');
  const k=method+' '+u.href+' '+(init?.body??'');
  if(!cache.has(k)){trace.push({path:u.pathname,method});cache.set(k,fetch(url,{...init,signal:AbortSignal.timeout(20000)}));}
  return (await cache.get(k)).clone();
};
for(const [name,root]of [['rc22',join(repo,'packages/kit')],['rc23',resolve(candidateArg)]]) {
  const load=p=>import(pathToFileURL(join(root,'dist/esm',p)));
  const kit={...await load('api.js'),...await load('wallet.node.js'),...await load('engine.node.js')};
  const api=kit.createTbcOfficialApi({network:'testnet',fetch:readFetch});
  const keyless=await kit.createWasmTbcKeylessEngine(await readFile(join(root,'artifacts/wasm/tbc_keyless_wasm.wasm')));
  const engine=kit.createTbcEngine({backend:await kit.createWasmTbcEngineBackend(await readFile(join(root,'artifacts/wasm/tbc_engine_wasm.wasm')))});
  const raw=(await api.rawTransaction({txid:collectionId})).txraw,tx=new tbc.Transaction(raw);
  const publicKey=tx.inputs[0].script.chunks.at(-1).buf.toString('hex');
  assert.equal(new tbc.PublicKey(publicKey).toAddress().toString(),address);
  const account={address,chainId,accountId:chainId+':'+address,publicKey};
  const status=await kit.createTbc721Reader({api,engine:keyless}).getMintStatus({collectionId,address});
  assert.equal(status.status,'available');assert(status.availableSlots.length>=100);
  const network=kit.createDefaultTbcTestnetNetwork({accounts:{current:async()=>[account]},fetch:readFetch,poolNative:keyless,
    broadcast:{submit(){throw Error('Broadcast prohibited');},reconcile(){throw Error('Not needed');}}});
  for(const count of [1,2,6,7,100]) {
    const slots=status.availableSlots.slice(0,count),type=count===1?'tbc721-standard-mint':'tbc721-standard-batch-mint';
    const result={version:name,count,available:status.availableCount,spent:status.spentCount};results.push(result);
    const snapshot=await network.resolveChainData({version:'1.0',chainId,accountId:account.accountId,requirement:{
      intentType:type,contractIds:[collectionId],collectionSlots:slots,includeAncestry:true,
      assets:[{kind:'native'},{kind:'collection',contractId:collectionId,minimumAmount:String(count)}]}});
    if(snapshot.portError){result.error=snapshot.portError;continue;}
    result.materialUtxos=snapshot.payload.utxos.length;
    result.nativeCandidates=snapshot.payload.utxos.filter(u=>u.classification==='native').length;
    const fields={name:'Read-only audit',symbol:'AUDIT',description:'No signing or broadcast',attributes:[{traitType:'number',value:1}]};
    const intent=count===1?{type,version:'1.0',collectionId,...fields,slot:slots[0]}:
      {type,version:'1.0',collectionId,items:slots.map(slot=>({...fields,slot}))};
    const normalized=await engine.normalizeRequest({version:'1.0',request:{version:'1.0',chainId,from:address,intent,
      constraints:{maxFee:'100000',expiresAt:new Date(Date.now()+180000).toISOString(),feePreference:'standard'}}});
    const policy=await network.resolvePolicy({version:'1.0',request:normalized.request,requestHash:normalized.requestHash,snapshotHash:snapshot.snapshotHash});
    assert.equal(policy.portError,undefined);
    const params={version:'1.0',request:normalized.request,requestHash:normalized.requestHash,snapshot,policy};
    const planned=await engine.plan(params);
    assert.deepEqual(await engine.validate({...params,phase:'plan',plan:planned.plan}),{valid:true,violations:[]});
    result.transactions=planned.plan.payload.transactions.length;result.totalFee=planned.plan.payload.preview.totalFee;
    result.planValidated=true;
  }
}
console.log(JSON.stringify({status:'READ_ONLY_PLAN_COMPARISON',observedAt:new Date().toISOString(),address,collectionId,
  results,trace,totalReadRequests:trace.length,signatures:0,broadcasts:0},null,2));
