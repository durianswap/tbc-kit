// Reproducible focused closure of the shared Legacy message profile only.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart&&output);const run=promisify(execFile),options={cwd:base,maxBuffer:8e6,timeout:120000};
const sha=x=>createHash('sha256').update(x).digest('hex');
const tests=['legacy_message_signing','legacy_mapping','legacy_shared_worker','signing_executor','workflow_execution','workflow_plan','typed_signing'].map(n=>'test/'+n+'_test.dart');
await run(process.execPath,['tool/legacy_message_oracle.mjs','--check'],options);
const analysis=await run(dart,['analyze','lib',...tests],options);
const tested=await run(dart,['test',...tests,'--reporter=json'],options);
const events=tested.stdout.trim().split('\n').map(l=>JSON.parse(l));
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const passed=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped);assert.equal(passed.length,283);assert(passed.every(e=>e.result==='success'));
const reports={};
for(const name of ['f3-legacy-native-profile-20261014-b','f3-legacy-profile-mobile-compile-20261014-b']){
 const path='evidence/'+name+'.json',bytes=await readFile(join(base,path)),r=JSON.parse(bytes);
 for(const [p,h]of Object.entries(r.sources))assert.equal(sha(await readFile(join(base,p))),h,p+' changed after check');
 reports[path]={sha256:sha(bytes),status:r.status,...r.legacyMessages?{legacyMessages:r.legacyMessages,protocolIsolation:r.protocolIsolation}:{}};
}
const sources={};
async function tree(dir){for(const e of await readdir(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())await tree(path);else if(e.isFile())sources[relative(base,path)]=sha(await readFile(path));}}
await tree(join(base,'lib'));
for(const p of [...tests,'test/fixtures/legacy-message-signing.json','tool/legacy_message_oracle.mjs','tool/check_legacy_message.mjs'])sources[p]=sha(await readFile(join(base,p)));
await run(process.execPath,['tool/check_protected.mjs'],options);
const report={status:'SHARED_LEGACY_MESSAGE_NATIVE_PROFILE_PASS',recordedAt:new Date().toISOString(),tests,passed:passed.length,analysis:analysis.stdout.trim(),sources,reports,
 proof:'Current frozen Core/Noble public-fixture reference versus shared Dart executor and paired Swift/Kotlin native binding. Four standalone messages, mixed message/typed workflow and dependent TBC-to-message workflow match. Native standalone consent/signature replay, exact result and deferred-source checks pass. Native protocol isolation uses real macOS SQLite and Kotlin fixture storage. Mobile platform sources compile, but no installed Legacy channel or physical-device/Vault claim.',
 corrections:['Frozen Core standalone Legacy task ID is legacy-sign-message; shared Dart/native trusted profile now preserves it. Standard IDs and digest bytes unchanged.',
 'Initial native test used stepId/task instead of actual deferred descriptor targetStepId/concreteTask; test lookup fixed, no production validation relaxed.',
 'Legacy does not bypass the existing Sign-In context-parser gate; unimplemented Sign-In profile remains rejected.'],
 invariants:['One operation consent and one shared signing lifecycle; no Legacy execution loop.','Profile comes from private worker/native registration, not page marker or digest.','Native recomputes message digest; wrong framing and rehashed forged digest are rejected before signer.','No added chain-data HTTP, signing journal or approval round. Typed signing retains Standard framing.'],
 pending:['Facade/Pool/maintenance/balance/current NFT and authenticated metadata mappings','Native Legacy document channel, coexistence and actual delivery integration','Switchable default-on Legacy and paired device acceptance','Safe template, clean install, matched timing/size and sealed full handoff'],
 externalHttp:0,broadcasts:0,deviceAcceptance:false,acceptedDeliveryChanged:false,protectedFiles:326,goalComplete:false,published:false};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,passed:report.passed,reports,externalHttp:0,broadcasts:0,goalComplete:false}));
