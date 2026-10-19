// Current-holder source checkpoint only. It does not promote Reviewed into
// Provider or replace any immutable earlier preview, device or chain report.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart);
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>readFile(join(base,p));
const fixturePath='test/fixtures/reviewed-current.json';
const oracle=JSON.parse(await read(fixturePath));
assert.equal(oracle.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
assert.equal(oracle.cases.length,11);
assert.equal(oracle.cases.filter(c=>c.material.format==='associated').length,2);
for(const c of oracle.cases){
  assert.equal(c.reads.length,4,c.name);
  assert.equal(c.reads.filter(r=>r.path==='/api/tbc/txo/status').length,2,c.name);
}
assert(oracle.nftDiagnostic[0].refusal);
assert(oracle.nftDiagnostic[1].result&&oracle.nftDiagnostic[2].result);
assert.equal(oracle.nftDiagnostic[1].input.resolvedOutputs.length,
  oracle.nftDiagnostic[0].input.resolvedOutputs.length+1);
for(const [p,h]of Object.entries(oracle.provenance))assert.equal(sha(await read('test/fixtures/'+p)),h,p);
assert.equal(sha(await read('test/fixtures/reviewed-current-dependency-lock.json')),oracle.dependencyLockSha256);
const previousPath='evidence/f3-reviewed-preview-source-b.json',previousBytes=await read(previousPath);
const previous=JSON.parse(previousBytes),hashes={},changes={};
const allowedChanges=new Set(['lib/src/internal/reviewed_preview.dart',
  'lib/src/internal/reviewed_keyless.dart','lib/src/internal/read_api.dart']);
for(const [p,h]of Object.entries(previous.sourceHashes)){
  const current=sha(await read(p));hashes[p]=current;
  if(allowedChanges.has(p))changes[p]={before:h,after:current};
  else assert.equal(current,h,p);
}
for(const p of ['lib/src/internal/reviewed_token.dart','lib/src/internal/reviewed_current_holder.dart',
  'lib/src/internal/reviewed_address.dart','test/reviewed_current_holder_test.dart',
  'test/read_api_get_test.dart',fixturePath,'test/fixtures/reviewed-current-dependency-lock.json',
  'tool/reviewed_current_oracle.mjs','tool/check_reviewed_current.mjs'])hashes[p]=sha(await read(p));
const analysis=execFileSync(dart,['analyze','--fatal-infos','lib','test','tool'],{cwd:base,encoding:'utf8'});
const events=execFileSync(dart,['test','test/reviewed_current_holder_test.dart',
  'test/reviewed_preview_test.dart','test/reviewed_material_test.dart',
  'test/read_api_test.dart','test/read_api_get_test.dart','--reporter=json'],
  {cwd:base,encoding:'utf8'}).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const tests=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').length;
assert.equal(tests,108);
const protectedState=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const report={status:'F3_REVIEWED_CURRENT_HOLDER_PRIVATE_PARITY_PASS',recordedAt:new Date().toISOString(),
  parent:{path:previousPath,sha256:sha(previousBytes)},tests,analysis,sourceHashes:hashes,changes,protectedState,
  proof:{currentHolderTests:24,controlledReadTransportTests:3,previousRelatedTests:81,
    currentFrozenPreviewPolicyHashCases:11,associatedCurrentPreflightCases:2,
    sourceOnlyActualNativeCodeTapeInspection:true,associatedUnsignedDigestsDiscarded:true,
    readsPerCurrentCase:{primaryStatus:1,missingTapeStatus:1,indexedDecode:1,fullCodeInfo:1,total:4},
    nativeWasmNftPolicyDiagnostic:'Primary Code/Hold/native alone refuses; exactly one authenticated adjacent Tape makes policy pass in both frozen engines. Full current-NFT review remains pending.',
    perOperationDedup:true,globalMutableUtxoCache:false,labelsBalancesDecimalsFromIndexNotTrusted:true,
    coinHolderLockPublicTerms:true,coinAdministratorRefused:true,
    publicExecutorProviderWorkerNativeBindingUnchanged:true,
    transport:'Actual Dart GET transport exercised through a controlled HttpClient for both official networks and trusted custom HTTPS. No live API request.'},
  limits:['Current FT/Coin holder preview and policy only, not an enabled public Reviewed method.',
    'Associated tests are source-stage current proofs. Later dependent stages must be rebuilt with actual signed parents inside the shared native custody lifecycle.',
    'Current NFT identity/flow, historical FT complete amounts, order/escrow and advanced witnesses still need full recognition.',
    'No new paired-device, live-chain, matched timing, full-scope size or partner Vault claim.'],
  remaining:['Complete remaining authenticated asset recognizers and shared review composition.',
    'Join exact review/request to shared executor, one bounded approval and native custody, then enable Provider and paired-device checks.',
    'Complete remaining goal scope and final Testnet, performance, size and clean local delivery.'],
  chainHttp:0,broadcasts:0,acceptedDeliveryChanged:false,goalComplete:false,published:false};
if(output)await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests,protectedFiles:protectedState.protectedFiles,output:output??null}));
