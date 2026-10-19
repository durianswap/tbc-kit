import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const [dart,output]=process.argv.slice(2);assert(dart&&output);
const base=resolve(import.meta.dirname,'..'),run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const tests=['test/multi_round_merge_test.dart','test/balance_read_test.dart','test/signing_worker_test.dart'];
const opts={cwd:base,timeout:120000,maxBuffer:6e6};
const [analysis,checked,protectedCheck]=await Promise.all([
 run(dart,['analyze','lib/src/internal/multi_round_merge.dart',...tests],opts),
 run(dart,['test',...tests,'--reporter=json'],opts),
 run(process.execPath,['tool/check_protected.mjs'],opts),
]);
const events=checked.stdout.trim().split('\n').map(v=>JSON.parse(v));
assert.equal(events.findLast(v=>v.type==='done').success,true);
const finished=events.filter(v=>v.type==='testDone'&&!v.hidden&&!v.skipped);assert(finished.every(v=>v.result==='success'));
const sourcePaths=['lib/src/internal/multi_round_merge.dart','lib/src/internal/protocol_codec.dart',
 'lib/src/internal/signing_worker.dart',...tests,'tool/multi_round_oracle.mjs','tool/check_multi_round.mjs',
 'test/fixtures/multi-round-frozen-kit.json','evidence/f3-multi-round-integration-plan.json'];
const sources={};for(const p of sourcePaths)sources[p]=sha(await readFile(join(base,p)));
const oracle=JSON.parse(await readFile(join(base,'test/fixtures/multi-round-frozen-kit.json')));
assert.equal(oracle.generatorSha256,sources['tool/multi_round_oracle.mjs']);assert.equal(oracle.cases.length,39);
const report={status:'SHARED_MULTI_ROUND_COORDINATOR_PASS_NATIVE_ADAPTER_PENDING',recordedAt:new Date().toISOString(),
 tests,passed:finished.length,analysis:analysis.stdout.trim(),sources,protectedFiles:JSON.parse(protectedCheck.stdout),
 frozenKit:oracle.identity,frozenOracleCases:39,exactParityCases:36,
 safetyDeltas:oracle.cases.filter(v=>v.config.safetyDelta).map(v=>({name:v.config.name,change:v.config.safetyDelta,frozenResult:v.result})),
 proof:'44 coordinator checks plus affected balance/worker regressions. Frozen normal/error result,approval scope/hash,prepared metadata and callback trace parity across all5asset kinds and both networks. One callback consent, bounded index refresh, fees/transactions/expiry and parent membership, explicit failed/pending/uncertain distinction. Read-only coordinator has no HTTP client, key, SQLite or Legacy executor.',
 correction:'First oracle attempt recorded initial Pool metadata after mutating the synthetic Pool. Retained evidence/multi-round-oracle-attempt-20261014-a.json; generator now captures actual initial state before running. Result/callback oracle was not rewritten to match Dart.',
 notProved:'No production material/native bounded-consent adapter or Provider/Legacy registration yet. This is not an actual Engine transaction/signature, native approval, installed device, real-chain, matched performance or final package proof. Follow the integration plan before enabling.',
 performance:'Normal frozen callback counts match; no new runtime path or per-transaction overhead yet because this module is not wired. Deadline correction reduces stale index polling. No measured wall-clock or App-size claim.',
 externalHttp:0,broadcasts:0,newSignatures:0,published:false,goalComplete:false};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,passed:report.passed,frozenOracleCases:39,exactParityCases:36,protectedFiles:report.protectedFiles}));
