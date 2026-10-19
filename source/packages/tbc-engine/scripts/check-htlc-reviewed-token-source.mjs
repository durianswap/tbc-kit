// Public synthetic Token/Coin fixtures, never production raw or preimages.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerHooks,createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {loadHtlcSdkOracle} from './lib/htlc-sdk-oracle.mjs';
import {checkAssociatedHtlcHost} from './lib/check-associated-htlc-host.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const deps=createRequire(root+'packages/kit/package.json'),tbc=deps('tbc-lib-js');
const sdkIndex=process.argv.indexOf('--sdk');
if(sdkIndex>=0)assert.ok(process.argv[sdkIndex+1]&&!process.argv[sdkIndex+1].startsWith('--'));
const oracle=sdkIndex<0?undefined:await loadHtlcSdkOracle(process.argv[sdkIndex+1],deps);
const currentProofs=process.argv.includes('--current-proofs');
const dependentRefunds=process.argv.includes('--dependent-refunds');
const exportRefunds=process.argv.includes('--export-refunds');
if(exportRefunds)assert.ok(dependentRefunds,'Refund fixtures require dependent validation');
if(dependentRefunds)assert.ok(currentProofs,'Dependent refunds require current shared proofs');
if(currentProofs)assert.ok(oracle&&process.argv.includes('--associated-witness'),'Current proofs require the fixed SDK and associated checks');
const sighash=deps('tbc-lib-js/lib/transaction/sighash');
const built=await build({stdin:{contents:`
export {createTbcDefaultRawTransactionReviewer,createTbcDefaultAssociatedTransactionReviewer} from './packages/kit/src/reviewed-transaction-reviewer.ts';
export {createTbcWallet} from './packages/kit/src/wallet-runtime.ts';
export {createApprovalHostEvidenceReader} from './packages/kit/src/approval-host-evidence.ts';
export {projectTbcApprovalPresentation} from './packages/kit/src/approval-presentation.ts';
export {createMemoryTwsHostStore} from './packages/host/src/index.ts';
export {assertValidTws,TWS_RELEASE_FINGERPRINT} from './packages/core/src/index.ts';
export {createTbcNetworkContext} from './packages/kit/src/network-context.ts';
export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';
export {inspectReviewedTokenCodes} from './packages/kit/src/reviewed-token.ts';
export {createTbcStandardWorkflowCapabilities} from './packages/kit/src/standard-workflow-capabilities.ts';
export {inspectAssociatedHtlcWitness} from './packages/kit/src/reviewed-htlc-witness.ts';
export {hashCanonical} from './packages/core/src/index.ts';
export {discoverReviewedTokenAssets} from './packages/kit/src/reviewed-token-assets.ts';
export {createTbcOfficialApi} from './packages/kit/src/official-api.ts';`,resolveDir:root,loader:'ts'},
  alias:{'@tbc-wallet/core':root+'packages/core/src/index.ts','@tbc-wallet/host':root+'packages/host/src/index.ts',
    '@tbc-wallet/provider':root+'packages/provider/src/index.ts','@tbc-wallet/provider/in-memory':root+'packages/provider/src/in-memory.ts'},
  plugins:[{name:'portable-parser',setup(b){b.onResolve({filter:/^\.\/vendor\/tbc-tx-parser\/index\.js$/},()=>({path:root+'packages/kit/dist/esm/vendor/tbc-tx-parser/index.js'}));}}],
  banner:{js:"import {createRequire as auditRequire} from 'node:module'; const require=auditRequire(import.meta.url);"},
  bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const virtual=new URL('../../../packages/kit/src/.htlc-token-review-check.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,n){return s===virtual?{url:virtual,shortCircuit:true}:n(s,c)},
  load(u,c,n){return u===virtual?{source:built.outputFiles[0].text,format:'module',shortCircuit:true}:n(u,c)}});
const kit=await import(virtual);hooks.deregister();
const wasmBytes=readFileSync(root+'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm');
const wasm=await kit.createWasmTbcKeylessEngine(wasmBytes);
let parityCalls=0,runner;
const reportDirectory=mkdtempSync(join(tmpdir(),'tbc-reviewed-htlc-controller-'));
if(process.argv.includes('--native-parity')){
  assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
  const native=root+'packages/tbc-engine/rust/target/release/';runner=join(reportDirectory,'native-runner');
  const cc=spawnSync('cc',[root+'packages/tbc-engine/scripts/keyless-native-runner.c',
    '-I'+root+'packages/tbc-engine/rust/crates/tbc-keyless-native/include',native+'libtbc_keyless_native.dylib','-Wl,-rpath,'+native,'-o',runner],{encoding:'utf8'});
  assert.equal(cc.status,0,'Native runner compilation failed');
}
// All calls here contain public synthetic fixtures only, never custody data.
const keyless=runner?{protocolInfo:()=>wasm.protocolInfo(),async execute(op,json){
  let result,error;try{result=await wasm.execute(op,json);}catch(e){error=e;}
  const native=spawnSync(runner,[op,json],{encoding:'utf8',maxBuffer:8*1024*1024});
  assert.equal(native.status,0,'Synthetic Native runner failed');const decoded=JSON.parse(native.stdout);
  if(error){assert.equal(decoded.error,error.message,'Native/WASM rejection differs');parityCalls++;throw error;}
  assert.deepEqual(decoded,JSON.parse(result),'Native/WASM result differs');parityCalls++;return result;
}}:wasm;
const run=spawnSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test','htlc_token','--','--nocapture'],
  {cwd:root+'packages/tbc-engine/rust',env:{...process.env,HTLC_TOKEN_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
assert.equal(run.status,0,'Public synthetic fixture generation failed; output withheld');
const marker='HTLC_TOKEN_WIRE:',rows=run.stdout.split('\n').filter(l=>l.startsWith(marker)).map(l=>JSON.parse(l.slice(marker.length)));assert.equal(rows.length,21);
const reports=[];let negativeCases=0,boundPreviews=0,detachedSignatures=0,sdkFilledTransactions=0,sdkVmInputs=0,associatedWitnessCases=0,associatedStandardBound=0,associatedDefaultReviews=0,associatedNegatives=0;
const checkAssociated=process.argv.includes('--associated-witness');if(checkAssociated)assert.ok(oracle,'Associated witness verification requires the pinned SDK oracle');
const hostProfiles=new Set(),hostChecks=[];
const controllerNegativeProfiles=new Set();let controllerNegatives=0;
const lockedParents=new Map(),dependentChecks=[],dependentHostProfiles=new Set(),dependentHostChecks=[];
const refundVectors=[];
for(const [index,row]of rows.entries()){
  const tx=new tbc.Transaction(row.raw);tx.inputs.forEach(i=>i.setScript(tbc.Script.empty()));
  const raw=tx.uncheckedSerialize(),parents=[row.parentRaw,...row.ancestorsRaw].map(r=>new tbc.Transaction(r));
  const statuses=new Map();
  for(const p of parents)for(const [vout,o]of p.outputs.entries())statuses.set(`${p.id}:${vout}`,{txid:p.id,index:String(vout),value:String(o.satoshis),scriptPubKey:o.script.toHex(),spent:false,height:'1'});
  for(const i of row.inputs)statuses.set(`${i.txId}:${i.outputIndex}`,{txid:i.txId,index:String(i.outputIndex),value:String(i.satoshis),scriptPubKey:i.script,spent:false,height:'1'});
  const scripts=[...new Set(row.inputs.map(i=>i.script))],codes=await kit.inspectReviewedTokenCodes(keyless,scripts);
  const identities=new Map();codes.forEach((c,n)=>{if(c)identities.set(c.codeIdentity,{code:c,script:scripts[n],id:createHash('sha256').update(c.codeIdentity).digest('hex')});});
  assert.equal(identities.size,1);const asset=[...identities.values()][0];
  const reads=[],responses=new Map();let fault='';
  const reviewerOptions={network:kit.createTbcNetworkContext({network:'testnet'}),materialNative:keyless,
    fetch:async(url,init)=>{const u=new URL(String(url));assert.equal(u.origin,'https://api.tbcdev.org');reads.push(u.pathname);
      let data;if(u.pathname==='/api/tbc/txo/status'){
        assert.equal(init.method,'POST');data={txos:JSON.parse(init.body).txos.map(p=>{const s=statuses.get(`${p.txid}:${p.index}`);assert.ok(s,'Unrequested sibling');
          return {...s,...(s.value==='0'&&fault==='tape-value'?{value:'1'}:{}),...(s.value==='0'&&fault==='tape-script'?{scriptPubKey:'51'}:{})};})};
      }else if(/\/decode\/txid\//u.test(u.pathname)){
        assert.equal(init.method??'GET','GET');const id=u.pathname.split('/').at(-1),p=parents.find(p=>p.id===id);assert.ok(p,'Unknown decode parent');
        data={txid:fault==='decode-txid'?'00'.repeat(32):id,contract_id:asset.id,output:fault==='decode-point'?[]:p.outputs.map((_,vout)=>({txid:id,vout}))};
      }else if(/\/info\//u.test(u.pathname)){
        assert.equal(u.pathname.split('/').at(-1),asset.id);data={code_script:fault==='metadata-code'?'51':asset.script,
          ...(row.profile==='Coin'?{stablecoin_id:fault==='metadata-id'?'00'.repeat(32):asset.id}:{})};
      }else throw new Error('Unexpected reviewer query');
      const body=JSON.stringify({code:'200',data});
      if(exportRefunds&&!fault)responses.set(JSON.stringify([u.pathname,init.method??'GET',init.body??null]),body);
      return new Response(body,{status:200});}};
  const reviewer=kit.createTbcDefaultRawTransactionReviewer(reviewerOptions);
  const associatedReviewer=kit.createTbcDefaultAssociatedTransactionReviewer(reviewerOptions);
  const signer=new tbc.PrivateKey(new tbc.crypto.BN(row.operation==='claim'?2:1));
  const reviewInput={request:{txraws:[raw],utxos_satoshis:[row.inputs.map(i=>i.satoshis)],script_pubkeys:[row.inputs.map(i=>i.script)]},
    context:{origin:'https://reviewer.test',chainId:'tbc:testnet',accountId:`tbc:testnet:${signer.toAddress()}`,sessionId:'audit',navigationId:'audit'},transactionIds:[tx.id]};
  try{const reviewed=await reviewer.review(reviewInput);
    const p=reviewed.preview.transactions[0];assert.ok(p.htlcLocks?.length);assert.ok(p.groups.some(g=>g.asset.contractId===asset.id));
    assert.equal(reads.length,4);assert.equal(new Set(reads.filter(p=>p.includes('/info/'))).size,1);const positiveReads=reads.length;
    const escrow=p.htlcLocks[0].escrowToken;assert.equal(escrow.contractId,asset.id);assert.equal(escrow.standardId,asset.code.standardId);
    assert.equal(p.htlcLocks[0].amount,'100');assert.equal(p.htlcLocks[0].preimageVerified,false);
    const actualEscrow=row.operation==='lock'?tx.outputs[1]:new tbc.Transaction(row.parentRaw).outputs[1];
    const actualTape=(row.operation==='lock'?tx:new tbc.Transaction(row.parentRaw)).outputs[2].script.toBuffer();
    // Pinned SDK lib/util/common/util.js getFtBalanceFromTape: six LE u64
    // slots at byte 3. Independent of the Rust/Kit inspection result above.
    const expectedAmount=Array.from({length:6},(_,n)=>actualTape.readBigUInt64LE(3+n*8)).reduce((a,b)=>a+b,0n);
    assert.equal(escrow.amount,expectedAmount.toString());
    const own=p.groups.find(g=>g.asset.contractId===asset.id).flows.filter(f=>f.purpose==='lock'||f.purpose==='release');
    assert.ok(own.some(f=>f.amount.raw===escrow.amount));assert.equal(actualEscrow.satoshis,500);
    const account={chainId:'tbc:testnet',accountId:reviewInput.context.accountId,address:signer.toAddress().toString(),publicKey:signer.publicKey.toString()};
    const request={payload:{format:'raw',transactions:[{rawTransaction:raw,inputs:row.inputs.map(i=>({satoshis:String(i.satoshis),scriptPubKey:i.script}))}]}};
    const capabilities=kit.createTbcStandardWorkflowCapabilities({chainId:'tbc:testnet',account,networkSourceIdentity:'fixture',materialNative:keyless,
      navigation:{origin:'https://reviewer.test',sessionId:'audit',navigationId:'audit'},readCurrentAuthority:async()=>({...account,networkSourceIdentity:'fixture'}),
      rawReviewer:{review:async()=>reviewed},associatedReviewer:{review:async()=>{throw new Error('Unexpected associated call');}},privateNative:{},
      now:()=>new Date().toISOString().replace(/\.\d{3}Z$/u,'Z')});
    const bound=await capabilities.reviewedTransaction.review({version:'1.0',origin:'https://reviewer.test',sessionId:'audit',chainId:'tbc:testnet',
      accountId:account.accountId,publicKey:account.publicKey,request,requestHash:kit.hashCanonical(request)},{operation:'reviewedTransaction.review'});
    assert.deepEqual(bound.payload.preview.htlcLocks,p.htlcLocks.map(l=>({...l,transactionIndex:0})));
    assert.equal(bound.reviewHash,kit.hashCanonical(bound.payload));boundPreviews++;
    if(oracle){
      // The wallet review/keyless request never receives the synthetic claim
      // preimage. Only the DApp's local SDK assembly below receives it.
      const keylessRequest={format:'raw',publicKey:account.publicKey,resolvedOutputs:reviewed.policyMaterial.resolvedOutputs,
        request:{txraws:[raw],utxosSatoshis:reviewInput.request.utxos_satoshis,scriptPubkeys:reviewInput.request.script_pubkeys}};
      const syntheticPreimage='33'.repeat(32);
      assert.equal(JSON.stringify(reviewInput).includes(syntheticPreimage),false);
      assert.equal(JSON.stringify(keylessRequest).includes(syntheticPreimage),false);
      const stage=JSON.parse(await keyless.execute('prepareReviewedStage',JSON.stringify(keylessRequest)));
      const unsigned=new tbc.Transaction(raw);unsigned.inputs.forEach((i,n)=>i.output=new tbc.Transaction.Output({script:tbc.Script.fromHex(row.inputs[n].script),satoshis:row.inputs[n].satoshis}));
      const signatures=stage.digests.map((digest,n)=>{
        const expected=sighash.sighash(unsigned,0x41,n,unsigned.inputs[n].output.script,new tbc.crypto.BN(row.inputs[n].satoshis));
        assert.equal(Buffer.from(expected).reverse().toString('hex'),digest);
        return secp256k1.sign(digest,signer.toBuffer(),{prehash:false,lowS:true}).toCompactHex();
      });
      const signed=JSON.parse(await keyless.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
      assert.equal(signed.txraw,raw);assert.deepEqual(signed.sigs,unsigned.inputs.map((_,n)=>unsigned.getSignature(n,signer)));
      assert.equal(JSON.stringify(signed).includes(syntheticPreimage),false);detachedSignatures+=signed.sigs.length;
      const parent=new tbc.Transaction(row.parentRaw),ancestors=row.ancestorsRaw.map(r=>new tbc.Transaction(r));
      const resolver=id=>{const found=ancestors.find(p=>p.id===id);assert.ok(found,'Missing synthetic ancestor');return found;};
      const filled=row.operation==='lock'?oracle.HTLC.fillSigDeployHTLCToken(raw,signed.sigs,account.publicKey,
        row.inputs.slice(0,-1).map(()=>parent),row.inputs.slice(0,-1).map(()=>resolver))
        :row.operation==='claim'?oracle.HTLC.fillSigWithdrawHTLCToken(raw,signed.sigs,account.publicKey,syntheticPreimage,parent,resolver)
        :oracle.HTLC.fillSigRefundHTLCToken(raw,signed.sigs,account.publicKey,parent,resolver);
      assert.equal(filled,row.raw,'SDK must assemble the exact independently validated witness');
      const finalTx=new tbc.Transaction(filled);
      finalTx.inputs.forEach((i,n)=>{i.output=unsigned.inputs[n].output;assert.equal(finalTx.verifyScript(n).success,true);sdkVmInputs++;});
      if(checkAssociated){
        // Shared witness gate and actual default reviewer; all material is synthetic.
        const sourceUtxos=row.inputs.map((input,n)=>{
          if(currentProofs){
            const base={txId:input.txId,outputIndex:input.outputIndex,satoshis:input.satoshis,script:input.script};
            if(n===row.inputs.length-1)return {...base,scriptSigType:'p2pkh'};
            if(row.operation==='lock'||n===1)return {...base,scriptSigType:row.profile==='Coin'?'tbc20-stablecoin':'tbc20-standard',
              preTx:row.parentRaw,ancestorTransactions:row.ancestorsRaw};
          }
          const chunks=finalTx.inputs[n].script.chunks,template=new tbc.Script();let slots=0;
          chunks.forEach(chunk=>{if(chunk.buf?.toString('hex')===signed.sigs[n]){template.add(Buffer.from('signature'));slots++;}else template.add(chunk);});
          assert.equal(slots,1);
          return{txId:input.txId,outputIndex:input.outputIndex,satoshis:input.satoshis,script:input.script,scriptSigType:'other',unfinishedScriptSig:template.toHex()};
        });
        const associated={format:'associated',publicKey:account.publicKey,resolvedOutputs:reviewed.policyMaterial.resolvedOutputs,request:{sourceTxraw:raw,sourceUtxos,inputs:[],outputs:[]}};
        const associatedStage=JSON.parse(await keyless.execute('prepareReviewedStage',JSON.stringify(associated)));
        assert.deepEqual(associatedStage.digests,stage.digests);
        const assembled=JSON.parse(await keyless.execute('finalizeReviewedStage',JSON.stringify({stage:associatedStage,signatures,signatureEncoding:'compact64'})));
        assert.equal(assembled.txraw,filled);associatedWitnessCases++;
        if(dependentRefunds&&row.operation==='lock')lockedParents.set(new tbc.Transaction(filled).id,{associated,raw:filled});
        if(dependentRefunds&&row.operation==='refund'){
          const prior=lockedParents.get(new tbc.Transaction(row.parentRaw).id);assert.ok(prior,'Missing matching lock fixture');
          const linked=structuredClone(prior.associated);
          linked.request.inputs=[sourceUtxos.map(i=>{
            const child=structuredClone(i);
            if(i.txId===new tbc.Transaction(row.parentRaw).id)for(const k of ['txId','script','satoshis','preTx','ancestorTransactions'])delete child[k];
            return child;
          })];
          linked.request.outputs=[tx.outputs.map(o=>({satoshis:o.satoshis,script:o.script.toHex()}))];
          // External fee inputs remain explicitly bound; local escrow inputs
          // are resolved only from the actual finalized preceding transaction.
          linked.resolvedOutputs=[...(linked.resolvedOutputs??[]),...(associated.resolvedOutputs??[])];
          const finalized=[];let vmInputs=0;
          for(let transactionIndex=0;transactionIndex<2;transactionIndex++){
            const next=JSON.parse(await keyless.execute('prepareReviewedStage',JSON.stringify({...linked,transactionIndex,previousTransactions:finalized})));
            const sigs=next.digests.map(d=>secp256k1.sign(d,signer.toBuffer(),{prehash:false,lowS:true}).toCompactHex());
            const result=JSON.parse(await keyless.execute('finalizeReviewedStage',JSON.stringify({stage:next,signatures:sigs,signatureEncoding:'compact64'})));
            const actual=new tbc.Transaction(result.txraw);
            actual.inputs.forEach((i,n)=>{const p=next.inputs[n];i.output=new tbc.Transaction.Output({script:tbc.Script.fromHex(p.script),satoshis:p.satoshis});assert.equal(actual.verifyScript(n).success,true);vmInputs++;});
            assert.equal(result.txraw,transactionIndex===0?prior.raw:filled,'Dependent refund must equal fixed SDK assembly');
            finalized.push(result.txraw);
          }
          assert.equal(new tbc.Transaction(finalized[1]).inputs[0].prevTxId.toString('hex'),new tbc.Transaction(finalized[0]).id);
          for(const input of linked.request.sourceUtxos)statuses.set(`${input.txId}:${input.outputIndex}`,{txid:input.txId,index:String(input.outputIndex),value:String(input.satoshis),scriptPubKey:input.script,spent:false,height:'1'});
          const before=reads.length;
          const review=await associatedReviewer.review({request:linked.request,context:reviewInput.context,publicKey:account.publicKey,
            operationDigest:kit.hashCanonical({kind:'signAssociated',request:linked.request})});
          assert.equal(review.preview.transactions.length,2);
          const lock=review.preview.transactions[1].htlcLocks.find(l=>l.position==='input');
          assert.equal(lock.branch,'refund');assert.equal(lock.transactionLockTime,new tbc.Transaction(finalized[1]).nLockTime);
          assert.equal(JSON.stringify(review).includes(syntheticPreimage),false);
          dependentChecks.push({profile:row.profile,transactions:2,vmInputs,exactSdkRaw:true,reviewReads:reads.length-before,actualFinalizedParent:true});
          if(!dependentHostProfiles.has(row.profile)){
            const map=i=>({...(i.txId===undefined?{}:{txid:i.txId}),outputIndex:i.outputIndex,
              ...(i.satoshis===undefined?{}:{satoshis:String(i.satoshis)}),...(i.script===undefined?{}:{scriptPubKey:i.script}),
              signingProfile:i.scriptSigType==='other'?'contract-template':i.scriptSigType,
              ...(i.unfinishedScriptSig===undefined?{}:{unlockingScriptTemplate:i.unfinishedScriptSig}),
              ...(i.preTx===undefined?{}:{previousTransaction:i.preTx,ancestorTransactions:i.ancestorTransactions})});
            const publicRequest={payload:{format:'associated',sourceTransaction:linked.request.sourceTxraw,sourceInputs:linked.request.sourceUtxos.map(map),
              children:[{inputs:linked.request.inputs[0].map(map),outputs:linked.request.outputs[0].map(o=>({satoshis:String(o.satoshis),scriptPubKey:o.script}))}]}};
            const checks=await checkAssociatedHtlcHost({kit,keyless,account,request:publicRequest,reviewer:associatedReviewer,signer,
              expectedRaws:finalized,claim:false,preimage:syntheticPreimage,reads});
            dependentHostChecks.push(...checks.map(c=>({profile:row.profile,...c})));dependentHostProfiles.add(row.profile);
            if(exportRefunds){
              const vector={profile:row.profile,publicSyntheticScalar:1,account,request:publicRequest,expectedRaws:finalized,
                keylessRequest:linked,responses:[...responses]};
              assert.equal(JSON.stringify(vector).includes(syntheticPreimage),false,'Refund fixture must not contain a claim preimage');
              refundVectors.push(vector);
            }
          }
        }
        if(currentProofs&&row.operation==='claim'&&!controllerNegativeProfiles.has(row.profile)){
          const cases=[
            ['controller-profile',(items)=>{items[0].scriptSigType='p2pkh';}],
            ['controller-script',(items)=>{items[0].script='51';}],
            ['controller-value',(items)=>{items[0].satoshis++;}],
            ['controller-point',(items,tx)=>{items[0].outputIndex=2;tx.inputs[0].outputIndex=2;}],
            ['controller-parent',(items)=>{items[1].preTx=row.ancestorsRaw[0];}],
            ['controller-ambiguous',(items,tx)=>{items.push(structuredClone(items[0]));tx.inputs.push(new tbc.Transaction.Input(tx.inputs[0].toObject()));}],
            ['supplied-controller-proof',(items)=>{items[1].contractTx=row.parentRaw;}],
          ];
          for(const [label,mutate]of cases){
            const bad=structuredClone(associated),altered=new tbc.Transaction(raw);mutate(bad.request.sourceUtxos,altered);bad.request.sourceTxraw=altered.uncheckedSerialize();
            await assert.rejects(()=>keyless.execute('prepareReviewedStage',JSON.stringify(bad)),undefined,label);controllerNegatives++;
            const final={stage:structuredClone(associatedStage),signatures,signatureEncoding:'compact64'};
            final.stage.inputs=bad.request.sourceUtxos;final.stage.txraw=bad.request.sourceTxraw;
            await assert.rejects(()=>keyless.execute('finalizeReviewedStage',JSON.stringify(final)),undefined,label);controllerNegatives++;
          }
          controllerNegativeProfiles.add(row.profile);
        }
        const projected=structuredClone(reviewed);
        for(const lock of projected.preview.transactions[0].htlcLocks){
          if(lock.position!=='input')continue;
          const terms=kit.inspectAssociatedHtlcWitness({scriptPubKey:sourceUtxos[lock.index].script,
            unlockingScriptTemplate:sourceUtxos[lock.index].unfinishedScriptSig,accountAddress:account.address,addressVersion:0,
            sequence:unsigned.inputs[lock.index].sequenceNumber,transactionLockTime:unsigned.nLockTime});
          lock.branch=terms.branch;lock.preimageVerified=terms.preimageVerified;
        }
        // Actual default reviewer -> Standard adapter/Schema/hash, not a stub.
        const beforeAssociatedReads=reads.length;
        const defaultReviewed=await associatedReviewer.review({request:associated.request,context:reviewInput.context,publicKey:account.publicKey,
          operationDigest:kit.hashCanonical({kind:'signAssociated',request:associated.request})});
        assert.equal(reads.length-beforeAssociatedReads,4,'Associated review must reuse the raw read budget');
        assert.deepEqual(defaultReviewed.preview.transactions[0].htlcLocks,projected.preview.transactions[0].htlcLocks);
        assert.equal(JSON.stringify(defaultReviewed).includes(syntheticPreimage),false);associatedDefaultReviews++;
        const associatedCapabilities=kit.createTbcStandardWorkflowCapabilities({chainId:'tbc:testnet',account,networkSourceIdentity:'fixture',materialNative:keyless,
          navigation:{origin:'https://reviewer.test',sessionId:'audit',navigationId:'audit'},readCurrentAuthority:async()=>({...account,networkSourceIdentity:'fixture'}),
          rawReviewer:{review:async()=>{throw Error('Unexpected raw call');}},associatedReviewer,privateNative:{},
          now:()=>new Date().toISOString().replace(/\.\d{3}Z$/u,'Z')});
        const associatedPublicRequest={payload:{format:'associated',sourceTransaction:raw,children:[],sourceInputs:sourceUtxos.map(i=>({txid:i.txId,
          outputIndex:i.outputIndex,satoshis:String(i.satoshis),scriptPubKey:i.script,signingProfile:i.scriptSigType==='other'?'contract-template':i.scriptSigType,
          ...(i.unfinishedScriptSig===undefined?{}:{unlockingScriptTemplate:i.unfinishedScriptSig}),
          ...(i.preTx===undefined?{}:{previousTransaction:i.preTx,ancestorTransactions:i.ancestorTransactions})}))}};
        const associatedBound=await associatedCapabilities.reviewedTransaction.review({version:'1.0',origin:'https://reviewer.test',sessionId:'audit',chainId:'tbc:testnet',
          accountId:account.accountId,publicKey:account.publicKey,request:associatedPublicRequest,requestHash:kit.hashCanonical(associatedPublicRequest)},{operation:'reviewedTransaction.review'});
        assert.equal(associatedBound.reviewHash,kit.hashCanonical(associatedBound.payload));
        assert.deepEqual(associatedBound.payload.preview.htlcLocks,projected.preview.transactions[0].htlcLocks.map(l=>({...l,transactionIndex:0})));
        assert.equal(associatedBound.payload.preview.warnings.includes('HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE'),row.operation==='claim');
        assert.equal(JSON.stringify(associatedBound).includes(syntheticPreimage),false);associatedStandardBound++;
        assert.equal(reads.length-beforeAssociatedReads,8,'Each independent review has the same four-read budget');
        if(row.operation==='claim'&&!hostProfiles.has(row.profile)){
          const checks=await checkAssociatedHtlcHost({kit,keyless,account,request:associatedPublicRequest,reviewer:associatedReviewer,
            signer,expectedRaw:filled,preimage:syntheticPreimage,reads});
          hostChecks.push(...checks.map(check=>({profile:row.profile,...check})));hostProfiles.add(row.profile);
        }
        if(row.operation!=='lock'){
          const htlcIndex=projected.preview.transactions[0].htlcLocks.find(l=>l.position==='input').index;
          for(const mutate of [i=>{delete i.unfinishedScriptSig;},i=>{i.scriptSigType='p2pkh';},i=>{i.unfinishedScriptSig+='51';}]){
            const bad=structuredClone(associated.request);mutate(bad.sourceUtxos[htlcIndex]);
            await assert.rejects(()=>associatedReviewer.review({request:bad,context:reviewInput.context,publicKey:account.publicKey,
              operationDigest:kit.hashCanonical({kind:'signAssociated',request:bad})}),/Invalid associated HTLC witness/);
            associatedNegatives++;
          }
        }
      }
      if(!checkAssociated)assert.equal(reads.length,positiveReads,'Detached signing/filling must not fetch');sdkFilledTransactions++;
    }
    for(const name of ['tape-value','tape-script','decode-txid','decode-point','metadata-code',...(row.profile==='Coin'?['metadata-id']:[])]){
      fault=name;await assert.rejects(()=>reviewer.review(reviewInput));negativeCases++;
    }fault='';
    const malformed=new tbc.Transaction(raw);malformed.inputs[0].setScript(tbc.Script.fromHex('51'));
    const bad=structuredClone(reviewInput);bad.request.txraws=[malformed.uncheckedSerialize()];bad.transactionIds=[malformed.id];
    await assert.rejects(()=>reviewer.review(bad));negativeCases++;
    const outputCodes=await kit.inspectReviewedTokenCodes(keyless,tx.outputs.map(o=>o.script.toHex()));
    const codeIndex=outputCodes.findIndex(Boolean);assert.ok(codeIndex>=0);
    for(const kind of ['controller','conservation']){
      const changed=new tbc.Transaction(raw);
      if(kind==='controller'){
        const original=changed.outputs[codeIndex].script.toHex(),controller=outputCodes[codeIndex].controller;
        assert.ok(original.includes(controller));changed.outputs[codeIndex].setScript(tbc.Script.fromHex(original.replace(controller,'ff'.repeat(20)+'01')));
      }else{
        const tape=changed.outputs[codeIndex+1].script.toBuffer();tape.writeBigUInt64LE(tape.readBigUInt64LE(3)+1n,3);
        changed.outputs[codeIndex+1].setScript(tbc.Script.fromBuffer(tape));
      }
      const altered=structuredClone(reviewInput);altered.request.txraws=[changed.uncheckedSerialize()];altered.transactionIds=[changed.id];
      await assert.rejects(()=>reviewer.review(altered));negativeCases++;
    }
    reports.push({index,profile:row.profile,operation:row.operation,status:'accepted',reads:positiveReads});
  }catch(e){reports.push({index,profile:row.profile,operation:row.operation,status:'rejected',reason:String(e.message).replace(/[0-9a-f]{32,}/gi,'[withheld]').slice(0,140),reads:reads.length});}
}
const report={status:'HTLC_TOKEN_RAW_REVIEW_AUDIT',reports,boundPreviews,negativeCases,externalHttp:0,currentProofs,controllerNegatives,parityCalls,dependentChecks,dependentHostChecks,
  wasmSha256:createHash('sha256').update(wasmBytes).digest('hex'),
  detachedFixtureSignatures:detachedSignatures,sdkFilledTransactions,sdkVmInputs,associatedWitnessCases,associatedStandardBound,associatedDefaultReviews,associatedNegatives,hostChecks,sdkCommit:oracle?.commit,sdkFiles:oracle?.files,authorizedSignatures:0,broadcasts:0};
const reportPath=join(reportDirectory,'report.json');writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...report,reportPath}));
if(oracle){assert.equal(sdkFilledTransactions,21);assert.equal(sdkVmInputs,58);}if(checkAssociated){assert.equal(associatedWitnessCases,21);assert.equal(associatedStandardBound,21);assert.equal(associatedDefaultReviews,21);assert.ok(associatedNegatives>0);assert.equal(hostChecks.length,18);}
if(currentProofs)assert.equal(controllerNegatives,28);
if(dependentRefunds){assert.equal(dependentChecks.length,7);assert.equal(dependentHostChecks.length,18);}
if(exportRefunds){
  assert.ok(reports.every(r=>r.status==='accepted'),'Do not export failed fixtures');assert.equal(refundVectors.length,2);
  const path=join(reportDirectory,'refund-vectors.json');
  const bytes=JSON.stringify({fixtureOnly:true,realSecrets:false,sdkCommit:oracle.commit,reportSha256:createHash('sha256').update(readFileSync(reportPath)).digest('hex'),cases:refundVectors},null,2)+'\n';
  writeFileSync(path,bytes,{flag:'wx'});console.log(JSON.stringify({refundVectorsPath:path,sha256:createHash('sha256').update(bytes).digest('hex')}));
}
if(process.argv.includes('--require-complete')&&reports.some(r=>r.status!=='accepted'))process.exitCode=1;
if(process.argv.includes('--live-identity')){
  // Only the two already-public lock transactions, NOT claim transactions.
  // Read-only API compatibility check, not a current-spend or broadcast test.
  let requests=0;const live=kit.createTbcOfficialApi({network:'testnet',fetch:async(url,options)=>{
    const u=new URL(String(url));assert.equal(u.origin,'https://api.tbcdev.org');assert.equal(options?.method??'GET','GET');
    assert.ok(++requests<=6);return fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
  }});
  for(const [txid,contractId]of [
    ['49cf50686af811bc7b1d9847ba7cfeefd12da2018651308fb6e4a20d07d11d65','93ba56b55e3d638bc92c1d4c40f03499ddbf16fc47bf7ea2ae9f548f56a536d2'],
    ['b87a5f5c8cf3154b5bad55832b715e9c578502ce18b5689573125197a6c5459b','a80a37a536efd16a62f999a7d6b8e67b15bec0be175e7b3fe7454b3bdb592562'],
  ]){
    const data=await live.rawTransaction({txid}),tx=new tbc.Transaction(data.txraw);assert.equal(tx.id,txid);
    const [code]=await kit.inspectReviewedTokenCodes(keyless,[tx.outputs[1].script.toHex()]);assert.ok(code);
    const assets=await kit.discoverReviewedTokenAssets(keyless,live,[{code,txid,vout:1}]);assert.equal(assets.get(code.codeIdentity).contractId,contractId);
  }
  console.log(JSON.stringify({status:'HTLC_LIVE_ASSET_IDENTITY_PASS',assets:2,requests,signatures:0,broadcasts:0,spendabilityVerified:false}));
}
