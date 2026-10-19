import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {sha256} from '../flutter/scripts/candidate-inputs.mjs';
const dir=resolve(process.argv[2]);
const platforms={};let kitIdentity;
const range=(rows,key,scale=1)=>[Math.min(...rows.map(r=>r[key]))/scale,Math.max(...rows.map(r=>r[key]))/scale].map(n=>Math.round(n*1000)/1000);
for(const platform of ['android','ios']){
 const bytes=await readFile(join(dir,platform+'-accepted.json')),r=JSON.parse(bytes);
 assert.equal(r.status,'CONTRACT173_DEVICE_PUBLIC_FIXTURE_PASS');assert.equal(r.artifact.installedVerified,true);
 kitIdentity??=r.kitIdentity;assert.deepEqual(r.kitIdentity,kitIdentity);
 const named=r.deviceReport.cases.filter(c=>c.name),amm=named.filter(c=>c.name.startsWith('fees'));
 assert.equal(named.length,45);assert.equal(amm.length,43);
 const groups={};for(const c of amm){const kind=c.name.replace(/^fees[01]-(public|controller)-(plain|locked)-/,'');(groups[kind]??=[]).push(c);}
 platforms[platform]={status:r.status,evidenceSha256:sha256(bytes),buildMode:r.artifact.buildMode,device:r.device,
  methodSelections:named.length,lifecycleChecks:r.deviceReport.cases.length-named.length,
  approvalsPerSelection:[...new Set(named.map(c=>c.approvalDelta))],
  allSignedTransactionsExact:named.filter(c=>c.method==='tbc_signTransaction').every(c=>c.signedTransactionsExact),
  artifact:r.artifact,
  timings:Object.fromEntries(Object.entries(groups).map(([kind,rows])=>[kind,{samples:rows.length,
   approvalToLastSignatureMs:range(rows,'approvalToLastSignatureUs',1000),nativeSignatureComputeMs:range(rows,'nativeSignUs',1000),
   pageReturnMs:range(rows,'pageMs'),readCount:range(rows,'reads')}]))};
}
const report={status:'PAIRED_DEVICE_CONTROLLED_ACCEPTANCE_PASS',kitIdentity,platforms,
 scope:'45 selections and 5 lifecycle checks per platform. New explicit-fee AMM 40 lifecycle variants plus 3 paged variants, message and TBC transfer. Public fixtures only.',
 timingLimit:'Single controlled run, synthetic chain data, 5 ms/read delay and 250 ms automated consent. iOS simulator Debug versus Android emulator Release. Not live API latency, physical-device performance, old/new matched regression or partner App increment.',
 broadcasts:0,published:false,acceptedDeliveryChanged:false,
 remaining:['Affected private Testnet lifecycle and confirmation','Matched timing and Release App increment','Paired partner package and clean integration','Deferred original Dart switchChain/Legacy and full-scope final closure']};
await writeFile(join(dir,'summary.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,platforms:Object.fromEntries(Object.entries(platforms).map(([p,r])=>[p,{selections:r.methodSelections,lifecycle:r.lifecycleChecks,timings:r.timings}]))}));
