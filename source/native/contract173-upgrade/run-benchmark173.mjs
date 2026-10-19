// Public synthetic signing only; no broadcast route exists in this consumer.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {sha256} from '../flutter/scripts/candidate-inputs.mjs';
const [platform,consumerArg,outArg]=process.argv.slice(2);assert(['ios','android'].includes(platform));
const consumer=resolve(consumerArg),out=resolve(outArg),p=JSON.parse(await readFile(join(consumer,'consumer-provenance.json')));
assert.equal(p.publicFixtureOnly,true);assert.equal(p.broadcasts,0);assert(p.benchmark);assert.equal(p.platform,platform);
assert.equal(sha256(await readFile(join(consumer,'lib/main.dart'))),p.benchmark.mainSha256);
assert.equal(sha256(await readFile(join(consumer,'assets/pilot.json'))),p.benchmark.fixtureSha256);
await mkdir(out,{recursive:false});
const android=platform==='android',device=android?'emulator-5554':'C2C010B8-4071-4888-9E25-D91BF88EB461',id='io.tbc.dartkit.f1';
const run=args=>execFileSync(android?'/Users/alex/Library/Android/sdk/platform-tools/adb':'xcrun',android?['-s',device,...args]:['simctl',...args],{maxBuffer:64*1024*1024});
let pid,data,artifact;
if(android){
 const apkPath=run(['shell','pm','path',id]).toString().trim();assert.match(apkPath,/^package:\/data\/app\/[^\n]+\/base.apk$/);
 const apk=join(consumer,'build/app/outputs/flutter-apk/app-release.apk'),bytes=await readFile(apk);
 assert.equal(sha256(run(['exec-out','cat',apkPath.slice(8)])),sha256(bytes));artifact={path:apk,sha256:sha256(bytes),bytes:bytes.length};
 run(['shell','am','force-stop',id]);run(['shell','am','start','-n',id+'/io.tbc.dartkitf1.MainActivity']);
 for(let i=0;i<20;i++){try{pid=run(['shell','pidof',id]).toString().trim();}catch{}if(pid)break;await new Promise(r=>setTimeout(r,100));}
}else{
 const app=run(['get_app_container',device,id,'app']).toString().trim();data=run(['get_app_container',device,id,'data']).toString().trim();
 const file=join(consumer,'build/ios/iphonesimulator/Runner.app/Runner.debug.dylib'),bytes=await readFile(file);
 assert.equal(sha256(await readFile(join(app,'Runner.debug.dylib'))),sha256(bytes));artifact={path:file,sha256:sha256(bytes),bytes:bytes.length};
 try{run(['terminate',device,id]);}catch{}
 pid=run(['launch',device,id]).toString().trim().match(/: (\d+)$/)?.[1];
}
assert(pid);console.log(JSON.stringify({status:'BENCHMARK_RUNNING',platform,pid,out}));
let report;
for(let i=0;i<60;i++){
 await new Promise(r=>setTimeout(r,500));
 try{
  const bytes=android?run(['exec-out','cat',`/sdcard/Android/data/${id}/files/f1-report.json`]):await readFile(join(data,'Documents/f1-report.json'));
  const r=JSON.parse(bytes);if(String(r.pid)===pid)report=r;
 }catch{}
 if(report?.status==='PASS_MATCHED_CURRENT_TBC20'||report?.status?.startsWith('FAIL'))break;
}
assert(report,'No matching-process result; inspect the same process, do not restart on timeout');
await writeFile(join(out,'device-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
await writeFile(join(out,'artifact.json'),JSON.stringify({recordedAt:new Date().toISOString(),...artifact,consumer:p,device,pid},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,error:report.error,operations:report.operations}));
assert.equal(report.status,'PASS_MATCHED_CURRENT_TBC20');assert.equal(report.broadcasts,0);assert.equal(report.operations.length,4);
