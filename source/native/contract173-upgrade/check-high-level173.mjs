// Directional public-surface and pagination checks against fixed SDK fixtures.
// The transport is mocked. No live HTTP, funds, wallet keys or broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sourceOracle,source,root,canonical,hash,sha,account} from './source-oracle.mjs';
const o=await sourceOracle();
const {prepareTbcTransaction}=await source('packages/kit/src/prepared.ts');
const {isValidTws}=await source('packages/core/src/validation.ts');
const {quoteTbcAmm}=await source('packages/kit/src/amm-quote.ts');
const original=await readFile(join(import.meta.dirname,'high-level173.json'));
const input=JSON.parse(original),prepared=[],paged=[];
const engine=Object.fromEntries(['normalizeRequest','plan','validate'].map(m=>[m,i=>o.call(m,i)]));
let refusals=0,quotes=0;
for(const s of input.cases){
  const m=s.audit.material;
  const proposal=await prepareTbcTransaction({request:s.request,engine,network:{
    resolveChainData:async()=>m.snapshot,resolvePolicy:async()=>m.policy}});
  assert.equal(isValidTws('preparedTransactionRequest',proposal),true,s.name);
  for(const invalid of ['template','family','protocol','genesis']){
    const bad=structuredClone(proposal),c=bad.proposal.payload.evidence.contracts[0];
    if(invalid==='template')c.templateRevision='ff'.repeat(32);
    if(invalid==='family')c.family='stablecoin';
    if(invalid==='protocol')c.protocolVersion='coin';
    if(invalid==='genesis')c.genesisOutpoint.vout=1;
    bad.proposal.proposalHash=hash(bad.proposal.payload);
    assert.equal(isValidTws('preparedTransactionRequest',bad),false);refusals++;
    const snapshot=structuredClone(m.snapshot),sc=snapshot.payload.contracts[0];
    Object.assign(sc,Object.fromEntries(['templateRevision','family','protocolVersion','genesisOutpoint'].map(k=>[k,c[k]])));
    snapshot.snapshotHash=hash(snapshot.payload);
    assert.equal(isValidTws('chainDataResolveResult',snapshot),false);refusals++;
  }
  if(s.kind!=='create'){
    const id=m.snapshot.payload.contracts[0].currentOutpoint.txid;
    const action=s.kind==='add'?{kind:'addTbc',amount:'100000',initialFtAmount:'200000'}:
      {kind:s.kind,amount:s.kind==='sell'?'1000':'10000'};
    const pool=m.snapshot.payload.parents.find(p=>p.txid===id);
    const quote=await quoteTbcAmm({pool,action},{engine:o.keyless});
    const policy=s.feePolicy;
    assert.equal(quote.feePolicy.totalFeeBps,policy.lpFeeRate+policy.taxFeeRate+policy.serviceProviderFeeRate+policy.protocolFeeRate);
    assert.equal(quote.feePolicy.lpFeeBps,policy.lpFeeRate);
    assert.equal(quote.feePolicy.serviceFeeAddress,policy.feeAddress);
    quotes++;
  }
  prepared.push({name:s.name,now:s.now,request:proposal,normalizedRequest:s.request,plan:s.audit.plan,snapshot:m.snapshot});
}
// Exactly three cases cover native, FT and LP pagination end to end. Put a
// selected input on the next page: an implementation ignoring cursors fails.
for(const kind of ['add','sell','remove']){
  const s=structuredClone(input.cases.find(c=>c.kind===kind)),replies=structuredClone(s.replies),trace=[];
  const changed=[];
  for(const [path,reply]of Object.entries(s.replies))if(Array.isArray(reply.utxos)){
    replies[path]={utxos:[],next_cursor:'page/2+'};
    replies[path+'?after=page%2F2%2B']={utxos:reply.utxos};changed.push(path);
  }
  const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),
    accounts:{current:async()=>[account]},poolNative:o.keyless,now:()=>Date.parse(s.now),snapshotId:()=>s.snapshotId,
    fetch:async(url,init)=>{assert.equal(init?.method??'GET','GET');const u=new URL(url),path=u.pathname+u.search;trace.push(path);
      // URLSearchParams encodes '/', '+' exactly; spaces are not cursors here.
      assert(Object.hasOwn(replies,path),'Unexpected page '+path);
      return new Response(JSON.stringify({code:200,data:replies[path]}));}});
  const query={version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement:s.requirement};
  const snapshot=await network.chainData.resolve(query,account);
  assert.equal(hash(snapshot),hash(s.audit.material.snapshot),'paged snapshot '+kind);
  const coldTrace=[...trace];trace.length=0;
  const warm=await network.chainData.resolve(query,account);assert.equal(hash(warm),hash(snapshot));
  assert.equal(coldTrace.length,s.coldTrace.length+changed.length);
  assert.equal(trace.length,s.warmTrace.length+changed.length);
  assert.equal(coldTrace.length,new Set(coldTrace).size);
  paged.push({...s,name:s.name+'-paged',replies,coldTrace,warmTrace:[...trace]});
}
const report={status:'PREPARED_QUOTE_PAGED173_PASS',sourceFixtureSha256:sha(original),preparedCases:prepared.length,
  negativeChecks:refusals,quoteCases:quotes,pagedCases:paged.length,engineWasmSha256:o.wasmSha256,keylessWasmSha256:o.keylessWasmSha256,
  scope:'Source helpers, generated schema and mocked indexes only; not installed or real chain',liveHttp:0,broadcasts:0,prepared,cases:paged};
await writeFile(join(import.meta.dirname,'high-level173-extra.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...report,prepared:undefined,cases:undefined}));
