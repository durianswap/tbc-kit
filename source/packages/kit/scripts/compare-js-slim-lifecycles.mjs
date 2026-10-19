// Controlled public-key-one fixtures; no network sockets or real broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,symlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [baseArg,installedArg,outArg]=process.argv.slice(2);
assert.ok(outArg,'BASE_KIT CLEAN_INSTALLED_KIT NEW_OUTPUT');
const root=resolve(import.meta.dirname,'../../..'),out=resolve(outArg),candidate=resolve(installedArg);
await mkdir(out);
const base=join(out,'baseline');await cp(resolve(baseArg),base,{recursive:true});
await cp(join(root,'packages/kit/test'),join(base,'test'),{recursive:true});
await cp(join(root,'packages/kit/src'),join(base,'src'),{recursive:true});
await mkdir(join(base,'scripts'));
await symlink(resolve(candidate,'../../'),join(base,'node_modules'));
const template=await readFile(join(root,'packages/kit/scripts/check-default-success-lifecycles.mjs'),'utf8');
assert.ok(template.includes('const signOnly = [];'));
let source=template.slice(0,template.indexOf('const signOnly = [];'));
source=source.replace('let approvals = 0;','let approvals = 0; let approvedAtMs = 0;')
 .replace('approvals += 1;','approvals += 1; approvedAtMs = performance.now();')
 .replace('      label,\n      mode,','      label,\n      mode,\n      afterApprovalMs: performance.now() - approvedAtMs,\n      rawHashes: result.transactions.map(t => createHash("sha256").update(t.rawTransaction).digest("hex")),');
source+='\nexport const labels=cases.filter(([name])=>!name.includes(".create")).map(([name])=>name);\nexport async function sample(label){const entry=cases.find(([name])=>name===label);const start=performance.now();const result=await runCase(...entry,"sign");return {...result,totalMs:performance.now()-start};}\n';
const modules=[];
for(const p of [base,candidate]){
 const file=join(p,'scripts/js-slim-controlled-probe.mjs');await writeFile(file,source);
 modules.push(await import(pathToFileURL(file)));
}
assert.deepEqual(modules[0].labels,modules[1].labels);
const summary=[];
const stable=({afterApprovalMs,totalMs,hostIdentity,...value})=>{
 // Each execution has fresh opaque Host call IDs. runCase already verifies
 // uniqueness; compare their count and ordered operations, not random IDs.
 const {callIds,...host}=hostIdentity;
 return {...value,hostIdentity:{...host,callIdCount:callIds.length}};
};
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
for(const label of modules[0].labels){
 const samples=[[],[]];
 for(let round=0;round<10;round++){
  const pair=[];
  for(const side of round%2?[1,0]:[0,1]){pair[side]=await modules[side].sample(label);if(round>0)samples[side].push(pair[side]);}
  assert.deepEqual(stable(pair[1]),stable(pair[0]),`${label}: transaction, approval, signer, HTTP or Host behavior changed`);
 }
 const times=samples.map(rows=>({totalMs:median(rows.map(r=>r.totalMs)),afterApprovalMs:median(rows.map(r=>r.afterApprovalMs))}));
 const gates=Object.fromEntries(['totalMs','afterApprovalMs'].map(k=>[k,{limit:times[0][k]*1.15+2,pass:times[1][k]<=times[0][k]*1.15+2}]));
 summary.push({label,baseline:times[0],candidate:times[1],gates,behavior:stable(samples[0][0]),samples:samples.map(rows=>rows.map(({totalMs,afterApprovalMs})=>({totalMs,afterApprovalMs})))});
 console.log(label,JSON.stringify({baseline:times[0],candidate:times[1],gates}));
}
const passed=summary.every(r=>Object.values(r.gates).every(g=>g.pass));
const report={status:passed?'PASS_CONTROLLED_PARITY_AND_TIMING':'TIMING_REQUIRES_INVESTIGATION',rounds:9,
 methodology:'One warmup then nine alternating A/B rounds per case. Same-process Node, public synthetic fixtures; not device or real-network latency.',
 gate:'median <= baseline * 1.15 + 2 ms, both total and approval-to-completion',
 summary,realNetwork:false,realBroadcast:false,deviceAcceptance:false};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
if(!passed)process.exitCode=1;
