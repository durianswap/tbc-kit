// Focused private NFT review checkpoint. Historical reports stay immutable.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart);
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>readFile(join(base,p));
const oracle=JSON.parse(await read('test/fixtures/reviewed-nft.json'));
assert.equal(oracle.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
assert.equal(oracle.cases.length,10);
for(const [p,h]of Object.entries(oracle.provenance))assert.equal(sha(await read('test/fixtures/'+p)),h,p);
for(const c of oracle.cases){assert.equal(c.identity.verification,'origin-template');assert(c.policyResult);}
const parentPath='evidence/f3-reviewed-current-holder-source.json',parentBytes=await read(parentPath),
  parent=JSON.parse(parentBytes),sourceHashes={},changes={};
for(const [p,h]of Object.entries(parent.sourceHashes)){
  const actual=sha(await read(p));sourceHashes[p]=actual;
  if(p==='lib/src/internal/reviewed_current_holder.dart')changes[p]={before:h,after:actual,
    reason:'Move unchanged parsed-plan/input-matrix binding to reviewed_rows.dart for both holder decoders.'};
  else assert.equal(actual,h,p);
}
for(const p of ['lib/src/internal/reviewed_rows.dart','lib/src/internal/reviewed_nft.dart',
  'test/reviewed_nft_test.dart','test/fixtures/reviewed-nft.json',
  'tool/reviewed_nft_oracle.mjs','tool/check_reviewed_nft.mjs'])sourceHashes[p]=sha(await read(p));
const analysis=execFileSync(dart,['analyze','--fatal-infos','lib','test','tool'],{cwd:base,encoding:'utf8'});
const events=execFileSync(dart,['test','test/reviewed_nft_test.dart',
  'test/reviewed_current_holder_test.dart','test/reviewed_preview_test.dart',
  'test/reviewed_material_test.dart','test/read_api_test.dart','test/read_api_get_test.dart','--reporter=json'],
  {cwd:base,encoding:'utf8'}).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const tests=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').length;
assert.equal(tests,127);
const protectedState=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const report={status:'F3_REVIEWED_NFT_HOLDER_PRIVATE_PASS',recordedAt:new Date().toISOString(),
  parent:{path:parentPath,sha256:sha(parentBytes)},tests,analysis,sourceHashes,changes,protectedState,
  proof:{nftTests:19,priorAffectedTests:108,frozenOriginAndPolicyCases:10,
    currentNftCases:4,historicalNftCases:6,historicalVersions:[0,1,2],
    originalMintIdsMatchFrozenEngine:true,exactNativeWasmOriginAndIssuancePolicy:true,
    actualSpentCodeAndHoldRequired:true,adjacentTapeReadOnce:true,
    fullCodeAndImmutableTapeContinuation:true,collectionSlotIdentityRetained:true,
    externalNftAndNativeRecipientsVisible:true,unknownOutputAndBurnNotMisclassified:true,
    readonlyColdCalls:{primaryStatus:1,missingTapeStatus:1,selectedNftIndex:1,mintHistory:1,total:4},
    readonlyWarmCalls:{primaryStatus:1,missingTapeStatus:1,total:2},
    immutableIdentityCacheBound:256,statusOwnerAndBalanceNeverCached:true,
    tapeAndIdentityReadsOverlap:true,revocationSuppressesLateOrigin:true,
    publicExecutorProviderWorkerNativeBindingUnchanged:true},
  comparison:{
    reference:'Frozen Native/WASM NFT origin, issuance policy and existing Engine-built identities/fees, not a copied default-parser preview.',
    reason:'The old default parser fails current NFT selected-policy material and can label descendants by their current state txid. The new private decoder binds the original mint ID to complete Code via immutable raw origin before approving any amount/recipient.',
    cost:'Two cold identity reads in addition to primary/Tape status, no ancestry walk, account scan, tip or fee-funding reads. Validated mint identity is reusable; the supplied shared immutable parent reader can eliminate a physical origin GET. Warm operation still refreshes both status batches.',
    transactionBuilderReadsChanged:false,frozenRustModified:false},
  limitations:['Holder transfer review only; NFT creation already has separate wallet-build evidence and is not represented as Reviewed support by this checkpoint.',
    'Remaining native/FT/lock/order/escrow recognition and full associated witness composition still precede public Reviewed routing.',
    'Native signing custody, device signatures, live API/chain, matched performance and incremental size are not proved by these offline helpers.',
    'The identity resolver must be owned by one immutable network/source worker and recreated on a source switch.'],
  chainHttp:0,broadcasts:0,acceptedDeliveryChanged:false,goalComplete:false,published:false};
if(output)await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests,protectedFiles:protectedState.protectedFiles,output:output??null}));
