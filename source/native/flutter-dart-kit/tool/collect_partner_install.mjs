// Installs only the dedicated no-account clean consumer. Never loads a wallet,
// signs, fetches chain data or submits. Collects fresh process/install evidence.
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const [consumerArg,packageArg,device,android,output,installMode]=process.argv.slice(2);
assert(consumerArg&&packageArg&&device&&android&&output);
assert(installMode===undefined||installMode==='--use-installed-android');
const consumer=resolve(consumerArg),pkg=resolve(packageArg),id='io.tbc.dartpartner.clean';
const adb=join(process.env.ANDROID_HOME,'platform-tools/adb');
const options={maxBuffer:64*1024*1024,timeout:45000};
const xcrun=args=>run('xcrun',['simctl',...args],options),adbRun=args=>run(adb,['-s',android,...args],options);
const manifest=JSON.parse(await readFile(join(pkg,'distribution.json')));
const apk=join(consumer,'build/app/outputs/apk/release/app-release.apk');
const app=join(consumer,'build/ios/Debug-iphonesimulator/Runner.app');
const androidBuildLog=await stat(join(consumer,'android-final-build.log')).then(()=> 'android-final-build.log').catch(()=> 'android-build.log');
assert.match(await readFile(join(consumer,androidBuildLog),'utf8'),/BUILD SUCCESSFUL/);
assert.equal((await run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',join(app,'Info.plist')],options)).stdout.trim(),id);
await run('codesign',['--verify','--deep','--strict',app],options);
const installedAfter=Date.now();
await xcrun(['terminate',device,id]).catch(()=>{});
await xcrun(['install',device,app]);const launched=await xcrun(['launch',device,id]);
console.log('iOS clean package installed and launched');
await adbRun(['shell','am','force-stop',id]);
if(installMode!=='--use-installed-android')await adbRun(['install','-r','-f',apk]);
await adbRun(['shell','am','start','-n',id+'/io.tbc.dartpartner.MainActivity']);
console.log('Android clean package installed and launched');
const container=(await xcrun(['get_app_container',device,id,'data'])).stdout.trim();
const iosReport=join(container,'tmp/package-install.json');
let ios,androidReport,androidPid,androidUi;
for(let attempt=0;attempt<30;attempt++){
 if(!ios)try{const s=await stat(iosReport);if(s.mtimeMs>=installedAfter)ios=JSON.parse(await readFile(iosReport));}catch{}
 if(!androidReport){
  androidPid=(await adbRun(['shell','pidof',id])).stdout.trim();
  if(/^\d+$/.test(androidPid)){
   const log=(await adbRun(['logcat','-d','--pid='+androidPid,'-s','flutter:I','*:S'])).stdout;
   const matches=[...log.matchAll(/TBC_PACKAGE_CHECK:(\{[^\n]+\})/g)];
   if(matches.length)androidReport=JSON.parse(matches.at(-1)[1]);
   // Release stdout is not reliably forwarded by Flutter. Read the installed
   // check's final status, without adding a debug channel to the shipped plugin.
   if(!androidReport){
    await adbRun(['shell','uiautomator','dump','/sdcard/tbc-package-install.xml']);
    const xml=(await adbRun(['shell','cat','/sdcard/tbc-package-install.xml'])).stdout;
    if(xml.includes('package="'+id+'"')&&xml.includes('content-desc="CLEAN_INSTALL_PASS"')){
     androidUi=xml;
     androidReport={status:'CLEAN_INSTALL_PASS',evidence:'fresh process UI status; see hashed acceptance source for checks, not a JSON report'};
    }
   }
  }
 }
 if(ios&&androidReport)break;
 await new Promise(r=>setTimeout(r,1000));
}
for(const [platform,value] of [['ios',ios],['android',androidReport]]){
 assert(value,platform+' fresh report missing');assert.equal(value.status,'CLEAN_INSTALL_PASS',platform);
 if(platform==='android'&&androidUi)continue;
 assert.equal(value.symbols,4);assert.equal(value.unconfiguredWalletDenied,true);assert.equal(value.packageSignerDenied,true);
 for(const k of ['broadcasts','signatures','approvals'])assert.equal(value[k],0);
}
const pins=JSON.parse(await readFile(join(app,'tbc-dart-native-pins.json')));
assert.equal(ios.engineSha256,pins.engineSha256);assert.equal(pins.artifactId,manifest.artifactId);
if(!androidUi)assert.equal(androidReport.engineSha256,manifest.androidEngineSha256);
const engine=await run('unzip',['-p',apk,'lib/arm64-v8a/libtbc_compute_native.so'],{...options,encoding:'buffer'});
assert.equal(sha(engine.stdout),manifest.androidEngineSha256);
const remote=(await adbRun(['shell','pm','path',id])).stdout.trim().replace(/^package:/,'');
assert.match(remote,/^\/data\/app\/[^\n]+\/base.apk$/);
const installed=await run(adb,['-s',android,'exec-out','cat',remote],{...options,encoding:'buffer'});
assert.equal(sha(installed.stdout),sha(await readFile(apk)),'Installed Android APK differs');
const flutterConfigs=JSON.parse(await readFile(join(consumer,'.dart_tool/package_config.json')));
const dependency=flutterConfigs.packages.find(p=>p.name==='tbc_kit_flutter_dart');assert(dependency);
assert.equal(decodeURIComponent(new URL(dependency.rootUri,new URL('file://'+join(consumer,'.dart_tool/package_config.json'))).pathname).replace(/\/$/,''),pkg);
const report={status:'PARTNER_PACKAGE_PAIRED_CLEAN_INSTALL_PASS',recordedAt:new Date().toISOString(),
 packageVersion:(await readFile(join(pkg,'pubspec.yaml'),'utf8')).match(/^version:\s*(\S+)/m)[1],kitIdentity:manifest.kitIdentity,nativeArtifactId:manifest.artifactId,
 packageManifestSha256:sha(await readFile(join(pkg,'distribution.json'))),consumer,
 ios:{device,process:launched.stdout.trim(),report:ios,build:'Debug simulator',appExecutableSha256:sha(await readFile(join(app,'Runner.debug.dylib'))),pins},
 android:{device:android,process:androidPid,report:androidReport,ui:androidUi,build:'Release arm64',installation:installMode??'install-and-check',apkSha256:sha(await readFile(apk)),apkBytes:(await stat(apk)).size,apkEngineSha256:sha(engine.stdout)},
 source:{mainSha256:sha(await readFile(join(consumer,'lib/main.dart'))),swiftTemplateSha256:sha(await readFile(join(consumer,'ios/Runner/PartnerTbcIntegration.swift'))),kotlinTemplateSha256:sha(await readFile(join(consumer,'android/app/src/main/kotlin/example/tbc/PartnerTbcIntegration.kt')))},
 scope:'External package compilation including both native integration templates; fresh installed native ABI, full-file pins and unconfigured-wallet denial. No new transaction/business/chain/minimum-OS/partner-Vault/performance acceptance.',
 warnings:'Upstream Flutter/WebView/Xcode/Gradle warnings retained in build logs; not a warning-free claim.',published:false,goalComplete:false};
await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,androidApkBytes:report.android.apkBytes,ios:ios.status,android:androidReport.status,transactions:0}));
