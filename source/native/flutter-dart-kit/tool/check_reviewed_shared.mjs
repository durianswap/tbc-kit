// Private shared-review checkpoint. No signing, devices, HTTP or publication.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart);
const read=p=>readFile(join(base,p)),sha=b=>createHash('sha256').update(b).digest('hex');
const oraclePath='test/fixtures/reviewed-htlc-token.json',oracleBytes=await read(oraclePath),oracle=JSON.parse(oracleBytes);
assert.equal(oracle.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
assert.equal(oracle.cases.length,16);
assert.equal(sha(await read('test/fixtures/reviewed-htlc-token-dependency-lock.json')),oracle.dependencyLockSha256);
for(const [p,h]of Object.entries(oracle.provenance))assert.equal(sha(await read('test/fixtures/'+p)),h,p);
for(const c of oracle.cases){assert(c.review&&!c.refusal);assert.equal(c.reads.length,4);}
const parentPath='evidence/f3-reviewed-lop-source.json',parentBytes=await read(parentPath),parent=JSON.parse(parentBytes),sourceHashes={},changes={};
assert.equal(sha(parentBytes),'d604c1b5d95c28f415dcef5aa7044ddefd43d71cc0a9f2a1904aa65069fa2f4e');
const permitted={
 'lib/src/internal/reviewed_native.dart':'Extract the unchanged HTLC lock/role/witness terms into one helper shared with token escrow; native artifact hashes remain identical.',
 'lib/src/internal/reviewed_preview.dart':'Whitelist exact public token escrow terms, without preimages, private templates or unsupported verification claims.',
 'lib/src/internal/reviewed_status.dart':'Coalesce same-microtask family dependency reads, reuse in-flight reads and fetch only missing later points; retain atomic validation and authority fences.',
 'lib/src/internal/reviewed_token.dart':'Per-review bounded exact immutable Code decode cache; no dynamic holding/status or balance cache.',
};
for(const [p,h]of Object.entries(parent.sourceHashes)){
 const actual=sha(await read(p));sourceHashes[p]=actual;
 if(permitted[p])changes[p]={before:h,after:actual,reason:permitted[p]};else assert.equal(actual,h,p);
}
for(const p of ['lib/src/internal/reviewed_htlc_terms.dart','lib/src/internal/reviewed_htlc_token.dart',
 'lib/src/internal/reviewed_reviewer.dart','test/reviewed_htlc_token_test.dart','test/reviewed_reviewer_test.dart',
 'test/reviewed_dependency_batch_test.dart',oraclePath,'test/fixtures/reviewed-htlc-token-dependency-lock.json',
 'tool/reviewed_htlc_token_oracle.mjs','tool/check_reviewed_shared.mjs'])sourceHashes[p]=sha(await read(p));
const analysis=execFileSync(dart,['analyze','--fatal-infos','lib','test','tool'],{cwd:base,encoding:'utf8'});
const testFiles=['reviewed_htlc_token','reviewed_reviewer','reviewed_dependency_batch',
 'reviewed_lop','reviewed_native','timelock_material','reviewed_historical_holder',
 'reviewed_nft','reviewed_current_holder','reviewed_preview','reviewed_material','read_api','read_api_get'];
const events=execFileSync(dart,['test',...testFiles.map(n=>'test/'+n+'_test.dart'),'--reporter=json'],{cwd:base,encoding:'utf8',maxBuffer:8*1024*1024}).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const tests=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').length;
assert.equal(tests,358);
const protectedState=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const report={status:'F3_REVIEWED_SHARED_PRIVATE_PASS',recordedAt:new Date().toISOString(),
 parent:{path:parentPath,sha256:sha(parentBytes)},oracle:{path:oraclePath,sha256:sha(oracleBytes)},
 tests,analysis,sourceHashes,changes,protectedState,
 proof:{previousAffectedTests:237,tokenHtlcTests:24,sharedEntryTests:92,dependencyBatchTests:5,
  tokenHtlcFullFrozenArtifacts:16,tokenHtlcReadCount:4,
  singleEntryCases:87,singleEntryFullFrozenArtifacts:71,singleEntryNftIdentityCases:10,
  singleEntryHistoricalPolicyCases:6,mixedFiveFamilyBatch:true,
  mixedPrimaryStatusBatches:1,mixedDependencyStatusBatches:1,
  duplicateMixedGetRequests:0,independentTransactionRowsPreserved:true,
  authorityRevocationFences:true,failureDrainedWithoutRetry:true,
  onlyImmutableScriptDecodeCached:true,partialDecodeNotCached:true,
  indexedEscrowControllerIdentityAndAmountBound:true,
  noPublicPreimageOrPrivateTemplate:true,existingPublicProviderCount:12,
  publicExecutorWorkerNativeCustodyUnchanged:true},
 implementationNotes:[
  'One normalized plan, one primary status matrix and one operation-owned codec feed parallel exact native/fungible/NFT/LOP/HTLC-token reviewers. There is no catch-and-fallback execution path.',
  'Same-microtask dependency requests share a status batch; late arrivals await that response and fetch only still-missing points. Per-operation same-path GETs share a future. No mutable cross-operation UTXO/reserve cache is introduced.',
  'The mixed test combines five disjoint-input public offline fixtures, retaining a single authenticated Code info response for the same asset across different valid holders. Identity stays bound; controller ownership is verified against each selected output.',
  'Token escrow exact HTLC script/controller, adjacent Code/Tape, 100-atomic collateral, conservation and Coin lock constraints are validated. Raw review cannot infer a claim/refund witness and reports unresolved branch and false preimage/VM/maturity proof.',
  'The mixed test initially could not choose disjoint inputs, then exposed fixture info responses with different valid controllers for one asset. Only test composition was corrected; immutable oracle bytes and production checks were not weakened.'
 ],
 limits:['Private review only: associated LOP/token-HTLC profiles, shared executor/native custody and public Reviewed routing remain pending.',
  'Exact templates and local conservation are not independent script VM, live chain maturity or network confirmation proof.',
  'No new device, chain HTTP, speed or full-feature App-size acceptance. Read budgets are not latency measurements.',
  '358 affected tests were run, not a fresh full suite. Current full-suite expected count is 1095.'],
 chainHttp:0,broadcasts:0,acceptedDeliveryChanged:false,frozenRustModified:false,goalComplete:false,published:false};
if(output)await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests,protectedFiles:protectedState.protectedFiles,output:output??null}));
