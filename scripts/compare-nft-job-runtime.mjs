// Same controlled workload against accepted and candidate job routes; no real network.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
const repo=resolve(import.meta.dirname,'..'),out=resolve(process.argv[2]);
const candidate=JSON.parse(await readFile(join(out,'evidence/installed-check.json'))).installed;
const results=[];
for(const [name,path]of [['rc23',join(repo,'packages/kit')],['rc24',candidate]]){
 let log='';const code=await new Promise((res,rej)=>{const p=spawn(process.execPath,['--test','--test-name-pattern=real Engine/Host/Provider','packages/kit/test/nft-job-lifecycle-stress.test.mjs'],{
  cwd:join(repo,'source'),env:{...process.env,TBC_STRESS_MAX:'',TBC_TEST_INSTALLED_KIT:path,TBC_TEST_WASM_DIR:join(path,'artifacts/wasm')},stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>log+=b);p.stderr.on('data',b=>log+=b);p.on('error',rej);p.on('close',res)});
 await writeFile(join(out,'evidence',name+'-same-job-timing.log'),log);assert.equal(code,0,log);
 const rows=log.split('\n').filter(l=>l.startsWith('# {"count"')).map(l=>JSON.parse(l.slice(2)));results.push({version:name,rows});
}
const comparison=results[0].rows.map((a,i)=>{const b=results[1].rows[i];assert.equal(a.count,b.count);assert.deepEqual(a.reads,b.reads);assert.equal(a.approvals,b.approvals);assert.equal(a.signatures,b.signatures);
 return{count:a.count,beforeMs:a.ms,afterMs:b.ms,changePercent:(b.ms/a.ms-1)*100,reads:b.reads,approvals:b.approvals};});
const evidence={status:'PASS',scope:'single sequential Node/WASM synthetic sample; existing rc23 job route versus rc24 job route; not devices/network/monolithic path',comparison};
await writeFile(join(out,'evidence/same-job-timing.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
