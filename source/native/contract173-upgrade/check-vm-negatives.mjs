// Independent covenant negatives: rebuild the public Pool witness after output
// tampering. Failure must be in Pool input 0, not a now-stale P2PKH signature.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),upstream=resolve(process.argv[2]??'/private/tmp/tbc-contract-audit-20261014');
const req=createRequire(join(upstream,'package/index.js'));
const tbc=createRequire(join(root,'packages/kit/package.json'))('tbc-lib-js');
const {buildPoolUnlockScript}=req('./lib/util/tbc-amm/witness.js');
const fixtureBytes=await readFile(join(root,'packages/tbc-engine/rust/fixtures/amm-explicit173-lifecycle.json'));
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(await readFile(join(upstream,'npm-1.7.3.tgz'))),'32c3d291e9f566a9ccfcca73d42fe54a25c592361004b2acf3946f04547f028e');
const f=JSON.parse(fixtureBytes),history=new Map(Object.entries(f.raws).map(([id,raw])=>[id,new tbc.Transaction(raw)]));
const rows=[];
for(const c of f.cases.filter(c=>!c.controlled))for(const a of c.actions){
  const op={add:1,remove:2,buy:3,sell:4}[a.operation];
  const base=history.get(a.txid);
  const parent=history.get(base.inputs[0].prevTxId.toString('hex'));
  const ancestor=history.get(parent.inputs[0].prevTxId.toString('hex'));
  const inputTxs=base.inputs.slice(1).map(i=>history.get(i.prevTxId.toString('hex')));
  for(const offset of [null,128,130,132,134,136,155]){
    const tx=new tbc.Transaction(base.uncheckedSerialize());
    tx.inputs.forEach(i=>{i.output=history.get(i.prevTxId.toString('hex')).outputs[i.outputIndex];});
    if(offset!==null){const tape=Buffer.from(tx.outputs[1].script.toBuffer());tape[offset]^=1;tx.outputs[1].setScript(tbc.Script.fromBuffer(tape));}
    tx.inputs[0].setScript(buildPoolUnlockScript({tx,preTx:parent,prePreTx:ancestor,inputTxs,option:op}));
    const verdict=tx.verifyScript(0);
    rows.push({case:c.label,operation:a.operation,changedTapeOffset:offset,success:verdict.success,error:verdict.error??null});
    assert.equal(verdict.success,offset===null,`${c.label}-${a.operation} offset ${offset}: ${verdict.error}`);
  }
}
const out=join(root,'native/contract173-upgrade/vm-negatives.json');
await writeFile(out,JSON.stringify({status:'EXPLICIT173_VM_CONFIGURATION_PASS',fixtureSha256:sha(fixtureBytes),scope:'Offline independent public Pool VM, no broadcast',accepted:rows.filter(r=>r.success).length,rejected:rows.filter(r=>!r.success).length,rows},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({path:out,accepted:rows.filter(r=>r.success).length,rejected:rows.filter(r=>!r.success).length}));
