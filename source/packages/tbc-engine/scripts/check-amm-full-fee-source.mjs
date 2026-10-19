#!/usr/bin/env node
// Re-sign and execute every input of pinned, synthetic AMM buy transactions.
// Never prints raw transactions, unlock scripts or signing material.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import {resolve,join,relative} from 'node:path';
import {build} from 'esbuild';

const [upstreamArg,depsArg]=process.argv.slice(2);
assert.ok(upstreamArg&&depsArg&&process.argv.length===4);
const upstream=resolve(upstreamArg),deps=createRequire(join(resolve(depsArg),'package.json'));
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986';
execFileSync(process.execPath,[new URL('./check-amm-pool-proof-source.mjs',import.meta.url).pathname,upstream,resolve(depsArg)],{stdio:'pipe',timeout:60000});
const built=await build({stdin:{contents:`export {buildPoolUnlockScript,getPoolOutputLayout} from './lib/util/poolnft3/witness.js';
export {buildTBC20UnlockScriptWithSignature} from './lib/util/tbc20/tbc20unlock.js';
export {validatePool3Transaction} from './lib/validator/poolnft3.js';`,resolveDir:upstream},
  bundle:true,write:false,metafile:true,platform:'node',format:'cjs',target:'node22',external:['tbc-lib-js'],logLevel:'silent'});
for(const file of Object.keys(built.metafile.inputs)){
  if(file==='<stdin>')continue;
  const path=resolve(file),rel=relative(upstream,path);assert.ok(!rel.startsWith('..'));
  assert.deepEqual(readFileSync(path),execFileSync('git',['-C',upstream,'show',`${commit}:${rel}`],{maxBuffer:8*1024*1024}));
}
const module={exports:{}};
runInThisContext(`(function(module,exports,require){${built.outputFiles[0].text}\n})`)(module,module.exports,name=>{
  assert.ok(name==='tbc-lib-js'||name.startsWith('tbc-lib-js/')||name==='node:crypto');return deps(name);
});
const {buildPoolUnlockScript,getPoolOutputLayout,buildTBC20UnlockScriptWithSignature,validatePool3Transaction}=module.exports;
const tbc=deps('tbc-lib-js');
const fixture=JSON.parse(readFileSync(new URL('../rust/fixtures/amm-pool-proof.json',import.meta.url)));
const buyer=new tbc.PrivateKey(new tbc.crypto.BN(1));
const controller=new tbc.PrivateKey(new tbc.crypto.BN(2));
const txById=new Map(Object.entries(fixture.raws).map(([id,raw])=>[id,new tbc.Transaction(raw)]));
const results=[];
const txFee=tx=>tx.inputs.reduce((total,input)=>total+BigInt(input.output.satoshis),0n)-
  tx.outputs.reduce((total,output)=>total+BigInt(output.satoshis),0n);

for(const vector of fixture.vectors.filter(row=>row.operation===3)){
  for(const variant of ['baseline','zero-service','increase-service','alternate-recipient']){
    const tx=new tbc.Transaction(vector.currentRaw);
    for(const input of tx.inputs){
      const previous=txById.get(input.prevTxId.toString('hex'));
      assert.ok(previous);input.output=previous.outputs[input.outputIndex];input.setScript(tbc.Script.empty());
    }
    const layout=getPoolOutputLayout(tx,3),fee=tx.outputs[layout.feeVout],change=tx.outputs[layout.tbcChangeVout];
    const originalFee=fee.satoshis;
    assert.ok(originalFee>0&&change.satoshis>originalFee);
    const baselineMiningFee=txFee(tx);
    if(variant==='zero-service'){
      fee.satoshis=0;fee.setScript(tbc.Script.fromHex('006a'));change.satoshis+=originalFee;
    }else if(variant==='increase-service'){
      fee.satoshis+=10;change.satoshis-=10;
    }else if(variant==='alternate-recipient'){
      fee.setScript(tbc.Script.buildPublicKeyHashOut(controller.toAddress()));
    }
    assert.equal(txFee(tx),baselineMiningFee,`${vector.id}: mining fee changed`);
    assert.equal(fee.satoshis,variant==='zero-service'?0:variant==='increase-service'?originalFee+10:originalFee);
    const parent=txById.get(vector.parentTxid),ancestor=txById.get(vector.ancestorTxid);
    const auxiliary=vector.auxiliaryTxids.map(id=>txById.get(id));
    assert.ok(parent&&ancestor&&auxiliary.every(Boolean));
    const poolSignature=vector.publicKeyHex?Buffer.from(tx.getSignature(0,controller),'hex'):undefined;
    tx.inputs[0].setScript(buildPoolUnlockScript({tx,preTx:parent,prePreTx:ancestor,inputTxs:auxiliary,option:3,
      ...(poolSignature?{signature:poolSignature,publicKey:controller.publicKey.toBuffer()}:{})}));
    tx.inputs[1].setScript(new tbc.Script().add(Buffer.from(tx.getSignature(1,buyer),'hex')).add(buyer.publicKey.toBuffer()));
    // The FT input owns the same immutable Pool FT asset in the signed fixture.
    // Rebuild its proof against the changed transaction and the actual ancestors.
    const poolFt=auxiliary[1];
    tx.inputs[2].setScript(buildTBC20UnlockScriptWithSignature({
      currentTx:tx,inputIndex:2,preTx:poolFt,preTxVout:tx.inputs[2].outputIndex,
      ancestorTransactions:txById,outputGroups:[{codeVout:0,tapeVout:1},{codeVout:2,tapeVout:3},
        {codeVout:4},{codeVout:5,tapeVout:6},{codeVout:7}],
      contractController:{transaction:parent,currentInputIndex:0},
      signature:Buffer.from(tx.getSignature(2,buyer),'hex'),publicKey:buyer.publicKey.toBuffer(),
    }));
    const validation=validatePool3Transaction(tx);
    assert.equal(validation.valueConserved,true);
    const expected=variant!=='alternate-recipient';
    assert.equal(validation.success,expected,`${vector.id}/${variant}: full VM result changed`);
    assert.equal(validation.inputs.length,3);
    assert.deepEqual(validation.inputs.map(input=>input.success),[expected,true,true]);
    if(variant==='baseline'){
      assert.equal(tx.id,vector.signedTxid,`${vector.id}: baseline txid`);
      assert.ok(validation.success,`${vector.id}: baseline failed`);
    }
    results.push({vector:vector.id,variant,valid:validation.success,
      serviceOutputSat:fee.satoshis,miningFeeUnchanged:true,
      inputResults:validation.inputs.map(({inputIndex,success,error})=>({inputIndex,success,error}))});
  }
}
assert.equal(results.length,16);
const summary=Object.fromEntries([...new Set(results.map(row=>row.variant))].map(variant=>{
  const rows=results.filter(row=>row.variant===variant);
  return[variant,{cases:rows.length,fullVmAccepted:rows.filter(row=>row.valid).length,
    serviceOutputSat:rows.map(row=>row.serviceOutputSat)}];
}));
console.log(JSON.stringify({sourceCommit:commit,scope:'Independent offline whole-transaction input VM; public synthetic signing only',
  fixtureSha256:createHash('sha256').update(readFileSync(new URL('../rust/fixtures/amm-pool-proof.json',import.meta.url))).digest('hex'),
  cases:results.length,inputsPerCase:3,networkRequests:0,broadcasts:0,summary},null,2));
