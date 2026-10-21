// Independent public-fixture apps; never replaces a partner or funded wallet.
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
const run=promisify(execFile),root=resolve(process.argv[2]),variant=process.argv[3]??'candidate';
if(!['candidate','baseline'].includes(variant))throw Error('Bad variant');
const t=JSON.parse(await readFile(join(root,'toolchain.json'))),out=join(root,variant),baseline=variant==='baseline';
const packaged=process.argv[4]?resolve(process.argv[4]):null;
if(packaged&&baseline)throw Error('Package input is for candidate verification only');
await mkdir(out,{recursive:true});
const opts={maxBuffer:2e6,timeout:180000},text=async(cmd,args)=>(await run(cmd,args,opts)).stdout.trim();
async function source(path){
 if(packaged&&path.startsWith('platform/'))return readFile(join(packaged,path.slice('platform/'.length)),'utf8');
 return baseline?text('git',['-C',t.repo,'show',`HEAD:source/native/flutter-dart-kit/${path}`]):readFile(join(t.base,path),'utf8');
}
const swift=[],kotlin=[];const hashes={};
for(const name of t.names)for(const [lang,dir,list]of [['swift','platform/ios/Classes',swift],['kt','platform/android/src/main/kotlin/io/tbc/kit/dart',kotlin]]){
 const contents=await source(`${dir}/${name}.${lang}`),p=join(out,`${name}.${lang}`);await writeFile(p,contents);list.push(p);hashes[`${name}.${lang}`]=createHash('sha256').update(contents).digest('hex');
}
let s=await source('test/native/WorkflowConsentCheck.swift');
s=s.replace('@main @MainActor struct WorkflowConsentCheck','@MainActor struct WorkflowConsentCheck').replace('static func main()throws{','static func run(_ path:String)throws{').replaceAll('CommandLine.arguments[1]','path');
let appSwift=await readFile(join(t.base,'test/native/ApprovalDisplayDevice.swift.inc'),'utf8');
if(baseline)appSwift=appSwift.replace(/^.*h\.ui\.onUpdate=.*$/m,'');
await writeFile(join(out,'Display.swift'),s+appSwift);
let k=await source('test/native/WorkflowConsentCheck.kt');k=k.replace('fun main(args:Array<String>)','fun workflowDisplayChecks(args:Array<String>)');
let appKt=await readFile(join(t.base,'test/native/ApprovalDisplayDevice.kt.inc'),'utf8');
if(baseline)appKt=appKt.replace(/^.*h\.ui\.onUpdate=.*$/m,'');
await writeFile(join(out,'DisplayActivity.kt'),k+appKt);
const app=join(out,'ApprovalDisplay.app'),bundleId=`io.tbc.approvaldisplay.${variant}`,androidId=`io.tbc.approvaldisplay.${variant}`;
await mkdir(app,{recursive:true});const sdk=await text('xcrun',['--sdk','iphonesimulator','--show-sdk-path']);
const android=join(out,'android');await mkdir(join(android,'classes'),{recursive:true});await mkdir(join(android,'dex'),{recursive:true});
await Promise.all([
 run('xcrun',['swiftc','-O','-swift-version','6','-parse-as-library','-target','arm64-apple-ios15.0-simulator','-sdk',sdk,...swift,join(out,'Display.swift'),'-framework','UIKit','-o',join(app,'ApprovalDisplay')],opts),
 run(join(t.java,'bin/java'),['-cp',t.compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-language-version','1.8','-api-version','1.8','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[t.compiler[1],t.compiler[6],t.android].join(':'),'-d',join(android,'classes'),...kotlin,join(out,'DisplayActivity.kt')],opts)
 ]);
await writeFile(join(app,'Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>ApprovalDisplay</string><key>CFBundleName</key><string>Approval ${variant}</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>0.1</string><key>CFBundlePackageType</key><string>APPL</string><key>LSRequiresIPhoneOS</key><true/><key>UIDeviceFamily</key><array><integer>1</integer></array><key>UILaunchScreen</key><dict/></dict></plist>`);
await run('codesign',['--force','--sign','-',app],opts);
const tools=join(homedir(),'Library/Android/sdk/build-tools/36.0.0');
await run(join(t.java,'bin/jar'),['cf',join(android,'classes.jar'),'-C',join(android,'classes'),'.'],opts);
const env={...process.env,JAVA_HOME:t.java};
await run(join(tools,'d8'),['--min-api','26','--lib',t.android,'--output',join(android,'dex'),join(android,'classes.jar'),t.compiler[1],t.compiler[6]],{...opts,env});
await writeFile(join(android,'AndroidManifest.xml'),`<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${androidId}"><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="28"/><application android:label="Approval ${variant}" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:debuggable="true" android:allowBackup="false"><activity android:name="io.tbc.kit.dart.DisplayActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>`);
await run(join(tools,'aapt2'),['link','-o',join(android,'unsigned.apk'),'--manifest',join(android,'AndroidManifest.xml'),'-I',t.android],opts);
await run('zip',['-q',join(android,'unsigned.apk'),'classes.dex'],{...opts,cwd:join(android,'dex')});
await run(join(tools,'zipalign'),['-f','-p','4',join(android,'unsigned.apk'),join(android,'aligned.apk')],opts);
const key=join(root,'approval-test.keystore');try{await readFile(key);}catch{await run(join(t.java,'bin/keytool'),['-genkeypair','-keystore',key,'-storepass','android','-keypass','android','-alias','androiddebugkey','-dname','CN=Public Fixture Test','-keyalg','RSA','-validity','30'],opts);}
const apk=join(out,'approval-display.apk');await run(join(tools,'apksigner'),['sign','--ks',key,'--ks-pass','pass:android','--key-pass','pass:android','--out',apk,join(android,'aligned.apk')],{...opts,env});
const report={variant,packagedSource:packaged,sourceHashes:hashes,app,bundleId,apk,androidId};await writeFile(join(out,'build.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
