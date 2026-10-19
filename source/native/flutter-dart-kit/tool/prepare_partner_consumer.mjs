// Isolated no-account clean consumer. Partner source is compiled as a real
// external module, with no runtime import of this maintainer repository.
import assert from 'node:assert/strict';
import {access,readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const base=resolve(import.meta.dirname,'..');
const [sdkArg,packageArg,outArg]=process.argv.slice(2);assert(sdkArg&&packageArg&&outArg);
const sdk=resolve(sdkArg),pkg=resolve(packageArg),out=resolve(outArg);
assert.match(out,/^\/private\/tmp\/tbc-dart-partner-consumer-/);
try{await access(out);throw Error('Consumer exists');}catch(e){if(e.code!=='ENOENT')throw e;}
const run=(c,a,cwd=out)=>execFileSync(c,a,{cwd,stdio:'inherit',env:{...process.env,COCOAPODS_DISABLE_STATS:'true'}});
run(join(sdk,'bin/flutter'),['create','--no-pub','--platforms=ios,android','--org','io.tbc','--project-name','dartpartner',out],base);
await writeFile(join(out,'pubspec.yaml'),`name: dartpartner
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
    path: ${JSON.stringify(pkg)}
dev_dependencies:
  flutter_test:
    sdk: flutter
flutter:
  uses-material-design: true
`);
await cp(join(base,'acceptance/package/main.dart'),join(out,'lib/main.dart'));
await cp(join(pkg,'example/lib/partner_browser.dart'),join(out,'lib/partner_browser.dart'));
await cp(join(pkg,'example/ios/PartnerTbcIntegration.swift'),join(out,'ios/Runner/PartnerTbcIntegration.swift'));
await mkdir(join(out,'android/app/src/main/kotlin/example/tbc'),{recursive:true});
await cp(join(pkg,'example/android/PartnerTbcIntegration.kt'),join(out,'android/app/src/main/kotlin/example/tbc/PartnerTbcIntegration.kt'));
await writeFile(join(out,'android/app/build.gradle.kts'),`plugins {id("com.android.application");id("kotlin-android");id("dev.flutter.flutter-gradle-plugin")}
android {
 namespace="io.tbc.dartpartner"
 compileSdk=36
 ndkVersion="27.1.12297006"
 defaultConfig{applicationId="io.tbc.dartpartner.clean";minSdk=26;targetSdk=36;versionCode=1;versionName="clean-package";ndk{abiFilters+="arm64-v8a"}}
 compileOptions{sourceCompatibility=JavaVersion.VERSION_17;targetCompatibility=JavaVersion.VERSION_17}
 kotlinOptions{jvmTarget="17"}
 packaging{jniLibs{useLegacyPackaging=true;keepDebugSymbols+="**/libtbc*.so"}}
 buildTypes{getByName("release"){signingConfig=signingConfigs.getByName("debug")}}
}
flutter{source="../.."}
`);
run(join(sdk,'bin/flutter'),['pub','get','--offline']);
const pod=join(out,'ios/Podfile');let pods=await readFile(pod,'utf8');
pods=pods.replace("# platform :ios, '12.0'","platform :ios, '15.0'").replace("flutter_additional_ios_build_settings(target)","flutter_additional_ios_build_settings(target)\n    target.build_configurations.each { |c| c.build_settings['IPHONEOS_DEPLOYMENT_TARGET']='15.0' }");
await writeFile(pod,pods);
run('ruby',['-rxcodeproj','-e',`
p=Xcodeproj::Project.open('ios/Runner.xcodeproj');t=p.targets.find{|x|x.name=='Runner'};g=p.main_group.find_subpath('Runner')
t.source_build_phase.add_file_reference(g.new_file('PartnerTbcIntegration.swift'))
t.build_configurations.each{|c|c.build_settings['PRODUCT_BUNDLE_IDENTIFIER']='io.tbc.dartpartner.clean';c.build_settings['IPHONEOS_DEPLOYMENT_TARGET']='15.0';c.build_settings['ARCHS']='arm64'}
p.save
`]);
run('pod',['install','--no-repo-update'],join(out,'ios'));
run('ruby',[join(pkg,'tool/install_ios.rb'),join(out,'ios/Runner.xcodeproj')]);
await writeFile(join(out,'clean-consumer.json'),JSON.stringify({status:'PREPARED_NOT_BUILT',package:pkg,publicFixtureOnly:false,hasAccount:false,broadcasts:0,scope:'External package link and safe unconfigured startup only'}));
console.log(JSON.stringify({status:'PREPARED_NOT_BUILT',out}));
