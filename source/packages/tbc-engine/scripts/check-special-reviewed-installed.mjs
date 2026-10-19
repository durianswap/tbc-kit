// Audit latest TimeLock/HTLC raw compatibility using frozen package exports.
// Public synthetic Rust fixtures only; no real HTTP, custody, UI or broadcast.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {registerHooks,createRequire} from 'node:module';
import {build} from 'esbuild';
import {secp256k1} from '@noble/curves/secp256k1.js';
const [consumer]=process.argv.slice(2);assert.ok(consumer);
const installed=join(resolve(consumer),'node_modules/@tbc/kit');
const version=JSON.parse(readFileSync(join(installed,'package.json'))).version;assert.equal(version,'0.1.0-candidate.207');
for(const item of JSON.parse(readFileSync(join(installed,'artifacts/provenance.json'))).artifacts)
  assert.equal(createHash('sha256').update(readFileSync(join(installed,item.path))).digest('hex'),item.sha256);
let wallet=await import(pathToFileURL(join(installed,'dist/esm/wallet.js')));
const sourceMode=process.argv.includes('--source');
if(sourceMode){
  const root=resolve(import.meta.dirname,'../../..');
  const built=await build({stdin:{contents:`export {createTbcDefaultRawTransactionReviewer,createTbcDefaultAssociatedTransactionReviewer} from './packages/kit/src/reviewed-transaction-reviewer.ts';
    export {createTbcNetworkContext} from './packages/kit/src/network-context.ts';
    export {createTbcStandardWorkflowCapabilities} from './packages/kit/src/standard-workflow-capabilities.ts';
    export {reviewNativeHtlcFlow} from './packages/kit/src/reviewed-htlc-flows.ts';
    export {reviewNativeTimelockFlow} from './packages/kit/src/reviewed-timelock-flows.ts';
    export {hashCanonical} from './packages/core/src/index.ts';`,resolveDir:root,loader:'ts'},
    alias:{'@tbc-wallet/core':join(root,'packages/core/src/index.ts')},
    plugins:[{name:'portable-parser',setup(b){b.onResolve({filter:/^\.\/vendor\/tbc-tx-parser\/index\.js$/},()=>({path:join(installed,'dist/esm/vendor/tbc-tx-parser/index.js')}))}}],
    banner:{js:"import {createRequire as auditRequire} from 'node:module'; const require=auditRequire(import.meta.url);"},
    bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
  const virtual=pathToFileURL(join(root,'packages/kit/src/.special-review-check.mjs')).href;
  const hooks=registerHooks({resolve(s,c,next){return s===virtual?{url:virtual,shortCircuit:true}:next(s,c)},
    load(u,c,next){return u===virtual?{source:built.outputFiles[0].text,format:'module',shortCircuit:true}:next(u,c)}});
  wallet={...wallet,...await import(virtual)};hooks.deregister();
}
const api=await import(pathToFileURL(join(installed,'dist/esm/api.js')));
const keyless=await wallet.createWasmTbcKeylessEngine(readFileSync(join(installed,'artifacts/wasm/tbc_keyless_wasm.wasm')));
const dependency=createRequire(resolve(import.meta.dirname,'../../kit/package.json'));
const tbc=dependency('tbc-lib-js'),sighash=dependency('tbc-lib-js/lib/transaction/sighash');
const reports=[];let boundPreviews=0,negativeCases=0,integrationNegatives=0,detachedSignatures=0,timelockAssociated=0,timelockVmInputs=0,timelockFixtureSignatures=0;
for(const [family,testName,prefix]of[
  ['timelock','public_timelock_uses_shared_plan_approval_and_finalize','TIMELOCK_PUBLIC'],
  ['htlc','public_htlc_uses_shared_plan_approval_and_finalize','HTLC_PUBLIC'],
]){
  const run=spawnSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test',family+'_public',testName,'--','--exact','--nocapture'],{
    cwd:resolve(import.meta.dirname,'../rust'),env:{...process.env,[prefix+'_DUMP_WIRE']:'1'},encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
  assert.equal(run.status,0,'Synthetic source failed; raw withheld');
  const marker=prefix+'_WIRE:',rows=run.stdout.split('\n').filter(l=>l.startsWith(marker)).map(l=>JSON.parse(l.slice(marker.length)));
  const inputs=rows.filter(r=>r.definition==='planParams').map(r=>r.value),plans=rows.filter(r=>r.definition==='planResult').map(r=>r.value);
  const finalized=rows.filter(r=>r.definition==='finalizeResult').map(r=>r.value);
  assert.equal(inputs.length,family==='timelock'?2:6);assert.equal(inputs.length,plans.length);
  for(const [index,input]of inputs.entries()){
    const raw=plans[index].plan.payload.transactions[0].unsignedTransaction,parsed=api.inspectTbcTransaction(raw);
    const source=input.snapshot.payload,selected=parsed.transaction.inputs.map(p=>{const u=source.utxos.find(u=>u.txid===p.txid&&u.vout===p.vout);assert.ok(u);return u;});
    const trace=[];
    const reviewOptions={network:wallet.createTbcNetworkContext({network:'testnet'}),materialNative:keyless,
      fetch:async(url,init)=>{
        const u=new URL(String(url));assert.equal(u.origin,'https://api.tbcdev.org');assert.equal(u.pathname,'/api/tbc/txo/status');assert.equal(init.method,'POST');
        trace.push('txo/status');const requested=JSON.parse(init.body).txos;
        const txos=requested.map(p=>{const old=selected.find(s=>s.txid===p.txid&&String(s.vout)===String(p.index));assert.ok(old,'Unexpected input read');
          return {txid:old.txid,index:String(old.vout),value:old.satoshis,scriptPubKey:old.scriptPubKey,spent:false,height:'1'};});
        return new Response(JSON.stringify({code:'200',data:{txos}}),{status:200});
      }};
    const reviewer=wallet.createTbcDefaultRawTransactionReviewer(reviewOptions);
    const account=source.account;
    const reviewInput={request:{txraws:[raw],utxos_satoshis:[selected.map(s=>Number(s.satoshis))],script_pubkeys:[selected.map(s=>s.scriptPubKey)]},
      context:{origin:'https://reviewer.test',chainId:'tbc:testnet',accountId:`tbc:testnet:${account.address}`,sessionId:'special-audit',navigationId:'special-audit'},transactionIds:[parsed.txid]};
    try{
      const result=await reviewer.review(reviewInput);
      const positiveReads=trace.length;
      // Do not print preview/raw/claim data. Acceptance is not yet semantic or
      // exact-template verification; inspect review fields separately.
      const preview=result.preview.transactions[0];
      if(sourceMode&&family==='timelock'){
        assert.ok(preview.timeLocks?.length>0,'Missing bound public TimeLock terms');
        for(const lock of preview.timeLocks){
          assert.equal(lock.verification,'exact-template');assert.equal(lock.domain,'height');
          assert.equal(lock.chainMaturityChecked,false);assert.equal(lock.scriptExecutionVerified,false);
          const actual=lock.position==='input'?selected[lock.index]:parsed.transaction.outputs[lock.index];
          const script=lock.position==='input'?actual.scriptPubKey:Buffer.from(actual.scriptPubKey).toString('hex');
          assert.equal(lock.amount,String(actual.satoshis));
          assert.equal(lock.lockHeight,Buffer.from(script.slice(84,92),'hex').readUInt32LE());
          assert.equal(lock.owner,tbc.Address.fromPublicKeyHash(Buffer.from(script.slice(6,46),'hex')).toString());
          if(lock.position==='input'){
            assert.equal(lock.scriptLockChecked,true);assert.ok(lock.transactionLockTime>=lock.lockHeight);
            assert.ok(lock.sequence<4294967295);
          }else assert.equal(lock.scriptLockChecked,false);
        }
        assert.equal(trace.length,1,'TimeLock review must not add network reads');
        const active={...account,chainId:'tbc:testnet',accountId:`tbc:testnet:${account.address}`},origin='https://reviewer.test';
        const standardRequest={payload:{format:'raw',transactions:[{rawTransaction:raw,inputs:selected.map(s=>({satoshis:s.satoshis,scriptPubKey:s.scriptPubKey}))}]}};
        const capabilities=wallet.createTbcStandardWorkflowCapabilities({chainId:'tbc:testnet',account:active,networkSourceIdentity:'fixture',
          navigation:{origin,sessionId:'special-audit',navigationId:'special-audit'},readCurrentAuthority:async()=>({...active,networkSourceIdentity:'fixture'}),
          rawReviewer:{review:async()=>result},associatedReviewer:{review:async()=>{throw new Error('Unexpected associated review');}},
          privateNative:{},now:()=>new Date().toISOString().replace(/\.\d{3}Z$/u,'Z')});
        const bound=await capabilities.reviewedTransaction.review({version:'1.0',origin,sessionId:'special-audit',chainId:'tbc:testnet',
          accountId:active.accountId,publicKey:active.publicKey,request:standardRequest,requestHash:wallet.hashCanonical(standardRequest)},
          {operation:'reviewedTransaction.review'});
        assert.deepEqual(bound.payload.preview.timeLocks,preview.timeLocks.map(l=>({...l,transactionIndex:0})));
        assert.ok(bound.payload.preview.warnings.includes('LOCKED_ASSET'));boundPreviews++;
        for(const field of ['owner','amount','lockHeight','transactionLockTime']){
          const changed=structuredClone(bound.payload);changed.preview.timeLocks[0][field]='changed';
          assert.notEqual(wallet.hashCanonical(changed),bound.reviewHash);
        }
        const row={index:0,txid:parsed.txid,transaction:parsed.transaction,inputs:result.verifiedInputs[0]};
        const opts={addressVersion:0,accountAddress:account.address};
        for(const mutate of [
          r=>r.transaction.inputs[0].scriptSig=new Uint8Array([81]),
          r=>r.transaction.outputs[0].satoshis=selected.reduce((s,i)=>s+BigInt(i.satoshis),1n),
          r=>r.transaction.outputs.push({satoshis:0n,scriptPubKey:new Uint8Array([81])}),
          ...(preview.timeLocks.some(l=>l.position==='input')?[
            (r,o)=>o.accountAddress='unrelated',r=>r.transaction.locktime=0,r=>r.transaction.locktime=500000000,
            r=>r.transaction.inputs[0].sequence=4294967295]:[]),
        ]){const copy=structuredClone(row),options={...opts};mutate(copy,options);assert.throws(()=>wallet.reviewNativeTimelockFlow(copy,options));negativeCases++;}
        for(const mutate of [
          v=>v.request.utxos_satoshis[0][0]++,v=>v.context.chainId='tbc:mainnet',
          v=>{const tx=new tbc.Transaction(raw);tx.inputs[0].setScript(tbc.Script.fromHex('51'));v.request.txraws=[tx.uncheckedSerialize()];v.transactionIds=[tx.id];},
          ...(preview.timeLocks.some(l=>l.position==='input')?[v=>{
            const tx=new tbc.Transaction(raw);tx.setInputSequence(0,4294967295);v.request.txraws=[tx.uncheckedSerialize()];v.transactionIds=[tx.id];
          }]:[]),
        ]){const copy=structuredClone(reviewInput);mutate(copy);await assert.rejects(()=>reviewer.review(copy));integrationNegatives++;}
        const altered=structuredClone(reviewInput),saved=selected.map(s=>s.scriptPubKey),alteredTx=new tbc.Transaction(raw);
        selected.forEach((s,n)=>{if(s.scriptPubKey.length===106){s.scriptPubKey=s.scriptPubKey.slice(0,-2)+'00';altered.request.script_pubkeys[0][n]=s.scriptPubKey;}});
        alteredTx.outputs.forEach(o=>{const script=o.script.toHex();if(script.length===106)o.setScript(tbc.Script.fromHex(script.slice(0,-2)+'00'));});
        altered.request.txraws=[alteredTx.uncheckedSerialize()];altered.transactionIds=[alteredTx.id];
        try{await assert.rejects(()=>reviewer.review(altered));integrationNegatives++;}
        finally{selected.forEach((s,n)=>s.scriptPubKey=saved[n]);}
        // Public fixture only: source transaction preserves its actual height
        // and sequences. Child matrices have no per-child lock fields and are
        // deliberately NOT claimed as generic TimeLock-unlock support.
        const key=new tbc.PrivateKey(new tbc.crypto.BN(1));assert.equal(account.publicKey,key.publicKey.toString());
        const reference=new tbc.Transaction(finalized[index].bundle.transactions[0].rawTransaction);
        const unsigned=new tbc.Transaction(raw);
        unsigned.inputs.forEach((i,n)=>i.output=new tbc.Transaction.Output({script:tbc.Script.fromHex(selected[n].scriptPubKey),satoshis:Number(selected[n].satoshis)}));
        const sourceUtxos=selected.map((s,n)=>{
          const expected=unsigned.getSignature(n,key),chunks=reference.inputs[n].script.chunks;
          const positions=chunks.flatMap((c,j)=>c.buf?.toString('hex')===expected?[j]:[]);assert.equal(positions.length,1);
          const template=new tbc.Script();chunks.forEach((c,j)=>template.add(j===positions[0]?Buffer.from('signature'):c));
          return{txId:s.txid,outputIndex:s.vout,satoshis:Number(s.satoshis),script:s.scriptPubKey,scriptSigType:'other',unfinishedScriptSig:template.toHex()};
        });
        const associatedRequest={sourceTxraw:raw,sourceUtxos,inputs:[],outputs:[]},beforeAssociatedReads=trace.length;
        const associated=await wallet.createTbcDefaultAssociatedTransactionReviewer(reviewOptions).review({request:associatedRequest,
          operationDigest:wallet.hashCanonical({kind:'signAssociated',request:associatedRequest}),context:reviewInput.context});
        assert.deepEqual(associated.preview.transactions[0].timeLocks,preview.timeLocks);
        assert.equal(trace.length-beforeAssociatedReads,1);timelockAssociated++;
        const stage=JSON.parse(await keyless.execute('prepareReviewedStage',JSON.stringify({format:'associated',publicKey:account.publicKey,request:associatedRequest})));
        const signatures=stage.digests.map((digest,n)=>{
          const expected=sighash.sighash(unsigned,0x41,n,unsigned.inputs[n].output.script,new tbc.crypto.BN(selected[n].satoshis));
          assert.equal(Buffer.from(expected).reverse().toString('hex'),digest);
          return secp256k1.sign(digest,key.toBuffer(),{prehash:false,lowS:true}).toCompactHex();
        });
        const assembled=JSON.parse(await keyless.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
        timelockFixtureSignatures+=signatures.length;
        assert.equal(assembled.txraw,reference.uncheckedSerialize());
        const verified=new tbc.Transaction(assembled.txraw);verified.inputs.forEach((item,n)=>{
          item.output=unsigned.inputs[n].output;assert.equal(verified.verifyScript(n).success,true);timelockVmInputs++;
        });
      }
      if(sourceMode&&family==='htlc'){
        assert.ok(preview.htlcLocks.length>0,'Missing bound public HTLC terms');
        for(const lock of preview.htlcLocks){
          assert.equal(lock.verification,'exact-template');assert.equal(lock.chainMaturityChecked,false);
          assert.equal(lock.scriptExecutionVerified,false);assert.equal(lock.preimageVerified,false);
          assert.equal(lock.domain,lock.lockTime<500000000?'height':'timestamp');
          assert.equal(Object.hasOwn(lock,'preimage'),false);
          const actual=lock.position==='input'?selected[lock.index]:parsed.transaction.outputs[lock.index];
          assert.equal(lock.amount,String(actual.satoshis));
          const script=lock.position==='input'?actual.scriptPubKey:Buffer.from(actual.scriptPubKey).toString('hex');
          assert.equal(lock.hashlock,script.slice(6,70));
          assert.equal(lock.lockTime,Buffer.from(script.slice(122,130),'hex').readUInt32LE());
        }
        const active={...account,chainId:'tbc:testnet',accountId:`tbc:testnet:${account.address}`},origin='https://reviewer.test';
        const standardRequest={payload:{format:'raw',transactions:[{rawTransaction:raw,inputs:selected.map(s=>({satoshis:s.satoshis,scriptPubKey:s.scriptPubKey}))}]}};
        const capabilities=wallet.createTbcStandardWorkflowCapabilities({chainId:'tbc:testnet',account:active,networkSourceIdentity:'fixture',
          navigation:{origin,sessionId:'special-audit',navigationId:'special-audit'},readCurrentAuthority:async()=>({...active,networkSourceIdentity:'fixture'}),
          rawReviewer:{review:async()=>result},associatedReviewer:{review:async()=>{throw new Error('Unexpected associated review');}},
          privateNative:{},now:()=>new Date().toISOString().replace(/\.\d{3}Z$/u,'Z')});
        const bound=await capabilities.reviewedTransaction.review({version:'1.0',origin,sessionId:'special-audit',chainId:'tbc:testnet',
          accountId:active.accountId,publicKey:active.publicKey,request:standardRequest,requestHash:wallet.hashCanonical(standardRequest)},
          {operation:'reviewedTransaction.review'});
        assert.deepEqual(bound.payload.preview.htlcLocks,preview.htlcLocks.map(l=>({...l,transactionIndex:0})));
        assert.equal(bound.reviewHash,wallet.hashCanonical(bound.payload));boundPreviews++;
        const changed=structuredClone(bound.payload);changed.preview.htlcLocks[0].lockTime++;
        assert.notEqual(wallet.hashCanonical(changed),bound.reviewHash);
        const row={index:0,txid:parsed.txid,transaction:parsed.transaction,inputs:result.verifiedInputs[0]};
        const opts={addressVersion:0,accountAddress:account.address,associated:false};
        for(const mutate of [
          (r,o)=>o.associated=true,
          r=>r.transaction.inputs[0].scriptSig=new Uint8Array([81]),
          r=>r.transaction.outputs[0].satoshis=selected.reduce((s,i)=>s+BigInt(i.satoshis),1n),
          r=>r.transaction.outputs.push({satoshis:0n,scriptPubKey:new Uint8Array([81])}),
          ...(preview.htlcLocks.some(l=>l.position==='input')?[(r,o)=>o.accountAddress='unrelated']:[]),
        ]){const copy=structuredClone(row),options={...opts};mutate(copy,options);assert.throws(()=>wallet.reviewNativeHtlcFlow(copy,options));negativeCases++;}
        const tampered=structuredClone(row);
        for(const i of tampered.inputs)if(i.scriptPubKey.length===274)i.scriptPubKey=i.scriptPubKey.slice(0,-2)+'00';
        for(const o of tampered.transaction.outputs)if(o.scriptPubKey.length===137)o.scriptPubKey[o.scriptPubKey.length-1]=0;
        assert.equal(wallet.reviewNativeHtlcFlow(tampered,opts),undefined);negativeCases++;
        assert.equal(trace.length,1,'HTLC review must not add dependency/tip reads');
        for(const mutate of [
          v=>v.context.chainId='tbc:mainnet',
          v=>v.request.utxos_satoshis[0][0]++,
          v=>v.request.script_pubkeys[0][0]='51',
          v=>{const tx=new tbc.Transaction(raw);tx.inputs[0].setScript(tbc.Script.fromHex('51'));v.request.txraws=[tx.uncheckedSerialize()];v.transactionIds=[tx.id];},
          v=>{const tx=new tbc.Transaction(raw);tx.outputs.push(new tbc.Transaction.Output({script:tbc.Script.fromHex('51'),satoshis:0}));v.request.txraws=[tx.uncheckedSerialize()];v.transactionIds=[tx.id];},
        ]){const copy=structuredClone(reviewInput);mutate(copy);await assert.rejects(()=>reviewer.review(copy));integrationNegatives++;}
        const altered=structuredClone(reviewInput),saved=selected.map(s=>s.scriptPubKey),alteredTx=new tbc.Transaction(raw);
        selected.forEach((s,n)=>{if(s.scriptPubKey.length===274){s.scriptPubKey=s.scriptPubKey.slice(0,-2)+'00';altered.request.script_pubkeys[0][n]=s.scriptPubKey;}});
        alteredTx.outputs.forEach(o=>{const script=o.script.toHex();if(script.length===274)o.setScript(tbc.Script.fromHex(script.slice(0,-2)+'00'));});
        altered.request.txraws=[alteredTx.uncheckedSerialize()];altered.transactionIds=[alteredTx.id];
        try{await assert.rejects(()=>reviewer.review(altered));integrationNegatives++;}
        finally{selected.forEach((s,n)=>s.scriptPubKey=saved[n]);}
        // Known public fixture key only. Detached digest parity is not a
        // complete HTLC witness or an authorization to publish a claim.
        const key=new tbc.PrivateKey(new tbc.crypto.BN(1));assert.equal(account.publicKey,key.publicKey.toString());
        const stage=JSON.parse(await keyless.execute('prepareReviewedStage',JSON.stringify({format:'raw',publicKey:account.publicKey,
          request:{txraws:[raw],utxosSatoshis:reviewInput.request.utxos_satoshis,scriptPubkeys:reviewInput.request.script_pubkeys}})));
        const tx=new tbc.Transaction(raw);tx.inputs.forEach((i,n)=>{i.output=new tbc.Transaction.Output({script:tbc.Script.fromHex(selected[n].scriptPubKey),satoshis:Number(selected[n].satoshis)});});
        const signatures=stage.digests.map((digest,n)=>{
          const expected=sighash.sighash(tx,0x41,n,tx.inputs[n].output.script,new tbc.crypto.BN(selected[n].satoshis));
          assert.equal(Buffer.from(expected).reverse().toString('hex'),digest);
          return secp256k1.sign(digest,key.toBuffer(),{prehash:false,lowS:true}).toCompactHex();
        });
        const detached=JSON.parse(await keyless.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
        assert.equal(detached.txraw,raw);assert.equal(detached.txid,parsed.txid);
        assert.deepEqual(detached.sigs,tx.inputs.map((_,n)=>tx.getSignature(n,key)));detachedSignatures+=detached.sigs.length;
      }
      reports.push({family,index,operation:input.request.intent.type,review:'accepted',fields:Object.keys(preview),reads:positiveReads});
    }catch(error){
      reports.push({family,index,operation:input.request.intent.type,review:'rejected',error:String(error.message).replace(/[0-9a-f]{32,}/gi,'[hex withheld]').slice(0,200),reads:trace.length});
    }
  }
}
console.log(JSON.stringify({status:'SPECIAL_REVIEW_AUDIT',version,sourceMode,reports,boundPreviews,negativeCases,integrationNegatives,timelockAssociated,timelockVmInputs,timelockFixtureSignatures,
  externalRequests:0,detachedFixtureSignatures:detachedSignatures,authorizedSignatures:0,broadcasts:0,semanticVerification:false,deviceAcceptance:false}));
if(process.argv.includes('--require-complete')&&reports.some(r=>r.review!=='accepted'))process.exitCode=1;
