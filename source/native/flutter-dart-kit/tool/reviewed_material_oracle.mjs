// Frozen public Reviewed normalization and keyless prepare/finalize evidence.
// This is not a replacement reviewer or an approval/signing adapter.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {execFileSync} from 'node:child_process';
import {base,frozenOracle,sha,publicKey,address} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[],provenance={};
// This frozen package externalizes parser dependencies. Install exactly its
// declared manifest into this disposable extraction, never the source tree.
execFileSync('npm',['install','--prefix',join(o.work,'package'),'--ignore-scripts','--omit=dev','--no-audit','--no-fund'],{stdio:'pipe'});
const dependencyLockSha256=sha(await readFile(join(o.work,'package/package-lock.json')));
const checkRequest=request=>o.kit.assertValidTws('signReviewedTransactionRequest',{version:'1.0',chainId:'tbc:testnet',from:address,request});
const rawInputs=[];
for(const [file,names]of [
 ['native-signing.json',['transfer-single','transfer-multiple','merge-two']],
 ['fungible-signing.json',['current-transfer-multiple-inputs','historical-transfer']],
 ['nft-signing.json',['current-nft-mint-output','historical-nft-v2']],
 ['stablecoin-signing.json',['current-coin-transfer']],
 ['htlc-native-signing.json',['htlc-native-lock-height']],
]){
 const bytes=await readFile(join(base,'test/fixtures',file));provenance[file]=sha(bytes);
 for(const s of JSON.parse(bytes).cases.filter(s=>names.includes(s.name))){
  assert.equal(s.audit.plan.payload.transactions.length,1);
  const raw=s.audit.plan.payload.transactions[0].unsignedTransaction;
  const tx=o.api.parseTbcTransaction(raw),utxos=s.audit.material.snapshot.payload.utxos;
  const inputs=tx.inputs.map(p=>{const u=utxos.find(u=>u.txid===p.txid&&u.vout===p.vout);assert(u,s.name);return {satoshis:u.satoshis,scriptPubKey:u.scriptPubKey};});
  const outputs=new Map(utxos.map(u=>[`${u.txid}:${u.vout}`,{txid:u.txid,vout:u.vout,satoshis:u.satoshis,scriptPubKey:u.scriptPubKey}]));
  for(const p of s.audit.material.snapshot.payload.parents) o.api.parseTbcTransaction(p.rawTransaction).outputs.forEach((v,vout)=>outputs.set(`${p.txid}:${vout}`,{txid:p.txid,vout,satoshis:String(v.satoshis),scriptPubKey:Buffer.from(v.scriptPubKey).toString('hex')}));
  rawInputs.push({name:s.name,request:{payload:{format:'raw',transactions:[{rawTransaction:raw,inputs}]}},source:{file,name:s.name},tx,utxos,resolvedOutputs:[...outputs.values()]});
 }
}
async function add(name,request,{source,execution=true,resolvedOutputs=[]}={}){
 checkRequest(request);
 const material=o.kit.normalizeTbcReviewedTransactionMaterial(request);
 const row={name,request,material,resolvedOutputs,...source?{source}:{}};
 if(execution){
  const count=material.format==='raw'?material.request.txraws.length:material.request.inputs.length+1;
  const previousTransactions=[],stages=[];
  try{
   for(let i=0;i<count;i++){
    const stage=JSON.parse(await o.keyless.execute('prepareReviewedStage',JSON.stringify({format:material.format,request:material.request,publicKey,transactionIndex:i,previousTransactions:material.format==='raw'?[]:previousTransactions,resolvedOutputs})));
    const signatures=stage.digests.map(d=>secp256k1.sign(d,1n,{lowS:true,prehash:false}).toCompactHex());
    const finalized=JSON.parse(await o.keyless.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
    assert.equal(typeof finalized.txraw,'string');
    stages.push({stage,signatures,finalized});previousTransactions.push(finalized.txraw);
   }
   row.stages=stages;
  }catch(e){row.keylessRefusal={name:e.name,message:e.message};}
 }
 cases.push(row);return row;
}
for(const s of rawInputs)await add('raw-'+s.name,s.request,{source:s.source,resolvedOutputs:s.resolvedOutputs});
const independent=structuredClone(rawInputs[0].request.payload.transactions[0]);
independent.rawTransaction=independent.rawTransaction.slice(0,10)+'55'.repeat(32)+independent.rawTransaction.slice(74);
await add('raw-two-independent',{payload:{format:'raw',transactions:[rawInputs[0].request.payload.transactions[0],independent]}});
const native=rawInputs[0],sourceInputs=native.tx.inputs.map((p,i)=>({txid:p.txid,outputIndex:p.vout,...native.request.payload.transactions[0].inputs[i],signingProfile:'p2pkh'}));
const sourceTransaction=native.request.payload.transactions[0].rawTransaction,script=sourceInputs[0].scriptPubKey;
const source={sourceTransaction,sourceInputs,format:'associated'};
await add('associated-source-only',{payload:{...source,children:[]}});
const children=[{inputs:[{outputIndex:1,signingProfile:'p2pkh'}],outputs:[{satoshis:'1000',scriptPubKey:script},{satoshis:'17000',scriptPubKey:script}]},
 {inputs:[{outputIndex:0,signingProfile:'p2pkh'},{outputIndex:1,signingProfile:'p2pkh'}],outputs:[{satoshis:'17800',scriptPubKey:script}]}];
await add('associated-two-dependent',{payload:{...source,children}});
await add('associated-explicit-and-local',{payload:{...source,children:[{inputs:[{outputIndex:1,signingProfile:'p2pkh'},
 {txid:'33'.repeat(32),outputIndex:2,satoshis:'1000',scriptPubKey:script,signingProfile:'p2pkh'}],outputs:[{satoshis:'18000',scriptPubKey:script}]}]}});
// Wire/profile normalization only: these do NOT claim matching contract proofs.
for(const signingProfile of ['ft','ft-contract','contract-template','tbc-lop-match','tbc20-standard','tbc20-stablecoin']){
 const current=signingProfile.startsWith('tbc20-');
 await add('mapping-'+signingProfile,{payload:{...source,sourceInputs:[{...sourceInputs[0],signingProfile,
  previousTransaction:sourceTransaction,...current?{ancestorTransactions:[]}:{previousOutputContext:'00',contractTransaction:'00',contractVersion:2,unlockingScriptTemplate:'00'}}],children:[]}}, {execution:false});
}
// Capture the real frozen review/fee result for independent native raw and
// associated requests. This uses exactly one batched status read, never a node.
for(const sample of cases.filter(s=>['raw-transfer-single','raw-transfer-multiple','raw-merge-two','associated-source-only','associated-two-dependent','associated-explicit-and-local'].includes(s.name))){
 const reads=[],statuses=[];
 if(sample.material.format==='raw')sample.material.request.txraws.forEach((raw,n)=>o.api.parseTbcTransaction(raw).inputs.forEach((p,i)=>statuses.push({txid:p.txid,index:String(p.vout),spent:false,value:String(sample.material.request.utxos_satoshis[n][i]),scriptPubKey:sample.material.request.script_pubkeys[n][i],height:'1'})));
 else for(const input of [sample.material.request.sourceUtxos,...sample.material.request.inputs].flat())if(input.txId)statuses.push({txid:input.txId,index:String(input.outputIndex),spent:false,value:String(input.satoshis),scriptPubKey:input.script,height:'1'});
 const options={network:o.kit.createTbcNetworkContext({network:'testnet'}),materialNative:o.keyless,async fetch(url,init){
  assert.equal(new URL(url).pathname,'/api/tbc/txo/status');assert.equal(init.method,'POST');
  const body=JSON.parse(init.body);reads.push(body);
  const txos=body.txos.map(p=>{const row=statuses.find(r=>r.txid===p.txid&&Number(r.index)===p.index);assert(row,'unexpected status');return row;});
  const response=new Response(JSON.stringify({code:200,data:{txos}}),{status:200,headers:{'content-type':'application/json'}});
  Object.defineProperty(response,'url',{value:String(url)});return response;
 }};
 const navigation={webViewInstanceId:'fixture',sessionId:'review-fixture',navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',frame:'top',createdAt:'2026-10-13T00:00:00.123Z'};
 const account={address,accountId:`tbc:testnet:${address}`,publicKey},networkSourceIdentity='frozen-reviewed-material';
 const capabilities=o.kit.createTbcStandardWorkflowCapabilities({navigation,chainId:'tbc:testnet',account,networkSourceIdentity,
  readCurrentAuthority:async()=>({...account,networkSourceIdentity}),rawReviewer:o.kit.createTbcDefaultRawTransactionReviewer(options),associatedReviewer:o.kit.createTbcDefaultAssociatedTransactionReviewer(options),materialNative:o.keyless,
  now:()=>navigation.createdAt,privateNative:{rawSigner:{sign(){throw Error('not used')}},associatedExecutor:{execute(){throw Error('not used')}},cryptoAdapter:{encrypt(){throw Error('not used')},decrypt(){throw Error('not used')}}}});
 sample.review=await capabilities.reviewedTransaction.review({version:'1.0',request:sample.request,requestHash:o.kit.hashCanonical(sample.request),origin:navigation.origin,sessionId:navigation.sessionId,chainId:'tbc:testnet',accountId:account.accountId,publicKey},{operation:'reviewedTransaction.review'});
 sample.statuses=statuses;sample.statusQueries=reads;assert.equal(reads.length,1,sample.name);
}
const invalid=[];
for(const [name,change]of [
 ['unknown-payload-field',r=>r.payload.extra=true],['empty-transactions',r=>r.payload.transactions=[]],
 ['number-amount',r=>r.payload.transactions[0].inputs[0].satoshis=1000],['negative-amount',r=>r.payload.transactions[0].inputs[0].satoshis='-1'],
 ['signing-key-override',r=>r.payload.transactions[0].inputs[0].signingPublicKey=publicKey],
 ['extra-root-field',r=>r.secret='public-negative-marker'],
]){const request=structuredClone(rawInputs[0].request);change(request);assert.throws(()=>checkRequest(request));invalid.push({name,request});}
const report={status:'FROZEN_REVIEWED_MATERIAL_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,dependencyLockSha256,publicSyntheticScalars:[1],provenance,cases,invalid,networkHttp:0,broadcasts:0,
 proof:'Frozen public normalization and keyless WASM prepare/finalize with public fixture signatures. Six frozen default reviewer/Standard review artifacts use controlled TXO status. Mapping-only and keyless-refused cases are not signing support; no native custody or device claim.'};
await writeFile(join(base,'test/fixtures/reviewed-material-b.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,keylessAccepted:cases.filter(s=>s.stages).length,keylessRefused:cases.filter(s=>s.keylessRefusal).map(s=>({case:s.name,...s.keylessRefusal})),reviewCases:cases.filter(s=>s.review).length,invalid:invalid.length}));
