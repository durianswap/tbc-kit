// Creates a new independent public-fixture consumer, never updates an existing
// project. This acceptance-only generator is not part of runtime distribution.
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,cp,readdir,access} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {buildReviewedAndroid,stageReviewedIos} from './reviewed_bridge_build.mjs';
import {sendConsumerSource} from './send_consumer_wire.mjs';
import {verifiedDartNativeCandidate,pairedNativeSource} from '../../contract173-upgrade/dart-native-candidate.mjs';
import {legacyPage,legacyConsumerSource} from './legacy_consumer.mjs';
const base=resolve(import.meta.dirname,'..'),sdk=resolve(process.argv[2]),out=resolve(process.argv[3]);
const platform=process.argv[4]??'ios';assert(['ios','android'].includes(platform));
const fixtureProfile=process.argv[5]??'all';assert(['all','pool2','pool2-maintenance','unified-pool','native-locks','token-htlc','lop','pool-dependent','pool-controller','typed-data','prepared','reviewed','workflow','crypto','send','contract173','network','legacy','legacy-maintenance','legacy-edges','legacy-maintenance-rounds'].includes(fixtureProfile));
const paired=['contract173','network','legacy','legacy-maintenance','legacy-edges','legacy-maintenance-rounds'].includes(fixtureProfile)?resolve(process.argv[6]):undefined;
const networkProfile=fixtureProfile==='network',legacyProfile=fixtureProfile.startsWith('legacy'),bundleId=legacyProfile?'io.tbc.dartkit.legacy':networkProfile?'io.tbc.dartkit.network':'io.tbc.dartkit.f1';
const mainSource=legacyProfile?'acceptance/legacy/main.dart':networkProfile?'acceptance/network/main.dart':'acceptance/lib/main.dart';
const pageSource=legacyProfile?'acceptance/legacy/dapp.html':networkProfile?'acceptance/network/dapp.html':'acceptance/dapp.html';
const pairedManifest=paired?await verifiedDartNativeCandidate(paired):undefined;
assert(/^\/private\/tmp\/tbc-dart-kit-f[123]-/.test(out));
try{await access(out);throw Error('Output already exists; use a new consumer directory');}catch(e){if(e.code!=='ENOENT')throw e;}
const frozen=paired??resolve(base,'../../release/flutter-native-bridge-20261012-b/tbc_kit_flutter');
const sha=b=>createHash('sha256').update(b).digest('hex');
const newPage=legacyProfile?await legacyPage(resolve(process.argv[7]),base,pairedManifest):undefined;
const page=newPage?.bytes??await readFile(join(frozen,'android/src/main/assets/tbc-kit/tbc-webview-page.js'));
assert.equal(sha(page),newPage?.manifest.sha256??pairedManifest?.artifacts['android/src/main/assets/tbc-kit/tbc-webview-page.js']??'9efa0a281e4de99f455fd2983e90db38836e8e9217e1dcf8aaee6c8a1d8f6a72');
function consumerSource(file,bytes){const value=pairedNativeSource(file,sendConsumerSource(file,bytes,fixtureProfile),pairedManifest);return legacyProfile?legacyConsumerSource(file,value,pairedManifest,newPage.manifest,['legacy-maintenance','legacy-edges','legacy-maintenance-rounds'].includes(fixtureProfile)):value;}
const run=(c,args,cwd=out)=>execFileSync(c,args,{cwd,stdio:'inherit',env:{...process.env,COCOAPODS_DISABLE_STATS:'true'}});
run(join(sdk,'bin/flutter'),['create','--no-pub',`--platforms=${platform}`,'--org','io.tbc','--project-name','dartkitf1',out],base);
await mkdir(join(out,'assets'),{recursive:true});
const selectedCases=fixtureProfile==='workflow'?['android-tbc_signMessage','android-tbc_signTransaction','transfer-single',...JSON.parse(await readFile(join(base,'test/fixtures/workflow-device.json'))).cases.map(s=>s.name)]:fixtureProfile==='reviewed'?['android-tbc_signMessage','android-tbc_signTransaction','transfer-single','prepared-transfer-single',...JSON.parse(await readFile(join(base,'test/fixtures/reviewed-signing.json'))).cases.map(s=>'reviewed-'+s.name)]:fixtureProfile==='prepared'?["android-tbc_signMessage","android-tbc_signTransaction","transfer-single","prepared-transfer-single","prepared-current-transfer-multiple-inputs","prepared-current-ft-staged-transfer","prepared-create-tbc20-fragmented","prepared-amm-holder-fragmented-sell","prepared-amm-controller-plain-add"]:fixtureProfile==='typed-data'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...JSON.parse(await readFile(join(base,'test/fixtures/typed-device-signing.json'))).cases.map(s=>s.name),
]:fixtureProfile==='pool-controller'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...(await Promise.all(['amm-controller-signing.json','amm-controller-extended.json'].map(async file=>JSON.parse(await readFile(join(base,'test/fixtures',file))).cases.map(s=>s.name)))).flat(),
]:fixtureProfile==='pool-dependent'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...JSON.parse(await readFile(join(base,'test/fixtures/amm-dependent-signing.json'))).cases.map(s=>s.name),
]:fixtureProfile==='lop'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...JSON.parse(await readFile(join(base,'test/fixtures/lop-signing.json'))).cases.filter(s=>s.minConfirmations==='0').map(s=>s.name),
]:fixtureProfile==='token-htlc'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...JSON.parse(await readFile(join(base,'test/fixtures/htlc-token-signing.json'))).cases.filter(s=>s.minConfirmations==='0').map(s=>s.name),
]:fixtureProfile==='native-locks'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...(await Promise.all(['timelock-signing.json','htlc-native-signing.json'].map(async file=>JSON.parse(await readFile(join(base,'test/fixtures',file))).cases.filter(s=>s.minConfirmations==='0').map(s=>s.name)))).flat(),
]:fixtureProfile==='unified-pool'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...JSON.parse(await readFile(join(base,'test/fixtures/unified-pool-signing.json'))).cases.filter(s=>s.minConfirmations==='0').map(s=>s.name),
]:fixtureProfile.startsWith('pool2')?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...JSON.parse(await readFile(join(base,'test/fixtures/pool2-signing.json'))).cases.map(s=>s.name),
 ...(fixtureProfile==='pool2-maintenance'?JSON.parse(await readFile(join(base,'test/fixtures/pool2-maintenance.json'))).cases.map(s=>s.name):[]),
]:null;
const cryptoSelection=fixtureProfile==='crypto'?['android-tbc_signMessage','android-tbc_signTransaction','transfer-single',...JSON.parse(await readFile(join(base,'test/fixtures/crypto-device.json'))).cases.map(s=>s.name)]:null;
const sendSelection=fixtureProfile==='send'?['android-tbc_signMessage','android-tbc_signTransaction','transfer-single',...JSON.parse(await readFile(join(base,'test/fixtures/send-device.json'))).cases.map(s=>s.name)]:null;
let contract173Selection;
if(paired){
 const all=[];for(const f of ['high-level173.json','high-level173-extra.json']){
  const input=JSON.parse(await readFile(resolve(base,'../contract173-upgrade',f)));
  for(const s of input.cases)all.push({...s,additionalAccounts:s.signingAccounts});
 }
 contract173Selection=['android-tbc_signMessage','transfer-single',...all.map(s=>s.name)];
 await writeFile(join(out,'assets/contract173.json'),JSON.stringify({cases:all,kitIdentity:pairedManifest.kitIdentity,scope:'Public fixtures only; no broadcast'}));
}
await writeFile(join(out,'assets/acceptance-profile.json'),JSON.stringify({name:fixtureProfile,selectedCases:contract173Selection??sendSelection??cryptoSelection??selectedCases}));
await writeFile(join(out,'pubspec.yaml'),`name: dartkitf1
description: Isolated candidate public-fixture acceptance, not partner runtime.
publish_to: none
version: 0.0.1+1
environment:
  sdk: '>=3.7.2 <4.0.0'
dependencies:
  flutter:
    sdk: flutter
  crypto: 3.0.7
  flutter_inappwebview: 6.1.5
  tbc_kit_flutter_dart:
    path: ${JSON.stringify(base)}
dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: 5.0.0
flutter:
  uses-material-design: true
  assets:
    - assets/
`);
await cp(join(base,mainSource),join(out,'lib/main.dart'));
if(legacyProfile)for(const file of ['legacy_edges.dart','maintenance_rounds.dart'])await cp(join(base,'acceptance/legacy',file),join(out,'lib',file));
for(const file of ['material.json','replay.json'])await cp(join(base,'test/fixtures/signing',file),join(out,'assets',file));
for(const file of ['native-transfers.json','native-signing.json','fungible-signing.json','nft-signing.json','stablecoin-signing.json','staged-signing.json','creation-signing.json','nft-mint-signing.json','amm-creation-signing.json','amm-business-signing.json','lp-signing.json','pool2-signing.json'])await cp(join(base,'test/fixtures',file),join(out,'assets',file));
await cp(join(base,pageSource),join(out,'assets/dapp.html'));
if(legacyProfile){await cp(join(base,'test/fixtures/legacy-message-signing.json'),join(out,'assets/legacy-message-signing.json'));await writeFile(join(out,'legacy-page-provenance.json'),JSON.stringify(newPage.manifest,null,2)+'\n');}
if(fixtureProfile==='workflow')await cp(join(base,'test/fixtures/workflow-device.json'),join(out,'assets/workflow-device.json'));
if(fixtureProfile==='crypto'||fixtureProfile==='legacy-edges')await cp(join(base,'test/fixtures/crypto-device.json'),join(out,'assets/crypto-device.json'));
if(fixtureProfile==='send')await cp(join(base,'test/fixtures/send-device.json'),join(out,'assets/send-device.json'));
await cp(join(base,'test/fixtures/pool2-maintenance.json'),join(out,'assets/pool2-maintenance.json'));
await cp(join(base,'test/fixtures/prepared-signing.json'),join(out,'assets/prepared-signing.json'));
for(const file of ['reviewed-signing.json','reviewed-material-b.json','reviewed-native-lock.json','reviewed-associated-contract.json'])await cp(join(base,'test/fixtures',file),join(out,'assets',file));
await cp(join(base,'test/fixtures/typed-device-signing.json'),join(out,'assets/typed-device-signing.json'));
await cp(join(base,'test/fixtures/unified-pool-signing.json'),join(out,'assets/unified-pool-signing.json'));
for(const file of ['timelock-signing.json','htlc-native-signing.json','htlc-token-signing.json','lop-signing.json','amm-dependent-signing.json','amm-controller-signing.json','amm-controller-extended.json'])await cp(join(base,'test/fixtures',file),join(out,'assets',file));
if(platform==='android'){
 const provenance={page:sha(page),native:{},candidate:{}};
 async function save(path,value){await mkdir(dirname(join(out,path)),{recursive:true});await writeFile(join(out,path),value);}
 for(const file of await readdir(join(base,'platform/android/src/main/kotlin/io/tbc/kit/dart'))){
  if(!file.endsWith('.kt'))continue;
  const content=await readFile(join(base,'platform/android/src/main/kotlin/io/tbc/kit/dart',file));
  const emitted=consumerSource(file,content);
  await save(`android/app/src/main/kotlin/io/tbc/kit/dart/${file}`,emitted);provenance.candidate[file]=sha(emitted);
 }
 for(const file of ['MainActivity.kt','FixtureWallet.kt']){
  const source=networkProfile&&file==='MainActivity.kt'?'acceptance/network/android':'acceptance/android';
  const emitted=consumerSource(file,await readFile(join(base,source,file)));
  await save(`android/app/src/main/kotlin/io/tbc/dartkitf1/${file}`,emitted);provenance.candidate[file]=sha(emitted);
 }
 if(fixtureProfile==='send')provenance.testOnlyWire={origin:'http://127.0.0.1:41878',sourceSha256:sha(await readFile(join(base,'tool/send_consumer_wire.mjs'))),note:'Only generated consumer host final HTTP destination is replaced; production configuration, journal, authority and result checks unchanged. Never sent to a public node.'};
 await save('android/app/src/main/assets/tbc-kit/tbc-webview-page.js',page);
 const jni=join(out,'android/app/src/main/jniLibs/arm64-v8a'),hashes={};await mkdir(jni,{recursive:true});
 const ndk=join(process.env.ANDROID_HOME,'ndk/27.1.12297006/toolchains/llvm/prebuilt/darwin-x86_64/bin');
 for(const [name,file]of [['engine','libtbc_compute_native.so'],['signer','libtbc_signer_kernel.so']]){
  const content=await readFile(join(frozen,'android/src/main/jniLibs/arm64-v8a',file));
  provenance.native[file]=sha(content);await writeFile(join(jni,file),content);
  run(join(ndk,'llvm-strip'),['--strip-unneeded',join(jni,file)]);
  hashes[name]=[...new Set([sha(content),sha(await readFile(join(jni,file)))])];
 }
 run(join(ndk,'aarch64-linux-android26-clang'),['-shared','-fPIC','-O2','-fvisibility=hidden','-Wl,-z,max-page-size=16384',join(base,'acceptance/android/fixture_signer.c'),'-L'+jni,'-ltbc_signer_kernel','-o',join(jni,'libtbc_f1_signer.so')]);
 provenance.fixtureCrypto={sourceSha256:sha(await readFile(join(base,'acceptance/android/fixture_signer.c'))),librarySha256:sha(await readFile(join(jni,'libtbc_f1_signer.so')))};
 provenance.reviewed=await buildReviewedAndroid(join(jni,'libtbc_dart_reviewed.so'),process.env.ANDROID_HOME,paired);
 if(pairedManifest)provenance.kitIdentity=pairedManifest.kitIdentity;
 await save('android/app/tbc-consumer-rules.pro',await readFile(join(base,'platform/android/consumer-rules.pro')));
 await save('assets/native-hashes.json',JSON.stringify(hashes));
 await save('android/app/build.gradle.kts',`plugins {id("com.android.application");id("kotlin-android");id("dev.flutter.flutter-gradle-plugin")}
android {
 namespace="io.tbc.dartkitf1"
 compileSdk=36
 ndkVersion="27.1.12297006"
 defaultConfig{applicationId="${bundleId}";minSdk=26;targetSdk=36;versionCode=1;versionName="f1-fixture";ndk{abiFilters+="arm64-v8a"}}
 compileOptions{sourceCompatibility=JavaVersion.VERSION_17;targetCompatibility=JavaVersion.VERSION_17}
 kotlinOptions{jvmTarget="17"}
 packaging{jniLibs{useLegacyPackaging=true}}
 buildTypes{getByName("release"){signingConfig=signingConfigs.getByName("debug");proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"),"tbc-consumer-rules.pro")}}
}
flutter{source="../.."}
dependencies{implementation("androidx.webkit:webkit:1.12.1")}
`);
 const manifest=join(out,'android/app/src/main/AndroidManifest.xml');
 await writeFile(manifest,(await readFile(manifest,'utf8')).replace('<application','<uses-permission android:name="android.permission.INTERNET"/>\n    <application android:usesCleartextTraffic="true"'));
 run(join(sdk,'bin/flutter'),['pub','get','--offline']);
 await save('consumer-provenance.json',JSON.stringify({status:'PREPARED_NOT_BUILT',recordedAt:new Date().toISOString(),base,frozen,platform,bundleId,publicFixtureOnly:true,broadcasts:0,proofLimit:'API36 consumer; not a minimum OS claim or production artifact',...provenance},null,2)+'\n');
 console.log(JSON.stringify({status:'PREPARED_NOT_BUILT',out,bundleId}));
 process.exit(0);
}
await mkdir(join(out,'native'),{recursive:true});
const provenance={page:sha(page),native:{},candidate:{}};
const engineHashes=[];
for(const name of ['TbcFlutterEngine','TbcFlutterSigner']){
 const source=join(frozen,'ios/Frameworks',name+'.xcframework');
 await cp(source,join(out,'native',name+'.xcframework'),{recursive:true});
 for(const arch of ['ios-arm64','ios-arm64-simulator']){
  const relative=`${name}.xcframework/${arch}/${name}.framework/${name}`;
  const original=sha(await readFile(join(frozen,'ios/Frameworks',relative)));
  assert.equal(sha(await readFile(join(out,'native',relative))),original);
  provenance.native[relative]=original;if(name==='TbcFlutterEngine')engineHashes.push(original);
 }
}
await writeFile(join(out,'assets/native-hashes.json'),JSON.stringify({engine:engineHashes}));
provenance.reviewed=await stageReviewedIos(join(out,'native/reviewed'),paired);
if(pairedManifest)provenance.kitIdentity=pairedManifest.kitIdentity;
await writeFile(join(out,'native/TbcF1Native.podspec'),`Pod::Spec.new do |s|
 s.name='TbcF1Native'
 s.version='0.0.1'
 s.summary='Frozen native artifacts for independent fixture acceptance'
 s.homepage='https://turingbitchain.io'
 s.license={:type=>'Proprietary'}
 s.author='TBC'
 s.source={:path=>'.'}
 s.platform=:ios,'15.0'
 s.vendored_frameworks='TbcFlutterEngine.xcframework','TbcFlutterSigner.xcframework'
 s.static_framework=true
 s.module_name='TbcReviewedCompute'
 s.source_files='reviewed/*.{cpp,h}'
 s.public_header_files='reviewed/reviewed_compute.h'
 s.pod_target_xcconfig={'CLANG_CXX_LANGUAGE_STANDARD'=>'c++17','OTHER_CPLUSPLUSFLAGS'=>'$(inherited) -fno-exceptions -fno-rtti -include "$(PODS_TARGET_SRCROOT)/reviewed/reviewed_build.h"'}
end
`);
for(const file of await readdir(join(base,'platform/ios/Classes'))){
 if(!file.endsWith('.swift'))continue;
 const content=await readFile(join(base,'platform/ios/Classes',file));
 const emitted=consumerSource(file,content);
 await writeFile(join(out,'ios/Runner',file),emitted);provenance.candidate[file]=sha(emitted);
}
for(const file of ['AppDelegate.swift','FixtureWallet.swift']){
 const source=networkProfile&&file==='AppDelegate.swift'?'acceptance/network/ios':'acceptance/ios';
 const emitted=consumerSource(file,await readFile(join(base,source,file)));
 await writeFile(join(out,'ios/Runner',file),emitted);provenance.candidate[file]=sha(emitted);
}
if(fixtureProfile==='send')provenance.testOnlyWire={origin:'http://127.0.0.1:41878',sourceSha256:sha(await readFile(join(base,'tool/send_consumer_wire.mjs'))),note:'Only generated consumer host final HTTP destination is replaced; production configuration, journal, authority and result checks unchanged. Never sent to a public node.'};
await writeFile(join(out,'ios/Runner/tbc-webview-page.js'),page);
await writeFile(join(out,'ios/Podfile'),`platform :ios, '15.0'
ENV['COCOAPODS_DISABLE_STATS']='true'
project 'Runner', {'Debug'=>:debug,'Profile'=>:release,'Release'=>:release}
def flutter_root
 File.foreach(File.expand_path(File.join('Flutter','Generated.xcconfig'),__dir__)) do |line|
  match=line.match(/FLUTTER_ROOT\\=(.*)/)
  return match[1].strip if match
 end
 raise 'Flutter SDK not found'
end
require File.expand_path(File.join('packages','flutter_tools','bin','podhelper'),flutter_root)
flutter_ios_podfile_setup
target 'Runner' do
 use_frameworks!
 pod 'TbcF1Native', :path=>'../native'
 flutter_install_all_ios_pods File.dirname(File.realpath(__FILE__))
 target 'RunnerTests' do
  inherit! :search_paths
 end
end
post_install do |installer|
 installer.pods_project.targets.each do |target|
  flutter_additional_ios_build_settings(target)
  target.build_configurations.each do |config|
   config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']='15.0'
  end
 end
end
`);
run('ruby',['-rxcodeproj','-e',`
p=Xcodeproj::Project.open('ios/Runner.xcodeproj');t=p.targets.find{|x|x.name=='Runner'};g=p.main_group.find_subpath('Runner')
Dir['ios/Runner/*.swift'].each do |path|
 name=File.basename(path);next if g.files.any?{|x|x.path==name}
 t.source_build_phase.add_file_reference(g.new_file(name))
end
t.resources_build_phase.add_file_reference(g.new_file('tbc-webview-page.js'))
t.build_configurations.each{|c|c.build_settings['PRODUCT_BUNDLE_IDENTIFIER']='${bundleId}';c.build_settings['IPHONEOS_DEPLOYMENT_TARGET']='15.0';c.build_settings['ARCHS[sdk=iphonesimulator*]']='arm64'}
p.save
info=Xcodeproj::Plist.read_from_path('ios/Runner/Info.plist');info['NSAppTransportSecurity']={'NSAllowsLocalNetworking'=>true,'NSAllowsArbitraryLoadsInWebContent'=>true};Xcodeproj::Plist.write_to_path(info,'ios/Runner/Info.plist')
`]);
run(join(sdk,'bin/flutter'),['pub','get','--offline']);
run('pod',['install','--no-repo-update'],join(out,'ios'));
await writeFile(join(out,'consumer-provenance.json'),JSON.stringify({status:'PREPARED_NOT_BUILT',recordedAt:new Date().toISOString(),base,frozen,platform,bundleId,publicFixtureOnly:true,broadcasts:0,...provenance},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'PREPARED_NOT_BUILT',out,bundleId}));
