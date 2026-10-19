// New current-holder Reviewed fixtures from pinned wallet-build materials.
// Metadata is a controlled indexed hint whose complete Code is authenticated
// by frozen Rust; labels/decimal/balance fields are not an approval authority.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {base,frozenOracle,sha,address,publicKey} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[],provenance={};
execFileSync('npm',['install','--prefix',join(o.work,'package'),'--ignore-scripts','--omit=dev','--no-audit','--no-fund'],{stdio:'pipe'});
const dependencyLock=await readFile(join(o.work,'package/package-lock.json'));
const sources=[];
for(const [file,names]of [
 ['fungible-signing.json',['current-transfer-multiple-inputs','current-transfer-receivers','current-merge','current-merge-token-only']],
 ['stablecoin-signing.json',['current-coin-transfer','current-coin-receivers','current-coin-payment','current-coin-merge','current-coin-unknown-zero']],
]){
 const bytes=await readFile(join(base,'test/fixtures',file));provenance[file]=sha(bytes);
 for(const s of JSON.parse(bytes).cases.filter(s=>names.includes(s.name)))sources.push({file,s});
}
const navigation={webViewInstanceId:'fixture',sessionId:'review-fixture',navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',frame:'top',createdAt:'2026-10-13T00:00:00.123Z'};
for(const {file,s}of sources){
 const snapshot=s.audit.material.snapshot.payload,raw=s.audit.plan.payload.transactions[0].unsignedTransaction;
 assert.equal(s.audit.plan.payload.transactions.length,1);
 const tx=o.api.parseTbcTransaction(raw),rows=tx.inputs.map(p=>{const u=snapshot.utxos.find(u=>u.txid===p.txid&&u.vout===p.vout);assert(u);return u;});
 const all=new Map(snapshot.utxos.map(u=>[`${u.txid}:${u.vout}`,{txid:u.txid,index:String(u.vout),spent:false,value:u.satoshis,scriptPubKey:u.scriptPubKey,height:'1'}]));
 for(const p of snapshot.parents)o.api.parseTbcTransaction(p.rawTransaction).outputs.forEach((v,i)=>all.set(`${p.txid}:${i}`,{txid:p.txid,index:String(i),spent:false,value:String(v.satoshis),scriptPubKey:Buffer.from(v.scriptPubKey).toString('hex'),height:'1'}));
 const codes=JSON.parse(await o.keyless.execute('inspectTokenMaterial',JSON.stringify({phase:'inspectCodes',scripts:rows.map(u=>u.scriptPubKey)}))).codes;
 const replies={},id=s.request.intent.contractId,coin=s.name.startsWith('current-coin-'),family=coin?'stablecoin':'ft';
 for(const txid of new Set(rows.filter((_,i)=>codes[i]).map(u=>u.txid)))replies[`/api/tbc/${family}/decode/txid/${txid}`]={txid,contract_id:id,output:rows.filter((u,i)=>u.txid===txid&&codes[i]).map((u,i)=>({txid,vout:i%2?String(u.vout):u.vout})),balance:'999999999999999',decimal:99};
 const codeScript=rows.find((_,i)=>codes[i]).scriptPubKey;
 replies[coin?`/api/tbc/stablecoin/info/stablecoinid/${id}`:`/api/tbc/ft/info/contract/${id}`]={code_script:codeScript,...coin?{stablecoin_id:id}:{},symbol:'UNTRUSTED_LABEL_NOT_USED',decimal:99};
 const inputs=rows.map(u=>({satoshis:u.satoshis,scriptPubKey:u.scriptPubKey}));
 const forms=[{name:'raw-'+s.name,request:{payload:{format:'raw',transactions:[{rawTransaction:raw,inputs}]}}}];
 if(['current-transfer-multiple-inputs','current-coin-transfer'].includes(s.name)){
  const sourceInputs=rows.map((u,i)=>{
   if(!codes[i])return {txid:u.txid,outputIndex:u.vout,satoshis:u.satoshis,scriptPubKey:u.scriptPubKey,signingProfile:'p2pkh'};
   const previous=snapshot.parents.find(p=>p.txid===u.txid);assert(previous);
   const parent=o.api.parseTbcTransaction(previous.rawTransaction),tape=Buffer.from(parent.outputs[u.vout+1].scriptPubKey);
   assert.equal(tape.subarray(0,3).toString('hex'),'006a30');
   const dependencies=new Set();
   for(let lane=0;lane<6;lane++)if(tape.readBigUInt64LE(3+lane*8)!==0n){assert(parent.inputs[lane]);dependencies.add(parent.inputs[lane].txid);}
   const ancestors=[...dependencies].map(id=>{const p=snapshot.parents.find(p=>p.txid===id);assert(p);return p.rawTransaction;});assert(ancestors.length<=6);
   return {txid:u.txid,outputIndex:u.vout,satoshis:u.satoshis,scriptPubKey:u.scriptPubKey,signingProfile:codes[i].standardId,previousTransaction:previous.rawTransaction,ancestorTransactions:ancestors};
  });
  forms.push({name:'associated-'+s.name,request:{payload:{format:'associated',sourceTransaction:raw,sourceInputs,children:[]}}});
 }
 for(const form of forms){
  o.kit.assertValidTws('signReviewedTransactionRequest',{version:'1.0',chainId:'tbc:testnet',from:address,request:form.request});
  const reads=[],inspections=[];let defaultReview;
  const native={execute:async(method,json)=>{const input=JSON.parse(json),response=await o.keyless.execute(method,json);if(['inspectCodes','inspectPairs'].includes(input.phase))inspections.push({method,input,result:JSON.parse(response)});return response;}};
  const options={network:o.kit.createTbcNetworkContext({network:'testnet'}),materialNative:native,async fetch(url,init){
   const path=new URL(url).pathname;let data;
   if(path==='/api/tbc/txo/status'){
    assert.equal(init.method,'POST');const body=JSON.parse(init.body);reads.push({path,body});
    data={txos:body.txos.map(p=>{const v=all.get(`${p.txid}:${p.index}`);assert(v,'missing fixture status');return v;})};
   }else{reads.push({path});assert(Object.hasOwn(replies,path),'unavailable indexed hint '+path);data=replies[path];}
   const response=new Response(JSON.stringify({code:200,data}),{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:String(url)});return response;
  }};
  const wrap=r=>({review:async input=>(defaultReview=await r.review(input))});
  const account={address,accountId:'tbc:testnet:'+address,publicKey},networkSourceIdentity='frozen-current-reviewed';
  const capabilities=o.kit.createTbcStandardWorkflowCapabilities({navigation,chainId:'tbc:testnet',account,networkSourceIdentity,readCurrentAuthority:async()=>({...account,networkSourceIdentity}),
   rawReviewer:wrap(o.kit.createTbcDefaultRawTransactionReviewer(options)),associatedReviewer:wrap(o.kit.createTbcDefaultAssociatedTransactionReviewer(options)),materialNative:native,now:()=>navigation.createdAt,
   privateNative:{rawSigner:{sign(){throw Error('not used')}},associatedExecutor:{execute(){throw Error('not used')}},cryptoAdapter:{encrypt(){throw Error('not used')},decrypt(){throw Error('not used')}}}});
  const review=await capabilities.reviewedTransaction.review({version:'1.0',request:form.request,requestHash:o.kit.hashCanonical(form.request),origin:navigation.origin,sessionId:navigation.sessionId,chainId:'tbc:testnet',accountId:account.accountId,publicKey},{operation:'reviewedTransaction.review'});
  assert.equal(reads.filter(r=>r.path==='/api/tbc/txo/status').length,2);assert.equal(reads.length,4);
  cases.push({name:form.name,source:{file,name:s.name},request:form.request,material:o.kit.normalizeTbcReviewedTransactionMaterial(form.request),account:{chainId:'tbc:testnet',...account},defaultReview,review,statuses:[...all.values()],replies,reads,inspections});
 }
}
const nftBytes=await readFile(join(base,'test/fixtures/reviewed-material-b.json'));provenance['reviewed-material-b.json']=sha(nftBytes);
const nft=JSON.parse(nftBytes).cases.find(s=>s.name==='raw-current-nft-mint-output'),request=nft.material.request,tx=o.api.parseTbcTransaction(request.txraws[0]);
const primary=tx.inputs.map((p,i)=>({txid:p.txid,vout:p.vout,satoshis:String(request.utxos_satoshis[0][i]),scriptPubKey:request.script_pubkeys[0][i]}));
const tape=nft.resolvedOutputs.find(p=>p.txid===tx.inputs[0].txid&&p.vout===tx.inputs[0].vout+2);assert(tape);
const nftDiagnostic=[];
for(const [name,outputs]of [['primary-only',primary],['primary-plus-tape',[...primary,tape]],['all-authenticated-material',nft.resolvedOutputs]]){
 const input={phase:'checkHistoricalIssuance',transactions:request.txraws.map(rawTransaction=>({rawTransaction})),resolvedOutputs:outputs};
 try{nftDiagnostic.push({name,input,result:JSON.parse(await o.keyless.execute('inspectTokenMaterial',JSON.stringify(input)))});}
 catch(e){nftDiagnostic.push({name,input,refusal:String(e.message)});}
}
const report={status:'FROZEN_REVIEWED_CURRENT_HOLDER_ORACLE',archiveSha256:o.archiveSha256,provenance,dependencyLockSha256:sha(dependencyLock),cases,nftDiagnostic,networkHttp:0,broadcasts:0,
 proof:'Frozen public current-holder review, exact Code/Tape/metadata identity and controlled reads. This is not live API, native custody or broadcast evidence.'};
await writeFile(join(base,'test/fixtures/reviewed-current.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
await writeFile(join(base,'test/fixtures/reviewed-current-dependency-lock.json'),dependencyLock,{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,nftDiagnostic:nftDiagnostic.map(s=>({name:s.name,accepted:!!s.result,refusal:s.refusal}))}));
