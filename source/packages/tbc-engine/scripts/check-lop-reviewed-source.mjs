// Audit actual new LOP raw transactions through the shared default reviewer.
// Fixture TXO status only; --detached-signatures uses public scalar 1/4 for
// separate cryptographic parity, never wallet authorization or full signing.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {sourceKeylessFixtureRuntime} from './lib/source-keyless-fixture-runtime.mjs';
import {checkAssociatedLopHost} from './lib/check-associated-lop-host.mjs';
import {fileURLToPath} from 'node:url';
import {registerHooks,createRequire} from 'node:module';
import {build} from 'esbuild';
import {secp256k1} from '@noble/curves/secp256k1.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const dependency=createRequire(`${root}packages/kit/package.json`),tbc=dependency('tbc-lib-js');
const {Transaction,Script}=tbc,sighash=dependency('tbc-lib-js/lib/transaction/sighash');
assert.equal(dependency('tbc-lib-js/package.json').version,'1.0.31');
const cryptoOnly=process.argv.includes('--detached-signatures');
const associatedTemplates=process.argv.includes('--associated-templates');
const currentProofs=process.argv.includes('--current-proofs');
const checkHost=process.argv.includes('--host');
assert.ok(!checkHost||currentProofs,'Host audit requires current shared proofs');
assert.ok(!currentProofs||associatedTemplates,'Current proof audit requires associated checks');
assert.ok(!associatedTemplates||cryptoOnly,'Associated template audit requires detached-signature comparison');
// Public synthetic fixtures only. No wallet vault/key retrieval is available.
const keys=new Map([1,4].map(n=>{const key=new tbc.PrivateKey(new tbc.crypto.BN(n));return[key.publicKey.toString(),key]}));
const wasmBuild=spawnSync('cargo',['build','--offline','--locked','--release','-p','tbc-keyless-wasm','--target','wasm32-unknown-unknown'],
  {cwd:`${root}packages/tbc-engine/rust`,env:{...process.env,RUSTFLAGS:'--cfg getrandom_backend="unsupported"'},encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
assert.equal(wasmBuild.status,0,'Source keyless WASM build failed');
const run=spawnSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test','lop_public','uses_shared_bound_signer_and_finalize','--','--test-threads=1','--nocapture'],
  {cwd:`${root}packages/tbc-engine/rust`,env:{...process.env,LOP_PUBLIC_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:24*1024*1024});
assert.equal(run.status,0,'Public Rust fixture failed; raw output withheld');
const marker='LOP_PUBLIC_WIRE:',rows=run.stdout.split('\n').filter(l=>l.includes(marker)).map(l=>JSON.parse(l.slice(l.indexOf(marker)+marker.length)));
const inputs=rows.filter(r=>r.definition==='planParams').map(r=>r.value),plans=rows.filter(r=>r.definition==='planResult').map(r=>r.value);
const finalized=rows.filter(r=>r.definition==='finalizeResult').map(r=>r.value);
assert.equal(inputs.length,27);assert.equal(plans.length,27);
assert.equal(finalized.length,27);
const built=await build({stdin:{contents:`
export {createTbcDefaultRawTransactionReviewer,createTbcDefaultAssociatedTransactionReviewer} from './packages/kit/src/reviewed-transaction-reviewer.ts';
export {createTbcWallet} from './packages/kit/src/wallet-runtime.ts';
export {createApprovalHostEvidenceReader} from './packages/kit/src/approval-host-evidence.ts';
export {projectTbcApprovalPresentation} from './packages/kit/src/approval-presentation.ts';
export {createMemoryTwsHostStore} from './packages/host/src/index.ts';
export {assertValidTws,TWS_RELEASE_FINGERPRINT} from './packages/core/src/index.ts';
export {createTbcNetworkContext} from './packages/kit/src/network-context.ts';
export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';
export {createTbcStandardWorkflowCapabilities} from './packages/kit/src/standard-workflow-capabilities.ts';
export {inspectReviewedTokenCodes,inspectReviewedTokenPairs} from './packages/kit/src/reviewed-token.ts';
export {hashCanonical} from './packages/core/src/index.ts';
export {normalizeTbcReviewedTransactionMaterial} from './packages/kit/src/standard-workflow-capabilities.ts';
export {inspectTbcTransaction} from './packages/kit/src/testnet-validation.ts';`,resolveDir:root,loader:'ts'},
  alias:{'@tbc-wallet/core':`${root}packages/core/src/index.ts`,'@tbc-wallet/host':`${root}packages/host/src/index.ts`,
    '@tbc-wallet/provider':`${root}packages/provider/src/index.ts`,'@tbc-wallet/provider/in-memory':`${root}packages/provider/src/in-memory.ts`},
  plugins:[{name:'current-portable-parser',setup(b){b.onResolve({filter:/^\.\/vendor\/tbc-tx-parser\/index\.js$/},()=>({path:`${root}packages/kit/dist/esm/vendor/tbc-tx-parser/index.js`}))}}],
  banner:{js:"import {createRequire as auditRequire} from 'node:module'; const require=auditRequire(import.meta.url);"},
  bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const virtual=new URL('../../../packages/kit/src/.lop-reviewed-check.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,next){return s===virtual?{url:virtual,shortCircuit:true}:next(s,c)},
  load(u,c,next){return u===virtual?{source:built.outputFiles[0].text,format:'module',shortCircuit:true}:next(u,c)}});
const kit=await import(virtual);hooks.deregister();
const runtime=await sourceKeylessFixtureRuntime(root,{parity:process.argv.includes('--native-parity')}),keyless=runtime.engine;
const nativeRun=spawnSync('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','lop_material','--','--nocapture'],
  {cwd:`${root}packages/tbc-engine/rust`,env:{...process.env,LOP_REVIEW_DUMP_WIRE:'1',LOP_MATERIAL_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
assert.equal(nativeRun.status,0,'Local material/inspection tests failed');
const parityRows=nativeRun.stdout.split('\n').filter(line=>/^LOP_(REVIEW|MATERIAL)_WIRE:/.test(line)).map(line=>JSON.parse(line.slice(line.indexOf(':')+1)));
assert.equal(parityRows.length,5);
for(const row of parityRows)assert.deepEqual(JSON.parse(await keyless.execute('inspectLopMaterial',JSON.stringify(row.input))),row.result);
const tokenRun=spawnSync('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','token_material','--','--nocapture'],
  {cwd:`${root}packages/tbc-engine/rust`,env:{...process.env,TOKEN_MATERIAL_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
assert.equal(tokenRun.status,0,'Shared Token material test failed');
const tokenParity=tokenRun.stdout.split('\n').filter(line=>line.startsWith('TOKEN_MATERIAL_WIRE:')).map(line=>JSON.parse(line.slice(line.indexOf(':')+1)));
assert.equal(tokenParity.length,6);
for(const row of tokenParity)assert.deepEqual(JSON.parse(await keyless.execute('inspectTokenMaterial',JSON.stringify(row.input))),row.result);
let associatedNativeWasmParity=0;
if(associatedTemplates){
  const native=spawnSync('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','reviewed','associated_lop_match_reuses_shared_proof_and_only_requests_needed_signatures','--','--exact','--nocapture'],
    {cwd:`${root}packages/tbc-engine/rust`,env:{...process.env,REVIEWED_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  assert.equal(native.status,0,'Associated Native fixture failed; public raw withheld');
  const rows=native.stdout.split('\n').filter(l=>l.startsWith('REVIEWED_WIRE:')).map(l=>JSON.parse(l.slice(14)));
  assert.equal(rows.length,2);
  for(const row of rows){assert.deepEqual(JSON.parse(await keyless.execute(row.operation,JSON.stringify(row.input))),row.result);associatedNativeWasmParity++;}
}
const reports=[];let tamperedTemplatesRejected=0,standardPreviewsBound=0;
let detachedFixtureSignatures=0,detachedTransactions=0;
let inspectedTokenPairs=0,currentNegativeCases=0,lockedReviewVariants=0,lockedNegativeCases=0;
const associatedReports=[];let associatedVmInputs=0,associatedPreviewsBound=0,associatedFixtureSignatures=0;
let cancellationNegatives=0;
const hostChecks=[],hostVectors=[];
for(const [index,input]of inputs.entries()){
  const raw=plans[index].plan.payload.transactions[0].unsignedTransaction,tx=kit.inspectTbcTransaction(raw);
  const status=new Map();
  // Fixture ancestors include synthetic zero-input funding. Use the fixture
  // codec only to populate the intercepted API, never relax runtime validation.
  for(const p of input.snapshot.payload.parents){const parent=new Transaction(p.rawTransaction);
    for(const [vout,out]of parent.outputs.entries())status.set(`${p.txid}:${vout}`,{txid:p.txid,index:String(vout),value:String(out.satoshis),scriptPubKey:out.script.toHex(),spent:false,height:'1'});}
  for(const u of input.snapshot.payload.utxos)status.set(`${u.txid}:${u.vout}`,{txid:u.txid,index:String(u.vout),value:u.satoshis,scriptPubKey:u.scriptPubKey,spent:false,height:'1'});
  const selected=tx.transaction.inputs.map(p=>{const s=status.get(`${p.txid}:${p.vout}`);assert.ok(s,'Fixture input material missing');return s});let reads=0;
  const resolvedOutputs=[...status.values()].map(s=>({txid:s.txid,vout:Number(s.index),satoshis:s.value,scriptPubKey:s.scriptPubKey}));
  // Pure material preparation for the pending shared flow reviewer, not an
  // acceptance override. Use authenticated fixture siblings, never fake parents.
  const material=[...selected.map(s=>({codeScript:s.scriptPubKey,codeSatoshis:Number(s.value),
    tape:status.get(`${s.txid}:${Number(s.index)+1}`)})),
    ...tx.transaction.outputs.map((out,i)=>({codeScript:Buffer.from(out.scriptPubKey).toString('hex'),codeSatoshis:Number(out.satoshis),
      tape:tx.transaction.outputs[i+1]===undefined?undefined:{scriptPubKey:Buffer.from(tx.transaction.outputs[i+1].scriptPubKey).toString('hex'),value:String(tx.transaction.outputs[i+1].satoshis)}}))];
  const hints=await kit.inspectReviewedTokenCodes(keyless,material.map(m=>m.codeScript));
  const recognized=material.flatMap((m,i)=>hints[i]===null?[]:[m]);
  if(recognized.length){
    const pairs=await kit.inspectReviewedTokenPairs(keyless,recognized.map(m=>{assert.ok(m.tape,'Exact Token requires adjacent Tape');
      return {codeScript:m.codeScript,codeSatoshis:m.codeSatoshis,tapeScript:m.tape.scriptPubKey,tapeSatoshis:Number(m.tape.value)};}));
    assert.equal(pairs.length,recognized.length);assert.ok(pairs.every(p=>p.code.assetIdentityVerified===false));
    inspectedTokenPairs+=pairs.length;
  }
  let associatedRequest;
  if(cryptoOnly){
    const publicKey=input.snapshot.payload.account.publicKey,key=keys.get(publicKey);assert.ok(key,'Only known public fixture keys allowed');
    const stage=JSON.parse(await keyless.execute('prepareReviewedStage',JSON.stringify({format:'raw',publicKey,resolvedOutputs,
      request:{txraws:[raw],utxosSatoshis:[selected.map(s=>Number(s.value))],scriptPubkeys:[selected.map(s=>s.scriptPubKey)]}})));
    assert.equal(stage.format,'raw');
    const sdk=new Transaction(raw);
    sdk.inputs.forEach((i,index)=>{i.output=new Transaction.Output({script:Script.fromHex(selected[index].scriptPubKey),satoshis:Number(selected[index].value)});});
    const signatures=stage.digests.map((digest,index)=>{
      const expected=sighash.sighash(sdk,0x41,index,sdk.inputs[index].output.script,new tbc.crypto.BN(selected[index].value));
      assert.equal(Buffer.from(expected).reverse().toString('hex'),digest,'Keyless/independent SDK digest parity');
      return secp256k1.sign(digest,key.toBuffer(),{prehash:false,lowS:true}).toCompactHex();
    });
    const result=JSON.parse(await keyless.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
    assert.equal(result.txraw,raw,'Detached signing must not manufacture covenant witnesses');assert.equal(result.txid,tx.txid);
    assert.deepEqual(result.sigs,sdk.inputs.map((_,index)=>sdk.getSignature(index,key)),'Independent SDK detached signature parity');
    detachedFixtureSignatures+=result.sigs.length;detachedTransactions++;
    if(associatedTemplates){
      const reference=new Transaction(finalized[index].bundle.transactions[0].rawTransaction);
      const missing=[];
      const sourceUtxos=selected.map((s,i)=>{
        if(currentProofs){
          const base={txId:s.txid,outputIndex:Number(s.index),satoshis:Number(s.value),script:s.scriptPubKey};
          if(hints[i]){
            const parent=input.snapshot.payload.parents.find(p=>p.txid===s.txid);assert.ok(parent);
            const decoded=new Transaction(parent.rawTransaction),tape=decoded.outputs[Number(s.index)+1].script.toBuffer();
            const ids=new Set(Array.from({length:6},(_,slot)=>tape.readBigUInt64LE(3+slot*8)>0n?decoded.inputs[slot].prevTxId.toString('hex'):null).filter(Boolean));
            const ancestors=[...ids].map(id=>{const p=input.snapshot.payload.parents.find(p=>p.txid===id);assert.ok(p,'Missing selected synthetic ancestor');return p.rawTransaction;});
            return {...base,scriptSigType:hints[i].standardId,preTx:parent.rawTransaction,ancestorTransactions:ancestors};
          }
          if(/^76a914[0-9a-f]{40}88ac$/.test(s.scriptPubKey))return {...base,scriptSigType:'p2pkh'};
        }
        const chunks=reference.inputs[i].script.chunks;
        const positions=chunks.flatMap((chunk,j)=>chunk.buf?.toString('hex')===result.sigs[i]?[j]:[]);
        if(positions.length!==1){
          if(input.request.intent.type==='tbc-lop-match'&&(i===0||i===2)&&positions.length===0){
            const parent=input.snapshot.payload.parents.find(p=>p.txid===s.txid);assert.ok(parent);
            return {txId:s.txid,outputIndex:Number(s.index),satoshis:Number(s.value),script:s.scriptPubKey,
              scriptSigType:'tbc_lop_match',preTx:parent.rawTransaction};
          }
          missing.push(i);return null;
        }
        // Only replace a complete data-push, never bytes nested in proof data.
        const template=new Script();
        chunks.forEach((chunk,j)=>template.add(j===positions[0]?Buffer.from('signature'):chunk));
        return {txId:s.txid,outputIndex:Number(s.index),satoshis:Number(s.value),script:s.scriptPubKey,
          scriptSigType:'other',unfinishedScriptSig:template.toHex()};
      });
      if(missing.length){
        associatedReports.push({index,intent:input.request.intent.type,status:'unsupported-template',inputsWithoutOneWalletSignature:missing});
      }else{
        associatedRequest={sourceTxraw:raw,sourceUtxos,inputs:[],outputs:[]};
        const associatedStage=JSON.parse(await keyless.execute('prepareReviewedStage',JSON.stringify({format:'associated',publicKey,resolvedOutputs,request:associatedRequest})));
        const signingIndexes=sourceUtxos.flatMap((u,i)=>u.scriptSigType==='tbc_lop_match'?[]:[i]);
        assert.deepEqual(associatedStage.signingInputIndexes,signingIndexes);
        assert.deepEqual(associatedStage.digests,signingIndexes.map(i=>stage.digests[i]));
        const selectedSignatures=signingIndexes.map(i=>signatures[i]);
        associatedFixtureSignatures+=selectedSignatures.length;
        const assembled=JSON.parse(await keyless.execute('finalizeReviewedStage',JSON.stringify({stage:associatedStage,signatures:selectedSignatures,signatureEncoding:'compact64'})));
        assert.equal(assembled.txraw,reference.uncheckedSerialize(),'Associated assembly must reproduce independently verified Engine witnesses');
        if(input.request.intent.type==='tbc-lop-cancel'){
          for(const mutate of [u=>{u.unfinishedScriptSig=u.unfinishedScriptSig.slice(0,-2)+'51';},
            u=>{u.unfinishedScriptSig+='00';},u=>{u.scriptSigType='p2pkh';},u=>{u.unfinishedScriptSig=u.unfinishedScriptSig.replace(publicKey,'02'+'11'.repeat(32));}]){
            const bad=structuredClone(associatedRequest);mutate(bad.sourceUtxos[0]);
            await assert.rejects(()=>keyless.execute('prepareReviewedStage',JSON.stringify({format:'associated',publicKey,resolvedOutputs,request:bad})),/Invalid associated LOP cancellation witness/);
            const tampered=structuredClone(associatedStage);tampered.inputs=bad.sourceUtxos;
            await assert.rejects(()=>keyless.execute('finalizeReviewedStage',JSON.stringify({stage:tampered,signatures:selectedSignatures,signatureEncoding:'compact64'})),/Invalid associated LOP cancellation witness/);
            cancellationNegatives+=2;
          }
        }
        const verified=new Transaction(assembled.txraw);
        verified.inputs.forEach((item,i)=>{item.output=sdk.inputs[i].output;
          assert.equal(verified.verifyScript(i).success,true,`Associated LOP sample ${index} input ${i}`);associatedVmInputs++;});
        if(index===15){
          const prepare=req=>keyless.execute('prepareReviewedStage',JSON.stringify({format:'associated',publicKey,resolvedOutputs,request:req}));
          for(const [field,value]of [['preTx',input.snapshot.payload.parents.find(p=>p.txid!==sourceUtxos[0].txId).rawTransaction],['satoshis',301],['script',selected[1].scriptPubKey],['unfinishedScriptSig','51']]){
            const bad=structuredClone(associatedRequest);bad.sourceUtxos[0][field]=value;
            await assert.rejects(prepare(bad),field==='preTx'?/Reviewed policy parent identity mismatch/:
              field==='unfinishedScriptSig'?/LOP/:/Reviewed policy material conflict/);
          }
          const bad=structuredClone(associatedStage);bad.signingInputIndexes[0]=0;
          await assert.rejects(keyless.execute('finalizeReviewedStage',JSON.stringify({stage:bad,signatures:selectedSignatures,signatureEncoding:'compact64'})),/stage mismatch/);
        }
      }
    }
  }
  let metadataReads=0,fault='';const httpFixtures=new Map();
  const reviewerOptions={materialNative:keyless,network:kit.createTbcNetworkContext({network:'testnet'}),fetch:async(url,init)=>{
    const path=new URL(String(url)).pathname;let data;
    if(path==='/api/tbc/txo/status'){
      assert.equal(init.method,'POST');reads++;
      const requested=JSON.parse(init.body).txos;data={txos:requested.map(p=>{const s=status.get(`${p.txid}:${p.index}`);assert.ok(s,'Fixture dependency missing');
        return fault==='tape-value'&&s.value==='0'?{...s,value:'1'}:s;})};
    }else{
      assert.equal(init.method??'GET','GET');metadataReads++;
      const match=path.match(/^\/api\/tbc\/(ft\/info\/contract|stablecoin\/info\/stablecoinid)\/([0-9a-f]{64})$/);assert.ok(match,'Only bounded official asset metadata allowed');
      const id=match[2],contract=input.snapshot.payload.contracts.find(c=>c.contractId===id);assert.ok(contract,'Fixture contract missing');
      const point=contract.currentOutpoint??contract.genesisOutpoint;assert.ok(point,'Fixture contract point missing');
      const code=status.get(`${point.txid}:${point.vout}`);assert.ok(code,'Fixture indexed Code missing');
      data={code_script:fault==='metadata'?'51':code.scriptPubKey,...(match[1].startsWith('stablecoin')?{stablecoin_id:id}:{})};
    }
    const body=JSON.stringify({code:'200',data});
    if(!fault)httpFixtures.set(JSON.stringify([path,init.method??'GET',init.body??null]),body);
    return new Response(body,{status:200});}};
  const reviewer=kit.createTbcDefaultRawTransactionReviewer(reviewerOptions);
  let reviewAccepted=false;
  try{const result=await reviewer.review({request:{txraws:[raw],utxos_satoshis:[selected.map(s=>Number(s.value))],script_pubkeys:[selected.map(s=>s.scriptPubKey)]},
    context:{origin:'https://reviewer.test',chainId:'tbc:testnet',accountId:input.snapshot.payload.account.accountId,sessionId:'audit',navigationId:'audit'},transactionIds:[tx.txid]});
    reviewAccepted=true;const preview=result.preview.transactions[0];
    assert.ok(preview.orderTerms,'Accepted LOP must retain exact order terms');
    const orders=[...preview.orderTerms.inputs,...preview.orderTerms.outputs];assert.ok(orders.length>0);
    for(const {terms}of orders){assert.equal(terms.standardId,'tbc-lop');assert.equal(terms.feeScale,'1000000');assert.equal(typeof terms.saleVolume,'string');}
    const account={...input.snapshot.payload.account,chainId:'tbc:testnet',accountId:`tbc:testnet:${input.snapshot.payload.account.address}`},origin='https://reviewer.test';
    const standardRequest={payload:{format:'raw',transactions:[{rawTransaction:raw,inputs:selected.map(s=>({satoshis:s.value,scriptPubKey:s.scriptPubKey}))}]}};
    let projectionReview=result;
    let projectionAssociated;
    const capabilities=kit.createTbcStandardWorkflowCapabilities({chainId:'tbc:testnet',account,networkSourceIdentity:'fixture',materialNative:keyless,
      navigation:{origin,sessionId:'audit',navigationId:'audit'},readCurrentAuthority:async()=>({...account,networkSourceIdentity:'fixture'}),
      // Reuse this exact trusted review: this projection check is not a second
      // chain review or an execution/signature authorization.
      rawReviewer:{review:async()=>projectionReview},associatedReviewer:{review:async()=>{assert.ok(projectionAssociated);return projectionAssociated}},
      privateNative:{},now:()=>new Date().toISOString().replace(/\.\d{3}Z$/u,'Z')});
    const bound=await capabilities.reviewedTransaction.review({version:'1.0',origin,sessionId:'audit',chainId:'tbc:testnet',
      accountId:account.accountId,publicKey:account.publicKey,request:standardRequest,requestHash:kit.hashCanonical(standardRequest)},
      {operation:'reviewedTransaction.review'});
    assert.deepEqual(bound.payload.preview.lopOrders,[{...preview.orderTerms,transactionIndex:0}]);
    if(preview.coinLocks)assert.deepEqual(bound.payload.preview.coinLocks,preview.coinLocks.map(l=>({...l,transactionIndex:0})));
    assert.equal(bound.reviewHash,kit.hashCanonical(bound.payload));standardPreviewsBound++;
    if(associatedRequest){
      const standardAssociated={payload:{format:'associated',sourceTransaction:raw,children:[],sourceInputs:associatedRequest.sourceUtxos.map(u=>({
        txid:u.txId,outputIndex:u.outputIndex,satoshis:String(u.satoshis),scriptPubKey:u.script,
        signingProfile:u.scriptSigType==='tbc_lop_match'?'tbc-lop-match':u.scriptSigType==='other'?'contract-template':u.scriptSigType,
        ...(u.preTx?{previousTransaction:u.preTx}:{}),...(u.unfinishedScriptSig?{unlockingScriptTemplate:u.unfinishedScriptSig}:{}),
        ...(u.ancestorTransactions?{ancestorTransactions:u.ancestorTransactions}:{})}))}};
      assert.deepEqual(kit.normalizeTbcReviewedTransactionMaterial(standardAssociated).request,associatedRequest);
      const before=[reads,metadataReads];
      const associated=await kit.createTbcDefaultAssociatedTransactionReviewer(reviewerOptions).review({
        request:associatedRequest,publicKey:account.publicKey,operationDigest:kit.hashCanonical({kind:'signAssociated',request:associatedRequest}),
        context:{origin,chainId:'tbc:testnet',accountId:account.accountId,sessionId:'audit',navigationId:'audit'}});
      assert.deepEqual(associated.preview.transactions[0].orderTerms,preview.orderTerms);
      assert.equal(associated.preview.transactions[0].txidKind,'unsigned-preview');
      projectionAssociated=associated;
      const associatedBound=await capabilities.reviewedTransaction.review({version:'1.0',origin,sessionId:'audit',chainId:'tbc:testnet',
        accountId:account.accountId,publicKey:account.publicKey,request:standardAssociated,requestHash:kit.hashCanonical(standardAssociated)},
        {operation:'reviewedTransaction.review'});
      assert.deepEqual(associatedBound.payload.preview.lopOrders,[{...preview.orderTerms,transactionIndex:0}]);
      assert.equal(associatedBound.reviewHash,kit.hashCanonical(associatedBound.payload));associatedPreviewsBound++;
      associatedReports.push({index,intent:input.request.intent.type,status:'source-template-verified',reads:reads-before[0],metadataReads:metadataReads-before[1]});
      if(checkHost&&[1,4,15,21].includes(index)){
        const expectedReads=reads-before[0]+metadataReads-before[1];
        const checks=await checkAssociatedLopHost({kit,keyless,account,request:standardAssociated,
          reviewer:kit.createTbcDefaultAssociatedTransactionReviewer(reviewerOptions),signer:keys.get(account.publicKey),
          expectedRaw:finalized[index].bundle.transactions[0].rawTransaction,expectedOrders:associatedBound.payload.preview.lopOrders,
          readCount:()=>reads+metadataReads,expectedReads});
        const profiles=[...new Set(associatedRequest.sourceUtxos.map(u=>u.scriptSigType))];
        hostChecks.push(...checks.map(check=>({index,intent:input.request.intent.type,profiles,...check})));
        const scalar=[1,4].find(n=>new tbc.PrivateKey(new tbc.crypto.BN(n)).publicKey.toString()===account.publicKey);assert.ok(scalar);
        hostVectors.push({index,intent:input.request.intent.type,profiles,account,request:standardAssociated,publicSyntheticScalar:scalar,
          expectedRaw:finalized[index].bundle.transactions[0].rawTransaction,expectedOrders:associatedBound.payload.preview.lopOrders,
          expectedReads,responses:[...httpFixtures]});
      }
      // The baseline counters describe one raw review, not this extra audit.
      reads=before[0];metadataReads=before[1];
    }
    reports.push({index,intent:input.request.intent.type,status:'accepted',reads,metadataReads,
      classification:preview.classification,assetGroups:preview.groups.length,
      hasOrderTerms:Object.hasOwn(preview,'orderTerms')||Object.hasOwn(preview,'protocolDetails')});
    if(index===7){
      const bad=new Transaction(raw),vout=preview.orderTerms.outputs[0].index;
      const code=bad.outputs[vout].script.toHex();bad.outputs[vout].setScript(Script.fromHex('61'+code.slice(2)));
      const badRaw=bad.uncheckedSerialize(),badId=kit.inspectTbcTransaction(badRaw).txid;
      await assert.rejects(reviewer.review({request:{txraws:[badRaw],utxos_satoshis:[selected.map(s=>Number(s.value))],script_pubkeys:[selected.map(s=>s.scriptPubKey)]},
        context:{origin:'https://reviewer.test',chainId:'tbc:testnet',accountId:input.snapshot.payload.account.accountId,sessionId:'audit',navigationId:'audit'},transactionIds:[badId]}),
        /LOP review requires an exact supported order template/);
      tamperedTemplatesRejected++;
    }
    if(index===9){
      const reviewRaw=async changed=>reviewer.review({request:{txraws:[changed],utxos_satoshis:[selected.map(s=>Number(s.value))],script_pubkeys:[selected.map(s=>s.scriptPubKey)]},
        context:{origin:'https://reviewer.test',chainId:'tbc:testnet',accountId:input.snapshot.payload.account.accountId,sessionId:'audit',navigationId:'audit'},transactionIds:[kit.inspectTbcTransaction(changed).txid]});
      for(const [value,expected]of [['metadata',/Indexed Token Code identity differs/],['tape-value',/Trusted Token Tape unavailable/]]){
        fault=value;await assert.rejects(reviewRaw(raw),expected);currentNegativeCases++;fault='';
      }
      const orderIndex=preview.orderTerms.outputs[0].index,tokenIndex=orderIndex+1,tapeIndex=tokenIndex+1;
      const changedBalance=new Transaction(raw),tape=Buffer.from(changedBalance.outputs[tapeIndex].script.toHex(),'hex');
      tape.writeBigUInt64LE(tape.readBigUInt64LE(3)+1n,3);changedBalance.outputs[tapeIndex].setScript(Script.fromHex(tape.toString('hex')));
      await assert.rejects(reviewRaw(changedBalance.uncheckedSerialize()),/Raw Token conservation differs/);currentNegativeCases++;
      const changedController=new Transaction(raw),script=changedController.outputs[tokenIndex].script.toHex();
      const [tokenCode]=await kit.inspectReviewedTokenCodes(keyless,[script]);assert.ok(tokenCode);
      const offset=script.lastIndexOf(tokenCode.controller);assert.ok(offset>=0);
      changedController.outputs[tokenIndex].setScript(Script.fromHex(script.slice(0,offset)+'44'.repeat(20)+'00'+script.slice(offset+42)));
      await assert.rejects(reviewRaw(changedController.uncheckedSerialize()),/LOP escrow is not bound/);currentNegativeCases++;
      const unknown=new Transaction(raw);unknown.outputs.at(-1).setScript(Script.fromHex('51'));
      await assert.rejects(reviewRaw(unknown.uncheckedSerialize()),/Unrecognized current raw transaction script/);currentNegativeCases++;
    }
    const coinIndex=selected.findIndex((_,i)=>hints[i]?.standardId==='tbc20-stablecoin');
    if(lockedReviewVariants===0&&input.request.intent.type==='tbc-lop-create'&&coinIndex>=0){
      // Canonical raw parents with modified public lock fixtures. These are
      // local review predicates, not a claim that the synthetic parents mined.
      const original=selected[coinIndex],parentRaw=input.snapshot.payload.parents.find(p=>p.txid===original.txid)?.rawTransaction;assert.ok(parentRaw);
      for(const lock of [12,500000001]){
        const parent=new Transaction(parentRaw),vout=Number(original.index),tape=Buffer.from(parent.outputs[vout+1].script.toHex(),'hex');
        tape.writeUInt32LE(lock,tape.length-14);parent.outputs[vout+1].setScript(Script.fromHex(tape.toString('hex')));
        const parentId=parent.id;for(const [i,o]of parent.outputs.entries())status.set(`${parentId}:${i}`,{txid:parentId,index:String(i),value:String(o.satoshis),scriptPubKey:o.script.toHex(),spent:false,height:'1'});
        const changed=new Transaction(raw);changed.inputs[coinIndex].prevTxId=Buffer.from(parentId,'hex');changed.nLockTime=lock;
        changed.inputs[coinIndex].sequenceNumber=4294967294;
        const outputCodes=await kit.inspectReviewedTokenCodes(keyless,changed.outputs.map(o=>o.script.toHex()));
        for(const [i,c]of outputCodes.entries())if(c?.standardId==='tbc20-stablecoin'){
          const outTape=Buffer.from(changed.outputs[i+1].script.toHex(),'hex');outTape.writeUInt32LE(lock,outTape.length-14);changed.outputs[i+1].setScript(Script.fromHex(outTape.toString('hex')));
        }
        const reviewVariant=async candidate=>{const raw=candidate.uncheckedSerialize();return reviewer.review({request:{txraws:[raw],utxos_satoshis:[selected.map(s=>Number(s.value))],script_pubkeys:[selected.map(s=>s.scriptPubKey)]},
          context:{origin,chainId:'tbc:testnet',accountId:account.accountId,sessionId:'audit',navigationId:'audit'},transactionIds:[kit.inspectTbcTransaction(raw).txid]});};
        const before=[reads,metadataReads],result=await reviewVariant(changed),locks=result.preview.transactions[0].coinLocks;
        assert.ok(locks.some(l=>l.position==='input'&&l.lockTime===lock&&l.scriptLockChecked===true&&l.chainMaturityChecked===false));
        assert.ok(locks.some(l=>l.position==='output'&&l.lockTime===lock&&l.scriptLockChecked===false));
        assert.deepEqual([reads-before[0],metadataReads-before[1]],[2,1],'Locks add no query');
        projectionReview=result;
        const request={payload:{...standardRequest.payload,transactions:[{...standardRequest.payload.transactions[0],rawTransaction:changed.uncheckedSerialize()}]}};
        const projected=await capabilities.reviewedTransaction.review({version:'1.0',origin,sessionId:'audit',chainId:'tbc:testnet',accountId:account.accountId,publicKey:account.publicKey,request,requestHash:kit.hashCanonical(request)},{operation:'reviewedTransaction.review'});
        assert.deepEqual(projected.payload.preview.coinLocks,locks.map(l=>({...l,transactionIndex:0})));assert.ok(projected.payload.preview.warnings.includes('LOCKED_ASSET'));
        assert.equal(projected.reviewHash,kit.hashCanonical(projected.payload));lockedReviewVariants++;
        for(const [txLock,sequence,pattern]of [[lock-1,4294967294,/parent lock exceeds/],[lock<500000000?500000000:12,4294967294,/different domains/],[lock,4294967295,/requires nonfinal sequence/]]){
          const bad=new Transaction(changed.uncheckedSerialize());bad.nLockTime=txLock;bad.inputs[coinIndex].sequenceNumber=sequence;
          await assert.rejects(reviewVariant(bad),pattern);lockedNegativeCases++;
        }
      }
    }
  }catch(error){if(reviewAccepted||error.code==='ERR_ASSERTION')throw error;
    assert.ok(!/Dynamic require|Fixture dependency|is not a function/.test(error.message),error.message);
    reports.push({index,intent:input.request.intent.type,status:'rejected',reads,metadataReads,reason:error.message});}
}
assert.ok(reports.every(row=>row.reads>=1&&row.reads<=2),'Every sample must actually reach bounded material inspection');
assert.ok(reports.every(row=>row.metadataReads<=2),'At most one metadata read per actual token identity');
assert.equal(tamperedTemplatesRejected,1,'Exact template negative must actually run');
assert.equal(currentNegativeCases,5,'Current token negatives must actually run');
assert.equal(lockedReviewVariants,2);assert.equal(lockedNegativeCases,6);
if(associatedTemplates){
  assert.equal(associatedReports.filter(r=>r.status==='source-template-verified').length,27);
  assert.equal(associatedReports.filter(r=>r.status==='unsupported-template').length,0);
  assert.equal(associatedVmInputs,88);
  assert.equal(associatedPreviewsBound,27);assert.equal(associatedFixtureSignatures,64);
}
const accepted=reports.filter(row=>row.status==='accepted').length;
if(checkHost)assert.equal(hostChecks.length,36);
let publicHostVectors;
if(checkHost){
  const bytes=JSON.stringify({fixtureOnly:true,realSecrets:false,cases:hostVectors},null,2)+'\n';
  const path=join(runtime.directory,'lop-public-host-vectors.json');writeFileSync(path,bytes,{flag:'wx'});
  publicHostVectors={path,sha256:createHash('sha256').update(bytes).digest('hex'),cases:hostVectors.length};
}
const report={status:accepted===reports.length?'LOP_REVIEWED_SOURCE_AUDIT_ACCEPTED':'LOP_REVIEWED_SOURCE_AUDIT_PARTIAL',
  accepted,rejected:reports.length-accepted,reports,walletApprovals:0,broadcasts:0,externalRequests:0,
  syntheticHostApprovals:hostChecks.reduce((sum,row)=>sum+row.approvals,0),
  currentProofs,cancellationNegatives,runtime:runtime.evidence,hostChecks,publicHostVectors,
  tamperedTemplatesRejected,
  nativeWasmParity:parityRows.length,
  tokenNativeWasmParity:tokenParity.length,
  standardPreviewsBound,
  detachedTransactions,detachedFixtureSignatures,authorizedSignatures:0,
  inspectedTokenPairs,
  currentNegativeCases,
  lockedReviewVariants,lockedNegativeCases,
  associatedReports,associatedVmInputs,associatedNativeWasmParity,associatedPreviewsBound,associatedFixtureSignatures,
  associatedCoverage:associatedTemplates?'source-only including match; dependent children not covered':'not-run',
  evidence:checkHost?'Source reviewer and Core/Host synthetic approval/signing across three methods; no real Vault, device or chain acceptance':
    associatedTemplates?'Reviewer, detached signatures and 27 source-only assemblies with 88 independent VM inputs; no authorization, device or chain acceptance':
    cryptoOnly?'Reviewer plus public synthetic detached-signature parity; no authorization, full witness/VM or chain acceptance':
    'Reviewer only; acceptance is not external signing, VM execution or chain acceptance'};
const reportPath=join(runtime.directory,'lop-reviewed-report.json');writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...report,reportPath}));
if(process.argv.includes('--require-complete')&&accepted!==reports.length)process.exitCode=1;
