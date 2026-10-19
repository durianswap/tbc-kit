// Native/lock review extension. Run affected gates only; retain parent evidence.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart);
const read=p=>readFile(join(base,p)),sha=b=>createHash('sha256').update(b).digest('hex');
const oraclePath='test/fixtures/reviewed-native-lock.json',oracleBytes=await read(oraclePath),oracle=JSON.parse(oracleBytes);
assert.equal(oracle.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
assert.equal(oracle.cases.length,5);
assert.equal(sha(await read('test/fixtures/reviewed-native-lock-dependency-lock.json')),oracle.dependencyLockSha256);
for(const [p,h]of Object.entries(oracle.provenance))assert.equal(sha(await read('test/fixtures/'+p)),h,p);
for(const c of oracle.cases){assert.equal(c.reads.length,1);assert(c.stages.length>=1);}
const parentPath='evidence/f3-reviewed-historical-fungible-source.json',parentBytes=await read(parentPath),parent=JSON.parse(parentBytes),sourceHashes={},changes={};
assert.equal(sha(parentBytes),'a71934419b62ce4136449a0042eae17ec72ff28f56e6646fdc3caefb6bf742c0');
for(const [p,h]of Object.entries(parent.sourceHashes)){
 const actual=sha(await read(p));sourceHashes[p]=actual;
 if(p==='lib/src/internal/reviewed_material.dart')changes[p]={before:h,after:actual,
  reason:'Extract the existing associated HTLC refund-lock helper for shared witness validation; normalization and material fixtures stay unchanged.'};
 else assert.equal(actual,h,p);
}
const timeParentPath='evidence/f2-timelock-worker-source-final.json',timeParentBytes=await read(timeParentPath),timeParent=JSON.parse(timeParentBytes),timePath='lib/src/internal/timelock_material.dart';
changes[timePath]={before:timeParent.sourceHashes[timePath],after:sha(await read(timePath)),
 reason:'Extract the existing exact 53-byte Code parser for read and review reuse; keep maturity, selected owner, index and read policy in the original reader.'};
assert.equal(changes[timePath].before,'decffe84ad550219c2465811ad4b4ce4107ce811a864859ddf88ab1657ead339');
for(const p of [timePath,'lib/src/internal/reviewed_native.dart','lib/src/internal/reviewed_htlc_witness.dart',
 'test/reviewed_native_test.dart','test/timelock_material_test.dart',oraclePath,
 'test/fixtures/reviewed-native-lock-dependency-lock.json','tool/reviewed_native_lock_oracle.mjs',
 'tool/check_reviewed_native.mjs'])sourceHashes[p]=sha(await read(p));
const analysis=execFileSync(dart,['analyze','--fatal-infos','lib','test','tool'],{cwd:base,encoding:'utf8'});
const events=execFileSync(dart,['test','test/reviewed_native_test.dart','test/timelock_material_test.dart',
 'test/reviewed_historical_holder_test.dart','test/reviewed_nft_test.dart','test/reviewed_current_holder_test.dart',
 'test/reviewed_preview_test.dart','test/reviewed_material_test.dart','test/read_api_test.dart',
 'test/read_api_get_test.dart','--reporter=json'],{cwd:base,encoding:'utf8'}).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const tests=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').length;
assert.equal(tests,203);
const protectedState=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const report={status:'F3_REVIEWED_NATIVE_LOCK_PRIVATE_PASS',recordedAt:new Date().toISOString(),
 parent:{path:parentPath,sha256:sha(parentBytes)},timeParserParent:{path:timeParentPath,sha256:sha(timeParentBytes)},
 oracle:{path:oraclePath,sha256:sha(oracleBytes)},tests,analysis,sourceHashes,changes,protectedState,
 proof:{newNativeReviewTests:35,priorTimeLockReaderWorkerTests:23,priorReviewedAffectedTests:145,
  frozenStandardReviewHashCases:21,newAssociatedHtlcCases:5,nativeWasmExactStages:6,
  associatedTimeLockProfiles:['p2pkh','exact signature/pubkey template'],
  singleBatchedStatusPerFixture:true,localParentReads:0,extraBuilderReads:0,
  ownerLockSequenceWitnessBindings:true,minimalPreimagePushNativeParity:true,
  publicReviewContainsNoPreimageOrTemplate:true,rawHtlcBranchUnresolved:true,
  chainMaturityNotClaimed:true,scriptVmExecutionNotClaimed:true,
  publicExecutorProviderWorkerNativeBindingUnchanged:true},
 implementationNotes:[
  'One parsed plan and authenticated status matrix serve native, TimeLock and HTLC terms. Unknown scripts cannot fall through to ordinary transfer.',
  'Ordinary native output grouping uses the same Standard public projection/hash without copying frozen parser prose or implementation-only group keys.',
  'HTLC witness checks share exact prefix, compressed account key, minimal push, hashlock, branch and refund lock-domain constraints with frozen Rust. Only public terms leave the witness helper.',
  'Historical/current fungible and NFT review artifacts retain their exact prior results; extracted TimeLock parser preserves existing material/worker results.'
 ],
 limits:['Private review and public-fixture Native/WASM computation, not public Reviewed/native custody or device signing.',
  'No new chain HTTP, broadcast, wall-clock regression or package/App-size evidence.',
  'LOP/token escrow review and shared composition/native lifecycle remain before public routing.'],
 chainHttp:0,broadcasts:0,acceptedDeliveryChanged:false,frozenRustModified:false,goalComplete:false,published:false};
if(output)await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests,protectedFiles:protectedState.protectedFiles,output:output??null}));
