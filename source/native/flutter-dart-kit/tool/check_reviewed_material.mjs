// Focused gate; do not rerun unrelated device/contract suites for private
// material helpers. Evidence output, when requested, is create-only.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart);
const sha=b=>createHash('sha256').update(b).digest('hex');
const hashes={};
for(const p of ['lib/src/internal/reviewed_material.dart','lib/src/internal/reviewed_status.dart',
 'lib/src/internal/reviewed_keyless.dart','lib/src/internal/read_api.dart','test/read_api_test.dart',
 'test/reviewed_material_test.dart','test/fixtures/reviewed-material-b.json',
 'tool/reviewed_material_oracle.mjs','tool/check_reviewed_material.mjs'])hashes[p]=sha(await readFile(join(base,p)));
const oracle=JSON.parse(await readFile(join(base,'test/fixtures/reviewed-material-b.json')));
assert.equal(oracle.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
for(const [p,h]of Object.entries(oracle.provenance))assert.equal(sha(await readFile(join(base,'test/fixtures',p))),h);
assert.equal(oracle.cases.length,19);assert.equal(oracle.cases.filter(s=>s.stages).length,13);
assert.equal(oracle.cases.filter(s=>s.review).length,6);assert.equal(oracle.cases.filter(s=>s.keylessRefusal).length,0);
const baseline=JSON.parse(await readFile(join(base,'evidence/f3-prepared-integrated-source-b.json')));
for(const p of ['lib/src/internal/signing_executor.dart','lib/src/internal/provider_session.dart',
 'lib/src/internal/signing_worker.dart','lib/src/internal/native_wallet_binding.dart']) {
 assert.equal(sha(await readFile(join(base,p))),baseline.sourceHashes[p]);hashes[p]=baseline.sourceHashes[p];
}
const analysis=execFileSync(dart,['analyze','--fatal-infos','lib','test','tool'],{cwd:base,encoding:'utf8'});
const events=execFileSync(dart,['test','test/reviewed_material_test.dart','test/read_api_test.dart','--reporter=json'],
 {cwd:base,encoding:'utf8'}).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const tests=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').length;
assert.equal(tests,54);
const protectedState=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const report={status:'F3_REVIEWED_MATERIAL_NATIVE_WASM_PARITY_PASS',recordedAt:new Date().toISOString(),
 tests,analysis,sourceHashes:hashes,protectedState,
 parity:{normalizationCases:19,actualNativeKeylessCases:13,defaultFrozenReviewFeeAndStatusCases:6,
  malformedFrozenCases:6,actualNativeWasmDigestsBytesAndDetachedSignatures:true,
  nativeCurrentAndHistoricalFtNftStablecoinRaw:true,associatedNativeParentChild:true,
  profileMappingOnlyCases:6},
 reads:{nativeReviewedCasesOneBatchedStatusPost:true,localDerivedOutputsNeverFetched:true,
  sameOperationDependencyReuse:true,freshAcrossOperations:true,largeBatchInputs:512,largeBatchReads:1,
  transportStatusLimit:10000,transportResponseBytesUnchanged:4194304},
 security:{noKeyAccess:true,noSignerCallback:true,noProviderPromotion:true,authorityFenceAfterRead:true,
  unknownOrSpentInputRejected:true,partialOrUnsolicitedStatusRejected:true,
  noNewDurableState:true,oldIssuancePolicyKeptInFrozenRust:true},
 performance:{ownCompleteMaterialOncePerOperation:true,shareParsedReviewTransactions:true,
  noRepeatedWholeParentListParsing:true,noTimingOrSizeClaim:true},
 remaining:['Full asset flow recognition and approval presentation across included Reviewed profiles',
  'Shared executor/native custody/Provider/worker routing and paired-device acceptance',
  'General workflows, BIE1/thin Legacy, remaining network/message gaps, submit/reconcile and final delivery'],
 proofLimit:'Private source helpers only. Actual frozen Native keyless computation uses recorded public WASM/Noble fixture signatures, not a native Vault. No live API, broadcast, device, matched performance or full delivery claim.',
 networkHttp:0,broadcasts:0,acceptedDeliveryChanged:false,published:false};
if(output)await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests,protectedFiles:protectedState.protectedFiles,output:output??null}));
