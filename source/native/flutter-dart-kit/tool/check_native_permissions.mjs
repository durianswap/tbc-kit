// Host compile/replay, not mobile device acceptance. No downloads or key access.
// The supplied output report is create-only; build outputs live in one temp dir.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..');
const javaHome=process.env.JAVA_HOME,androidHome=process.env.ANDROID_HOME;
assert(javaHome&&androidHome,'JAVA_HOME (JDK17+) and ANDROID_HOME are required');
const cache=process.env.TBC_GRADLE_CACHE??join(homedir(),'.gradle/caches/modules-2/files-2.1');
async function jar(group,name,version){
 const root=join(cache,group,name,version),hits=[];
 for(const e of await readdir(root,{withFileTypes:true}))if(e.isDirectory()){
  for(const f of await readdir(join(root,e.name)))if(f===`${name}-${version}.jar`)hits.push(join(root,e.name,f));
 }
 assert.equal(hits.length,1,`${group}:${name}:${version} cached jar`);return hits[0];
}
const output=process.argv[2],sha=b=>createHash('sha256').update(b).digest('hex');
const extraction=JSON.parse((await run(process.execPath,['tool/native_permission_extraction.mjs'],{cwd:base,maxBuffer:2**20})).stdout);
const permissionMigration=JSON.parse(await readFile(join(base,'evidence/f2-controller-native-permission-migration.json')));
const typedPermissionMigration=JSON.parse(await readFile(join(base,'evidence/f2-typed-native-permission-migration.json')));
const networkPermissionMigration=JSON.parse(await readFile(join(base,'evidence/f3-network-native-permission-migration.json')));
assert.equal(networkPermissionMigration.parent,'evidence/f2-typed-native-permission-migration.json');
assert.equal(sha(await readFile(join(base,networkPermissionMigration.parent))),networkPermissionMigration.parentSha256);
assert.deepEqual(Object.keys(networkPermissionMigration.files).sort(),Object.keys(typedPermissionMigration.files).sort());
assert.equal(typedPermissionMigration.parent,'evidence/f2-controller-native-permission-migration.json');
assert.equal(sha(await readFile(join(base,typedPermissionMigration.parent))),typedPermissionMigration.parentSha256);
assert.deepEqual(Object.keys(typedPermissionMigration.files).sort(),Object.keys(permissionMigration.files).sort());
assert.equal(permissionMigration.parent,'tool/native_permission_extraction.mjs');
assert.deepEqual(Object.keys(permissionMigration.files).sort(),Object.keys(extraction.files).sort());
for(const [p,s]of Object.entries(extraction.files)){
 assert.equal(sha(s),permissionMigration.files[p].before,p);
 assert.equal(typedPermissionMigration.files[p].before,permissionMigration.files[p].after,p);
 assert.equal(networkPermissionMigration.files[p].before,typedPermissionMigration.files[p].after,p);
 assert.equal(sha(await readFile(join(base,p))),networkPermissionMigration.files[p].after,p);
}
const p5=resolve(base,'../flutter-dart-live-token-exploration');
const seal=JSON.parse(await readFile(join(p5,'evidence/sealed-final-20261012-b/seal.json')));
const custodySource='android/PublicFixtureVault.kt',custodySourceSha256=sha(await readFile(join(p5,custodySource)));
assert.equal(custodySourceSha256,seal.sourceHashes[custodySource]);
const swiftCustodySource='ios/PublicFixtureVault.swift',swiftCustodySourceSha256=sha(await readFile(join(p5,swiftCustodySource)));
assert.equal(swiftCustodySourceSha256,seal.sourceHashes[swiftCustodySource]);
const kotlin='platform/android/src/main/kotlin/io/tbc/kit/dart/NativePermissions.kt',swift='platform/ios/Classes/NativePermissions.swift';
const kotlinCustody='platform/android/src/main/kotlin/io/tbc/kit/dart/NativeCustody.kt';
const swiftCustody='platform/ios/Classes/NativeCustody.swift';
const kotlinHost='platform/android/src/main/kotlin/io/tbc/kit/dart/NativeWalletHost.kt';
const swiftHost='platform/ios/Classes/NativeWalletHost.swift';
const kotlinPrepared='platform/android/src/main/kotlin/io/tbc/kit/dart/NativePrepared.kt',swiftPrepared='platform/ios/Classes/NativePrepared.swift';
const kotlinReviewed='platform/android/src/main/kotlin/io/tbc/kit/dart/NativeReviewed.kt',swiftReviewed='platform/ios/Classes/NativeReviewed.swift';
const kotlinWorkflow='platform/android/src/main/kotlin/io/tbc/kit/dart/NativeWorkflow.kt',swiftWorkflow='platform/ios/Classes/NativeWorkflow.swift';
const kotlinCrypto='platform/android/src/main/kotlin/io/tbc/kit/dart/NativeCrypto.kt',swiftCrypto='platform/ios/Classes/NativeCrypto.swift';
const compiler=await Promise.all([
 ['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],
 ['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],
 ['org.jetbrains','annotations','13.0'],
 ['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1'],
].map(v=>jar(...v)));
const json=await jar('org.json','json','20240303');
const androidJar=join(androidHome,'platforms',process.env.TBC_ANDROID_PLATFORM??'android-36','android.jar');
const swiftc=(await run('/usr/bin/xcrun',['--find','swiftc'])).stdout.trim();
const macSdk=(await run('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'])).stdout.trim();
const scratch=await mkdtemp(join(tmpdir(),'tbc-dart-native-auth-'));
const options={cwd:base,maxBuffer:2**20,timeout:120000};
try{
 const compiled=await Promise.allSettled([
  run(join(javaHome,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
   '-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,androidJar].join(':'),
   '-d',join(scratch,'classes'),kotlin,kotlinCustody,kotlinPrepared,kotlinReviewed,kotlinWorkflow,kotlinHost,kotlinCrypto,'test/native/PermissionCheck.kt','test/native/CustodyCheck.kt'],options),
  run(swiftc,['-sdk',macSdk,'-swift-version','6','-parse-as-library',swift,'test/native/PermissionCheck.swift','-o',join(scratch,'permission-check')],options),
  run(swiftc,['-sdk',macSdk,'-swift-version','6','-parse-as-library',swift,swiftCustody,swiftPrepared,swiftReviewed,swiftWorkflow,swiftHost,swiftCrypto,'test/native/CustodyCheck.swift','-o',join(scratch,'custody-check')],options),
 ]);
 for(const result of compiled)if(result.status==='rejected')throw result.reason;
 const [kotlinCompile,swiftCompile,swiftCustodyCompile]=compiled.map(r=>r.value);
 const fixture=join(base,'test/fixtures/native-permissions.json');
 const executed=await Promise.allSettled([
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.PermissionCheckKt',fixture],options),
  run(join(scratch,'permission-check'),[fixture,join(scratch,'sqlite')],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/signing/replay.json')],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/signing/replay.json')],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/native-signing.json'),'native'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/native-signing.json'),'native'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/fungible-signing.json'),'native'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/fungible-signing.json'),'native'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/nft-signing.json'),'native'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/nft-signing.json'),'native'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/stablecoin-signing.json'),'native'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/stablecoin-signing.json'),'native'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/staged-signing.json'),'staged'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/staged-signing.json'),'staged'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/creation-signing.json'),'creation'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/creation-signing.json'),'creation'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/nft-mint-signing.json'),'mint'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/nft-mint-signing.json'),'mint'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/amm-creation-signing.json'),'amm',join(base,'test/fixtures/amm-fee-review.json')],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/amm-creation-signing.json'),'amm',join(base,'test/fixtures/amm-fee-review.json')],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/amm-business-signing.json'),'native'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/amm-business-signing.json'),'native'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/lp-signing.json'),'native'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/lp-signing.json'),'native'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/pool2-signing.json'),'native'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/pool2-signing.json'),'native'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/pool2-maintenance.json'),'native'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/pool2-maintenance.json'),'native'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/unified-pool-signing.json'),'native'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/unified-pool-signing.json'),'native'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/timelock-signing.json'),'native'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/timelock-signing.json'),'native'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/htlc-native-signing.json'),'native'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/htlc-native-signing.json'),'native'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/htlc-token-signing.json'),'native'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/htlc-token-signing.json'),'native'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/lop-signing.json'),'native'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/lop-signing.json'),'native'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/amm-dependent-signing.json'),'pool-dependent'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/amm-dependent-signing.json'),'pool-dependent'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/amm-controller-signing.json'),'controller'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/amm-controller-signing.json'),'controller'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/amm-controller-extended.json'),'controller-extended'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/amm-controller-extended.json'),'controller-extended'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/typed-signing.json'),'typed'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/typed-signing.json'),'typed'],options),
  run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',join(base,'test/fixtures/prepared-signing.json'),'prepared'],options),
  run(join(scratch,'custody-check'),[join(base,'test/fixtures/prepared-signing.json'),'prepared'],options),
 ]);
 for(const result of executed)if(result.status==='rejected')throw result.reason;
 const [kr,sr,cr,scr,nkr,nsr,fkr,fsr,nfkr,nfsr,stkr,stsr,sgkr,sgsr,ckr,csr,mkr,msr,akr,asr,abkr,absr,lpkr,lpsr,p2kr,p2sr,pmkr,pmsr,upkr,upsr,tlkr,tlsr,hnkr,hnsr,htkr,htsr,lkr,lsr,dpkr,dpsr,pckr,pcsr,cekr,cesr,tdkr,tdsr,ppkr,ppsr]=executed.map(r=>r.value);
 const preparedKotlin=JSON.parse(ppkr.stdout),preparedSwift=JSON.parse(ppsr.stdout);
 for(const r of [preparedKotlin,preparedSwift])assert.equal(r.status,'PASS');
 assert.equal(preparedKotlin.checks,preparedSwift.checks);assert.equal(preparedKotlin.hostChecks,preparedSwift.hostChecks);
 const typedDataKotlin=JSON.parse(tdkr.stdout),typedDataSwift=JSON.parse(tdsr.stdout);
 for(const r of [typedDataKotlin,typedDataSwift])assert.equal(r.status,'PASS');
 assert.equal(typedDataKotlin.checks,typedDataSwift.checks);assert.equal(typedDataKotlin.hostChecks,typedDataSwift.hostChecks);
 const controllerExtendedKotlin=JSON.parse(cekr.stdout),controllerExtendedSwift=JSON.parse(cesr.stdout);
 for(const r of [controllerExtendedKotlin,controllerExtendedSwift])assert.equal(r.status,'PASS');
 assert.equal(controllerExtendedKotlin.checks,controllerExtendedSwift.checks);assert.equal(controllerExtendedKotlin.hostChecks,controllerExtendedSwift.hostChecks);
 const controllerKotlin=JSON.parse(pckr.stdout),controllerSwift=JSON.parse(pcsr.stdout);
 for(const r of [controllerKotlin,controllerSwift])assert.equal(r.status,'PASS');
 assert.equal(controllerKotlin.checks,controllerSwift.checks);assert.equal(controllerKotlin.hostChecks,controllerSwift.hostChecks);
 const dependentPoolKotlin=JSON.parse(dpkr.stdout),dependentPoolSwift=JSON.parse(dpsr.stdout);
 for(const r of [dependentPoolKotlin,dependentPoolSwift])assert.equal(r.status,'PASS');
 assert.equal(dependentPoolKotlin.checks,dependentPoolSwift.checks);assert.equal(dependentPoolKotlin.hostChecks,dependentPoolSwift.hostChecks);
 const lopKotlin=JSON.parse(lkr.stdout),lopSwift=JSON.parse(lsr.stdout);
 for(const r of [lopKotlin,lopSwift])assert.equal(r.status,'PASS');
 assert.equal(lopKotlin.checks,lopSwift.checks);assert.equal(lopKotlin.hostChecks,lopSwift.hostChecks);
 const tokenHtlcKotlin=JSON.parse(htkr.stdout),tokenHtlcSwift=JSON.parse(htsr.stdout);
 for(const r of [tokenHtlcKotlin,tokenHtlcSwift])assert.equal(r.status,'PASS');
 assert.equal(tokenHtlcKotlin.checks,tokenHtlcSwift.checks);assert.equal(tokenHtlcKotlin.hostChecks,tokenHtlcSwift.hostChecks);
 const nativeHtlcKotlin=JSON.parse(hnkr.stdout),nativeHtlcSwift=JSON.parse(hnsr.stdout);
 for(const r of [nativeHtlcKotlin,nativeHtlcSwift])assert.equal(r.status,'PASS');
 assert.equal(nativeHtlcKotlin.checks,nativeHtlcSwift.checks);assert.equal(nativeHtlcKotlin.hostChecks,nativeHtlcSwift.hostChecks);
 const timelockKotlin=JSON.parse(tlkr.stdout),timelockSwift=JSON.parse(tlsr.stdout);
 for(const r of [timelockKotlin,timelockSwift])assert.equal(r.status,'PASS');
 assert.equal(timelockKotlin.checks,timelockSwift.checks);assert.equal(timelockKotlin.hostChecks,timelockSwift.hostChecks);
 const unifiedPoolKotlin=JSON.parse(upkr.stdout),unifiedPoolSwift=JSON.parse(upsr.stdout);
 for(const r of [unifiedPoolKotlin,unifiedPoolSwift])assert.equal(r.status,'PASS');
 assert.equal(unifiedPoolKotlin.checks,unifiedPoolSwift.checks);
 assert.equal(unifiedPoolKotlin.hostChecks,unifiedPoolSwift.hostChecks);
 const poolMaintenanceKotlin=JSON.parse(pmkr.stdout),poolMaintenanceSwift=JSON.parse(pmsr.stdout);
 for(const r of [poolMaintenanceKotlin,poolMaintenanceSwift])assert.equal(r.status,'PASS');
 assert.equal(poolMaintenanceKotlin.checks,poolMaintenanceSwift.checks);
 assert.equal(poolMaintenanceKotlin.hostChecks,poolMaintenanceSwift.hostChecks);
 const pool2Kotlin=JSON.parse(p2kr.stdout),pool2Swift=JSON.parse(p2sr.stdout);
 for(const r of [pool2Kotlin,pool2Swift])assert.equal(r.status,'PASS');
 assert.equal(pool2Kotlin.checks,pool2Swift.checks);assert.equal(pool2Kotlin.hostChecks,pool2Swift.hostChecks);
 const lpKotlin=JSON.parse(lpkr.stdout),lpSwift=JSON.parse(lpsr.stdout);
 for(const r of [lpKotlin,lpSwift])assert.equal(r.status,'PASS');
 assert.equal(lpKotlin.checks,lpSwift.checks);assert.equal(lpKotlin.hostChecks,lpSwift.hostChecks);
 const ammBusinessKotlin=JSON.parse(abkr.stdout),ammBusinessSwift=JSON.parse(absr.stdout);
 for(const r of [ammBusinessKotlin,ammBusinessSwift])assert.equal(r.status,'PASS');
 assert.equal(ammBusinessKotlin.checks,ammBusinessSwift.checks);
 assert.equal(ammBusinessKotlin.hostChecks,ammBusinessSwift.hostChecks);
 const ammCreationKotlin=JSON.parse(akr.stdout),ammCreationSwift=JSON.parse(asr.stdout);
 for(const r of [ammCreationKotlin,ammCreationSwift])assert.equal(r.status,'PASS');
 assert.equal(ammCreationKotlin.checks,ammCreationSwift.checks);
 assert.equal(ammCreationKotlin.hostChecks,ammCreationSwift.hostChecks);
 const nftMintKotlin=JSON.parse(mkr.stdout),nftMintSwift=JSON.parse(msr.stdout);
 for(const r of [nftMintKotlin,nftMintSwift])assert.equal(r.status,'PASS');
 assert.equal(nftMintKotlin.checks,nftMintSwift.checks);
 assert.equal(nftMintKotlin.hostChecks,nftMintSwift.hostChecks);
 const creationKotlin=JSON.parse(ckr.stdout),creationSwift=JSON.parse(csr.stdout);
 for(const r of [creationKotlin,creationSwift])assert.equal(r.status,'PASS');
 assert.equal(creationKotlin.checks,creationSwift.checks);
 assert.equal(creationKotlin.hostChecks,creationSwift.hostChecks);
 const stagedKotlin=JSON.parse(sgkr.stdout),stagedSwift=JSON.parse(sgsr.stdout);
 for(const r of [stagedKotlin,stagedSwift])assert.equal(r.status,'PASS');
 assert.equal(stagedKotlin.checks,stagedSwift.checks);
 const stablecoinKotlinResult=JSON.parse(stkr.stdout),stablecoinSwiftResult=JSON.parse(stsr.stdout);
 for(const r of [stablecoinKotlinResult,stablecoinSwiftResult]){
  assert.equal(r.status,'PASS');assert.equal(r.hostChecks,28);
 }
 assert.equal(stablecoinKotlinResult.checks,stablecoinSwiftResult.checks);
 const nftKotlinResult=JSON.parse(nfkr.stdout),nftSwiftResult=JSON.parse(nfsr.stdout);
 for(const r of [nftKotlinResult,nftSwiftResult]){
  assert.equal(r.status,'PASS');assert.equal(r.checks,227);assert.equal(r.hostChecks,28);
 }
 const fungibleKotlinResult=JSON.parse(fkr.stdout),fungibleSwiftResult=JSON.parse(fsr.stdout);
 for(const r of [fungibleKotlinResult,fungibleSwiftResult]){
  assert.equal(r.status,'PASS');assert.equal(r.checks,161);assert.equal(r.hostChecks,28);
 }
 const nativeKotlinResult=JSON.parse(nkr.stdout),nativeSwiftResult=JSON.parse(nsr.stdout);
 for(const r of [nativeKotlinResult,nativeSwiftResult]){
  assert.equal(r.status,'PASS');assert.equal(r.checks,420);assert.equal(r.hostChecks,26);
 }
 const kotlinResult=JSON.parse(kr.stdout),swiftResult=JSON.parse(sr.stdout),custodyResult=JSON.parse(cr.stdout),swiftCustodyResult=JSON.parse(scr.stdout);
 assert.equal(kotlinResult.status,'PASS');assert.equal(swiftResult.status,'PASS');
 assert.equal(custodyResult.status,'PASS');
 assert.equal(swiftCustodyResult.status,'PASS');
 assert.equal(custodyResult.checks,73);assert.equal(swiftCustodyResult.checks,73);
 assert.equal(custodyResult.hostChecks,27);assert.equal(swiftCustodyResult.hostChecks,27);
 assert.equal(kotlinResult.checks,69);assert.equal(swiftResult.checks,75);
 const sources={};for(const p of [kotlin,swift,kotlinCustody,swiftCustody,kotlinPrepared,swiftPrepared,kotlinReviewed,swiftReviewed,kotlinWorkflow,swiftWorkflow,kotlinHost,swiftHost,kotlinCrypto,swiftCrypto,'test/fixtures/prepared-signing.json','test/native/PermissionCheck.kt','test/native/PermissionCheck.swift','test/native/CustodyCheck.kt','test/native/CustodyCheck.swift','test/fixtures/native-permissions.json','test/fixtures/signing/replay.json','test/fixtures/native-signing.json','tool/native_permission_extraction.mjs','tool/check_native_permissions.mjs'])sources[p]=sha(await readFile(join(base,p)));
 sources['test/fixtures/fungible-signing.json']=sha(await readFile(join(base,'test/fixtures/fungible-signing.json')));
 sources['test/fixtures/nft-signing.json']=sha(await readFile(join(base,'test/fixtures/nft-signing.json')));
 sources['test/fixtures/stablecoin-signing.json']=sha(await readFile(join(base,'test/fixtures/stablecoin-signing.json')));
 sources['test/fixtures/staged-signing.json']=sha(await readFile(join(base,'test/fixtures/staged-signing.json')));
 sources['test/fixtures/creation-signing.json']=sha(await readFile(join(base,'test/fixtures/creation-signing.json')));
 sources['test/fixtures/nft-mint-signing.json']=sha(await readFile(join(base,'test/fixtures/nft-mint-signing.json')));
 for(const p of ['test/fixtures/amm-creation-signing.json','test/fixtures/amm-fee-review.json','test/fixtures/amm-business-signing.json','test/fixtures/lp-signing.json'])sources[p]=sha(await readFile(join(base,p)));
 sources['test/fixtures/pool2-signing.json']=sha(await readFile(join(base,'test/fixtures/pool2-signing.json')));
 sources['test/fixtures/pool2-maintenance.json']=sha(await readFile(join(base,'test/fixtures/pool2-maintenance.json')));
 sources['test/fixtures/unified-pool-signing.json']=sha(await readFile(join(base,'test/fixtures/unified-pool-signing.json')));
 sources['test/fixtures/timelock-signing.json']=sha(await readFile(join(base,'test/fixtures/timelock-signing.json')));
 sources['test/fixtures/htlc-native-signing.json']=sha(await readFile(join(base,'test/fixtures/htlc-native-signing.json')));
 sources['test/fixtures/htlc-token-signing.json']=sha(await readFile(join(base,'test/fixtures/htlc-token-signing.json')));
 sources['test/fixtures/lop-signing.json']=sha(await readFile(join(base,'test/fixtures/lop-signing.json')));
 sources['test/fixtures/amm-dependent-signing.json']=sha(await readFile(join(base,'test/fixtures/amm-dependent-signing.json')));
 for(const p of ['test/fixtures/amm-controller-signing.json','test/fixtures/amm-controller-extended.json','evidence/f2-controller-native-permission-migration.json','platform/android/src/main/kotlin/io/tbc/kit/dart/TbcDartWalletHost.kt'])sources[p]=sha(await readFile(join(base,p)));
 for(const p of ['test/fixtures/typed-signing.json','evidence/f2-typed-native-permission-migration.json','evidence/f3-network-native-permission-migration.json'])sources[p]=sha(await readFile(join(base,p)));
 const report={status:'F3_PREPARED_CUSTODY_HOST_CHECK_PASS',recordedAt:new Date().toISOString(),permissionMigration,typedPermissionMigration,preparedKotlin,preparedSwift,typedDataKotlin,typedDataSwift,controllerExtendedKotlin,controllerExtendedSwift,controllerKotlin,controllerSwift,dependentPoolKotlin,dependentPoolSwift,lopKotlin,lopSwift,tokenHtlcKotlin,tokenHtlcSwift,nativeHtlcKotlin,nativeHtlcSwift,timelockKotlin,timelockSwift,unifiedPoolKotlin,unifiedPoolSwift,poolMaintenanceKotlin,poolMaintenanceSwift,pool2Kotlin,pool2Swift,lpKotlin,lpSwift,
  provenance:extraction.provenance,networkPermissionMigration,sources,kotlin:kotlinResult,swift:swiftResult,kotlinCustody:custodyResult,swiftCustody:swiftCustodyResult,
  nativeTransferKotlin:nativeKotlinResult,nativeTransferSwift:nativeSwiftResult,
  fungibleKotlin:fungibleKotlinResult,fungibleSwift:fungibleSwiftResult,
  nftKotlin:nftKotlinResult,nftSwift:nftSwiftResult,
  stablecoinKotlin:stablecoinKotlinResult,stablecoinSwift:stablecoinSwiftResult,
  stagedKotlin,stagedSwift,creationKotlin,creationSwift,nftMintKotlin,nftMintSwift,ammCreationKotlin,ammCreationSwift,ammBusinessKotlin,ammBusinessSwift,
  custodyProvenance:{source:custodySource,sourceSha256:custodySourceSha256,
   swiftSource:swiftCustodySource,swiftSourceSha256:swiftCustodySourceSha256,
   adaptation:'P5 consent/binding/task checks adapted to required account/UI/digest callbacks; native account revision, targeted cancellation and result-only epoch permit; no test key/auto approval/fixed network/runtime diagnostics.'},
  compilerWarnings:[kotlinCompile.stderr,swiftCompile.stderr,swiftCustodyCompile.stderr].filter(Boolean),
  proof:['compiled actual candidate Swift and Kotlin permission owners',
   'typed-data has a separate grant; native consent shows the full canonical domain/type/message and independently recomputes the exact approved framed digest',
   'eight typed-data frozen vectors, twenty-six invalid requests, seven binding mutations and ordinary/typed grant isolation; no sign-only store writes or network queries',
   'controller identities originate from wallet-selected accounts with separate account and transaction grants; page role IDs never supply a key',
   'eight independent-controller plain/locked AMM vectors keep one consent and route each task to the exact account/public-key/digest recorded by the frozen oracle',
   'eight generic controller aliases and four native-consolidation dependent controllers retain one consent and exact account routing across stages',
   'connected account discovery and per-account metadata delivery use committed native grants; wrong keys, missing metadata grants and removed selections are denied',
   'controller removal, identity replacement during deferred key use, missing grants/resolution, changed intent, repeat resolution and stale delivery are denied',
   'same main/test origin/account/revoke/cancel/corruption vectors on both hosts',
   'no additional database load for repeated grant use',
   'macOS system SQLite reopen, CAS replay after revoke, rollback and profile/chain isolation',
   'Swift and Kotlin native consent/binding/one-use tasks and cancellation against the same recorded public signatures',
   'private native dispatcher, committed control replies and result-emission fences on both hosts',
   'native delivery refuses stale account/grant/document results and uncompleted signatures; lock hides public grants',
   'only other same-origin documents receive mutation notifications; current document receives its committed reply'],
  proofLimit:'Kotlin JVM and Swift desktop custody use memory stores and keyless recorded-signature adapters. Swift permissions additionally use desktop system SQLite. Neither is mobile UI, Vault, Flutter channel, Android SQLite or device acceptance.',
  newSignatures:0,broadcasts:0,acceptedDeliveryChanged:false};
 if(output)await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(report));
}catch(e){
 console.error(JSON.stringify({status:'FAIL',message:e.message,stdout:e.stdout?.slice(-4096),stderr:e.stderr?.slice(-6000)}));process.exitCode=1;
}finally{
 // Only this invocation's mkdtemp-owned compiler outputs; no checkout cleanup.
 await rm(scratch,{recursive:true,force:true});
}
