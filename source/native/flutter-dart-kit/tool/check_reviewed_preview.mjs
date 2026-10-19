// Focused source/Native policy checkpoint, not Provider/device acceptance.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart);
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>readFile(join(base,p));
const oracle=JSON.parse(await read('test/fixtures/reviewed-preview.json'));
assert.equal(oracle.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
assert.equal(oracle.cases.length,18);assert.equal(oracle.refusals.length,3);
for(const [p,h]of Object.entries(oracle.provenance))assert.equal(sha(await read('test/fixtures/'+p)),h,p);
assert.equal(sha(await read('test/fixtures/reviewed-preview-dependency-lock.json')),oracle.dependencyLockSha256);
const previous=JSON.parse(await read('evidence/f3-reviewed-material-source.json')),hashes={};
for(const [p,h]of Object.entries(previous.sourceHashes)){assert.equal(sha(await read(p)),h,p);hashes[p]=h;}
for(const p of ['lib/src/internal/reviewed_policy.dart','lib/src/internal/reviewed_preview.dart',
 'test/reviewed_preview_test.dart','test/fixtures/reviewed-preview.json',
 'test/fixtures/reviewed-preview-dependency-lock.json','tool/reviewed_preview_oracle.mjs',
 'tool/check_reviewed_preview.mjs'])hashes[p]=sha(await read(p));
const analysis=execFileSync(dart,['analyze','--fatal-infos','lib','test','tool'],{cwd:base,encoding:'utf8'});
const events=execFileSync(dart,['test','test/reviewed_preview_test.dart','test/reviewed_material_test.dart',
 'test/read_api_test.dart','--reporter=json'],{cwd:base,encoding:'utf8'}).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const tests=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').length;
assert.equal(tests,81);
const protectedState=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const report={status:'F3_REVIEWED_PRIVATE_PREVIEW_AND_POLICY_PASS',recordedAt:new Date().toISOString(),
 tests,analysis,sourceHashes:hashes,protectedState,
 proof:{frozenPreviewExpiryPolicyHashCases:17,frozenNativePolicyCases:18,
  historicalFtIndeterminateRejected:1,materialAndStatusTests:54,previewAndPolicyTests:27,
  existingMaterialAndPublicRoutingUnchanged:true,nativePolicyCallsPerCheck:1,additionalHttp:0,
  noRawWitnessOrPreimageInPublicLockProjection:true,millisecondExpiryPreserved:true},
 incompleteOracleRows:oracle.refusals.map(r=>({name:r.name,message:r.message,
  reason:r.name==='raw-current-nft-mint-output'?'Frozen default reviewer failed issuance-policy validation with its selected material; missing new NFT Tape/origin context must be investigated, not claimed as a live API failure.':'Existing wallet-build fixture has no Reviewed-specific FT/Coin decode response; controlled fixture gap, not a live API outage.',
  liveNetwork:false})),
 limits:['The projection consumes internally authenticated structured reviews; asset decoders are not yet ported.',
  'Coin/order/token escrow terms currently reject pending their complete verified decoders; no silent term removal.',
  'One frozen historical FT review has INSUFFICIENT_FT_AMOUNT_EVIDENCE; this candidate refuses it pending complete amount recognition.',
  'No public Reviewed, native custody, device, live-chain, matched speed or size acceptance is claimed.'],
 remaining:['Complete trusted raw/associated asset recognition including current NFT material and advanced associated witnesses.',
  'Join shared executor/native custody/Provider/worker, then focused paired-device signatures.',
  'Continue remaining full goal scope and final chain/performance/size/clean-consumer handoff.'],
 broadcast:0,acceptedDeliveryChanged:false,goalComplete:false,published:false};
if(output)await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests,protectedFiles:protectedState.protectedFiles,output:output??null}));
