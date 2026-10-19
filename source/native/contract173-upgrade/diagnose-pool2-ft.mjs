// Offline public fixtures only; reuse Engine signatures and compare both SDK
// witness branches. Never replace production witnesses just to pass a test.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),upstream='/private/tmp/tbc-contract-audit-20261014';
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(await readFile(join(upstream,'npm-1.7.3.tgz'))),'32c3d291e9f566a9ccfcca73d42fe54a25c592361004b2acf3946f04547f028e');
globalThis.fetch=()=>{throw new Error('No live HTTP in wire diagnostic');};
const tbc=createRequire(join(root,'packages/kit/package.json'))('tbc-lib-js');
const sdk=createRequire(join(upstream,'package/index.js'))('./index.js');
const run=spawnSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test','pool','pool2_lp6_330_uses_bound_current_economics_and_shared_signing','--','--nocapture'],
  {cwd:join(root,'packages/tbc-engine/rust'),env:{...process.env,POOL173_DUMP_WIRE:'1',POOL173_INVALID_PROVENANCE:'1'},encoding:'utf8',maxBuffer:32*1024*1024});
assert.equal(run.status,0);
const rows=run.stdout.split('\n').filter(s=>s.startsWith('POOL173_WIRE:')).map(s=>JSON.parse(s.slice(13)));
assert.equal(rows.length,8);
const results=[];
for(const row of rows){
  const parents=row.parents.map(p=>new tbc.Transaction(p.rawTransaction));
  for(const raw of row.bundle.transactions){
    const tx=new tbc.Transaction(raw.rawTransaction);
    const contract=parents.find(p=>p.id===tx.inputs[0].prevTxId.toString('hex'));
    for(const [vin,input]of tx.inputs.entries()){
      const parent=parents.find(p=>p.id===input.prevTxId.toString('hex'));assert.ok(parent);
      input.output=parent.outputs[input.outputIndex];
      const actual=input.script,baseline=tx.verifyScript(vin);
      if(baseline.success)continue;
      const signature=actual.chunks.find(({buf})=>buf&&buf.length>=70&&buf[0]===0x30)?.buf;
      assert.ok(signature);
      const args=[signature.toString('hex'),new tbc.PrivateKey(new tbc.crypto.BN(1)).publicKey.toString(),
        tx,parent,sdk.buildFtPrePreTxData(parent,input.outputIndex,parents),contract,vin,input.outputIndex,4,false];
      const variants=[];
      for(const contractTXs of [false,true]){
        const script=sdk.FT.getFTunlockSwap(...args,contractTXs);input.setScript(script);
        const result=tx.verifyScript(vin);
        variants.push({contractTXs,sameWitness:script.toHex()===actual.toHex(),success:result.success,error:result.error??null});
      }
      input.setScript(actual);
      results.push({operation:row.name,plan:row.plan,vin,baseline,variants});
    }
    parents.push(tx);
  }
}
const report={scope:'Offline diagnostic, not chain acceptance',results,liveHttp:0,broadcasts:0};
await writeFile(resolve(process.argv[2]??join(import.meta.dirname,'pool2-ft-wire-diagnostic.json')),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report));
