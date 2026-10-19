// Synthetic public-key fixtures only. Validate actual Engine-finalized scripts
// using the independent JS interpreter; no API, wallet key or broadcast.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),rust=join(root,'packages/tbc-engine/rust');
const tbc=createRequire(join(root,'packages/kit/package.json'))('tbc-lib-js');
const sha=b=>createHash('sha256').update(b).digest('hex');
const run=spawnSync('cargo',['test','--locked','-p','tbc-engine-core','--test','pool','pool2_lp6_330_uses_bound_current_economics_and_shared_signing','--','--nocapture'],
  {cwd:rust,env:{...process.env,POOL173_DUMP_WIRE:'1'},encoding:'utf8',maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']});
assert.equal(run.status,0,'Engine fixture test failed; rerun without POOL173_DUMP_WIRE for concise diagnostics');
const output=run.stdout;
const rows=output.split('\n').filter(s=>s.startsWith('POOL173_WIRE:')).map(s=>JSON.parse(s.slice(13)));
assert.equal(rows.length,8);
const evidence=[];
for(const row of rows){
  const history=new Map(row.parents.map(p=>[p.txid,new tbc.Transaction(p.rawTransaction)]));
  const verdicts=[];
  for(const raw of row.bundle.transactions){
    const tx=new tbc.Transaction(raw.rawTransaction);assert.equal(tx.id,raw.txid);
    for(const [vin,input]of tx.inputs.entries()){
      const parent=history.get(input.prevTxId.toString('hex'));assert.ok(parent);input.output=parent.outputs[input.outputIndex];
      const result=tx.verifyScript(vin);
      verdicts.push({vin,success:result.success,error:result.success?null:result.error});
    }
    history.set(tx.id,tx);
  }
  evidence.push({operation:row.name,plan:row.plan,transactions:row.bundle.transactions.length,verdicts,
    hashes:row.bundle.transactions.map(tx=>({txid:tx.txid,rawSha256:sha(Buffer.from(tx.rawTransaction,'hex'))}))});
}
const failures=evidence.filter(r=>r.verdicts.some(v=>!v.success));
const report={status:failures.length?'POOL2_SYNTHETIC_VM_DIAGNOSTIC':'POOL2_LP6_330_VM_PASS',totalFeeBps:330,lpFeeBps:200,providerFeeBps:130,
  historical130Compatibility:false,evidence,liveHttp:0,broadcasts:0,scope:'Offline actual signed-input VM; not Testnet acceptance',
  interpreterVersion:createRequire(join(root,'packages/kit/package.json'))('tbc-lib-js/package.json').version,
  sourceHashes:{}};
for(const path of ['crates/tbc-engine-core/src/families/pool.rs','vendor/tbc-sdk/src/contracts/pool_nft_v2/math.rs','vendor/tbc-sdk/src/contracts/pool_nft_v2/builder.rs'])report.sourceHashes[path]=sha(await readFile(join(rust,path)));
await writeFile(resolve(process.argv[2]??join(import.meta.dirname,'pool2-lp6-vm.json')),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,evidence:evidence.map(({hashes,...r})=>r),liveHttp:0,broadcasts:0}));
