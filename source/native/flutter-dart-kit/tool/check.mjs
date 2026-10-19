// Current source gate. Historical F0/F1 reports remain immutable checkpoints.
// With no output argument this is read-only. A supplied output is create-only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
const base=resolve(import.meta.dirname,'..'),dart=process.argv[2],output=process.argv[3];
assert(dart,'Dart SDK executable required');
const sha=b=>createHash('sha256').update(b).digest('hex');
const readJson=async p=>JSON.parse(await readFile(p));
const p5=resolve(base,'../flutter-dart-live-token-exploration');
const seal=await readJson(join(p5,'evidence/sealed-final-20261012-b/seal.json'));
const replay=await readJson(join(base,'test/fixtures/signing/replay.json'));
const workerFixture=await readFile(join(base,'test/fixtures/signing/material.json'));
assert.equal(sha(workerFixture),seal.sourceHashes['matched/dart/fixture.json']);
const transportSource=await readFile(join(p5,'lib/wire_session.dart'));
assert.equal(sha(transportSource),seal.sourceHashes['lib/wire_session.dart']);
for(const p of replay.provenance){
 assert.equal(sha(await readFile(join(p5,p.path))),p.sha256);
 assert.equal(p.sha256,seal.evidenceHashes[p.path.slice('evidence/'.length)]);
 const old=await readJson(join(p5,p.path));
 const platform=p.path.startsWith('evidence/android')?'android':'ios';
 for(const [i,method]of [[0,'tbc_signMessage'],[1,'tbc_signTransaction']]){
  const entry=replay.cases.find(c=>c.name===platform+'-'+method);assert(entry);
  assert.deepEqual(entry.audit,old.host[i].audit);
  assert.deepEqual(entry.result,old.page[i].value);
 }
}
const material=await readJson(join(base,'evidence/f1-source-check.json'));
const migration=await readJson(join(base,'evidence/f2-fungible-extraction-migration.json'));
assert.equal(sha(await readFile(join(base,migration.parent))),migration.parentSha256);
assert.deepEqual(Object.keys(migration.files).sort(),['lib/src/internal/tbc20_material.dart','lib/src/internal/transaction_read.dart']);
assert.equal(sha(await readFile(join(base,migration.oracle))),migration.oracleSha256);
const tokenMigration=await readJson(join(base,'evidence/f2-htlc-token-shared-readers-migration.json'));
assert.equal(sha(await readFile(join(base,tokenMigration.parent))),tokenMigration.parentSha256);
assert.equal(sha(await readFile(join(base,tokenMigration.priorMigration))),tokenMigration.priorMigrationSha256);
assert.equal(sha(await readFile(join(base,tokenMigration.oracle))),tokenMigration.oracleSha256);
const tokenParent=await readJson(join(base,tokenMigration.parent));
assert.deepEqual(Object.keys(tokenMigration.files).sort(),['lib/src/internal/native_material.dart','lib/src/internal/stablecoin_material.dart','lib/src/internal/tbc20_material.dart']);
for(const [p,change]of Object.entries(tokenMigration.files)){
 assert.equal(change.before,tokenParent.sourceHashes[p],p);
 assert.equal(sha(await readFile(join(base,p))),change.after,p);
}
for(const [p,h]of Object.entries(material.sourceHashes).filter(([p])=>p.startsWith('lib/src/internal/')||p==='lib/src/configuration.dart')){
 const changed=migration.files[p];if(changed)assert.equal(changed.before,h,p);
 const extended=tokenMigration.files[p];if(extended)assert.equal(extended.before,changed?.after??h,p);
 assert.equal(sha(await readFile(join(base,p))),extended?.after??changed?.after??h,p);
}
const extraction=await readJson(join(base,'evidence/f1-host-extraction.json'));
for(const f of extraction.provenance)assert.equal(sha(await readFile(join(base,f.destination))),f.sha256,f.destination);
const analysis=execFileSync(dart,['analyze','--fatal-infos','lib','test','tool'],{cwd:base,encoding:'utf8'});
const events=execFileSync(dart,['test','--reporter=json'],{cwd:base,encoding:'utf8'}).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const done=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success');
assert.equal(done.length,1182);
const protection=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const hashes={};async function walk(path){for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())await walk(p);else if(e.isFile())hashes[relative(base,p)]=sha(await readFile(p));}}
await walk(join(base,'lib'));await walk(join(base,'test'));
for(const p of ['pubspec.yaml','pubspec.lock'])hashes[p]=sha(await readFile(join(base,p)));
const report={
 status:'F3_PREPARED_SHARED_PROVIDER_WORKER_NATIVE_ROUTING_PASS',recordedAt:new Date().toISOString(),
 reviewedMaterial:{normalizationCases:19,nativeWasmKeylessCases:13,frozenDefaultReviewCases:6,
  focusedTests:52,readTransportTests:5,privateHelpersOnly:true,providerAdvertised:false,
  previewPolicyTests:27,completeFrozenPreviewCases:17,historicalIndeterminateRejected:1,
  currentHolderTests:24,completeCurrentHolderCases:11,currentAssociatedPreflightCases:2,
  currentHolderReadCount:4,currentNftMissingTapeRootCauseProved:true,
  nftHolderTests:19,nftOriginPolicyCases:10,nftVersions:['current',0,1,2],
  nftColdReadCount:4,nftWarmReadCount:2,nftOriginalMintIdentityVerified:true,
  historicalHolderTests:18,historicalFrozenCases:6,historicalHolderReadCount:4,
  historicalFullIndexedCodeBinding:true,sharedCurrentHistoricalReview:true,
  mixedCurrentHistoricalStatusBatches:2,
  nativeLockReviewTests:35,nativeLockStandardArtifactCases:21,nativeLockAssociatedStages:6,
  nativeLockStatusBatches:1,nativeLockLocalParentFetch:0,preimagePrivate:true,
  lopReviewTests:34,lopFrozenArtifacts:23,lopExactReadCounts:[1,3,4],sharedIndexedCodeAuthentication:true,
  tokenHtlcReviewTests:24,tokenHtlcFrozenArtifacts:16,tokenHtlcReadCount:4,
  sharedReviewerTests:92,sharedSingleCases:87,sharedFullFrozenArtifacts:71,
  dependencyBatchTests:5,mixedFiveFamilyStatusBatches:2,mixedDuplicateGets:0,
  associatedHolderCases:16,sharedSigningCoreCases:7,sharedSigningTests:16,
  sharedSigningOneConsent:true,sharedSigningInterstageReads:0,
  remaining:['specialized old ft/ft-contract associated profiles','native custody and private channel','Provider/device proof'],
  proof:'Private shared reviewer and signing executor with exact frozen Core plan/binding/result and Native/WASM parity; not a complete public Reviewed capability.'},
 preparedTransaction:{oracleCases:22,invalidOracleCases:17,focusedTests:53,providerWorkerTests:6,nativeBindingTests:3,
  archiveSha256:'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0',
  exactFrozenCoreBindingPreviewTasksAndSignedBytes:true,sourceNativeWasmParity:true,
  mainnetAndTestnetOfflineVectors:true,fixedAndTwoThreeStageDeferred:true,independentController:true,
  oneConsent:true,onePreparation:true,preparedEvidenceNeverPassedToReaders:true,
  parallelPrefetchPreserved:true,noBetweenStageReads:true,journalWrites:0,
  schemaHashTimeBeforeReads:true,proposalCheckedBeforeReceiptOrSignature:true,
  nativeCustodyAdapterConnected:true,publicProviderAdvertised:true,deviceProof:false,
  existingTransactionPermission:true,invalidCode:-32602,expiredCode:4100,mismatchCode:-32603,
  remaining:['focused dual-device Rust signatures; device evidence collected separately','matched timing and private Testnet acceptance'],
  proof:'Recorded public fixture signatures from frozen Core and WASM revalidated through actual Native Engine. No native Vault, HTTP or broadcast.'},
 typedData:{oracleCases:8,invalidOracleCases:26,focusedTests:55,providerWorkerTests:9,
  archiveSha256:'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0',
  exactFrozenEnvelopePreviewBindingTaskPayloadDigestSignatureResult:true,
  mainnetAndTestnetOfflineVectors:true,englishAsciiFieldNameSortCases:787,
  oneConsent:true,sharedReceiptAndAccountFences:true,chainReads:0,journalWrites:0,
  nativeCustodyAdapterConnected:true,publicProviderAdvertised:true,deviceProof:false,
  separateOrdinaryTypedPermissions:true,invalidParamsCode:-32602,invalidRequestDoesNotCloseSession:true,
  remaining:['actual frozen Rust signatures on both Flutter consumers','matched timing'],
  proof:'Shared Provider/worker/executor with public recorded Core/Noble signatures. Paired native and device evidence is separate.'},
 independentController:{oracleCases:20,focusedTests:72,workerCases:20,
  concreteCases:8,genericAliases:8,nativeConsolidationCases:4,
  exactFrozenMaterialPolicyPlanFeeSignedBytes:true,trustedAccountIdentityOnly:true,
  nativeCustodyAdapterConnected:true,oneConsent:true,parallelInitialReads:4,
  noBetweenStageReads:true,ordinarySingleAccountHasNoRoleResolution:true,
  connectedAccountCatalogAndPerAccountMetadata:true,accountDiscoveryHasNoNetworkReads:true,
  negativeProof:['missing, duplicate and unrequested identities','revocation during resolution and dependent signing',
   'changed material identity','native catalog integrity and separate metadata grants'],
  nativeDeviceProof:false,realBroadcasts:0},
 dependentPool:{oracleCases:7,focusedTests:23,workerCases:7,nativeFundingCases:4,holderFragmentCases:3,
  exactNativeWasmSnapshotPolicyPlanFeeSignedBytes:true,oneConsent:true,parallelInitialReads:4,
  noBetweenStageReads:true,unknownAggregateCountUsesBoundedValidatedStages:true,
  nativeDeviceProof:false,networkHttp:0,realBroadcasts:0},
 lop:{oracleCases:23,focusedTests:56,workerCases:10,
  profiles:['tbc-lop-create','tbc-lop-cancel','tbc-lop-match'],markets:['native-token','token-token'],
  assetStandards:['tbc20-standard','tbc20-stablecoin'],exactNativeWasmSnapshotPolicyPlanFeeSignedBytes:true,
  oneConsent:true,parallelPreparation:true,sharedImmutableParents:true,freshOrderAndPairedEscrowStatus:true,
  noFeeFundingParentRead:true,createMaximumTokenInputs:5,originalOrderRolesAndTermsPreserved:true,
  nativeDeviceProof:false,networkHttp:0,realBroadcasts:0},
 tokenHtlc:{oracleCases:16,focusedTests:49,workerCases:8,
  profiles:['tbc-htlc-lock','tbc-htlc-claim','tbc-htlc-refund'],assetStandards:['tbc20-standard','tbc20-stablecoin'],
  exactNativeWasmSnapshotPolicyPlanFeeSignedBytes:true,oneConsent:true,initialParallelReads:{lock:4,spend:5},
  lockColdGets:[5,6],lockWarmGets:3,spendColdGets:[5,6],spendWarmGets:2,spendStatusPosts:1,
  positiveUnknownFloorWarmGets:3,maximumAssetInputs:5,sharedNativeFundingAndParentCache:true,
  pairedEscrowAndTokenStatus:true,authenticatedIdentityRoleMaturityAndAmount:true,
  preimageRemovedFromReadProjection:true,preimageAbsentFromReadsReviewAndMetrics:true,
  claimSignedBytesDisclosureWarningRequired:true,policyDust:42,
  nativeDeviceProof:false,networkHttp:0,realBroadcasts:0},
 nativeHtlc:{oracleCases:11,focusedTests:34,workerCases:6,
  profiles:['tbc-htlc-lock','tbc-htlc-claim','tbc-htlc-refund'],tokenHtlc:false,
  exactNativeWasmSnapshotPolicyPlanFeeSignedBytes:true,oneConsent:true,initialParallelReads:2,
  lockColdWarmGets:2,spendColdGets:[2,3],spendWarmGets:1,spendStatusPosts:1,
  positiveUnknownFloorWarmGets:2,spendNativeFeeIndexReads:0,directParentOnly:true,
  sharedImmutableParentCache:true,selectionOwnedBeforeAwait:true,unknownConfirmationsNotZero:true,
  preimageRemovedFromReadProjection:true,preimageAbsentFromReadsReviewAndMetrics:true,
  claimSignedBytesDisclosureWarningRequired:true,refundUsesChainHeightOrMedianTime:true,
  claimAfterRefundThresholdAllowed:true,nativeDeviceProof:false,networkHttp:0,realBroadcasts:0},
 timelock:{oracleCases:8,focusedTests:23,workerCases:4,profiles:['tbc-timelock-lock','tbc-timelock-unlock'],
  exactNativeWasmSnapshotPolicyPlanFeeSignedBytes:true,oneConsent:true,initialParallelReads:2,
  lockColdWarmGets:2,unlockColdGets:[3,4],unlockWarmGets:2,positiveUnknownFloorWarmGets:3,
  unlockNativeFeeIndexReads:0,directParentOnly:true,sharedImmutableParentCache:true,
  selectionOwnedBeforeAwait:true,unknownConfirmationsNotZero:true,
  nativeDeviceProof:false,networkHttp:0,realBroadcasts:0},
 unifiedPool:{oracleCases:24,focusedTests:55,workerCases:15,policyOverrideBeforeSignRejected:true,
  profiles:['amm.swap','amm.addLiquidity','amm.removeLiquidity','amm.mergeToken','tbc20Lp.transfer','tbc20Lp.lock','tbc20Lp.unlock','tbc20Lp.merge','tbc20Lp.burn'],
  exactFrozenMaterialPolicyPlanFeesAndSignedBytes:true,originalGenericRequestBindingPreserved:true,
  privateReadProjectionOnly:true,sharedConcreteReaders:true,extraNetworkReads:0,
  requestScopedDynamicReuse:true,boundedImmutableOriginCache:256,unsupportedTemplatesFailClosed:true,
  historicalExplicitInputsRejectedByBothFrozenWasmAndNative:true,
  workerAndNativeCustodyAliasesEnabled:true,oneConsent:true,originalGenericRequestInCustody:true,
  initialParallelReads:{business:4,maintenance:3},newDeviceProof:false,realBroadcasts:0,
  remaining:['Legacy mapping','matched timing and private Testnet acceptance']},
 pool2:{oracleCases:14,focusedTests:42,profiles:['buy','sell','add','remove','merge-ft','merge-lp','burn-lp'],
  coldGets:{buy:9,sell:11,add:11,remove:10},warmGets:{buy:4,sell:4,add:4,remove:5},
  positiveFloorColdGets:{buy:9,sell:11,add:11,remove:10},positiveFloorWarmGets:{buy:6,sell:6,add:6,remove:7},
  nativeWasmMaterialPolicyPlanFeesAndSignedBytesExact:true,sharedImmutableHistory:true,
  slowTipDoesNotBlockZeroFloorParentReads:true,confirmationOnlyQueriesAtZeroFloor:0,
  oldPoolCreationEnabled:false,providerOrCustodyEnabled:true,oneConsent:true,initialParallelReads:4,
  authenticatedPoolPolicyOverrideRejected:true,expiredRequestNoReadsOrConsent:true,deviceProof:false,realBroadcasts:0,
  maintenance:{oracleCases:6,wholeInputsOnly:true,tokenLimit:4,lpLimit:5,taskLimit:6,
   coldGets:[10,9,9],warmGets:[4,4,4],positiveFloorWarmGets:[5,5,5],
   nativeWasmBytesAndFeesExact:true,noLpReserveWithdrawalOnBurn:true,
   singleConsentSharedWorker:true,staleConfirmationCache:false},
  remaining:['Legacy mapping','private Testnet proof'],
  explicitInputs:'Unsupported by frozen Engine for all seven concrete Pool2 intents; not a missing Dart selection mode'},
 lp:{oracleCases:9,focusedTests:27,profiles:['transfer','merge','lock','unlock'],coldGets:[6,7],warmGets:3,
  unknownHeightPositiveFloorFreshDecode:true,oneConsent:true,parallelPreparation:true,sourceNativeWasmBytesExact:true,
  noCurrentPoolReserveRead:true,noNativeFeeParentRead:true,noRecursiveAncestry:true},
 ammFunding:{oracleCases:5,largestFirstConfirmedCandidates:true,maximumAlternatives:100,explicitOneNativeOnly:true,
  noExtraParentReadsForAlternatives:true,unchangedSingleFundingSignedBytes:true},
 tests:done.length,analysis:analysis.trim(),protection,sourceHashes:hashes,
 replayCases:replay.cases.map(c=>({name:c.name,resultExact:true,approvalCount:1,
  signingTasks:c.audit.signatures.length,fee:c.result.totalFee??null,
  mode:'Recorded public-fixture signatures revalidated using the actual pinned Native Engine'})),
 sharedLifecycle:['explicit host authorization, no granted/unlocked defaults','one bounded consent overlaps one preparation',
  'immutable request/context/material/receipt','plan, pre-sign and finalized validation retained',
  'message signature/key verification retained','per-task native authority and returned signature checks',
  'scope invalidation and operation teardown','no default payload audit collection',
  'one immutable network/source per reusable non-UI worker','native custody remains outside compute isolate',
  'parallel requests without a global consent queue','late native handles are closed after cancellation',
  'default HTTP transport parses in the worker; only read-only TXO-status POST, no broadcast or retries'],
 worker:{tests:8,currentTbc20ControlledReads:{cold:5,warm:3},exactSignedTransactionReplay:true,
  ordinaryMessageWithDefaultTransport:true,liveHttpOrDeviceProof:false},
 nativeBinding:{tests:18,privateEnvelope:true,nativeCommitSnapshot:true,targetedCancel:true,
  proof:'Typed Dart channel double only; paired actual native dispatcher has separate host evidence. Flutter device channel not yet proved.'},
 transport:{tests:9,sourcePath:'lib/wire_session.dart',sourceSha256:sha(transportSource),
  implementation:'Adapted P5 protocol, not a byte-identical copy or complete Provider',
  changes:['wallet-owned identity/network','required native lifecycle/delivery fences',
   'replay rechecks delivery authority','fixed public errors only',
   'request fingerprints and ACK result reclamation, bounded unacknowledged bytes'],
  proof:'Synthetic native delivery and execution callbacks; no WebView device acceptance'},
 providerSession:{tests:9,callableInternalSession:true,publicFullFeatureEntry:false,
  control:'Native-shaped mock owner with no default grant; actual native commit/delivery fences not proved',
  methods:['tbc_chainId','tbc_accounts','tbc_requestAccounts','tbc_getAccount','tbc_getCapabilities',
   'wallet_getPermissions','wallet_requestPermissions','tbc_disconnect','tbc_signMessage','tbc_signTypedData','tbc_signTransaction','tbc_signPreparedTransaction'],
  limits:['ordinary and typed structured messages; remaining Sign-In/Legacy profiles are pending','Enabled transaction families and Prepared signing share the lifecycle; Reviewed and general workflows remain pending','one active configured chain and primary payer; separately selected and granted Pool-controller role does not switch the primary account'],
  sharedWorker:true,defaultPolicyExactFrozenParity:true,policyTests:2,
  targetedCancel:true,cancelBeforeWorkerBegin:true,userRejectionCode:4001,
  extraChainReads:0,grantWritesDuringSignOnly:0},
 tbc20MaterialReaderUnchanged:false,materialMigration:migration,tokenHtlcMaterialMigration:tokenMigration,
 ammCreation:{oracleCases:4,focusedTests:14,coldGets:4,warmGets:2,dependentStages:2,
  oneApproval:true,stageReads:0,nativeDust:'10',signedByteParity:true,deviceProof:false},
 ammBusiness:{oracleCases:8,focusedTests:24,publicPlainAndLocked:true,
  profiles:['tbc-amm-add-liquidity','tbc-amm-swap','tbc-amm-remove-liquidity'],
  nativeWasmMaterialPolicyPlanFeeAndSignedBytesExact:true,
  coldGets:{add:8,buy:7,sell:9,remove:10},warmGets:{add:5,buy:4,sell:5,remove:5},
  oneApproval:true,initialParallelReads:4,fundingParentAuthenticated:true,sharedImmutableCache:true,
  extraStageReads:0,newPersistence:false,independentControllerAdapter:true,
  proof:'Frozen public fixtures; no new network or device signatures here. Separate mobile, real-chain and matched performance evidence remains required.'},
 nftMint:{oracleCases:7,focusedTests:20,coldGets:4,warmGets:3,missingSelectedSlotsStatusPosts:1,
  positiveUnknownConfirmationExtraDecode:1,zeroFloorObservationDecode:0,
  oneConsent:true,parallelInitialReads:4,extraStageGets:0,persistenceAdded:false,
  nativeWasmMaterialPolicyFeeAndSignedBytesExact:true,requestedOrderPreserved:true,
  proof:'Frozen Kit/WASM and actual Native Engine with public recorded signatures. Exact slot, index lag, unknown confirmations, wrong/spent/duplicate slot and between-stage cancellation are covered. Separate native/device/chain proof required.'},
 creation:{oracleCases:6,focusedTests:18,profiles:['tbc20-standard-create','tbc721-standard-create-collection'],
  coldGets:2,warmGets:2,extraStageGets:0,parentReads:0,oneConsent:true,oneBinding:true,
  nativeWasmSignedOutputExact:true,stages:[1,2,3],oldCreationEnabled:false,
  maintenanceWarnings:'Only the exact known warning pair with the creation maintenance/prerequisite/primary plan shape is covered; unknown warnings fail before bind.',
  proof:'Frozen WASM oracle vs actual Native Engine with recorded public signatures. Separate native and device proof required; no broadcast.'},
 staged:{oracleCases:2,tests:13,transactionsPerFixture:2,tasksPerStage:[6,4],
  nativeWasmSignedOutputExact:true,oneConsent:true,oneBinding:true,onePreparation:true,
  coldGets:7,warmGets:3,extraStageGets:0,persistenceAdded:false,
  pendingEngineValidation:true,nativePrivateStageAdvance:true,
  negativeProof:['parent signature','altered parent raw','next digest','stage replay','cross-plan','cross-approval','between-stage cancel/expiry'],
  proof:'Frozen WASM oracle and actual pinned Native Engine, recorded public-fixture signatures, no device or broadcast claim in this source report.'},
 stablecoin:{oracleCases:9,tests:23,currentAndHistoricalMaterialExact:true,nativeWasmSignedOutputExact:true,
  currentColdGetRange:[5,6],currentWarmGets:3,positiveFloorWarmGets:4,historicalColdGets:8,historicalWarmGets:4,
  oneConsent:true,fourInitialReadsOverlapConsent:true,immutableParentCacheShared:true,
  currentNoIssuerStateScan:true,currentDustThreshold:24,holderOnly:true,lockReadSelection:true,
  proof:'Frozen Kit/WASM vs actual Native Engine with recorded public signatures. Lock discovery doubles only test read selection; real Engine remains final script authority. No device/live-chain or matched speed claim.'},
 nft:{oracleCases:10,tests:21,currentAndHistoricalMaterialExact:true,nativeWasmSignedOutputExact:true,
  coldReadRange:[6,7],warmReads:4,statusReadPosts:1,oneConsent:true,readsOverlapConsent:true,
  currentDirectAncestorOnly:true,immutableParentCacheShared:true,freshSpendState:true,
  proof:'Frozen Kit/WASM vs actual Native Engine with recorded public-fixture signatures; separate native/device reports required.'},
 fungible:{oracleCases:7,tests:12,currentAndHistoricalMaterialExact:true,nativeWasmSignedOutputExact:true,
  coldGetRange:[6,7],warmGets:3,oneConsent:true,readsOverlapConsent:true,
  historicalPolicySelectedFromMaterial:true,defaultPolicyAfterPreparation:true,
  proof:'Frozen Kit/WASM oracle, native compute with recorded public fixture signatures; separate native custody/device proof required.'},
 nativeTransfer:{materialCases:12,wrongNetworkRejectedBeforeReads:true,wasmNativeSignedOutputCases:6,
  sharedWorkerCases:2,controlledReadCount:2,parentReads:0,
  consentCount:1,mergeInputLimit:100,transferInputLimit:128,
  proof:'Frozen WASM oracle/public-scalar-one signatures replayed through actual Native Engine and shared Dart lifecycle; not device/chain proof.'},
 networkHttp:0,newSignatures:0,broadcasts:0,
 nativeLibrarySha256:replay.library.sha256,
 proofLimit:'Callable internal partial Provider session through the shared non-UI worker and actual Native Engine, with recorded signatures and mock native control. No new device/Vault atomicity, complete Provider, live broadcast, speed or complete App-size proof.',
 acceptedDeliveryChanged:false,published:false,
};
if(output)await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests:report.tests,replayCases:report.replayCases,protectedFiles:protection.protectedFiles,newDeviceAcceptance:false}));
