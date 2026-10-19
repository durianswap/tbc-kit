// Diagnose the exact associated boundary without relaxing production policy.
// Public fixture key only; no external API, device, custody or broadcast.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {loadHolderInstalledHarness} from './lib/holder-installed-harness.mjs';
import {loadTokenUnlockSdkOracle} from './lib/token-unlock-sdk-oracle.mjs';

const [consumer,archive,upstream]=process.argv.slice(2);assert.ok(consumer&&archive&&upstream&&process.argv.length===5);
const root=fileURLToPath(new URL('../../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const expectedSha='d55790f48f761316672f3e256cf24a50ccf0381753a9a0db014e541d77317eb0';
const {kit,native,fixtureRoot,evidence}=await loadHolderInstalledHarness({consumer,archive,expectedSha});
const require=createRequire(join(root,'package.json')),tbc=require('tbc-lib-js'),signer=new tbc.PrivateKey(new tbc.crypto.BN(1));
const oracle=await loadTokenUnlockSdkOracle(upstream,require);
globalThis.fetch=()=>{throw Error('External HTTP forbidden');};
const coin=JSON.parse(await readFile(fixtureRoot+'packages/tbc-engine/rust/fixtures/coin-proof.json'));
const ft=JSON.parse(await readFile(fixtureRoot+'packages/tbc-engine/rust/fixtures/tbc20-standard-transfer.json'));
const vectors=[...coin.vectors,...ft.stages.slice(2).map((s,i)=>({id:'tbc20-'+s.id,signedRaw:s.signedRaw,parentRaw:ft.stages[i+1].signedRaw,
 ancestorsRaw:ft.stages.slice(0,i+1).map(p=>p.signedRaw),publicKeyHex:ft.request.publicKeyHex,contractId:ft.stages[0].txid}))];
const network=kit.createTbcNetworkContext({network:'testnet',endpoint:{kind:'trusted-custom',apiOrigin:'https://devapi.tbcdev.org',trustId:'public-fixture'}});
const context={origin:'https://review.test',chainId:'tbc:testnet',accountId:'tbc:testnet:'+signer.toAddress(),sessionId:'associated-audit',navigationId:'associated-audit'};
const rows=[],unsafeTemplateControls=[];let vmInputs=0,sdkInputs=0;
for(const v of vectors){
 const parents=new Map([v.parentRaw,...v.ancestorsRaw].map(raw=>{const p=new tbc.Transaction(raw);return[p.id,p];}));
 const tx=new tbc.Transaction(v.signedRaw);tx.inputs.forEach(i=>i.setScript(tbc.Script.empty()));
 const previous=tx.inputs.map(i=>{const p=parents.get(i.prevTxId.toString('hex'));assert.ok(p);i.output=p.outputs[i.outputIndex];return i.output;});
 const codes=JSON.parse(await native.execute('inspectTokenMaterial',JSON.stringify({phase:'inspectCodes',scripts:previous.map(o=>o.script.toHex())}))).codes;
 const selected=codes.findIndex(Boolean),coinCode=codes[selected].standardId==='tbc20-stablecoin';
 const sourceUtxos=tx.inputs.map((input,i)=>{
  const base={txId:input.prevTxId.toString('hex'),outputIndex:input.outputIndex,script:previous[i].script.toHex(),satoshis:previous[i].satoshis};
  if(!codes[i])return {...base,scriptSigType:'p2pkh'};
  // Build the real covenant witness using pinned independent SDK, then replace
  // exactly its signature leaf. Not a made-up P2PKH unlock or byte substring.
  const groups=[];for(let n=0;n<tx.outputs.length;n++){
   if(tx.outputs[n].satoshis===500){groups.push({codeVout:n,tapeVout:n+1});n++;}else groups.push({codeVout:n});
  }
  const signature=tx.getSignature(i,signer);
  const script=(coinCode?oracle.coin:oracle.token)({currentTx:tx,inputIndex:i,preTx:parents.get(base.txId),preTxVout:base.outputIndex,
   ancestorTransactions:parents,outputGroups:groups,signature:Buffer.from(signature,'hex'),publicKey:signer.publicKey.toBuffer()});
  const template=new tbc.Script();let replaced=0;
  for(const chunk of script.chunks){if(chunk.buf?.toString('hex')===signature){template.add(Buffer.from('signature'));replaced++;}else template.add(chunk);}
  assert.equal(replaced,1);sdkInputs++;
  return {...base,scriptSigType:'other',unfinishedScriptSig:template.toHex()};
 });
 const request={sourceTxraw:tx.uncheckedSerialize(),sourceUtxos,inputs:[],outputs:[]};
 const resolvedOutputs=[...parents].flatMap(([txid,p])=>p.outputs.map((o,vout)=>({txid,vout,satoshis:String(o.satoshis),scriptPubKey:o.script.toHex()})));
 const stage=JSON.parse(await native.execute('prepareReviewedStage',JSON.stringify({format:'associated',publicKey:v.publicKeyHex,request,resolvedOutputs})));
 const signatures=stage.digests.map(d=>secp256k1.sign(d,signer.toBuffer(),{prehash:false,lowS:true}).toCompactHex());
 const signed=JSON.parse(await native.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
 assert.equal(signed.txraw,v.signedRaw);const assembled=new tbc.Transaction(signed.txraw);
 assembled.inputs.forEach((input,i)=>{input.output=previous[i];assert.equal(assembled.verifyScript(i).success,true);vmInputs++;});
 if(v.id==='first-0'){
  // A generic placeholder assembler is not a covenant-proof verifier. Prove
  // the distinction before considering broader default-reviewer acceptance.
  for(const [label,leaf]of [['public-key-slot',99],['parent-version-slot',107]]){
   const altered=structuredClone(request),template=new tbc.Script(altered.sourceUtxos[selected].unfinishedScriptSig);
   assert.equal(template.chunks.length,123);assert.ok(template.chunks[leaf].buf);
   const wrong=Buffer.from(template.chunks[leaf].buf);wrong[wrong.length-1]^=1;
   const script=new tbc.Script();template.chunks.forEach((c,i)=>script.add(i===leaf?wrong:c));
   altered.sourceUtxos[selected].unfinishedScriptSig=script.toHex();
   const badStage=JSON.parse(await native.execute('prepareReviewedStage',JSON.stringify({format:'associated',publicKey:v.publicKeyHex,request:altered,resolvedOutputs})));
   assert.deepEqual(badStage.digests,stage.digests);
   const output=JSON.parse(await native.execute('finalizeReviewedStage',JSON.stringify({stage:badStage,signatures,signatureEncoding:'compact64'})));
   const invalid=new tbc.Transaction(output.txraw);invalid.inputs.forEach((input,i)=>{input.output=previous[i];});
   assert.equal(invalid.verifyScript(selected).success,false);
   unsafeTemplateControls.push({label,keylessGenericAssembly:'ACCEPTED',independentVm:'REJECTED',
    requiredBeforeDefaultSupport:'Bind and validate current covenant witness; do not just remove reviewer guard'});
  }
 }
 const standard={payload:{format:'associated',sourceTransaction:request.sourceTxraw,children:[],sourceInputs:sourceUtxos.map(u=>({
  txid:u.txId,outputIndex:u.outputIndex,satoshis:String(u.satoshis),scriptPubKey:u.script,
  signingProfile:u.scriptSigType==='other'?'contract-template':'p2pkh',...(u.unfinishedScriptSig?{unlockingScriptTemplate:u.unfinishedScriptSig}:{})}))}};
 assert.deepEqual(kit.normalizeTbcReviewedTransactionMaterial(standard).request,request);
 let reads=0;
 const reviewer=kit.createTbcDefaultAssociatedTransactionReviewer({network,materialNative:native,fetch:async(url,init)=>{
  reads++;const u=new URL(String(url));assert.equal(u.origin,'https://devapi.tbcdev.org');assert.equal(u.pathname,'/api/tbc/txo/status');
  const data={txos:JSON.parse(init.body).txos.map(p=>{const o=parents.get(p.txid)?.outputs[Number(p.index)];assert.ok(o);
   return {txid:p.txid,index:String(p.index),value:String(o.satoshis),scriptPubKey:o.script.toHex(),spent:false,height:'1'};})};
  return new Response(JSON.stringify({code:'200',data}),{status:200});
 }});
 let failure;
 try{await reviewer.review({request,operationDigest:kit.hashCanonical({kind:'signAssociated',request}),context});}catch(error){failure=String(error.message);}
 assert.equal(failure,'Unrecognized current raw transaction impact','Frozen reviewer gap must reproduce, not some other failure');
 // The named historical Coin profile is NOT silently repurposed for the new ABI.
 const old=structuredClone(request);old.sourceUtxos[selected].scriptSigType='tbc20_coin';
 await assert.rejects(native.execute('prepareReviewedStage',JSON.stringify({format:'associated',publicKey:v.publicKeyHex,request:old,resolvedOutputs})),/StableCoin associated signing is outside/);
 rows.push({id:v.id,standard:codes[selected].standardId,inputs:previous.length,sourceOnly:true,standardMapping:'PASS',
  keylessAssembly:'PASS_PINNED_SDK_AND_VM',defaultReviewer:'GAP',failure,reads,legacyCoinProfile:'REJECTED_UNCHANGED'});
}
assert.equal(rows.length,6);assert.equal(vmInputs,15);
const script='packages/tbc-engine/scripts/check-holder-associated-boundary214.mjs';
const report={status:'VERIFIED_CURRENT_HOLDER_ASSOCIATED_REVIEW_GAP',at:new Date().toISOString(),installed:evidence,rows,vmInputs,sdkInputs,unsafeTemplateControls,
 sdkCommit:oracle.commit,sdkFiles:oracle.files,actualHttp:0,broadcast:0,goalComplete:false,sourceSha256:sha(await readFile(join(root,script))),
 limitations:['No approval or Host execution because the reviewer rejects','Source-only: dependent covenant witness rebasing not proven','Administrator and mixed account signing not tested','Does not authorize accepting arbitrary proof templates']};
const dir=await mkdtemp(join(tmpdir(),'tbc-holder214-associated-boundary-')),path=join(dir,'report.json'),body=JSON.stringify(report,null,2)+'\n';
await writeFile(path,body,{flag:'wx'});console.log(JSON.stringify({status:report.status,path,sha256:sha(body),vmInputs,sdkInputs,rows}));
