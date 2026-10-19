// Maintainer-only private Testnet consumer. Never a partner release/default.
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pairedNativeSource,verifiedDartNativeCandidate} from './dart-native-candidate.mjs';
import {sha256} from '../flutter/scripts/candidate-inputs.mjs';
const root=resolve(import.meta.dirname,'../..'),base=join(root,'native/flutter-dart-kit');
const [sdkArg,outArg,candidateArg,planArg]=process.argv.slice(2);
assert(planArg);const sdk=resolve(sdkArg),out=resolve(outArg),candidate=resolve(candidateArg);
assert.match(out,/^\/private\/tmp\/tbc-dart-kit-f3-contract173-android-live-[a-z]+$/);
const manifest=await verifiedDartNativeCandidate(candidate);
const account=JSON.parse(await readFile(join(root,'native/flutter-dart-live-token-exploration/evidence/private-accounts-20261012-a/accounts.json'))).accounts.android;
const plan=JSON.parse(await readFile(resolve(planArg))),runId=plan.id;
assert.match(runId,/^contract173-android-[a-z0-9-]{1,80}$/);
assert.equal(plan.method,'tbc_sendTransaction');assert.equal(plan.request.chainId,'tbc:testnet');assert.equal(plan.request.from,account.address);
assert(['tbc.transfer','tbc20.transfer','tbc-amm-add-liquidity','tbc-amm-swap','tbc-amm-remove-liquidity'].includes(plan.request.intent.type));
assert(BigInt(plan.request.constraints.maxFee)<=100000n);
execFileSync(process.execPath,[join(base,'tool/prepare_consumer.mjs'),sdk,out,'android','contract173',candidate],{cwd:root,stdio:'inherit'});
for(const file of await readdir(join(out,'assets')))if(file!=='native-hashes.json')await unlink(join(out,'assets',file));
await unlink(join(out,'android/app/src/main/kotlin/io/tbc/dartkitf1/FixtureWallet.kt'));
await unlink(join(out,'android/app/src/main/jniLibs/arm64-v8a/libtbc_f1_signer.so'));
const sourceHashes={};
for(const file of ['main.dart','MainActivity.kt','PrivateTestnetWallet.kt']){
 const input=await readFile(join(import.meta.dirname,'live',file));sourceHashes[file]=sha256(input);
 await writeFile(join(out,file==='main.dart'?'lib/main.dart':'android/app/src/main/kotlin/io/tbc/dartkitf1/'+file),pairedNativeSource(file,input,manifest));
}
const page=(await readFile(join(base,'acceptance/dapp.html'),'utf8')).replaceAll('io.tbc.dartkit.f1','io.tbc.dartkit.contract173').replace('Public-fixture verification · NO broadcast','Private Testnet acceptance · one-shot broadcast');
await writeFile(join(out,'assets/dapp.html'),page);await writeFile(join(out,'assets/live-plan.json'),JSON.stringify(plan));
await writeFile(join(out,'android/app/src/main/assets/native-account.json'),JSON.stringify(account));
const gradle=join(out,'android/app/build.gradle.kts');
await writeFile(gradle,(await readFile(gradle,'utf8')).replace('applicationId="io.tbc.dartkit.f1"','applicationId="io.tbc.dartkit.contract173"').replace('versionName="f1-fixture"','versionName="contract173-private-testnet"'));
// JNI method names are preserved without changing production keep rules.
const rules=join(out,'android/app/tbc-consumer-rules.pro');
await writeFile(rules,(await readFile(rules,'utf8'))+'\n-keep class io.tbc.dartkitf1.PrivateTestnetWallet { native <methods>; }\n');
const ndk=join(process.env.ANDROID_HOME,'ndk/27.1.12297006/toolchains/llvm/prebuilt/darwin-x86_64/bin');
const jni=join(out,'android/app/src/main/jniLibs/arm64-v8a'),signer=join(import.meta.dirname,'live/private_testnet_signer.c');
execFileSync(join(ndk,'aarch64-linux-android26-clang'),['-shared','-fPIC','-O2','-fvisibility=hidden','-Wl,-z,max-page-size=16384',signer,'-L'+jni,'-ltbc_signer_kernel','-o',join(jni,'libtbc_contract173_signer.so')],{stdio:'inherit'});
sourceHashes['private_testnet_signer.c']=sha256(await readFile(signer));
const provenance=JSON.parse(await readFile(join(out,'consumer-provenance.json')));
delete provenance.fixtureCrypto;delete provenance.candidate['FixtureWallet.kt'];
for(const file of ['MainActivity.kt','PrivateTestnetWallet.kt'])provenance.candidate[file]=sha256(await readFile(join(out,'android/app/src/main/kotlin/io/tbc/dartkitf1',file)));
provenance.publicFixtureOnly=false;provenance.privateTestnetOnly=true;provenance.bundleId='io.tbc.dartkit.contract173';
provenance.liveHarness={sourceHashes,planSha256:sha256(JSON.stringify(plan)),runId,endpoint:'https://devapi.tbcdev.org',
 signerAdapterSha256:sha256(await readFile(join(jni,'libtbc_contract173_signer.so'))),
 scope:'Native account/approval/signer adapter only. Production Dart/Kotlin host, default HTTPS reads and native broadcast unchanged.'};
await writeFile(join(out,'consumer-provenance.json'),JSON.stringify(provenance,null,2)+'\n');
console.log(JSON.stringify({status:'PRIVATE_TESTNET_CONSUMER_PREPARED',out,runId,account:account.address,kitIdentity:manifest.kitIdentity}));
