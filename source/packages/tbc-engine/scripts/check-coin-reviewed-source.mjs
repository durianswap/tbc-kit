// Public synthetic Coin only. No custody, external HTTP or broadcast.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks, createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {checkRawHolderHost} from './lib/check-raw-holder-host.mjs';
import {loadTokenUnlockSdkOracle} from './lib/token-unlock-sdk-oracle.mjs';
import {loadHolderInstalledHarness} from './lib/holder-installed-harness.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(root+'packages/kit/package.json'),tbc=require('tbc-lib-js');
assert.ok(process.argv.length===2||(process.argv.length===4&&process.argv[2]==='--sdk'));
const oracle=process.argv[3]?await loadTokenUnlockSdkOracle(process.argv[3],require):undefined;
const env=process.env,installed=env.TBC_HOLDER_INSTALLED_CONSUMER?await loadHolderInstalledHarness({consumer:env.TBC_HOLDER_INSTALLED_CONSUMER,
 archive:env.TBC_HOLDER_ARCHIVE,expectedSha:env.TBC_HOLDER_ARCHIVE_SHA256,entry:env.TBC_HOLDER_ENTRY,backend:env.TBC_HOLDER_BACKEND}):undefined;
let kit;
if(installed)kit=installed.kit;
else {
const bundled=await build({stdin:{contents:`
export {createTbcDefaultRawTransactionReviewer} from './packages/kit/src/reviewed-transaction-reviewer.ts';
export {createTbcNetworkContext} from './packages/kit/src/network-context.ts';
export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';
export {inspectReviewedTokenCodes} from './packages/kit/src/reviewed-token.ts';
export {createTbcStandardWorkflowCapabilities} from './packages/kit/src/standard-workflow-capabilities.ts';
export {hashCanonical,assertValidTws} from './packages/core/src/index.ts';
export {TWS_RELEASE_FINGERPRINT} from './packages/core/src/release.ts';
export {createTbcWallet} from './packages/kit/src/wallet-runtime.ts';
export {createApprovalHostEvidenceReader} from './packages/kit/src/approval-host-evidence.ts';
export {projectTbcApprovalPresentation} from './packages/kit/src/approval-presentation.ts';
export {createMemoryTwsHostStore} from './packages/host/src/index.ts';
`,resolveDir:root,loader:'ts'},alias:{'@tbc-wallet/core':root+'packages/core/src/index.ts','@tbc-wallet/host':root+'packages/host/src/index.ts',
 '@tbc-wallet/provider':root+'packages/provider/src/index.ts','@tbc-wallet/provider/in-memory':root+'packages/provider/src/in-memory.ts'},
plugins:[{name:'parser',setup(b){b.onResolve({filter:/^\.\/vendor\/tbc-tx-parser\/index\.js$/},()=>({path:root+'packages/kit/dist/esm/vendor/tbc-tx-parser/index.js'}));}}],
banner:{js:"import {createRequire as ar} from 'node:module'; const require=ar(import.meta.url);"},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const url=new URL('../../../packages/kit/src/.coin-reviewed-source.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,n){return s===url?{url,shortCircuit:true}:n(s,c)},load(u,c,n){return u===url?{source:bundled.outputFiles[0].text,format:'module',shortCircuit:true}:n(u,c)}});
kit=await import(url);hooks.deregister();
}
globalThis.fetch=()=>{throw Error('External HTTP forbidden');};
const native=installed?.native??await kit.createWasmTbcKeylessEngine(readFileSync(root+'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm'));
const fixtureRoot=installed?.fixtureRoot??root;
const fixture=JSON.parse(readFileSync(fixtureRoot+'packages/tbc-engine/rust/fixtures/coin-proof.json'));
const ft=JSON.parse(readFileSync(fixtureRoot+'packages/tbc-engine/rust/fixtures/tbc20-standard-transfer.json'));
const vectors=[...fixture.vectors,...ft.stages.slice(2).map((s,i)=>({id:'tbc20-'+s.id,signedRaw:s.signedRaw,parentRaw:ft.stages[i+1].signedRaw,
 ancestorsRaw:ft.stages.slice(0,i+1).map(p=>p.signedRaw),publicKeyHex:ft.request.publicKeyHex,contractId:ft.stages[0].txid}))];
const network=kit.createTbcNetworkContext({network:'testnet',endpoint:{kind:'trusted-custom',apiOrigin:'https://devapi.tbcdev.org',trustId:'public-fixture'}});
const signer=new tbc.PrivateKey(new tbc.crypto.BN(1));
let signatures=0,vmInputs=0,negativeCases=0,sdkAssembledInputs=0;const rows=[],hostRows=[];
for(const vector of vectors){
 const parents=new Map([vector.parentRaw,...vector.ancestorsRaw].map(raw=>{const t=new tbc.Transaction(raw);return [t.id,t];}));
 const reference=new tbc.Transaction(vector.signedRaw),tx=new tbc.Transaction(vector.signedRaw);
 tx.inputs.forEach(i=>i.setScript(tbc.Script.empty()));
 const inputs=tx.inputs.map(i=>{const p=parents.get(i.prevTxId.toString('hex')),o=p.outputs[i.outputIndex];return {satoshis:o.satoshis,script:o.script.toHex()};});
 // Fixture selection only; real reviewer calls its own packaged strict codec.
 const codes=JSON.parse(await native.execute('inspectTokenMaterial',JSON.stringify({phase:'inspectCodes',scripts:inputs.map(i=>i.script)}))).codes;
 const selected=codes.findIndex(Boolean),code=codes[selected],assetScript=inputs[selected].script;
 const assetId=vector.contractId??new tbc.Transaction(vector.ancestorsRaw[0]).id,isCoin=code.standardId==='tbc20-stablecoin';
 let fault='',reads=[];
 const reviewer=kit.createTbcDefaultRawTransactionReviewer({network,materialNative:native,fetch:async(url,init)=>{
  const u=new URL(String(url));assert.equal(u.origin,'https://devapi.tbcdev.org');reads.push(u.pathname);let data;
  if(u.pathname==='/api/tbc/txo/status')data={txos:JSON.parse(init.body).txos.map(p=>{const out=parents.get(p.txid)?.outputs[Number(p.index)];assert.ok(out);
   let script=out.script.toHex();if(fault==='locked-parent'&&out.satoshis===0){const tape=Buffer.from(out.script.toBuffer());tape.writeUInt32LE(0xffffffff,tape.length-14);script=tape.toString('hex');}
   return {txid:p.txid,index:String(p.index),value:fault==='tape-value'&&out.satoshis===0?'1':String(out.satoshis),scriptPubKey:fault==='tape-script'&&out.satoshis===0?'51':script,spent:false,height:'1'};})};
  else if(u.pathname.includes('/decode/txid/')){const id=u.pathname.split('/').at(-1),p=parents.get(id);assert.ok(p);data={txid:fault==='decode-txid'?'00'.repeat(32):id,contract_id:assetId,output:fault==='decode-point'?[]:p.outputs.map((_,vout)=>({txid:id,vout}))};}
  else if(u.pathname.includes('/info/'))data={stablecoin_id:fault==='metadata-id'?'00'.repeat(32):assetId,code_script:fault==='metadata-code'?'51':assetScript};
  else throw Error('Unexpected request');
  return new Response(JSON.stringify({code:'200',data}),{status:200});
 }});
 const request={txraws:[tx.uncheckedSerialize()],utxos_satoshis:[inputs.map(i=>i.satoshis)],script_pubkeys:[inputs.map(i=>i.script)]};
 const context={origin:'https://review.test',chainId:'tbc:testnet',accountId:'tbc:testnet:'+signer.toAddress(),sessionId:'review',navigationId:'review'};
 const result=await reviewer.review({request,context,transactionIds:[tx.id]});
 const preview=result.preview.transactions[0];assert.equal(preview.classification.protocol,isCoin?'stablecoin':'ft');
 assert.ok(preview.groups.some(g=>g.asset.contractId===assetId));assert.equal(reads.length,4);
 const account={chainId:context.chainId,accountId:context.accountId,address:signer.toAddress().toString(),publicKey:vector.publicKeyHex};
 const caps=kit.createTbcStandardWorkflowCapabilities({chainId:context.chainId,account,networkSourceIdentity:'fixture',navigation:context,materialNative:native,
  readCurrentAuthority:async()=>({...account,networkSourceIdentity:'fixture'}),rawReviewer:{review:async()=>result},
  associatedReviewer:{review:async()=>{throw Error('Unexpected associated');}},privateNative:{},now:()=>new Date().toISOString().replace(/\.\d{3}Z$/u,'Z')});
 const envelope={payload:{format:'raw',transactions:[{rawTransaction:request.txraws[0],inputs:inputs.map(i=>({satoshis:String(i.satoshis),scriptPubKey:i.script}))}]}};
 const bound=await caps.reviewedTransaction.review({version:'1.0',origin:context.origin,sessionId:context.sessionId,chainId:context.chainId,
  accountId:context.accountId,publicKey:account.publicKey,request:envelope,requestHash:kit.hashCanonical(envelope)},{operation:'reviewedTransaction.review'});
 if(isCoin)assert.deepEqual(bound.payload.preview.coinLocks,preview.coinLocks.map(l=>({...l,transactionIndex:0})));
 assert.equal(bound.reviewHash,kit.hashCanonical(bound.payload));assert.equal(reads.length,4);
 // Raw promises detached signatures, not fabricated P2PKH Coin unlocks.
 const stage=JSON.parse(await native.execute('prepareReviewedStage',JSON.stringify({format:'raw',publicKey:vector.publicKeyHex,
  resolvedOutputs:result.policyMaterial.resolvedOutputs,
  request:{txraws:request.txraws,utxosSatoshis:request.utxos_satoshis,scriptPubkeys:request.script_pubkeys}})));
 const compact=stage.digests.map(d=>secp256k1.sign(d,signer.toBuffer(),{prehash:false,lowS:true}).toCompactHex());
 const signed=JSON.parse(await native.execute('finalizeReviewedStage',JSON.stringify({stage,signatures:compact,signatureEncoding:'compact64'})));
 assert.equal(signed.txraw,request.txraws[0]);
 tx.inputs.forEach((input,i)=>{input.output=parents.get(input.prevTxId.toString('hex')).outputs[input.outputIndex];assert.equal(signed.sigs[i],tx.getSignature(i,signer));
  // Replace only the signature push of an independently validated covenant
  // witness; this proves signing correctness, not an SDK assembly API.
  const chunks=reference.inputs[i].script.chunks;let replaced=0;let script=new tbc.Script();
  for(const chunk of chunks){if(chunk.buf?.toString('hex')===signed.sigs[i]){script.add(Buffer.from(signed.sigs[i],'hex'));replaced++;}else script.add(chunk);}
  assert.equal(replaced,1);
  if(oracle){
   const descriptor=codes[i];
   if(descriptor){
    const groups=[];for(let n=0;n<tx.outputs.length;n++){
     if(tx.outputs[n].satoshis===500){groups.push({codeVout:n,tapeVout:n+1});n++;}else groups.push({codeVout:n});
    }
    script=(isCoin?oracle.coin:oracle.token)({currentTx:tx,inputIndex:i,preTx:parents.get(input.prevTxId.toString('hex')),
     preTxVout:input.outputIndex,ancestorTransactions:parents,outputGroups:groups,signature:Buffer.from(signed.sigs[i],'hex'),publicKey:signer.publicKey.toBuffer()});
   }else script=new tbc.Script().add(Buffer.from(signed.sigs[i],'hex')).add(signer.publicKey.toBuffer());
   assert.equal(script.toHex(),reference.inputs[i].script.toHex());sdkAssembledInputs++;
  }
  input.setScript(script);signatures++;
 });
 tx.inputs.forEach((_,i)=>{assert.equal(tx.verifyScript(i).success,true);vmInputs++;});
 if(vector.id==='first-0'||vector.id==='tbc20-transfer')hostRows.push(...(await checkRawHolderHost({kit,native,account,request:envelope,reviewer,
  signer,expectedSignatures:signed.sigs,readCount:()=>reads.length})).map(row=>({standard:code.standardId,...row})));
 for(const f of ['tape-value','tape-script','decode-txid','decode-point','metadata-id','metadata-code','locked-parent']){
  if((f==='metadata-id'||f==='locked-parent')&&!isCoin)continue;
  fault=f;await assert.rejects(reviewer.review({request,context,transactionIds:[new tbc.Transaction(request.txraws[0]).id]}));negativeCases++;
 }
 fault='';await assert.rejects(reviewer.review({request,context:{...context,accountId:'tbc:testnet:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP'},transactionIds:[new tbc.Transaction(request.txraws[0]).id]}));negativeCases++;
 for(const mutation of ['amount','unknown-script','native-overspend','locked-output']){
  if(mutation==='locked-output'&&!isCoin)continue;
  const changed=new tbc.Transaction(request.txraws[0]);
  if(mutation==='amount'){
   const tape=changed.outputs[1].script.toBuffer();tape.writeBigUInt64LE(tape.readBigUInt64LE(3)+1n,3);changed.outputs[1].setScript(tbc.Script.fromBuffer(tape));
  }else if(mutation==='unknown-script')changed.outputs[0].setScript(tbc.Script.fromHex('51'));
  else if(mutation==='native-overspend')changed.outputs.at(-1).satoshis+=10000000;
  else {
   // Coin Tape layout's lock word is immediately before its final protocol tag.
   const tape=changed.outputs[1].script.toBuffer();tape.writeUInt32LE(500000001,tape.length-14);changed.outputs[1].setScript(tbc.Script.fromBuffer(tape));
  }
  const edited={...request,txraws:[changed.uncheckedSerialize()]};reads=[];
  if(mutation==='locked-output'){
   const locked=await reviewer.review({request:edited,context,transactionIds:[changed.id]});
   assert.ok(locked.preview.transactions[0].coinLocks.some(l=>l.position==='output'&&l.lockTime===500000001&&l.chainMaturityChecked===false));
  }else{await assert.rejects(reviewer.review({request:edited,context,transactionIds:[changed.id]}));negativeCases++;}
 }
 rows.push({id:vector.id,inputCount:inputs.length,readBudget:4,standard:code.standardId});
}
console.log(JSON.stringify({status:'PASS',...(installed?{installed:installed.evidence}:{}),rows,signatures,vmInputs,negativeCases,hostRows,sdkAssembledInputs,sdkCommit:oracle?.commit,sdkFiles:oracle?.files,
 actualHttp:0,broadcast:0,scope:installed?'Installed holder review/signature/SDK and Core/Host in Node; not device or chain acceptance':
 'Source raw holder review and detached signatures with public reference witness and optional pinned SDK assembly; not installed package or chain acceptance'}));
