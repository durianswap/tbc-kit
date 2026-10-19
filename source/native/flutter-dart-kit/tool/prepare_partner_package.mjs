// Maintainer build: immutable, allowlisted local distribution. No consumer App,
// private files, fixture accounts, automatic approval or network submission.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,readdir,access} from 'node:fs/promises';
import {resolve,join,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {buildReviewedAndroid,stageReviewedIos} from './reviewed_bridge_build.mjs';
import {verifiedDartNativeCandidate,pairedNativeSource} from '../../contract173-upgrade/dart-native-candidate.mjs';
import {legacyPage} from './legacy_consumer.mjs';
const base=resolve(import.meta.dirname,'..');
const [output,nativeArg,pageArg,versionArg,kitArg]=process.argv.slice(2);
const packageVersion=versionArg??'0.0.0-partner.20261014.3';
assert.match(packageVersion,/^0\.0\.0-partner\.\d{8}\.\d+$/);
assert(output&&nativeArg&&pageArg,'NEW_OUTPUT PAIRED_NATIVE PAGE');
const out=resolve(output),native=resolve(nativeArg),pageDir=resolve(pageArg);
assert(out!==base&&!base.startsWith(out+'/'));
try{await access(out);throw Error('Package output exists; use a new candidate');}catch(e){if(e.code!=='ENOENT')throw e;}
const paired=await verifiedDartNativeCandidate(native),page=await legacyPage(pageDir,base,paired,kitArg);
const sha=b=>createHash('sha256').update(b).digest('hex'),sources={};
async function save(p,bytes){await mkdir(dirname(join(out,p)),{recursive:true});await writeFile(join(out,p),bytes,{flag:'wx'});}
async function source(p,dest=p,transform=b=>b){const b=await readFile(join(base,p));sources[p]=sha(b);await save(dest,transform(b));}
async function files(root){const result=[];for(const item of await readdir(root,{withFileTypes:true})){assert(!item.isSymbolicLink(),'No source symlinks');const p=join(root,item.name);if(item.isDirectory())result.push(...await files(p));else result.push(p);}return result.sort();}
for(const p of await files(join(base,'lib')))await source(relative(base,p));
for(const p of await files(join(base,'platform/ios/Classes'))){
 if(!p.endsWith('.swift'))continue;
 await source(relative(base,p),'ios/Classes/'+p.split('/').at(-1),b=>{
  let s=pairedNativeSource(p.split('/').at(-1),b,paired).toString();
  if(p.endsWith('NativeReviewedRust.swift')){assert.equal(s.split('import TbcReviewedCompute').length,2);s=s.replace('import TbcReviewedCompute','// C ABI is exported by this plugin module.');}
  return s;
 });
}
for(const p of await files(join(base,'platform/android/src/main/kotlin')))await source(relative(base,p),relative(join(base,'platform'),p),b=>pairedNativeSource(p.split('/').at(-1),b,paired));
await source('distribution/ios/TbcPartnerWalletHost.swift','ios/Classes/TbcPartnerWalletHost.swift');
// Flutter discovers the entry by exact class filename before compiling Kotlin.
await source('distribution/android/TbcPartnerWalletHost.kt','android/src/main/kotlin/io/tbc/kit/dart/TbcDartKitPlugin.kt');
for(const file of ['install_ios.rb','pin_embedded_engine.rb'])await source('distribution/tool/'+file,'tool/'+file);
await source('distribution/README.md','README.md');
await source('distribution/NOTICE.md','NOTICE.md');
await save('LICENSE',await readFile(resolve(base,'../../LICENSE')));
for(const p of await files(join(base,'distribution/example')))await source(relative(base,p),relative(join(base,'distribution'),p));
await source('platform/android/consumer-rules.pro','android/consumer-rules.pro');
await source('pubspec.yaml','pubspec.yaml',b=>b.toString().replace('0.0.0-dev.20261012.1',packageVersion)+`\nflutter:\n  plugin:\n    platforms:\n      android:\n        package: io.tbc.kit.dart\n        pluginClass: TbcDartKitPlugin\n      ios:\n        pluginClass: TbcDartKitPlugin\n`);
for(const [p,hash] of Object.entries(paired.artifacts)){
 if(!p.startsWith('ios/Frameworks/')&&!p.startsWith('android/src/main/jniLibs/'))continue;
 const b=await readFile(join(native,p));assert.equal(sha(b),hash);await save(p,b);
}
const reviewedAndroid=await buildReviewedAndroid(join(out,'android/src/main/jniLibs/arm64-v8a/libtbc_dart_reviewed.so'),process.env.ANDROID_HOME,native);
await stageReviewedIos(join(out,'ios/Reviewed'),native);
// Include the build tag explicitly; consumers need no maintainer header paths.
const cpp=join(out,'ios/Reviewed/reviewed_compute.cpp');
await writeFile(cpp,'#include "reviewed_build.h"\n'+await readFile(cpp,'utf8'));
await save('android/src/main/assets/tbc-kit/tbc-webview-page.js',page.bytes);
await save('ios/Resources/tbc-webview-page.js',page.bytes);
const manifest={schema:1,kind:'dart-partner-package',status:'BUILD_INPUT_NOT_ACCEPTED',kitIdentity:paired.kitIdentity,
 ...(paired.postprocessing?{nativePostprocessing:paired.postprocessing}:{}),
 artifactId:paired.artifactId,pageSha256:page.manifest.sha256,androidEngineSha256:paired.artifacts['android/src/main/jniLibs/arm64-v8a/libtbc_compute_native.so'],
 nativeArtifacts:Object.fromEntries(Object.entries(paired.artifacts).filter(([p])=>p.startsWith('ios/Frameworks/')||p.startsWith('android/src/main/jniLibs/'))),sourceHashes:sources,reviewedAndroid,platforms:{android:{minimumApi:26,abis:['arm64-v8a']},ios:{deploymentTarget:'15.0',architectures:['arm64','arm64-simulator']}},
 defaults:{fixtureKeys:false,automaticApproval:false,cleartextTraffic:false,legacy:true},
 exclusions:['old asset creation','multisig','stablecoin admin','BTC/EVM'],published:false};
for(const p of ['distribution.json','android/src/main/assets/tbc-kit/distribution.json','ios/Resources/distribution.json'])await save(p,JSON.stringify(manifest,null,2)+'\n');
await save('android/src/main/AndroidManifest.xml','<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET"/></manifest>\n');
await save('android/build.gradle',`group 'io.tbc.kit.dart'
version '${packageVersion}'
buildscript {
 repositories { google(); mavenCentral() }
 dependencies { classpath 'com.android.tools.build:gradle:8.7.0'; classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:1.8.22' }
}
apply plugin: 'com.android.library'
apply plugin: 'kotlin-android'
android {
 namespace 'io.tbc.kit.dart'
 compileSdk 36
 defaultConfig { minSdk 26; consumerProguardFiles 'consumer-rules.pro'; ndk { abiFilters 'arm64-v8a' } }
 compileOptions { sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }
 kotlinOptions { jvmTarget = '17' }
 packagingOptions { doNotStrip '**/libtbc*.so' }
}
repositories { google(); mavenCentral() }
// The host template's WebView client types need this on the consumer classpath.
dependencies { api 'androidx.webkit:webkit:1.12.1' }
`);
await save('ios/tbc_kit_flutter_dart.podspec',`Pod::Spec.new do |s|
 s.name='tbc_kit_flutter_dart'
 s.version='0.0.1'
 s.summary='TBC Dart orchestration and paired native custody integration'
 s.homepage='https://turingbitchain.io'
 s.license={:type=>'CC0-1.0',:file=>'../LICENSE'}
 s.author='TBC'
 s.source={:path=>'.'}
 s.platform=:ios,'15.0'
 s.dependency 'Flutter'
 s.swift_version='5.0'
 s.static_framework=true
 s.source_files='Classes/**/*.swift','Reviewed/*.{cpp,h}'
 s.public_header_files='Reviewed/reviewed_compute.h'
 s.resource_bundles={'TbcDartKit'=>['Resources/*']}
 s.vendored_frameworks='Frameworks/TbcFlutterEngine.xcframework','Frameworks/TbcFlutterSigner.xcframework'
 s.libraries='sqlite3'
 s.pod_target_xcconfig={'DEFINES_MODULE'=>'YES','CLANG_CXX_LANGUAGE_STANDARD'=>'c++17','OTHER_CPLUSPLUSFLAGS'=>'$(inherited) -fno-exceptions -fno-rtti','EXCLUDED_ARCHS[sdk=iphonesimulator*]'=>'i386 x86_64'}
end
`);
const inventory={};let bytes=0;
for(const p of await files(out)){const b=await readFile(p);inventory[relative(out,p)]=sha(b);bytes+=b.length;}
await save('package-files.json',JSON.stringify({schema:1,status:'BUILD_INPUT_NOT_ACCEPTED',bytes,files:inventory},null,2)+'\n');
console.log(JSON.stringify({status:'PARTNER_PACKAGE_STAGED_NOT_ACCEPTED',out,files:Object.keys(inventory).length,bytes,kitIdentity:paired.kitIdentity}));
