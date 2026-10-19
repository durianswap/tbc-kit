// Public synthetic HTLC witnesses only. Never read a wallet or real preimage.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {base,frozenOracle,sha,address,publicKey,account} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[],provenance={};
execFileSync('npm',['install','--prefix',join(o.work,'package'),'--ignore-scripts','--omit=dev','--no-audit','--no-fund'],{stdio:'pipe'});
const lock=await readFile(join(o.work,'package/package-lock.json'));
const bytes=await readFile(join(base,'test/fixtures/htlc-native-signing.json'));
provenance['htlc-native-signing.json']=sha(bytes);
const old=JSON.parse(bytes).cases,forms=[],prefix='097369676e617475726521'+publicKey;
function source(s){
 const snapshot=s.audit.material.snapshot.payload,raw=s.audit.plan.payload.transactions[0].unsignedTransaction,tx=o.api.parseTbcTransaction(raw),
   rows=tx.inputs.map(p=>{const u=snapshot.utxos.find(u=>u.txid===p.txid&&u.vout===p.vout);assert(u);return u;});
 return {snapshot,raw,tx,rows};
}
for(const name of ['htlc-native-claim-before-refund-height','htlc-native-claim-after-refund-time','htlc-native-refund-height-equality','htlc-native-refund-time']){
 const s=old.find(s=>s.name===name),p=source(s),claim=name.includes('-claim-');
 const secret=claim?s.request.intent.preimage:null;
 assert(!claim||(typeof secret==='string'&&secret.length===64));
 const template=prefix+(claim?'20'+secret+'51':'00');
 forms.push({name:'associated-'+name,request:{payload:{format:'associated',sourceTransaction:p.raw,
  sourceInputs:p.rows.map(u=>({txid:u.txid,outputIndex:u.vout,satoshis:u.satoshis,scriptPubKey:u.scriptPubKey,
    signingProfile:'contract-template',unlockingScriptTemplate:template})),children:[]}},rows:p.rows,
    witnessCheck:{script:p.rows[0].scriptPubKey,template,accountAddress:address,sequence:p.tx.inputs[0].sequence,
      transactionLockTime:p.tx.locktime},publicFixturePreimage:secret});
}
{
 const s=old.find(s=>s.name==='htlc-native-lock-height'),p=source(s),output=p.tx.outputs[0];
 assert.equal(output.scriptPubKey.length,137);
 forms.push({name:'associated-native-lock-then-refund',rows:p.rows,request:{payload:{format:'associated',
  sourceTransaction:p.raw,sourceInputs:p.rows.map(u=>({txid:u.txid,outputIndex:u.vout,satoshis:u.satoshis,scriptPubKey:u.scriptPubKey,signingProfile:'p2pkh'})),
  children:[{inputs:[{outputIndex:0,signingProfile:'contract-template',unlockingScriptTemplate:prefix+'00'}],
    outputs:[{satoshis:String(output.satoshis-80n),scriptPubKey:'76a914751e76e8199196d454941c45d1b3a323f1433bd688ac'}]}]}}});
}
const navigation={webViewInstanceId:'fixture',sessionId:'review-fixture',navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',frame:'top',createdAt:'2026-10-13T00:00:00.123Z'};
for(const s of forms){
 const material=o.kit.normalizeTbcReviewedTransactionMaterial(s.request),reads=[],statuses=s.rows.map(u=>({txid:u.txid,index:String(u.vout),spent:false,value:u.satoshis,scriptPubKey:u.scriptPubKey,height:'1'}));
 const options={network:o.kit.createTbcNetworkContext({network:'testnet'}),materialNative:o.keyless,async fetch(url,init){
  assert.equal(new URL(url).pathname,'/api/tbc/txo/status');assert.equal(init.method,'POST');
  const body=JSON.parse(init.body);reads.push({path:'/api/tbc/txo/status',body});
  const txos=body.txos.map(p=>{const r=statuses.find(r=>r.txid===p.txid&&r.index===String(p.index));assert(r);return r;});
  const response=new Response(JSON.stringify({code:200,data:{txos}}),{status:200,headers:{'content-type':'application/json'}});
  Object.defineProperty(response,'url',{value:String(url)});return response;
 }};
 let defaultReview;
 const wrap=r=>({review:async input=>(defaultReview=await r.review(input))}),networkSourceIdentity='frozen-reviewed-native-lock';
 const caps=o.kit.createTbcStandardWorkflowCapabilities({navigation,chainId:'tbc:testnet',account,networkSourceIdentity,
  readCurrentAuthority:async()=>({...account,networkSourceIdentity}),rawReviewer:wrap(o.kit.createTbcDefaultRawTransactionReviewer(options)),
  associatedReviewer:wrap(o.kit.createTbcDefaultAssociatedTransactionReviewer(options)),materialNative:o.keyless,now:()=>navigation.createdAt,
  privateNative:{rawSigner:{sign(){throw Error('unused')}},associatedExecutor:{execute(){throw Error('unused')}},cryptoAdapter:{encrypt(){throw Error('unused')},decrypt(){throw Error('unused')}}}});
 const review=await caps.reviewedTransaction.review({version:'1.0',request:s.request,requestHash:o.kit.hashCanonical(s.request),origin:navigation.origin,sessionId:navigation.sessionId,chainId:'tbc:testnet',accountId:account.accountId,publicKey},{operation:'reviewedTransaction.review'});
 assert.equal(reads.length,1);
 if(s.publicFixturePreimage)assert(!JSON.stringify(review).includes(s.publicFixturePreimage));
 const resolvedOutputs=defaultReview.policyMaterial.resolvedOutputs,previousTransactions=[],stages=[];
 for(let i=0;i<material.request.inputs.length+1;i++){
  const stage=JSON.parse(await o.keyless.execute('prepareReviewedStage',JSON.stringify({format:'associated',request:material.request,publicKey,transactionIndex:i,previousTransactions,resolvedOutputs})));
  const signatures=stage.digests.map(d=>secp256k1.sign(d,1n,{lowS:true,prehash:false}).toCompactHex());
  const finalized=JSON.parse(await o.keyless.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
  stages.push({stage,signatures,finalized});previousTransactions.push(finalized.txraw);
 }
 cases.push({...s,material,account,statuses,reads,defaultReview,review,stages});
}
const report={status:'FROZEN_REVIEWED_NATIVE_LOCK_ORACLE',archiveSha256:o.archiveSha256,provenance,
 dependencyLockSha256:sha(lock),cases,publicSyntheticScalar:1,publicFixtureSecretsOnly:true,networkHttp:0,broadcasts:0};
await writeFile(join(base,'test/fixtures/reviewed-native-lock.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
await writeFile(join(base,'test/fixtures/reviewed-native-lock-dependency-lock.json'),lock,{flag:'wx'});
console.log(JSON.stringify({cases:cases.map(s=>({name:s.name,stages:s.stages.length,reads:s.reads.length})),networkHttp:0}));
