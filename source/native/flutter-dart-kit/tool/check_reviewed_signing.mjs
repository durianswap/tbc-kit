// Source-level parity only. Native custody/public routing require separate proof.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart);
const read=p=>readFile(join(base,p)),sha=b=>createHash('sha256').update(b).digest('hex');
const parentPath='evidence/f3-reviewed-associated-contract-source.json',parentBytes=await read(parentPath),parent=JSON.parse(parentBytes);
assert.equal(sha(parentBytes),'d0a45cff071571f3e83442aa902559b0ca4f907cbab4db2926cfb16eb2b8db19');
const permitted={
 'lib/src/internal/signing_executor.dart':'Add private Reviewed strategy to existing consent/bind/sign/advance/close lifecycle; no second executor or public routing.',
 'lib/src/signing_backend.dart':'Optional authenticated review and private Reviewed material fields for later native binding; existing profiles unchanged.',
 'lib/src/internal/reviewed_profiles.dart':'Recognized NFT/historical holder template requires one real signature push immediately followed by the bound compressed key; not a generic VM or permission.',
 'lib/src/internal/reviewed_nft.dart':'Exact associated Code/Hold/fee profile binding; existing identity and conservation unchanged.',
 'lib/src/internal/reviewed_current_holder.dart':'Exact current proof or historical holder template profile; raw behavior unchanged.',
};
const sourceHashes={},changes={};
for(const [p,h]of Object.entries(parent.sourceHashes)){
 const actual=sha(await read(p));sourceHashes[p]=actual;
 if(permitted[p])changes[p]={before:h,after:actual,reason:permitted[p]};else assert.equal(actual,h,p);
}
const oraclePaths=['test/fixtures/reviewed-associated-holder.json','test/fixtures/reviewed-signing.json'];
const oracles=[];
for(const [i,p]of oraclePaths.entries()){
 const b=await read(p),o=JSON.parse(b);assert.equal(o.cases.length,[16,7][i]);
 assert.equal(o.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
 oracles.push({path:p,sha256:sha(b),cases:o.cases.length});
}
for(const p of [...oraclePaths,'tool/reviewed_associated_holder_oracle.mjs','tool/reviewed_signing_oracle.mjs',
 'lib/src/internal/reviewed_signing.dart','lib/src/internal/signing_executor.dart','lib/src/signing_backend.dart',
 'test/reviewed_associated_holder_test.dart','test/reviewed_signing_test.dart','tool/check_reviewed_signing.mjs'])sourceHashes[p]=sha(await read(p));
const analysis=execFileSync(dart,['analyze','--fatal-infos','lib','test','tool'],{cwd:base,encoding:'utf8'});
const files=['reviewed_associated_contract','reviewed_htlc_token','reviewed_reviewer','reviewed_dependency_batch',
 'reviewed_lop','reviewed_native','timelock_material','reviewed_historical_holder','reviewed_nft','reviewed_current_holder',
 'reviewed_preview','reviewed_material','read_api','read_api_get','reviewed_associated_holder','reviewed_signing',
 'signing_executor','prepared_signing','typed_signing','staged_signing'];
const events=execFileSync(dart,['test',...files.map(n=>'test/'+n+'_test.dart'),'--reporter=json'],{cwd:base,encoding:'utf8',maxBuffer:12*1024*1024}).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const tests=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').length;
assert.equal(tests,565);
const protectedState=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const report={status:'F3_REVIEWED_SHARED_SIGNING_SOURCE_PASS',recordedAt:new Date().toISOString(),
 parent:{path:parentPath,sha256:sha(parentBytes)},oracles,tests,analysis,sourceHashes,changes,protectedState,
 proof:{associatedHolderCases:16,frozenCoreExecutionCases:7,oneApproval:true,outerRequestAndContextBinding:true,
  dependentStagesUseActualSignedParents:true,interstageChainReads:0,existingProviderCount:12},
 limits:[
  'Private shared Dart executor and actual Native keyless calculations, using replayed public test signatures. Not real Swift/Kotlin custody or public Reviewed routing.',
  'Associated NFT/historical holder contract-template proof does not cover every specialized legacy ft/ft-contract profile or independent Script VM behavior.',
  'Raw arbitrary transaction review completes before the one actual approval; this is not authorization from an unverified preview or fee-only consent.',
  'No new device, latency, App-size or live-chain proof. Full-suite expected count is 1179; only 565 affected tests were rerun.'
 ],chainHttp:0,broadcasts:0,acceptedDeliveryChanged:false,frozenRustModified:false,goalComplete:false,published:false};
const bytes=JSON.stringify(report,null,2)+'\n';
if(output)await writeFile(resolve(base,output),bytes,{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests,protectedFiles:protectedState.protectedFiles,reportSha256:sha(bytes),output:output??null}));
