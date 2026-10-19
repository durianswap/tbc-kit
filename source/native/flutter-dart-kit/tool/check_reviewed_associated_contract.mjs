// Frozen-package parity for associated HTLC/LOP; no live-chain or UI claim.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart);
const read=p=>readFile(join(base,p)),sha=b=>createHash('sha256').update(b).digest('hex');
const oraclePath='test/fixtures/reviewed-associated-contract.json',oracleBytes=await read(oraclePath),oracle=JSON.parse(oracleBytes);
assert.equal(oracle.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
assert.equal(oracle.cases.length,39);
assert.equal(sha(await read('test/fixtures/reviewed-associated-contract-dependency-lock.json')),oracle.dependencyLockSha256);
for(const [p,h]of Object.entries(oracle.provenance))assert.equal(sha(await read('test/fixtures/'+p)),h,p);
for(const c of oracle.cases){assert(c.review&&!c.refusal&&!c.stageFailure);assert.equal(c.stages.length,1);}
const parentPath='evidence/f3-reviewed-shared-source.json',parentBytes=await read(parentPath),parent=JSON.parse(parentBytes),sourceHashes={},changes={};
assert.equal(sha(parentBytes),'a36caf0a497c8f46cb09afc065015a450184bd3c69ba3836baaeb3a22d607b9e');
const permitted={
 'lib/src/internal/reviewed_lop.dart':'Bind associated fee/token/order profiles, exact cancellation witness/owner and permissionless match parent; reuse raw recognition/status/conservation.',
 'lib/src/internal/reviewed_htlc_token.dart':'Bind associated current-token and HTLC claim/refund witness profiles; retain public-preimage exclusion and existing raw checks/read budget.',
 'lib/src/internal/reviewed_keyless.dart':'Require complete actual signing-input coverage, excluding only associated permissionless LOP match inputs. Finalized signature count follows actual tasks, not all inputs; Set membership avoids quadratic coverage checks.',
};
for(const [p,h]of Object.entries(parent.sourceHashes)){
 const actual=sha(await read(p));sourceHashes[p]=actual;
 if(permitted[p])changes[p]={before:h,after:actual,reason:permitted[p]};else assert.equal(actual,h,p);
}
for(const p of ['lib/src/internal/reviewed_profiles.dart','test/reviewed_associated_contract_test.dart',
 oraclePath,'test/fixtures/reviewed-associated-contract-dependency-lock.json',
 'tool/reviewed_associated_contract_oracle.mjs','tool/check_reviewed_associated_contract.mjs'])sourceHashes[p]=sha(await read(p));
const analysis=execFileSync(dart,['analyze','--fatal-infos','lib','test','tool'],{cwd:base,encoding:'utf8'});
const files=['reviewed_associated_contract','reviewed_htlc_token','reviewed_reviewer','reviewed_dependency_batch',
 'reviewed_lop','reviewed_native','timelock_material','reviewed_historical_holder',
 'reviewed_nft','reviewed_current_holder','reviewed_preview','reviewed_material','read_api','read_api_get'];
const events=execFileSync(dart,['test',...files.map(n=>'test/'+n+'_test.dart'),'--reporter=json'],{cwd:base,encoding:'utf8',maxBuffer:8*1024*1024}).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const tests=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').length;
assert.equal(tests,406);
const protectedState=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const report={status:'F3_REVIEWED_ASSOCIATED_CONTRACT_PRIVATE_PASS',recordedAt:new Date().toISOString(),
 parent:{path:parentPath,sha256:sha(parentBytes)},oracle:{path:oraclePath,sha256:sha(oracleBytes)},
 tests,analysis,sourceHashes,changes,protectedState,
 proof:{previousAffectedTests:358,associatedTests:48,fullFrozenArtifacts:39,tokenHtlcCases:16,lopCases:23,
  exactNativeWasmStages:39,exactNativeWasmFinalizations:39,exactFrozenReadTraces:true,
  privateWitnessNotInPublicArtifacts:true,wrongClaimPreimageAndCancelOwnerRejected:true,
  actualSigningInputCoverage:true,extraOrMissingFinalizedSignaturesRejected:true,
  existingPublicProviderCount:12,publicExecutorWorkerNativeCustodyUnchanged:true},
 notes:[
  'Public review/hash, policy, read trace and actual Native stage/finalization match the frozen WASM package. Four native-only order rows differ only in internal parser display representation; public artifacts/hashes and order terms match exactly.',
  'Six match vectors exposed an adapter-only count defect: covenant order inputs have no account signature. The corrected count does not skip any owner signature, native finalization or contract-parent verification.',
  'A single Set replaces repeated linear index searches. No chain request, transaction selection, journal or Rust algorithm was added or changed.',
  'Oracles contain only deliberately public synthetic scalars, signatures and claim witnesses, never funded keys or private preimages.'
 ],
 limits:[
  'Private associated HTLC/LOP proof only. Other associated-profile gaps, shared execution/native custody and public Reviewed routing remain pending.',
  'Exact script/template and keyless finalization are not independent script VM, live maturity or chain confirmation proof.',
  'No new device, speed, full-feature App-size or live-chain acceptance. Read-trace parity is not a latency comparison.',
  '406 affected checks were run, not a full-suite rerun. Full-suite expected count is now 1143.'
 ],chainHttp:0,broadcasts:0,acceptedDeliveryChanged:false,frozenRustModified:false,goalComplete:false,published:false};
if(output)await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests,protectedFiles:protectedState.protectedFiles,reportSha256:sha(Buffer.from(JSON.stringify(report,null,2)+'\n')),output:output??null}));
