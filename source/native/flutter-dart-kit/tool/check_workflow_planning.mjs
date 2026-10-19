import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const base=resolve(import.meta.dirname,'..'),dart=process.argv[2];
assert(dart,'Dart SDK executable required');
const sha=b=>createHash('sha256').update(b).digest('hex');
const tests=['test/workflow_plan_test.dart','test/prepared_signing_test.dart',
 'test/typed_signing_test.dart','test/reviewed_signing_test.dart','test/native_material_test.dart'];
const analysis=execFileSync(dart,['analyze','lib','test'],{cwd:base,encoding:'utf8'}).trim();
const events=execFileSync(dart,['test',...tests,'--reporter=json'],{cwd:base,encoding:'utf8'})
 .trim().split('\n').map(s=>JSON.parse(s));
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const passed=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').length;
const planning=JSON.parse(await readFile(join(base,'test/fixtures/workflow-planning.json')));
const signing=JSON.parse(await readFile(join(base,'test/fixtures/workflow-signing.json')));
assert.equal(planning.cases.length,10);assert.equal(planning.invalid.length,14);
assert.equal(signing.cases.length,9);assert.equal(signing.cases.reduce((n,s)=>n+s.deferred.length,0),7);
assert.equal(signing.planningSha256,sha(await readFile(join(base,'test/fixtures/workflow-planning.json'))));
const protection=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const paths=[...tests,'lib/src/internal/workflow_request.dart','lib/src/internal/workflow_plan.dart',
 'lib/src/internal/transaction_read.dart','lib/src/internal/prepared_proposal.dart',
 'lib/src/internal/reviewed_signing.dart','lib/src/internal/typed_signing.dart',
 'lib/src/internal/transaction_signing_roles.dart','lib/src/internal/signing_executor.dart',
 'lib/src/internal/provider_session.dart','tool/workflow_planning_oracle.mjs',
 'tool/workflow_signing_oracle.mjs','tool/check_workflow_planning.mjs',
 'test/fixtures/workflow-planning.json','test/fixtures/workflow-signing.json'];
const hashes={};for(const p of paths)hashes[p]=sha(await readFile(join(base,p)));
const report={status:'F3_WORKFLOW_PLANNING_SOURCE_PASS',recordedAt:new Date().toISOString(),
 tests:passed,testFiles:tests,analysis,planningCases:10,frozenRejectionCases:14,
 frozenCoreSigningReferenceCases:9,frozenCoreDeferredReferences:7,protection,sourceHashes:hashes,
 proof:'Dart private graph/planning exact parity against frozen Core/WASM and actual Native plan validation; frozen Core signatures are future executor references only.',
 limits:['No new Dart whole-workflow signatures or public capability.',
  'No native batch custody/delivery or new paired-device proof.',
  'No private Vault, live-chain, matched speed or final App-size proof.'],
 newDeviceAcceptance:false,chainHttp:0,broadcasts:0,acceptedDeliveryChanged:false,published:false};
await writeFile(join(base,'evidence/f3-workflow-planning-source-a.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests:passed,planningCases:10,protectedFiles:protection.protectedFiles}));
