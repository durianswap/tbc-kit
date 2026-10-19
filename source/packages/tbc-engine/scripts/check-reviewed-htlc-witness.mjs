// Public synthetic HTLC templates only. Source Native/WASM parity and an
// independent script interpreter; no wallet, HTTP, private fixture or broadcast.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire,registerHooks} from 'node:module';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const root=resolve(import.meta.dirname,'../../..'),rust=join(root,'packages/tbc-engine/rust');
const args=process.argv.slice(2);
assert.ok(args.length===0||(args.length===2&&args[0]==='--consumer'),'Usage: [--consumer INSTALLED_CONSUMER]');
const installedPath=args.length?resolve(args[1],'node_modules/@tbc/kit'):undefined;
const installedKit=installedPath?await import(pathToFileURL(join(installedPath,'dist/esm/wallet.js'))):undefined;
const installedVersion=installedPath?JSON.parse(readFileSync(join(installedPath,'package.json'),'utf8')).version:undefined;
const native=spawnSync('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','reviewed_htlc','--','--nocapture'],
 {cwd:rust,env:{...process.env,HTLC_ASSOCIATED_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
assert.equal(native.status,0,'Native HTLC witness test failed; materials withheld');
const marker='HTLC_ASSOCIATED_WIRE:',rows=native.stdout.split('\n').filter(l=>l.startsWith(marker)).map(l=>JSON.parse(l.slice(marker.length)));
assert.equal(rows.length,33);
const childMarker='HTLC_ASSOCIATED_CHILD_WIRE:',childRows=native.stdout.split('\n').filter(l=>l.startsWith(childMarker)).map(l=>JSON.parse(l.slice(childMarker.length)));
assert.equal(childRows.length,3);
if(!installedPath){
const wasm=spawnSync('cargo',['build','--offline','--locked','--release','-p','tbc-keyless-wasm','--target','wasm32-unknown-unknown'],
 {cwd:rust,env:{...process.env,RUSTFLAGS:'--cfg getrandom_backend="unsupported"'},encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
assert.equal(wasm.status,0,'Source WASM build failed; materials withheld');
}
const compiled=await build({entryPoints:[join(root,'packages/kit/src/keyless.ts')],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {createWasmTbcKeylessEngine}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const projected=await build({entryPoints:[join(root,'packages/kit/src/reviewed-htlc-witness.ts')],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {inspectAssociatedHtlcWitness}=await import('data:text/javascript;base64,'+Buffer.from(projected.outputFiles[0].text).toString('base64'));
const engine=installedKit
 ?await installedKit.createWasmTbcKeylessEngine(readFileSync(join(installedPath,'artifacts/wasm/tbc_keyless_wasm.wasm')))
 :await createWasmTbcKeylessEngine(readFileSync(join(rust,'target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm')));
const require=createRequire(join(root,'packages/kit/package.json')),tbc=require('tbc-lib-js');
assert.equal(require('tbc-lib-js/package.json').version,'1.0.31');
let valid=0,invalid=0,vmInputs=0,vmInvalidProofs=0,publicProjectionCases=0,projectionRejections=0;
function projection(request){
 const tx=new tbc.Transaction(request.request.sourceTxraw),input=request.request.sourceUtxos[0];
 return inspectAssociatedHtlcWitness({scriptPubKey:input.script,unlockingScriptTemplate:input.unfinishedScriptSig,
  accountAddress:new tbc.PublicKey(request.publicKey).toAddress().toString(),addressVersion:0,
  sequence:tx.inputs[0].sequenceNumber,transactionLockTime:tx.nLockTime});
}
for(const row of rows){
 if(row.kind==='valid'){
  const stage=JSON.parse(await engine.execute('prepareReviewedStage',JSON.stringify(row.request)));assert.deepEqual(stage,row.stage);
  const result=JSON.parse(await engine.execute('finalizeReviewedStage',JSON.stringify({...row.finalRequest,stage})));assert.deepEqual(result,row.result);
  const terms=projection(row.request),claim=row.request.request.sourceUtxos[0].unfinishedScriptSig.endsWith('51');
  assert.deepEqual(terms,claim?{branch:'claim',preimageVerified:true,disclosureWarning:'HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE'}:{branch:'refund',preimageVerified:false});
  assert.equal(Object.isFrozen(terms),true);publicProjectionCases++;
  const tx=new tbc.Transaction(result.txraw);
  tx.inputs.forEach((i,n)=>{const input=row.request.request.sourceUtxos[n];i.output=new tbc.Transaction.Output({script:tbc.Script.fromHex(input.script),satoshis:input.satoshis});
   assert.equal(tx.verifyScript(n).success,true,'Independent SDK Script validation failed');vmInputs++;});valid++;
 }else{
  const op=row.kind==='invalid-prepare'?'prepareReviewedStage':'finalizeReviewedStage';
  const expectedError=row.kind==='invalid-prepare'&&[5,6].includes(row.case)?'Reviewed policy input identity mismatch':'Invalid associated HTLC witness';
  await assert.rejects(engine.execute(op,JSON.stringify(row.request)),e=>e.message===expectedError);invalid++;
  // Outpoint/profile/unsigned-input checks belong to the shared reviewer and
  // Engine, not this public-terms projector. Test its exact responsibility.
  if(row.kind==='invalid-prepare'&&[0,1,2,3,7,9,10,11,12,13,14].includes(row.case)){
   assert.throws(()=>projection(row.request),e=>e.message==='Invalid associated HTLC witness');projectionRejections++;
  }
  if(row.kind==='invalid-prepare'&&[0,9,10,11,12,13].includes(row.case)){
   // Independently sign the changed transaction with a correct test-key
   // signature so rejection cannot be explained by a stale/wrong digest.
   const input=row.request.request.sourceUtxos[0],tx=new tbc.Transaction(row.request.request.sourceTxraw);
   tx.inputs[0].output=new tbc.Transaction.Output({script:tbc.Script.fromHex(input.script),satoshis:input.satoshis});
   const sig=tx.getSignature(0,new tbc.PrivateKey(Buffer.from('07'.repeat(32),'hex'))),unlock=new tbc.Script();
   tbc.Script.fromHex(input.unfinishedScriptSig).chunks.forEach(c=>unlock.add(c.buf?.toString()==='signature'?Buffer.from(sig,'hex'):c));
   tx.inputs[0].setScript(unlock);assert.equal(tx.verifyScript(0).success,false,'Bad HTLC proof unexpectedly passed independent Script VM');vmInvalidProofs++;
  }
 }
}
assert.equal(valid,9);assert.equal(invalid,24);assert.equal(vmInputs,9);assert.equal(vmInvalidProofs,6);
assert.equal(publicProjectionCases,9);assert.equal(projectionRejections,11);
// Actual shared reviewer, including its unsigned local-parent resolution.
let reviewerKit=installedKit;
if(!reviewerKit){
const reviewerBundle=await build({stdin:{contents:`
 export {createTbcDefaultAssociatedTransactionReviewer,materializeAssociatedReviewRequest} from './packages/kit/src/reviewed-transaction-reviewer.ts';
 export {createTbcNetworkContext} from './packages/kit/src/network-context.ts';
 export {hashCanonical} from './packages/core/src/index.ts';`,resolveDir:root,loader:'ts'},
 alias:{'@tbc-wallet/core':join(root,'packages/core/src/index.ts')},
 plugins:[{name:'source-parser',setup(b){b.onResolve({filter:/^\.\/vendor\/tbc-tx-parser\/index\.js$/},()=>({path:join(root,'packages/kit/dist/esm/vendor/tbc-tx-parser/index.js')}));}}],
 banner:{js:"import {createRequire as auditRequire} from 'node:module'; const require=auditRequire(import.meta.url);"},
 bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const virtual=new URL('../../../packages/kit/src/.htlc-child-review-check.mjs',import.meta.url).href;
const hook=registerHooks({resolve(s,c,n){return s===virtual?{url:virtual,shortCircuit:true}:n(s,c)},load(u,c,n){return u===virtual?{source:reviewerBundle.outputFiles[0].text,format:'module',shortCircuit:true}:n(u,c)}});
reviewerKit=await import(virtual);hook.deregister();
}
let childStages=0,childVmInputs=0,childReviewReads=0,childRefunds=0,childVmRejections=0;
for(const row of childRows){
 {
  const finalized=[];
  for(const [prepare,expected,finalRequest,result] of [[row.prepareParent,row.parentStage,row.parentFinal,row.signedParent],[row.prepareChild,row.childStage,row.childFinal,row.signedChild]]){
   const stage=JSON.parse(await engine.execute('prepareReviewedStage',JSON.stringify({...prepare,previousTransactions:finalized})));
   assert.deepEqual(stage,expected);
   const actual=JSON.parse(await engine.execute('finalizeReviewedStage',JSON.stringify({...finalRequest,stage})));assert.deepEqual(actual,result);
   const tx=new tbc.Transaction(actual.txraw);
   tx.inputs.forEach((input,n)=>{const prev=stage.inputs[n];input.output=new tbc.Transaction.Output({script:tbc.Script.fromHex(prev.script),satoshis:prev.satoshis});assert.equal(tx.verifyScript(n).success,true);childVmInputs++;});
   finalized.push(actual.txraw);childStages++;
  }
  assert.equal(new tbc.Transaction(finalized[1]).inputs[0].prevTxId.toString('hex'),new tbc.Transaction(finalized[0]).id);
  if(row.kind==='refund'){
   childRefunds++;
   // Re-sign changed unsigned children with the public synthetic key so VM
   // rejection proves the lock predicate, not merely a stale signature.
   for(const mutation of ['lock','sequence','domain']){
    const tx=new tbc.Transaction(row.childStage.txraw),prev=row.childStage.inputs[0];
    tx.inputs[0].output=new tbc.Transaction.Output({script:tbc.Script.fromHex(prev.script),satoshis:prev.satoshis});
    if(mutation==='lock')tx.nLockTime--;
    else if(mutation==='sequence')tx.inputs[0].sequenceNumber=0xffffffff;
    else tx.nLockTime=tx.nLockTime<500000000?1774427165:834801;
    const signature=tx.getSignature(0,new tbc.PrivateKey(Buffer.from('07'.repeat(32),'hex'))),unlock=new tbc.Script();
    tbc.Script.fromHex(prev.unfinishedScriptSig).chunks.forEach(c=>unlock.add(c.buf?.toString()==='signature'?Buffer.from(signature,'hex'):c));
    tx.inputs[0].setScript(unlock);assert.equal(tx.verifyScript(0).success,false);childVmRejections++;
   }
  }
 }
 const prepare=row.prepareParent,request=prepare.request;
 const address=new tbc.PublicKey(prepare.publicKey).toAddress().toString();let reads=0;
 const reviewer=reviewerKit.createTbcDefaultAssociatedTransactionReviewer({network:reviewerKit.createTbcNetworkContext({network:'testnet'}),materialNative:engine,
  fetch:async(url,init)=>{const u=new URL(String(url));assert.equal(u.origin,'https://api.tbcdev.org');assert.equal(u.pathname,'/api/tbc/txo/status');assert.equal(init.method,'POST');reads++;
   const points=JSON.parse(init.body).txos;assert.equal(points.length,1,'No fetch of synthetic local child prevout');
   const prev=request.sourceUtxos[0];assert.equal(points[0].txid,prev.txId);assert.equal(Number(points[0].index),prev.outputIndex);
   return new Response(JSON.stringify({code:'200',data:{txos:[{txid:prev.txId,index:String(prev.outputIndex),value:String(prev.satoshis),scriptPubKey:prev.script,spent:false}]}}));}});
 const reviewInput={request,context:{origin:'https://reviewer.test',chainId:'tbc:testnet',accountId:`tbc:testnet:${address}`,sessionId:'child',navigationId:'child'},operationDigest:reviewerKit.hashCanonical({kind:'signAssociated',request})};
 {
  const reviewed=await reviewer.review(reviewInput);assert.equal(reviewed.preview.transactions.length,2);
  const parent=reviewed.preview.transactions[0],child=reviewed.preview.transactions[1];
  assert.equal(parent.htlcLocks[0].branch,'unresolved');assert.equal(child.htlcLocks[0].branch,row.kind);assert.equal(child.htlcLocks[0].preimageVerified,row.kind==='claim');
  const nativeChild=new tbc.Transaction(row.childStage.txraw);
  assert.equal(child.htlcLocks[0].transactionLockTime,nativeChild.nLockTime);
  assert.equal(child.htlcLocks[0].sequence,nativeChild.inputs[0].sequenceNumber);
  assert.equal(JSON.stringify(reviewed).includes('33'.repeat(32)),false);assert.equal(reads,1);childReviewReads+=reads;
 }
}
assert.equal(childStages,6);assert.equal(childVmInputs,6);assert.equal(childRefunds,2);assert.equal(childVmRejections,6);assert.equal(childReviewReads,3);
let childBoundaryCases=0;
if(!installedPath){
 const materialize=reviewerKit.materializeAssociatedReviewRequest;
 const height=childRows.find(r=>r.kind==='refund'&&new tbc.Transaction(r.childStage.txraw).nLockTime<500000000);
 const timestamp=childRows.find(r=>r.kind==='refund'&&new tbc.Transaction(r.childStage.txraw).nLockTime>=500000000);
 const base=structuredClone(height.prepareParent.request),external=structuredClone(base);
 const parent=new tbc.Transaction(base.sourceTxraw),output=parent.outputs[0];
 Object.assign(external.inputs[0][0],{txId:parent.id,script:output.script.toHex(),satoshis:output.satoshis,preTx:parent.toString()});
 assert.equal(new tbc.Transaction(materialize(external).txraws[1]).nLockTime,834801);childBoundaryCases++;
 for(const mutate of [i=>{delete i.preTx},i=>{i.txId='11'.repeat(32)},i=>{i.satoshis++},i=>{i.outputIndex=99}]){
  const bad=structuredClone(external);mutate(bad.inputs[0][0]);assert.throws(()=>materialize(bad));childBoundaryCases++;
 }
 const multiple=structuredClone(base),p=new tbc.Transaction(base.sourceTxraw);
 const second=new tbc.Transaction(timestamp.prepareParent.request.sourceTxraw).outputs[0];
 p.addOutput(new tbc.Transaction.Output({satoshis:second.satoshis,script:second.script}));
 multiple.sourceTxraw=p.toString();multiple.sourceUtxos[0].satoshis+=second.satoshis;
 multiple.inputs[0].push({...multiple.inputs[0][0],outputIndex:1});
 assert.throws(()=>materialize(multiple),/mix height and timestamp/);childBoundaryCases++;
 // Same-domain max, independently compared with the Rust prepare result.
 const code=output.script.toBuffer();code.writeUInt32LE(834802,61);
 p.outputs[1].setScript(tbc.Script.fromBuffer(code));multiple.sourceTxraw=p.toString();
 const preview=materialize(multiple),stage=JSON.parse(await engine.execute('prepareReviewedStage',JSON.stringify({format:'associated',request:multiple,
  publicKey:height.prepareParent.publicKey,transactionIndex:1,previousTransactions:[multiple.sourceTxraw]})));
 assert.equal(new tbc.Transaction(preview.txraws[1]).nLockTime,834802);assert.equal(preview.txraws[1],stage.txraw);childBoundaryCases++;
}
const out=mkdtempSync(join(tmpdir(),'tbc-reviewed-htlc-child-'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const sourceFiles=['packages/tbc-engine/rust/crates/tbc-keyless-core/src/reviewed.rs','packages/tbc-engine/rust/crates/tbc-keyless-core/src/reviewed/current_token.rs',
 'packages/tbc-engine/rust/crates/tbc-keyless-core/tests/reviewed_htlc.rs','packages/kit/src/reviewed-transaction-reviewer.ts','packages/kit/src/reviewed-htlc-witness.ts'];
const report={status:'PASS',mode:installedPath?'installed-package':'source',installedVersion,nativeWasmCases:valid,privateProjectionMode:'source',invalidCases:invalid,independentVmInputs:vmInputs,independentVmRejections:vmInvalidProofs,publicProjectionCases,projectionRejections,
 childStages,childVmInputs,childReviewReads,childRefunds,childVmRejections,childBoundaryCases,sourceHashes:Object.fromEntries(sourceFiles.map(p=>[p,sha(readFileSync(join(root,p)))])),
 wasmSha256:sha(readFileSync(installedPath?join(installedPath,'artifacts/wasm/tbc_keyless_wasm.wasm'):join(rust,'target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm'))),
 externalRequests:0,authorizedSignatures:0,broadcasts:0,publicAssociatedChildReviewerTested:true,deviceAcceptance:false,frozenArtifactsModified:false};
writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...report,out}));
