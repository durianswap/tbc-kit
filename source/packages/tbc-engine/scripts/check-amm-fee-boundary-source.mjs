#!/usr/bin/env node
// Offline audit of the frozen AMM Pool input only. All keys/material are public
// synthetic fixtures. This is not whole-transaction, node or custom-policy proof.
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
const upstream=resolve(upstreamArg),depsPath=resolve(depsArg);
const deps=createRequire(join(depsPath,'package.json'));
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986';
const sha=b=>createHash('sha256').update(b).digest('hex');
// Revalidate fixture provenance and the independent interpreter before probing.
execFileSync(process.execPath,[new URL('./check-amm-pool-proof-source.mjs',import.meta.url).pathname,upstream,depsPath],{stdio:'pipe',timeout:60000});
const built=await build({stdin:{contents:`export {buildPoolUnlockScript,getPoolOutputLayout} from './lib/util/poolnft3/witness.js';`,resolveDir:upstream},
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
const {buildPoolUnlockScript,getPoolOutputLayout}=module.exports;
const tbc=deps('tbc-lib-js'),VM=tbc.Script.Interpreter;
const fixture=JSON.parse(readFileSync(new URL('../rust/fixtures/amm-pool-proof.json',import.meta.url)));
const controller=new tbc.PrivateKey(new tbc.crypto.BN(2));
const alternateScript=tbc.Script.buildPublicKeyHashOut(controller.toAddress());
const results=[];

function probe(vector,name,mutate){
  const tx=new tbc.Transaction(vector.currentRaw);
  const parent=new tbc.Transaction(fixture.raws[vector.parentTxid]);
  const ancestor=new tbc.Transaction(fixture.raws[vector.ancestorTxid]);
  const inputTxs=vector.auxiliaryTxids.map(id=>new tbc.Transaction(fixture.raws[id]));
  tx.inputs.forEach(input=>{
    const previous=new tbc.Transaction(fixture.raws[input.prevTxId.toString('hex')]);
    input.output=previous.outputs[input.outputIndex];input.setScript(tbc.Script.empty());
  });
  const layout=getPoolOutputLayout(tx,vector.operation);
  const before=tx.uncheckedSerialize();
  mutate(tx,layout);
  const changed=tx.uncheckedSerialize()!==before;
  assert.equal(changed,name!=='baseline',`${vector.id}/${name} must not be a no-op`);
  const signature=vector.publicKeyHex?Buffer.from(tx.getSignature(0,controller),'hex'):undefined;
  let unlock;
  try{
    unlock=buildPoolUnlockScript({tx,preTx:parent,prePreTx:ancestor,inputTxs,option:vector.operation,
      ...(signature?{signature,publicKey:controller.publicKey.toBuffer()}:{})});
  }catch(error){
    results.push({vector:vector.id,case:name,stage:'witness',accepted:false,changed,error:error.message});return;
  }
  if(name==='baseline')assert.equal(sha(unlock.toBuffer()),vector.unlockHash);
  tx.inputs[0].setScript(unlock);
  const vm=new VM(),oldElement=VM.MAXIMUM_ELEMENT_SIZE,oldScript=VM.MAX_SCRIPT_ELEMENT_SIZE;
  let ok;
  try{
    VM.MAXIMUM_ELEMENT_SIZE=8;VM.MAX_SCRIPT_ELEMENT_SIZE=Number.MAX_SAFE_INTEGER;
    ok=vm.verify(unlock,tx.inputs[0].output.script,tx,0,VM.DEFAULT_FLAGS,tx.inputs[0].output.satoshisBN);
  }finally{VM.MAXIMUM_ELEMENT_SIZE=oldElement;VM.MAX_SCRIPT_ELEMENT_SIZE=oldScript;}
  const accepted=ok&&vm.stack.length===1;
  if(name==='baseline')assert.ok(accepted,`${vector.id}: ${vm.errstr}`);
  results.push({vector:vector.id,case:name,stage:'pool-input-vm',accepted,changed,error:vm.errstr||null});
}
const editTape=(tx,edit)=>{
  const bytes=Buffer.from(tx.outputs[1].script.toBuffer());assert.equal(bytes.length,143);
  edit(bytes);tx.outputs[1].setScript(tbc.Script.fromBuffer(bytes));
};
for(const vector of fixture.vectors){
  probe(vector,'baseline',()=>{});
  probe(vector,'replace-total-rate',tx=>editTape(tx,b=>b.writeUInt16LE(36,128)));
  probe(vector,'replace-plan',tx=>editTape(tx,b=>{b[130]=2;}));
  probe(vector,'replace-pool-code',tx=>tx.outputs[0].setScript(alternateScript));
  if(![3,4].includes(vector.operation))continue;
  probe(vector,'replace-fee-recipient',(tx,layout)=>{
    // The fixture's sell is below threshold. Convert the zero slot to an actual
    // payment as well, rather than merely changing the zero-output marker.
    const output=tx.outputs[layout.feeVout],delta=output.satoshis===0?10:0;
    output.setScript(alternateScript);output.satoshis+=delta;
    assert.ok(layout.tbcChangeVout!==undefined);tx.outputs[layout.tbcChangeVout].satoshis-=delta;
  });
  probe(vector,'increase-service-output',(tx,layout)=>{
    const fee=tx.outputs[layout.feeVout];
    // Keep the authenticated recipient, including when replacing a zero slot.
    fee.setScript(tbc.Script.buildPublicKeyHashOut('13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL'));
    fee.satoshis+=10;assert.ok(layout.tbcChangeVout!==undefined);
    tx.outputs[layout.tbcChangeVout].satoshis-=10;
  });
  // Only exercise an actual mutation; the pinned sell fixture already pays 0.
  if(vector.operation===3)probe(vector,'zero-service-output',(tx,layout)=>{
    const fee=tx.outputs[layout.feeVout];assert.ok(layout.tbcChangeVout!==undefined);
    tx.outputs[layout.tbcChangeVout].satoshis+=fee.satoshis;
    fee.satoshis=0;fee.setScript(tbc.Script.fromHex('006a'));
  });
}
// Pin observed boundaries, not a claim that the old contract implements the new
// fee policy. In particular, code replacement blocked by the builder is NOT a
// VM rejection. Fee-amount acceptance requires separate full-transaction review.
assert.equal(results.length,84);
for(const result of results){
  const expected=result.case==='baseline'||
    (result.vector.endsWith('-buy')&&['increase-service-output','zero-service-output'].includes(result.case));
  assert.equal(result.accepted,expected,`${result.vector}/${result.case} boundary changed`);
  assert.equal(result.stage,result.case==='replace-pool-code'?'witness':'pool-input-vm');
}
const summary=Object.fromEntries([...new Set(results.map(r=>r.case))].map(name=>{
  const rows=results.filter(r=>r.case===name);
  return[name,{cases:rows.length,accepted:rows.filter(r=>r.accepted).length,
    vmRejected:rows.filter(r=>!r.accepted&&r.stage==='pool-input-vm').length,
    builderRejected:rows.filter(r=>r.stage==='witness').length}];
}));
console.log(JSON.stringify({scope:'Frozen template Pool input only; changed transactions are NOT fully signed or chain-accepted',
  upstreamCommit:commit,fixtureSha256:sha(readFileSync(new URL('../rust/fixtures/amm-pool-proof.json',import.meta.url))),
  poolVmCases:results.filter(r=>r.stage==='pool-input-vm').length,networkRequests:0,broadcasts:0,summary},null,2));
