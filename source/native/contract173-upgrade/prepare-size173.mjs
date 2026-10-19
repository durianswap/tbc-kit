// Maintainer-only no-Kit control. Never modifies the installed/frozen consumer.
import assert from 'node:assert/strict';
import {access,readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const [sdkArg,outArg,androidArg,iosArg]=process.argv.slice(2);
assert(sdkArg&&outArg&&androidArg&&iosArg);
const sdk=resolve(sdkArg),out=resolve(outArg),android=resolve(androidArg),ios=resolve(iosArg);
assert.match(out,/^\/private\/tmp\/tbc-contract173-size-baseline-[a-z]+$/);
try{await access(out);throw Error('Use a new baseline directory');}catch(e){if(e.code!=='ENOENT')throw e;}
const run=(cmd,args,cwd=out)=>execFileSync(cmd,args,{cwd,stdio:'inherit',env:{...process.env,COCOAPODS_DISABLE_STATS:'true'}});
run(join(sdk,'bin/flutter'),['create','--no-pub','--platforms=android,ios','--org','io.tbc','--project-name','dartkitf1',out],resolve(import.meta.dirname));
await writeFile(join(out,'pubspec.yaml'),`name: dartkitf1
description: No-Kit WebView control for paired Release size measurement.
publish_to: none
version: 0.0.1+1
environment:
  sdk: '>=3.7.2 <4.0.0'
dependencies:
  flutter:
    sdk: flutter
  flutter_inappwebview: 6.1.5
dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: 5.0.0
flutter:
  uses-material-design: true
`);
await writeFile(join(out,'lib/main.dart'),`import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
void main()=>runApp(MaterialApp(home:Scaffold(appBar:AppBar(title:const Text('WebView shell')),
 body:InAppWebView(initialData:InAppWebViewInitialData(data:'<html><body>Release size control</body></html>'),
 initialSettings:InAppWebViewSettings(javaScriptEnabled:true)))));
`);
// Same Android compiler/R8/ABI/WebView dependency settings as the accepted App.
for(const file of ['build.gradle.kts','tbc-consumer-rules.pro'])await copyFile(join(android,'android/app',file),join(out,'android/app',file));
const manifest=join(out,'android/app/src/main/AndroidManifest.xml');
await writeFile(manifest,(await readFile(manifest,'utf8')).replace('<application','<uses-permission android:name="android.permission.INTERNET"/>\n    <application'));
// Preserve deployment target and framework linkage choices, omit all TBC code.
const podfile=(await readFile(join(ios,'ios/Podfile'),'utf8')).replace(/^.*pod 'TbcF1Native'.*\n/m,'');
assert(!podfile.includes('TbcF1Native'));
await writeFile(join(out,'ios/Podfile'),podfile);
run('ruby',['-rxcodeproj','-e',`p=Xcodeproj::Project.open('ios/Runner.xcodeproj');t=p.targets.find{|x|x.name=='Runner'};t.build_configurations.each{|c|c.build_settings['PRODUCT_BUNDLE_IDENTIFIER']='io.tbc.dartkit.f1';c.build_settings['IPHONEOS_DEPLOYMENT_TARGET']='15.0'};p.save`]);
run(join(sdk,'bin/flutter'),['pub','get','--offline']);
run('pod',['install','--no-repo-update'],join(out,'ios'));
const hash=p=>readFile(p).then(b=>createHash('sha256').update(b).digest('hex'));
await writeFile(join(out,'size-provenance.json'),JSON.stringify({status:'BASELINE_PREPARED',sdk,androidConsumer:android,iosConsumer:ios,
 baseline:'Flutter + flutter_inappwebview6.1.5; no Kit dependency, Engine, Signer, TBC host or page runtime',
 mainSha256:await hash(join(out,'lib/main.dart')),androidGradleSha256:await hash(join(out,'android/app/build.gradle.kts')),
 caveat:'Full consumer includes maintainer live-acceptance glue. Delta estimates current all-capability runtime cost, not exact partner/App Store download size.'},null,2)+'\n');
console.log(JSON.stringify({status:'NO_KIT_BASELINE_PREPARED',out}));
