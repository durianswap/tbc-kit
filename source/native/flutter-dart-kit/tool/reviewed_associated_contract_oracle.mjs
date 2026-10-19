// Frozen associated contract proofs using public synthetic fixtures only.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {base,frozenOracle,sha,publicKey,account} from './frozen_oracle.mjs';
const o=await frozenOracle(),provenance={},cases=[];
execFileSync('npm',['install','--prefix',join(o.work,'package'),'--ignore-scripts','--omit=dev','--no-audit','--no-fund'],{stdio:'pipe'});
const lock=await readFile(join(o.work,'package/package-lock.json'));
const navigation={webViewInstanceId:'fixture',sessionId:'review-fixture',navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',frame:'top',createdAt:'2026-10-13T00:00:00.123Z'};
const prefix='097369676e617475726521'+publicKey;
for(const [sourceFile,reviewFile]of [['htlc-token-signing.json','reviewed-htlc-token.json'],['lop-signing.json','reviewed-lop.json']]){
 const sourceBytes=await readFile(join(base,'test/fixtures',sourceFile)),reviewBytes=await readFile(join(base,'test/fixtures',reviewFile));
 provenance[sourceFile]=sha(sourceBytes);provenance[reviewFile]=sha(reviewBytes);
 const raws=JSON.parse(reviewBytes).cases;
 for(const s of JSON.parse(sourceBytes).cases){
  const raw=raws.find(c=>c.name==='raw-'+s.name);assert(raw);
  const snapshot=s.audit.material.snapshot.payload,tx=o.api.parseTbcTransaction(raw.request.payload.transactions[0].rawTransaction);
  const rows=tx.inputs.map(p=>{const u=snapshot.utxos.find(u=>u.txid===p.txid&&u.vout===p.vout);assert(u);return u;});
  const codes=JSON.parse(await o.keyless.execute('inspectTokenMaterial',JSON.stringify({phase:'inspectCodes',scripts:rows.map(r=>r.scriptPubKey)}))).codes;
  const orders=JSON.parse(await o.keyless.execute('inspectLopMaterial',JSON.stringify({phase:'inspectOrderScripts',scripts:rows.map(r=>r.scriptPubKey)}))).orders;
  const sourceInputs=rows.map((u,i)=>{
   const input={txid:u.txid,outputIndex:u.vout,satoshis:u.satoshis,scriptPubKey:u.scriptPubKey};
   if(codes[i]){
    const previous=snapshot.parents.find(p=>p.txid===u.txid);assert(previous);
    const parent=o.api.parseTbcTransaction(previous.rawTransaction),tape=Buffer.from(parent.outputs[u.vout+1].scriptPubKey);
    assert.equal(tape.subarray(0,3).toString('hex'),'006a30');
    const dependencies=new Set();for(let lane=0;lane<6;lane++)if(tape.readBigUInt64LE(3+lane*8)!==0n){assert(parent.inputs[lane]);dependencies.add(parent.inputs[lane].txid);}
    const ancestors=[...dependencies].map(id=>{const p=snapshot.parents.find(p=>p.txid===id);assert(p);return p.rawTransaction;});
    return {...input,signingProfile:codes[i].standardId,previousTransaction:previous.rawTransaction,ancestorTransactions:ancestors};
   }
   if(orders[i]){
    const parent=snapshot.parents.find(p=>p.txid===u.txid);assert(parent);
    return {...input,previousTransaction:parent.rawTransaction,...s.request.intent.type==='tbc-lop-match'?
      {signingProfile:'tbc-lop-match'}:{signingProfile:'contract-template',unlockingScriptTemplate:prefix+'52'}};
   }
   if(u.scriptPubKey.length===274){
    const claim=s.request.intent.type==='tbc-htlc-claim',secret=s.request.intent.preimage;
    assert(!claim||(typeof secret==='string'&&secret.length===64));
    return {...input,signingProfile:'contract-template',unlockingScriptTemplate:prefix+(claim?'20'+secret+'51':'00')};
   }
   assert(/^76a914[0-9a-f]{40}88ac$/.test(u.scriptPubKey));return {...input,signingProfile:'p2pkh'};
  });
  const request={payload:{format:'associated',sourceTransaction:raw.request.payload.transactions[0].rawTransaction,sourceInputs,children:[]}},reads=[];
  const options={network:o.kit.createTbcNetworkContext({network:'testnet'}),materialNative:o.keyless,async fetch(url,init){
   const path=new URL(url).pathname;let data;
   if(path==='/api/tbc/txo/status'){assert.equal(init.method,'POST');const body=JSON.parse(init.body);reads.push({path,body});data={txos:body.txos.map(p=>{const r=raw.statuses.find(r=>r.txid===p.txid&&r.index===String(p.index));assert(r);return r;})};}
   else{reads.push({path});assert(Object.hasOwn(raw.replies,path),'missing controlled reply');data=raw.replies[path];}
   const response=new Response(JSON.stringify({code:200,data}),{status:200,headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:String(url)});return response;
  }};
  let defaultReview,review,refusal,stageFailure;const stages=[],networkSourceIdentity='frozen-associated-contract',wrap=r=>({review:async input=>(defaultReview=await r.review(input))});
  const caps=o.kit.createTbcStandardWorkflowCapabilities({navigation,chainId:'tbc:testnet',account,networkSourceIdentity,
   readCurrentAuthority:async()=>({...account,networkSourceIdentity}),rawReviewer:wrap(o.kit.createTbcDefaultRawTransactionReviewer(options)),associatedReviewer:wrap(o.kit.createTbcDefaultAssociatedTransactionReviewer(options)),materialNative:o.keyless,now:()=>navigation.createdAt,
   privateNative:{rawSigner:{sign(){throw Error('unused')}},associatedExecutor:{execute(){throw Error('unused')}},cryptoAdapter:{encrypt(){throw Error('unused')},decrypt(){throw Error('unused')}}}});
  const material=o.kit.normalizeTbcReviewedTransactionMaterial(request);
  try{review=await caps.reviewedTransaction.review({version:'1.0',request,requestHash:o.kit.hashCanonical(request),origin:navigation.origin,sessionId:navigation.sessionId,chainId:'tbc:testnet',accountId:account.accountId,publicKey},{operation:'reviewedTransaction.review'});}
  catch(e){refusal=String(e.message).replace(/[0-9a-fA-F]{32,}/g,'[hex]').slice(0,256);}
  if(review){
   const previousTransactions=[];
   try{for(let i=0;i<1+material.request.inputs.length;i++){
    const stage=JSON.parse(await o.keyless.execute('prepareReviewedStage',JSON.stringify({format:'associated',request:material.request,publicKey,transactionIndex:i,previousTransactions,resolvedOutputs:defaultReview.policyMaterial.resolvedOutputs})));
    assert(Array.isArray(stage.digests),'stage did not provide digests');
    const signatures=stage.digests.map(d=>secp256k1.sign(d,1n,{lowS:true,prehash:false}).toCompactHex());
    const finalized=JSON.parse(await o.keyless.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
    assert(typeof finalized.txraw==='string','finalize did not provide transaction');stages.push({stage,signatures,finalized});previousTransactions.push(finalized.txraw);
   }}catch(e){stageFailure=String(e.message).replace(/[0-9a-fA-F]{32,}/g,'[hex]').slice(0,256);}
  }
  const secret=s.request.intent.preimage;
  if(secret&&review)assert(!JSON.stringify(review).includes(secret));
  cases.push({name:'associated-'+s.name,source:{file:sourceFile,name:s.name},request,material,account,statuses:raw.statuses,replies:raw.replies,reads,
   ...review?{defaultReview,review,stages,...stageFailure?{stageFailure}:{}}:{refusal}});
 }
}
const report={status:'FROZEN_ASSOCIATED_CONTRACT_ORACLE',archiveSha256:o.archiveSha256,provenance,dependencyLockSha256:sha(lock),cases,
 publicSyntheticScalar:1,publicFixtureSecretsOnly:true,networkHttp:0,broadcasts:0};
await writeFile(join(base,'test/fixtures/reviewed-associated-contract.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
await writeFile(join(base,'test/fixtures/reviewed-associated-contract-dependency-lock.json'),lock,{flag:'wx'});
console.log(JSON.stringify({cases:cases.map(s=>({name:s.name,accepted:!!s.review,stages:s.stages?.length,refusal:s.refusal,stageFailure:s.stageFailure})),networkHttp:0}));
