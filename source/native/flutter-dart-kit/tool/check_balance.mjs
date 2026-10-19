// Source, packaged-page and native-boundary proof. Not installed-device or
// real-chain evidence; no arbitrary balance is promoted to signing material.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
const [dart,pageDir,nativeReport,compileReport,output]=process.argv.slice(2);
assert(dart&&pageDir&&nativeReport&&compileReport&&output);
const base=resolve(import.meta.dirname,'..'),run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const opts={cwd:base,maxBuffer:6e6,timeout:120000};
const tests=['balance_read','legacy_provider_session','read_api_get','signing_worker'].map(p=>'test/'+p+'_test.dart');
const [analysis,dartRun,pageRun]=await Promise.all([
 run(dart,['analyze','lib',...tests],opts),run(dart,['test',...tests,'--reporter=json'],opts),
 run(process.execPath,['--test','test/legacy-page.test.mjs'],{...opts,env:{...process.env,TBC_DART_PAGE_DIR:resolve(pageDir)}}),
]);
const rows=dartRun.stdout.trim().split('\n').map(s=>JSON.parse(s));
assert.equal(rows.findLast(r=>r.type==='done').success,true);
const passed=rows.filter(r=>r.type==='testDone'&&!r.hidden&&!r.skipped);assert(passed.every(r=>r.result==='success'));
assert.match(pageRun.stdout,/# tests 10\n/);assert.match(pageRun.stdout,/# fail 0\n/);
const sources={},native={};
for(const p of [nativeReport,compileReport]){
 const bytes=await readFile(join(base,p)),r=JSON.parse(bytes);
 for(const [file,expected]of Object.entries(r.sources))assert.equal(sha(await readFile(join(base,file))),expected,file);
 assert(r.status.endsWith('PASS'));
 native[p]={sha256:sha(bytes),status:r.status,protocolIsolation:r.protocolIsolation,
  kotlinSources:r.kotlinSources,swiftSources:r.swiftSources};
}
async function tree(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
 const path=join(dir,entry.name);if(entry.isDirectory())await tree(path);else if(entry.isFile())sources[relative(base,path)]=sha(await readFile(path));
}}
await tree(join(base,'lib'));await tree(join(base,'runtime'));
for(const p of [...tests,'test/support/signing_replay.dart','test/legacy-page.test.mjs','test/fixtures/balance-frozen-kit.json',
 'tool/balance_oracle.mjs','tool/check_balance.mjs','tool/build_page.mjs'])sources[p]=sha(await readFile(join(base,p)));
const oracle=JSON.parse(await readFile(join(base,'test/fixtures/balance-frozen-kit.json')));
assert.equal(oracle.generatorSha256,sources['tool/balance_oracle.mjs']);assert.equal(oracle.cases.length,36);
const protectedFiles=JSON.parse((await run(process.execPath,['tool/check_protected.mjs'],opts)).stdout);
const page=JSON.parse(await readFile(join(resolve(pageDir),'page-provenance.json')));
const report={status:'BALANCE_SHARED_READ_AND_NATIVE_EMISSION_PASS_DEVICE_PENDING',recordedAt:new Date().toISOString(),
 passed:passed.length,tests,analysis:analysis.stdout.trim(),builtPageChecks:10,frozenOracleCases:36,
 frozenKit:oracle.identity,native,page,sources,protectedFiles,
 proof:'Actual frozen Kit oracle parity for accepts/refusals and historical decimal displays on both networks. Shared non-UI network worker executes one exact balance GET, no custody begin/consent/sign/write; fresh independent requests are not cached, identical request IDs replay once. API owner/range errors, grant revocation during a read and explicit cancellation suppress late results. Real Swift/Kotlin private host validates exact informational shape/account/chain/range, rejects Standard/private-method misuse and checks grant/document at release. Existing message/TBC signing/read-reuse regressions stay green.',
 trust:'Trusted configured API informational balance only. Native validates result shape and current authorization, not independent ledger truth. The result is never signing/approval/UTXO/receipt evidence.',
 performance:'One GET only for getBalance, no extra reads on signing routes, no new persistence/approval or native calls beyond existing delivery fences. Page grows362 bytes versus last installed page. This is counts/size evidence, not matched device wall-clock proof.',
 pending:['Install this page/native/Dart pair with the next affected Legacy device batch; prior device report predates balance',
 'Shared bounded multi-round maintenance, new-entry Reviewed/BIE1/send acceptance, safe template/clean install and final paired handoff'],
 externalHttp:0,broadcasts:0,newSignatures:0,deviceAcceptance:false,goalComplete:false,published:false};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,passed:report.passed,builtPageChecks:10,frozenOracleCases:36,pageBytes:page.bytes,protectedFiles}));
