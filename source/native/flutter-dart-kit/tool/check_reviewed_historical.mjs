// Historical holder extension: affected tests only; immutable parent evidence.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart);
const read=p=>readFile(join(base,p)),sha=b=>createHash('sha256').update(b).digest('hex');
const oraclePath='test/fixtures/reviewed-historical-fungible.json',oracleBytes=await read(oraclePath),oracle=JSON.parse(oracleBytes);
assert.equal(oracle.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
assert.equal(oracle.cases.length,6);
for(const [p,h]of Object.entries(oracle.provenance))assert.equal(sha(await read('test/fixtures/'+p)),h,p);
for(const s of oracle.cases){assert(s.policyResult);assert(s.identities.identities.every(i=>i.generation==='historical'));}
const parentPath='evidence/f3-reviewed-nft-source.json',parentBytes=await read(parentPath),parent=JSON.parse(parentBytes),sourceHashes={},changes={};
const permitted={
 'lib/src/internal/reviewed_current_holder.dart':'One shared fungible review now includes exact historical pairs without a separate execution or approval path. Preserve current pre-read rejection and four-read trace.',
 'lib/src/internal/reviewed_token.dart':'Frozen historical pair inspection and full indexed Code binding; shared metadata lookup, no balance/label trust.',
 'test/reviewed_current_holder_test.dart':'Call renamed private reviewFungibleHolderTransactions; existing golden outcomes and read counts unchanged.',
};
for(const [p,h]of Object.entries(parent.sourceHashes)){
 const actual=sha(await read(p));sourceHashes[p]=actual;
 if(permitted[p])changes[p]={before:h,after:actual,reason:permitted[p]};else assert.equal(actual,h,p);
}
for(const p of ['lib/src/internal/reviewed_historical_token.dart',
 'test/reviewed_historical_holder_test.dart',oraclePath,'tool/reviewed_historical_oracle.mjs',
 'tool/check_reviewed_historical.mjs'])sourceHashes[p]=sha(await read(p));
const analysis=execFileSync(dart,['analyze','--fatal-infos','lib','test','tool'],{cwd:base,encoding:'utf8'});
const events=execFileSync(dart,['test','test/reviewed_historical_holder_test.dart',
 'test/reviewed_nft_test.dart','test/reviewed_current_holder_test.dart','test/reviewed_preview_test.dart',
 'test/reviewed_material_test.dart','test/read_api_test.dart','test/read_api_get_test.dart','--reporter=json'],
 {cwd:base,encoding:'utf8'}).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const tests=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').length;
assert.equal(tests,145);
const protectedState=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const report={status:'F3_REVIEWED_HISTORICAL_FUNGIBLE_PRIVATE_PASS',recordedAt:new Date().toISOString(),
 parent:{path:parentPath,sha256:sha(parentBytes)},oracle:{path:oraclePath,sha256:sha(oracleBytes)},
 tests,analysis,sourceHashes,changes,protectedState,
 proof:{newHistoricalTests:18,previousAffectedTests:127,frozenHistoricalCases:6,
  historicalTypes:['FT v4 transfer/payment/merge','StableCoin v4 transfer/payment/merge'],
  nativeWasmExactPairReceiptAndIssuanceResults:true,currentFullPreviewAndHashCasesUnchanged:11,
  nftOriginPolicyCasesRetained:10,sharedFungibleReviewer:true,readOnlyCallsPerFixture:4,
  mixedCurrentHistoricalRows:{statusBatches:2,assetMetadataReads:4,totalCalls:6},
  currentKnownOwnerProfileFailureRejectsBeforeDependencyReads:true,
  historicalIndexedCodeEqualsFullCodeExceptController:true,
  externalTokenAndNativeCollateralVisible:true,conservationAndHolderRoleChecked:true,
  historicalCoinLockDomainsAndNonfinalSequenceChecked:true,chainMaturityNotClaimed:true,
  mutableStatusRefreshed:true,ancestryWalks:0,accountScans:0,extraBuilderReads:0,
  publicExecutorProviderWorkerNativeBindingUnchanged:true},
 implementationNotes:[
  'Recognition/balances use frozen inspectTokenMaterial identifyPairs. Controller/lock field extraction is a bounded private view of an already authenticated template, compared against frozen inspectTokenReceipt; Rust algorithm remains unchanged.',
  'The first shared refactor moved current account/profile checks after Tape reads. Existing tests caught extra failure-path reads; checks are again before dependency reads, without relaxing checks or changing their expected traces.',
  'An initial test incorrectly treated unspendable OP_RETURN Tape as a spendable input. Shared status deliberately requires live primary Code but permits historical Tape metadata; the corrected test proves both boundaries.',
  'Published FT codeIdentity includes a 32-byte partial hash plus encoded script size, not a fixed 33-byte identity. Shape validation follows the frozen SDK encoding; full indexed Code equality additionally excludes only controller bytes.'
 ],
 limits:['This is private raw-holder review, not public Reviewed signing, native custody, device or chain acceptance.',
  'Historical associated witnesses are not promoted; current associated preflight remains separately proved.',
  'No wall-clock regression or size conclusion follows from controlled read counts.',
  'Remaining native/lock/order/escrow reviews and shared dispatcher/executor/native binding still precede public routing.'],
 chainHttp:0,broadcasts:0,acceptedDeliveryChanged:false,frozenRustModified:false,goalComplete:false,published:false};
if(output)await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests,protectedFiles:protectedState.protectedFiles,output:output??null}));
