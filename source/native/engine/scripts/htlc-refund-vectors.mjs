// Acceptance only: frozen public scalar-1/scalar-7 refund fixtures, no secrets.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {secp256k1} from '@noble/curves/secp256k1';
export async function createHtlcRefundPlatformVectors({sdk,companion,wasm,runDesktop}){
 const sha=b=>createHash('sha256').update(b).digest('hex');
 const tbc=createRequire(resolve(import.meta.dirname,'../../../package.json'))('tbc-lib-js');
 const path='/var/folders/3b/09dp91rj013g4w55jfnwsq0c0000gn/T/tbc-reviewed-htlc-controller-hJgkA9/refund-vectors.json';
 const bytes=await readFile(path),fixtureSha256=sha(bytes);
 assert.equal(fixtureSha256,'4678f5e4706c509b42dcf7124690eb10d5f6868aa6917ceb2d53522588233c36');
 const fixture=JSON.parse(bytes);assert.equal(fixture.fixtureOnly,true);assert.equal(fixture.realSecrets,false);
 assert.equal(fixture.sdkCommit,'af77616121db340e15bb8b73c197bc2f8d1ee986');assert.equal(fixture.cases.length,2);
 assert.equal(bytes.includes(Buffer.from('33'.repeat(32))),false);
 const groups=[];
 for(const row of fixture.cases){
  assert.equal(row.publicSyntheticScalar,1);
  const signer=new tbc.PrivateKey(new tbc.crypto.BN(1));assert.equal(signer.publicKey.toString(),row.account.publicKey);
  const previousTransactions=[],calls=[];
  for(let transactionIndex=0;transactionIndex<2;transactionIndex++){
   const prepare={...row.keylessRequest,transactionIndex,previousTransactions:[...previousTransactions]};
   const stage=JSON.parse(await wasm.execute('prepareReviewedStage',JSON.stringify(prepare)));
   const finalize={stage,signatures:stage.digests.map(d=>secp256k1.sign(d,signer.toBuffer()).toCompactHex()),signatureEncoding:'compact64'};
   const result=JSON.parse(await wasm.execute('finalizeReviewedStage',JSON.stringify(finalize)));
   assert.equal(result.txraw,row.expectedRaws[transactionIndex],'Must equal SDK-validated complete raw');
   calls.push(['prepareReviewedStage',prepare,stage],['finalizeReviewedStage',finalize,result]);previousTransactions.push(result.txraw);
  }
  groups.push({profile:row.profile,calls});
 }
 const rust=join(companion,'source/packages/tbc-engine/rust');
 const source=await readFile(join(rust,'crates/tbc-keyless-core/tests/reviewed_htlc.rs'));
 const rustTestSha256=sha(source);assert.equal(rustTestSha256,'d120db3878c03c13ed9ca5fa59dd3f5e31ccab8a69e1def1eb1febf3e8bedba6');
 let output;try{output=execFileSync('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','reviewed_htlc',
  'associated_htlc_children_derive_refund_locks_from_finalized_parent','--','--exact','--nocapture'],
  {cwd:rust,env:{...process.env,CARGO_TARGET_DIR:join(companion,'target'),HTLC_ASSOCIATED_DUMP_WIRE:'1'},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000,maxBuffer:4*1024*1024});}
 catch{throw Error('Frozen public HTLC fixture generation failed; material withheld');}
 const marker='HTLC_ASSOCIATED_CHILD_WIRE:';
 const rows=output.split('\n').filter(l=>l.startsWith(marker)).map(l=>JSON.parse(l.slice(marker.length))).filter(r=>r.kind==='refund');
 assert.equal(rows.length,2);
 for(const row of rows)groups.push({profile:new tbc.Transaction(row.childStage.txraw).nLockTime<500000000?'TBC-height':'TBC-timestamp',calls:[
  ['prepareReviewedStage',row.prepareParent,row.parentStage],['finalizeReviewedStage',row.parentFinal,row.signedParent],
  ['prepareReviewedStage',row.prepareChild,row.childStage],['finalizeReviewedStage',row.childFinal,row.signedChild],
 ]});
 const vectors=[];let valid=0,rejected=0,vmInputs=0;
 for(const group of groups){
  const calls=[...group.calls];
  const childPrepare=group.calls[2][1],childFinal=group.calls[3][1];
  const missing=structuredClone(childPrepare);missing.previousTransactions=[];calls.push(['prepareReviewedStage',missing,null]);
  for(const change of ['lock','sequence','domain']){
   const bad=structuredClone(childFinal),tx=new tbc.Transaction(bad.stage.txraw);
   if(change==='lock')tx.nLockTime--;
   else if(change==='sequence')tx.inputs[0].sequenceNumber=0xffffffff;
   else tx.nLockTime=tx.nLockTime<500000000?1774427165:834801;
   bad.stage.txraw=tx.uncheckedSerialize();calls.push(['finalizeReviewedStage',bad,null]);
  }
  for(const [method,data,reference]of calls){
   const input=JSON.stringify(data);assert.equal(input.includes('33'.repeat(32)),false);
   const expected=runDesktop(method,input).trim(),result=JSON.parse(expected);
   if(reference===null){assert.equal(typeof result.error,'string');await assert.rejects(wasm.execute(method,input),e=>e.message===result.error);rejected++;}
   else{
    assert.deepEqual(result,reference);assert.deepEqual(JSON.parse(await wasm.execute(method,input)),reference);valid++;
    if(method==='finalizeReviewedStage'){
     const tx=new tbc.Transaction(result.txraw);tx.inputs.forEach((i,n)=>{const p=data.stage.inputs[n];
      i.output=new tbc.Transaction.Output({script:tbc.Script.fromHex(p.script),satoshis:p.satoshis});assert.equal(tx.verifyScript(n).success,true);vmInputs++;
     });
    }
   }
   vectors.push({method,input,expected});
  }
 }
 assert.equal(valid,16);assert.equal(rejected,16);assert.equal(vmInputs,14);
 return {vectors,evidence:{fixtureSha256,rustTestSha256,profiles:groups.map(g=>g.profile),valid,rejected,vmInputs,
  publicFixturesOnly:true,realCustody:false,chainMaturityChecked:false,sourceRoot:join(resolve(sdk,'..'),'source-snapshot.json')}};
}
