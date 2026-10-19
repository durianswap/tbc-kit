// Capture frozen, authenticated review output separately from the wire mapper.
// Only public fixtures/controlled status replies. No wallet key or node access.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {base,frozenOracle,sha,address,publicKey} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[],refusals=[],provenance={};
execFileSync('npm',['install','--prefix',join(o.work,'package'),'--ignore-scripts','--omit=dev','--no-audit','--no-fund'],{stdio:'pipe'});
const lock=await readFile(join(o.work,'package/package-lock.json'));
const materialBytes=await readFile(join(base,'test/fixtures/reviewed-material-b.json'));
provenance['reviewed-material-b.json']=sha(materialBytes);
const samples=JSON.parse(materialBytes).cases.filter(s=>s.stages).map(s=>({...s}));
const sources=new Map();
async function load(file){
 if(sources.has(file))return sources.get(file);
 const bytes=await readFile(join(base,'test/fixtures',file));provenance[file]=sha(bytes);
 const value=JSON.parse(bytes);sources.set(file,value);return value;
}
for(const [file,names]of [
 ['timelock-signing.json',['timelock-lock-default','timelock-lock-multiple','timelock-unlock-one']],
 ['htlc-native-signing.json',['htlc-native-lock-time','htlc-native-claim-before-refund-height','htlc-native-refund-height-equality']],
])for(const s of (await load(file)).cases.filter(s=>names.includes(s.name))){
 const transaction=s.audit.plan.payload.transactions[0];assert.equal(s.audit.plan.payload.transactions.length,1);
 const tx=o.api.parseTbcTransaction(transaction.unsignedTransaction),snap=s.audit.material.snapshot.payload;
 const inputs=tx.inputs.map(p=>{const u=snap.utxos.find(u=>u.txid===p.txid&&u.vout===p.vout);assert(u);return {satoshis:u.satoshis,scriptPubKey:u.scriptPubKey};});
 const outputs=new Map(snap.utxos.map(u=>[`${u.txid}:${u.vout}`,{txid:u.txid,vout:u.vout,satoshis:u.satoshis,scriptPubKey:u.scriptPubKey}]));
 for(const p of snap.parents)o.api.parseTbcTransaction(p.rawTransaction).outputs.forEach((v,vout)=>outputs.set(`${p.txid}:${vout}`,{txid:p.txid,vout,satoshis:String(v.satoshis),scriptPubKey:Buffer.from(v.scriptPubKey).toString('hex')}));
 samples.push({name:'raw-'+s.name,request:{payload:{format:'raw',transactions:[{rawTransaction:transaction.unsignedTransaction,inputs}]}},resolvedOutputs:[...outputs.values()],source:{file,name:s.name}});
}
// Include transfers to a different owner; the existing native seed is self-only.
for(const [name,scripts]of [
 ['external-recipient',['22'.repeat(20)]],['two-external-recipients',['22'.repeat(20),'33'.repeat(20)]],
]){
 const s=structuredClone(samples.find(s=>s.name==='raw-transfer-single'));
 let raw=s.request.payload.transactions[0].rawTransaction,at=0;
 for(const pkh of scripts){const old='76a914751e76e8199196d454941c45d1b3a323f1433bd688ac',i=raw.indexOf(old,at);assert(i>=0);raw=raw.slice(0,i)+'76a914'+pkh+'88ac'+raw.slice(i+old.length);at=i+old.length;}
 s.name='raw-'+name;s.request.payload.transactions[0].rawTransaction=raw;delete s.stages;delete s.review;samples.push(s);
}
const navigation={webViewInstanceId:'fixture',sessionId:'review-fixture',navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',frame:'top',createdAt:'2026-10-13T00:00:00.123Z'};
for(const sample of samples){
 const material=o.kit.normalizeTbcReviewedTransactionMaterial(sample.request);
 const reads=[],all=new Map((sample.resolvedOutputs??[]).map(p=>[`${p.txid}:${p.vout}`,{txid:p.txid,index:String(p.vout),spent:false,value:p.satoshis,scriptPubKey:p.scriptPubKey,height:'1'}]));
 if(material.format==='raw')material.request.txraws.forEach((raw,n)=>o.api.parseTbcTransaction(raw).inputs.forEach((p,i)=>all.set(`${p.txid}:${p.vout}`,{txid:p.txid,index:String(p.vout),spent:false,value:String(material.request.utxos_satoshis[n][i]),scriptPubKey:material.request.script_pubkeys[n][i],height:'1'})));
 else for(const input of [material.request.sourceUtxos,...material.request.inputs].flat())if(input.txId)all.set(`${input.txId}:${input.outputIndex}`,{txid:input.txId,index:String(input.outputIndex),spent:false,value:String(input.satoshis),scriptPubKey:input.script,height:'1'});
 const source=sample.source?(await load(sample.source.file)).cases.find(s=>s.name===sample.source.name):undefined;
 const options={network:o.kit.createTbcNetworkContext({network:'testnet'}),materialNative:o.keyless,async fetch(url,init){
  const path=new URL(url).pathname;let data;
  if(path==='/api/tbc/txo/status'){
   assert.equal(init.method,'POST');const body=JSON.parse(init.body);reads.push({path,body});
   data={txos:body.txos.map(p=>{const v=all.get(`${p.txid}:${p.index}`);assert(v,'unavailable controlled status');return v;})};
  }else{reads.push({path});assert(Object.hasOwn(source?.replies??{},path),'unavailable controlled read: '+path);data=source.replies[path];}
  const response=new Response(JSON.stringify({code:200,data}),{status:200,headers:{'content-type':'application/json'}});
  Object.defineProperty(response,'url',{value:String(url)});return response;
 }};
 let defaultReview;
 const raw=o.kit.createTbcDefaultRawTransactionReviewer(options),associated=o.kit.createTbcDefaultAssociatedTransactionReviewer(options);
 const wrap=reviewer=>({review:async input=>(defaultReview=await reviewer.review(input))});
 const account={address,accountId:`tbc:testnet:${address}`,publicKey},networkSourceIdentity='frozen-reviewed-preview';
 const capability=o.kit.createTbcStandardWorkflowCapabilities({navigation,chainId:'tbc:testnet',account,networkSourceIdentity,
  readCurrentAuthority:async()=>({...account,networkSourceIdentity}),rawReviewer:wrap(raw),associatedReviewer:wrap(associated),materialNative:o.keyless,now:()=>navigation.createdAt,
  privateNative:{rawSigner:{sign(){throw Error('not used')}},associatedExecutor:{execute(){throw Error('not used')}},cryptoAdapter:{encrypt(){throw Error('not used')},decrypt(){throw Error('not used')}}}});
 try{
  const review=await capability.reviewedTransaction.review({version:'1.0',request:sample.request,requestHash:o.kit.hashCanonical(sample.request),origin:navigation.origin,sessionId:navigation.sessionId,chainId:'tbc:testnet',accountId:account.accountId,publicKey},{operation:'reviewedTransaction.review'});
  assert(defaultReview);cases.push({name:sample.name,request:sample.request,material,defaultReview,review,reads,statuses:[...all.values()]});
 }catch(e){refusals.push({name:sample.name,message:e.message,reads});}
}
const report={status:'FROZEN_REVIEWED_PREVIEW_ORACLE',archiveSha256:o.archiveSha256,provenance,dependencyLockSha256:sha(lock),cases,refusals,networkHttp:0,broadcasts:0,
 proof:'Frozen trusted-review and Standard preview/hash outputs with controlled authenticated fixture data. Refusals are not passed capabilities. Dart decoding/custody/chain support requires separate proof.'};
await writeFile(join(base,'test/fixtures/reviewed-preview.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
await writeFile(join(base,'test/fixtures/reviewed-preview-dependency-lock.json'),lock,{flag:'wx'});
console.log(JSON.stringify({accepted:cases.map(s=>({name:s.name,queries:s.reads.length,flows:s.review.payload.preview.assetFlows.length})),refusals}));
