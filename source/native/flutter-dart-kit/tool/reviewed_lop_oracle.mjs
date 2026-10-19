// Read-only frozen LOP reviews of public offline builder vectors.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {base,frozenOracle,sha,address,publicKey,account} from './frozen_oracle.mjs';
const o=await frozenOracle(),file='lop-signing.json',bytes=await readFile(join(base,'test/fixtures',file)),cases=[];
execFileSync('npm',['install','--prefix',join(o.work,'package'),'--ignore-scripts','--omit=dev','--no-audit','--no-fund'],{stdio:'pipe'});
const lock=await readFile(join(o.work,'package/package-lock.json'));
const navigation={webViewInstanceId:'fixture',sessionId:'review-fixture',navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',frame:'top',createdAt:'2026-10-13T00:00:00.123Z'};
for(const s of JSON.parse(bytes).cases){
 const snapshot=s.audit.material.snapshot.payload,raw=s.audit.plan.payload.transactions[0].unsignedTransaction;
 assert.equal(s.audit.plan.payload.transactions.length,1);
 const tx=o.api.parseTbcTransaction(raw),rows=tx.inputs.map(p=>{const u=snapshot.utxos.find(u=>u.txid===p.txid&&u.vout===p.vout);assert(u);return u;});
 const all=new Map(snapshot.utxos.map(u=>[`${u.txid}:${u.vout}`,{txid:u.txid,index:String(u.vout),spent:false,value:u.satoshis,scriptPubKey:u.scriptPubKey,height:'1'}]));
 for(const p of snapshot.parents)o.api.parseTbcTransaction(p.rawTransaction).outputs.forEach((v,i)=>all.set(`${p.txid}:${i}`,{txid:p.txid,index:String(i),spent:false,value:String(v.satoshis),scriptPubKey:Buffer.from(v.scriptPubKey).toString('hex'),height:'1'}));
 const scripts=[...new Set([...all.values()].map(v=>v.scriptPubKey).concat(tx.outputs.map(v=>Buffer.from(v.scriptPubKey).toString('hex'))))];
 const decoded=JSON.parse(await o.keyless.execute('inspectTokenMaterial',JSON.stringify({phase:'inspectCodes',scripts}))).codes;
 const orderScripts=[...rows.map(u=>u.scriptPubKey),...tx.outputs.map(v=>Buffer.from(v.scriptPubKey).toString('hex'))];
 const orders=JSON.parse(await o.keyless.execute('inspectLopMaterial',JSON.stringify({phase:'inspectOrderScripts',scripts:orderScripts})));
 const replies={};
 for(const order of orders.orders.filter(Boolean))for(const asset of [order.baseAsset,order.quoteAsset]){
  if(asset.kind!=='token')continue;
  const i=decoded.findIndex(c=>c?.codeIdentity.startsWith(asset.partialHash));
  // A native-sell order may not supply the unrelated quote Code; the frozen
  // native-only review does not fetch or claim that token's identity.
  if(i<0)continue;
  const coin=decoded[i].standardId==='tbc20-stablecoin',id=asset.contractId;
  replies[coin?`/api/tbc/stablecoin/info/stablecoinid/${id}`:`/api/tbc/ft/info/contract/${id}`]={code_script:scripts[i],...coin?{stablecoin_id:id}:{},symbol:'UNTRUSTED',decimal:99};
 }
 const request={payload:{format:'raw',transactions:[{rawTransaction:raw,inputs:rows.map(u=>({satoshis:u.satoshis,scriptPubKey:u.scriptPubKey}))}]}},reads=[];
 let defaultReview,review,refusal;
 const options={network:o.kit.createTbcNetworkContext({network:'testnet'}),materialNative:o.keyless,async fetch(url,init){
  const path=new URL(url).pathname;let data;
  if(path==='/api/tbc/txo/status'){
   assert.equal(init.method,'POST');const body=JSON.parse(init.body);reads.push({path,body});
   data={txos:body.txos.map(p=>{const v=all.get(`${p.txid}:${p.index}`);assert(v,'missing fixture status');return v;})};
  }else{reads.push({path});assert(Object.hasOwn(replies,path),'unavailable indexed hint '+path);data=replies[path];}
  const response=new Response(JSON.stringify({code:200,data}),{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:String(url)});return response;
 }};
 const wrap=r=>({review:async input=>(defaultReview=await r.review(input))}),networkSourceIdentity='frozen-reviewed-lop';
 const caps=o.kit.createTbcStandardWorkflowCapabilities({navigation,chainId:'tbc:testnet',account,networkSourceIdentity,
  readCurrentAuthority:async()=>({...account,networkSourceIdentity}),rawReviewer:wrap(o.kit.createTbcDefaultRawTransactionReviewer(options)),
  associatedReviewer:wrap(o.kit.createTbcDefaultAssociatedTransactionReviewer(options)),materialNative:o.keyless,now:()=>navigation.createdAt,
  privateNative:{rawSigner:{sign(){throw Error('unused')}},associatedExecutor:{execute(){throw Error('unused')}},cryptoAdapter:{encrypt(){throw Error('unused')},decrypt(){throw Error('unused')}}}});
 try{review=await caps.reviewedTransaction.review({version:'1.0',request,requestHash:o.kit.hashCanonical(request),origin:navigation.origin,sessionId:navigation.sessionId,chainId:'tbc:testnet',accountId:account.accountId,publicKey},{operation:'reviewedTransaction.review'});}
 catch(e){refusal=String(e.message);}
 cases.push({name:'raw-'+s.name,request,account,material:o.kit.normalizeTbcReviewedTransactionMaterial(request),statuses:[...all.values()],replies,reads,orders,...review?{defaultReview,review}:{refusal}});
}
const report={status:'FROZEN_REVIEWED_LOP_ORACLE',archiveSha256:o.archiveSha256,provenance:{[file]:sha(bytes)},dependencyLockSha256:sha(lock),cases,networkHttp:0,broadcasts:0};
await writeFile(join(base,'test/fixtures/reviewed-lop.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
await writeFile(join(base,'test/fixtures/reviewed-lop-dependency-lock.json'),lock,{flag:'wx'});
console.log(JSON.stringify({cases:cases.map(s=>({name:s.name,accepted:!!s.review,reads:s.reads.length,refusal:s.refusal})),networkHttp:0}));
