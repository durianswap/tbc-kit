// Alternating paired Node/WASM benchmark; synthetic submitter, no network or device claims.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const repo=resolve(import.meta.dirname,'..');const [beforeArg,afterArg,outArg]=process.argv.slice(2);
const before=resolve(beforeArg),after=resolve(afterArg),out=resolve(outArg);await mkdir(out,{recursive:true});const samples=[];
const fixture=pathToFileURL(join(repo,'source/packages/kit/test/nft-job-stress-fixture.mjs')).href;
for(let round=0;round<3;round++)for(const which of round%2?['after','before']:['before','after']){
 const path=which==='before'?before:after;let log='';const code=await new Promise((done,fail)=>{const p=spawn(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {harness} from ${JSON.stringify(fixture)};for(const count of [10,100,101]){const h=await harness(count),start=performance.now();try{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.status,'complete');assert.equal(r.minted,count);console.log(JSON.stringify({count,ms:performance.now()-start,reads:h.calls,...h.stats()}))}finally{h.close()}}`],{cwd:repo,env:{...process.env,TBC_TEST_INSTALLED_KIT:path,TBC_TEST_WASM_DIR:join(path,'artifacts/wasm')},stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>log+=b);p.stderr.on('data',b=>log+=b);p.on('error',fail);p.on('close',done)});
 await writeFile(join(out,`timing-${round}-${which}.log`),log);assert.equal(code,0,log);
 for(const row of log.split('\n').filter(l=>l.startsWith('{')).map(JSON.parse))samples.push({round,which,...row});
}
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const comparison=[10,100,101].map(count=>{const a=samples.filter(r=>r.count===count&&r.which==='before'),b=samples.filter(r=>r.count===count&&r.which==='after');for(let i=0;i<3;i++){assert.deepEqual(a[i].reads,b[i].reads);assert.equal(a[i].approvals,b[i].approvals);assert.equal(a[i].signatures,b[i].signatures)}const beforeMs=median(a.map(r=>r.ms)),afterMs=median(b.map(r=>r.ms));return{count,beforeMs,afterMs,changePercent:(afterMs/beforeMs-1)*100,reads:b[0].reads,approvals:b[0].approvals}});
const result={status:'PASS',before:JSON.parse(await readFile(join(before,'package.json'))).version,after:JSON.parse(await readFile(join(after,'package.json'))).version,scope:'3 alternating local Node/WASM samples per count; synthetic API/submit, not iOS/Android or real-chain latency',comparison,samples};await writeFile(join(out,'timing.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:'PASS',comparison}));
