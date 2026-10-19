// One affected source checkpoint; frozen contracts and accepted handoff unchanged.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart);
const read=p=>readFile(join(base,p)),sha=b=>createHash('sha256').update(b).digest('hex');
const oraclePath='test/fixtures/reviewed-lop.json',oracleBytes=await read(oraclePath),oracle=JSON.parse(oracleBytes);
assert.equal(oracle.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
assert.equal(oracle.cases.length,23);
assert.equal(sha(await read('test/fixtures/reviewed-lop-dependency-lock.json')),oracle.dependencyLockSha256);
for(const [p,h]of Object.entries(oracle.provenance))assert.equal(sha(await read('test/fixtures/'+p)),h,p);
for(const c of oracle.cases){assert(c.review&&!c.refusal);assert([1,3,4].includes(c.reads.length));}
const parentPath='evidence/f3-reviewed-native-lock-source.json',parentBytes=await read(parentPath),parent=JSON.parse(parentBytes),sourceHashes={},changes={};
assert.equal(sha(parentBytes),'ddd1428547aadebb59b83673059b203bc4571bbd900c060bb6f3c92e84eb20af');
const permitted={
 'lib/src/internal/reviewed_token.dart':'Extract indexed Code authentication as one helper shared by discovery and explicit order commitments; keep holder read counts and binding unchanged.',
 'lib/src/internal/reviewed_preview.dart':'Add exact public LOP terms projection; no scripts/private fields in approval artifacts. Existing previews/hashes unchanged.',
};
for(const [p,h]of Object.entries(parent.sourceHashes)){
 const actual=sha(await read(p));sourceHashes[p]=actual;
 if(permitted[p])changes[p]={before:h,after:actual,reason:permitted[p]};else assert.equal(actual,h,p);
}
for(const p of ['lib/src/internal/reviewed_lop.dart','lib/src/internal/reviewed_lop_terms.dart',
 'test/reviewed_lop_test.dart',oraclePath,'test/fixtures/reviewed-lop-dependency-lock.json',
 'tool/reviewed_lop_oracle.mjs','tool/check_reviewed_lop.mjs'])sourceHashes[p]=sha(await read(p));
const analysis=execFileSync(dart,['analyze','--fatal-infos','lib','test','tool'],{cwd:base,encoding:'utf8'});
const events=execFileSync(dart,['test','test/reviewed_lop_test.dart','test/reviewed_native_test.dart','test/timelock_material_test.dart',
 'test/reviewed_historical_holder_test.dart','test/reviewed_nft_test.dart','test/reviewed_current_holder_test.dart',
 'test/reviewed_preview_test.dart','test/reviewed_material_test.dart','test/read_api_test.dart',
 'test/read_api_get_test.dart','--reporter=json'],{cwd:base,encoding:'utf8'}).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const tests=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').length;
assert.equal(tests,237);
const protectedState=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const report={status:'F3_REVIEWED_LOP_PRIVATE_PASS',recordedAt:new Date().toISOString(),
 parent:{path:parentPath,sha256:sha(parentBytes)},oracle:{path:oraclePath,sha256:sha(oracleBytes)},
 tests,analysis,sourceHashes,changes,protectedState,
 proof:{newLopTests:34,previousAffectedTests:203,frozenFullLopReviewCases:23,
  markets:['native-token','token-token'],assetStandards:['tbc20-standard','tbc20-stablecoin'],
  operations:['create','cancel','match with order continuation'],nativeWasmExactOrderCodec:true,
  standardPublicArtifactAndHashParity:true,exactControlledReadTrace:true,
  readCounts:{nativeOnly:1,oneToken:3,twoTokenMatch:4},selectedAdjacentTapeOnly:true,
  explicitCommitmentReusesIndexedCodeAuthenticator:true,extraDecodeRequests:0,ancestryWalks:0,
  exactEscrowControllerAndAdjacency:true,tokenConservationAndNativeBalance:true,
  nativeOnlyForeignPayoutRejected:true,privateTermsRejected:true,liveSpentAndRevokedRejected:true,
  publicExecutorProviderWorkerNativeBindingUnchanged:true},
 implementationNotes:[
  'LOP terms/controllers are decoded in one batched local frozen Rust call. Both asset identifiers and controller-owned token outputs are bound to exact Code, not metadata labels.',
  'The frozen native-only sell/cancel parser uses a principal-only flow with the network fee separately displayed. The Dart projection matches that public artifact, and additionally rejects foreign hidden payouts.',
  'LOP match may consume orders owned by different parties. Order controller roles are not confused with selected fee/address-held token ownership; signing-profile execution remains a separate gate.',
  'Unknown scripts, orphan or mismatched escrow, amount changes, invalid Coin metadata identity and unbound output terms fail without broad scans, signature or broadcast.'
 ],
 limits:['Unsigned raw review only; associated LOP witness/profile execution and shared dispatcher/native custody are not enabled.',
  'Exact templates and conservation are not script VM, chain maturity or live-chain execution evidence.',
  'No new device, HTTP, speed or App-size acceptance. Read parity is not a measured latency conclusion.',
  'Token-HTLC review, remaining composition and final goal scope remain pending.'],
 chainHttp:0,broadcasts:0,acceptedDeliveryChanged:false,frozenRustModified:false,goalComplete:false,published:false};
if(output)await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests,protectedFiles:protectedState.protectedFiles,output:output??null}));
