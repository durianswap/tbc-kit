import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [platform,currentArg,baselineArg,outArg]=process.argv.slice(2);
assert(['ios','android'].includes(platform));
const read=async p=>JSON.parse(await readFile(p));
const c=await read(join(resolve(currentArg),'device-report.json')),b=await read(join(resolve(baselineArg),'device-report.json'));
const ca=await read(join(resolve(currentArg),'artifact.json')),ba=await read(join(resolve(baselineArg),'artifact.json'));
assert.equal(c.status,'PASS_MATCHED_CURRENT_TBC20');assert.equal(b.status,'PASS_FROZEN_JS_TBC20');assert.equal(c.broadcasts,0);assert.equal(b.broadcasts,0);
assert.equal(c.platform,platform);assert.equal(b.platform,platform);assert.equal(c.build,b.build);
const ordered=x=>Array.isArray(x)?x.map(ordered):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,ordered(x[k])])):x;
const hash=x=>createHash('sha256').update(JSON.stringify(ordered(x))).digest('hex');
assert.equal(c.operations.length,4);assert.equal(b.page.operations.length,4);
const median=a=>a.toSorted((x,y)=>x-y)[Math.floor(a.length/2)];
const stats=a=>({samplesMs:a,medianMs:median(a),minMs:Math.min(...a),maxMs:Math.max(...a)});
const lanes={};
for(const [name,r,ops,events,approve,sign]of [
 ['current',c,c.operations,c.channelEvents,'signing.consent','signing.sign'],
 ['frozenKit',b,b.page.operations,b.custodyEvents,'approve','sign']
]){
 const incoming=r.wireEvents.filter(e=>e.stage==='request-received'&&e.method==='tbc_signTransaction');assert.equal(incoming.length,4);
 const rows=ops.map((op,i)=>{
  const begin=incoming[i].atUs,next=incoming[i+1]?.atUs??Infinity,method=e=>e.method??e.native;
  const approvals=events.filter(e=>method(e)===approve&&e.startUs>=begin&&e.startUs<next);assert.equal(approvals.length,1);
  const a=approvals[0],signs=events.filter(e=>method(e)===sign&&e.startUs>=a.endUs&&e.startUs<next);assert.equal(signs.length,2);
  const delivery=r.wireEvents.find(e=>e.stage==='delivery-start'&&e.id===incoming[i].id);assert(delivery);
  const reads=r.requests.filter(e=>e.startUs>=begin&&e.startUs<next);assert.equal(reads.length,i===0?5:3);assert(reads.every(e=>e.method==='GET'));
  const overlapsApproval=reads.some(e=>e.startUs<a.endUs&&e.endUs>a.startUs);
  // Server arrival timestamps include first-use TLS setup. Preserve cold
  // observations instead of pretending every historical lane overlaps it.
  if(i>0)assert(reads.some(e=>e.startUs<a.endUs),'Warm preparation must not wait for approval');
  const fresh=reads.filter(e=>!e.path.includes('/txraw/'));
  const concurrent=fresh.reduce((n,e)=>Math.max(n,fresh.filter(f=>f.startUs<=e.startUs&&f.endUs>e.startUs).length),0);assert.equal(fresh.length,3);assert(concurrent>=2);
  return {round:i,pageMs:op.ms,approvalToSignatureMs:(signs.at(-1).endUs-a.endUs)/1000,
   approvalToReturnMs:(delivery.atUs-a.endUs)/1000,approvalUiMs:(a.endUs-a.startUs)/1000,gets:reads.length,
   freshReadsMaxConcurrent:concurrent,overlapsApproval,allReadsFinishedBeforeApproval:reads.every(e=>e.endUs<=a.endUs)};
 });
 lanes[name]={rows,warm:Object.fromEntries(['pageMs','approvalToSignatureMs','approvalToReturnMs'].map(k=>[k,stats(rows.slice(1).map(r=>r[k]))]))};
}
for(let i=0;i<4;i++){
 assert.equal(c.operations[i].signedTransactionsHash,hash(b.page.operations[i].value.transactions));
 assert.equal(c.operations[i].totalFee,b.page.operations[i].value.totalFee);
}
const hot=b.wireEvents.find(e=>e.stage==='request-received'&&e.method==='tbc_signTransaction').atUs;
assert.equal(b.hostEvents.filter(e=>e.startUs>=hot&&e.method.startsWith('sqlite.')).length,0);
const report={status:'MATCHED_CURRENT_TBC20_MEASURED',recordedAt:new Date().toISOString(),platform,build:c.build,lanes,
 comparisonPercent:Object.fromEntries(['pageMs','approvalToSignatureMs','approvalToReturnMs'].map(k=>[k,(lanes.current.warm[k].medianMs/lanes.frozenKit.warm[k].medianMs-1)*100])),
 exactSignedTransactions:true,exactFee:true,oneApprovalBoth:true,twoSignaturesBoth:true,getsCold:5,getsWarm:3,warmParallelPrefetchBoth:true,
 artifact:{current:ca,baseline:ba},
 scope:'Current full Dart/native host with paired1.7.3 Compute versus unchanged accepted frozen JS Kit. Same TBC20 fixture, pinned loopback TLS5ms responses,200ms consent, device and build mode. One cold plus three warm samples. Current read callback crosses UI isolate; baseline reads in JS/Dart host. No unnecessary validation removed. No live-network or entire-business speed claim.',
 caveats:['Approval-to-sign measures private channel completion, not ECDSA only. Return ends at native delivery start, not page rendering.',
  'Fixture-specific benchmark does not prove new-AMM or every business latency. Native hot-path durability must also be verified from source/targeted tests; lack of a channel named sqlite does not prove absence of native DB writes.',
  'Whole test-App sizes are not partner incremental sizes. iOS Debug cannot establish Release distribution size.'],broadcasts:0};
await writeFile(resolve(outArg),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,platform,lanes,comparisonPercent:report.comparisonPercent}));
