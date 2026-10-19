// Focused business facade/mapping closure; this is not installed Legacy proof.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart&&output);
const run=promisify(execFile),opts={cwd:base,maxBuffer:12e6,timeout:120000};
const sha=v=>createHash('sha256').update(v).digest('hex');
const oracles=['legacy_mapping_oracle','legacy_business_mapping_oracle','legacy_pool_mapping_oracle','legacy_message_oracle'];
for(const name of oracles)await run(process.execPath,[`tool/${name}.mjs`,'--check'],opts);
const names=['legacy_pool_mapping','legacy_business','legacy_mapping','legacy_shared_worker','legacy_message_signing','workflow_json','signing_executor','workflow_execution','workflow_plan','typed_signing'];
const tests=names.map(n=>`test/${n}_test.dart`);
const analysis=await run(dart,['analyze','lib',...tests],opts);
const result=await run(dart,['test',...tests,'--reporter=json'],opts);
const events=result.stdout.trim().split('\n').map(x=>JSON.parse(x));
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const completed=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped);
assert(completed.length>=400);assert(completed.every(e=>e.result==='success'));
assert.equal(events.filter(e=>e.type==='testStart'&&e.test.name.endsWith('mapped into shared worker; one consent, same reads/bytes/fee')).length,20);
const sources={};
async function tree(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const p=join(dir,entry.name);if(entry.isDirectory())await tree(p);else if(entry.isFile())sources[relative(base,p)]=sha(await readFile(p));}}
await tree(join(base,'lib'));
for(const p of [...tests,'test/native_signing_test.dart',...oracles.map(n=>`tool/${n}.mjs`),'tool/check_legacy_business.mjs',
  ...['legacy-pool-mapping','legacy-business-mapping','legacy-mapping','legacy-message-signing','workflow-json','unified-pool-signing','fungible-signing','stablecoin-signing','nft-signing'].map(n=>`test/fixtures/${n}.json`)])sources[p]=sha(await readFile(join(base,p)));
const priorNative={};
for(const name of ['f3-legacy-native-profile-20261014-b','f3-legacy-profile-mobile-compile-20261014-b']){
  const p=`evidence/${name}.json`,bytes=await readFile(join(base,p)),report=JSON.parse(bytes);
  for(const [file,h]of Object.entries(report.sources))assert.equal(sha(await readFile(join(base,file))),h,file+' changed after native proof');
  priorNative[p]={sha256:sha(bytes),status:report.status};
}
const buildPath=process.env.TBC173_BUILD_REPORT??'/private/tmp/tbc-contract173-compute-20261014-a/build-report.json';
const build=JSON.parse(await readFile(buildPath)),library=build.builds.find(x=>x.target==='aarch64-apple-darwin');
assert.equal(library.sha256,'413559859a0fa0fed61220485ea482ca8c28f305b4145f600ff706ca3a8bd0db');
assert.equal(sha(await readFile(library.path)),library.sha256);
await run(process.execPath,['tool/check_protected.mjs'],opts);
const pool=JSON.parse(await readFile(join(base,'test/fixtures/legacy-pool-mapping.json')));
const report={status:'LEGACY_BUSINESS_FACADE_POOL_MAINTENANCE_SHARED_PARITY_PASS',recordedAt:new Date().toISOString(),
  tests,passed:completed.length,analysis:analysis.stdout.trim(),sources,priorNative,
  kitIdentity:pool.kitIdentity,currentCompute:{path:library.path,sha256:library.sha256,buildReportSha256:sha(await readFile(buildPath))},
  poolMapping:{frozenCases:pool.cases.length,rejections:pool.cases.filter(c=>c.error).length,lp6:'330/200 only; lpPlan never overrides authenticated pool config'},
  sharedWorkerCases:20,
  proof:'Frozen Kit20261014.3 Pool DTO oracle plus production Dart worker/current pinned macOS Rust Engine. Twenty mapped holder, FT/Coin merge, Pool buy/sell/add/remove/FT merge/LP merge/burn and new plain/locked LP merge cases retain exact signed bytes/fees/read paths, one consent and parallel initial reads. Facade tests use a typed fixture metadata adapter, preserve input snapshots and network/account/document fences, and overlap mixed batch metadata. Existing message/typed/workflow/number-mapping checks also pass.',
  invariants:['No extra HTTP stack, signing journal, approval round, legacy executor or Rust change','Only required metadata callback for FT/Coin transfer or Pool sell; not a live query-count proof for unwired metadata','Old create/admin/multisig/BTC/EVM remain excluded','No multi-round merge-all claim from a one-transaction maintenance mapping','Existing native platform sources match prior checked hashes; native suite not unnecessarily rerun'],
  corrections:['Initial new facade test hardcoded6-decimal fixture metadata for an18-decimal oracle row; fixed the fixture adapter to supply the recorded precision. Production amount validation was not relaxed.'],
  pending:['Connect the typed facade metadata to shared production read/origin cache without extra current-state reads','Read-only getBalance/metadata and multi-round maintenance semantics','Typed native Legacy document registration and actual committed result/event delivery','Default-on/on-off paired installed Legacy acceptance','Safe template, clean-project install and final paired sealed handoff'],
  protectedFiles:326,liveHttp:0,broadcasts:0,freshSignatures:0,deviceAcceptance:false,acceptedDeliveryChanged:false,published:false,goalComplete:false};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,passed:report.passed,poolMapping:report.poolMapping,sharedWorkerCases:20,sources:Object.keys(sources).length,liveHttp:0,broadcasts:0,deviceAcceptance:false}));
