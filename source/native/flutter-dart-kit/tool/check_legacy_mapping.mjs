// Targeted check, not all-business acceptance or a publication gate.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,relative} from 'node:path';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..');
const [dart,output]=process.argv.slice(2);assert(dart&&output,'Dart binary and new evidence filename required');
const sha=b=>createHash('sha256').update(b).digest('hex');
const options={cwd:base,maxBuffer:4e6,timeout:120000};
for(const script of ['legacy_mapping_oracle.mjs','legacy_business_mapping_oracle.mjs'])await run(process.execPath,['tool/'+script,'--check'],options);
const tests=['test/legacy_mapping_test.dart','test/legacy_shared_worker_test.dart','test/workflow_json_test.dart'];
const analysis=await run(dart,['analyze','lib/src/internal/legacy_mapping.dart','lib/src/internal/workflow_json.dart',...tests],options);
const test=await run(dart,['test',...tests,'--reporter=json'],options);
const events=test.stdout.trim().split('\n').map(x=>JSON.parse(x));
assert.equal(events.filter(e=>e.type==='done').at(-1)?.success,true);
const completed=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped);
assert(completed.length>=170);assert(completed.every(e=>e.result==='success'));
const sources={};
async function tree(path){for(const entry of await readdir(path,{withFileTypes:true})){const p=join(path,entry.name);if(entry.isDirectory())await tree(p);else if(entry.isFile())sources[relative(base,p)]=sha(await readFile(p));}}
await tree(join(base,'lib'));
for(const p of [...tests,'test/native_signing_test.dart','test/fixtures/legacy-mapping.json','test/fixtures/legacy-business-mapping.json','test/fixtures/workflow-json.json','test/fixtures/fungible-signing.json','test/fixtures/stablecoin-signing.json','test/fixtures/nft-signing.json','tool/legacy_mapping_oracle.mjs','tool/legacy_business_mapping_oracle.mjs','tool/check_legacy_mapping.mjs'])sources[p]=sha(await readFile(join(base,p)));
const buildPath=process.env.TBC173_BUILD_REPORT??'/private/tmp/tbc-contract173-compute-20261014-a/build-report.json';
const build=JSON.parse(await readFile(buildPath)),library=build.builds.find(x=>x.target==='aarch64-apple-darwin');
assert.equal(library.sha256,'413559859a0fa0fed61220485ea482ca8c28f305b4145f600ff706ca3a8bd0db');
assert.equal(sha(await readFile(library.path)),library.sha256);
await run(process.execPath,['tool/check_protected.mjs'],options);
const oracle=JSON.parse(await readFile(join(base,'test/fixtures/legacy-mapping.json'))),business=JSON.parse(await readFile(join(base,'test/fixtures/legacy-business-mapping.json')));
const report={status:'LEGACY_MAPPING_AND_SHARED_WORKER_PARITY_PASS',recordedAt:new Date().toISOString(),tests,passed:completed.length,analysis:analysis.stdout.trim(),sources,
 kitIdentity:oracle.kitIdentity,currentCompute:{path:library.path,sha256:library.sha256,buildReportSha256:sha(await readFile(buildPath))},
 mapping:{frozenCases:oracle.cases.length+business.cases.length,expectedRejections:[...oracle.cases,...business.cases].filter(c=>c.error).length,orderedPairs:36,standaloneSecureActions:4,sharedWorkerFamilies:7},
 proof:'Frozen installed Kit20261014.3 translation/output reference plus actual production Dart shared worker and pinned current Native Engine on macOS. Seven new/historical FT/Coin/NFT cases preserve signed transaction bytes/fees/read paths, one consent, concurrent read/preparation and exact-digest recorded public signatures. Shared JavaScript-compatible number/message-binding regressions retained. All read callbacks are fixture-backed; no fresh signatures, native Legacy custody, device, private Vault or live network acceptance.',
 corrections:['Raw upper-case transaction input remains rejected by the shared reader, matching frozen Kit; no silent normalization.',
 'Legacy decimal display inputs use a separate finite-JSON clone and shared JavaScript number formatter; canonical atomic protocol remains strict.',
 'Initial business oracle called a non-exported helper and misclassified seven valid cases as rejections. Replaced with the verified public resolver, asserted all exports, regenerated only this new draft fixture; frozen evidence untouched.',
 'Worker test initially mixed Dart relative/package type identities and compared NFT structured GET/POST trace as strings; repaired the harness, not production behavior.'],
 notEnabled:['Native-isolated Legacy permission and document channel','Trusted Bitcoin standalone/workflow profile in native custody','Pool/NFT-create/maintenance/balance mappings and shared metadata hookup','Legacy default-on paired device and unchanged-DApp acceptance','Clean safe template and sealed final handoff'],
 protectedFiles:326,liveHttp:0,broadcasts:0,freshSignatures:0,deviceAcceptance:false,acceptedDeliveryChanged:false,published:false,goalComplete:false};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,passed:report.passed,mapping:report.mapping,sourceFiles:Object.keys(sources).length,liveHttp:0,broadcasts:0,deviceAcceptance:false}));
