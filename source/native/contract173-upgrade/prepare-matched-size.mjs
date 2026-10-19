// Reproducible, build-only complete dispatcher comparison. No account or key.
import {readFile,writeFile,mkdir,cp,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const [sdk,root,newPkg]=process.argv.slice(2).map(x=>resolve(x));
assert(root.startsWith('/private/tmp/tbc-matched-size-'));
const oldRoot=join(root,'tbc-flutter-partner');
const oldPkg=join(oldRoot,'tbc_kit_flutter');
const run=(c,a,cwd)=>execFileSync(c,a,{cwd,stdio:'inherit',env:{...process.env,COCOAPODS_DISABLE_STATS:'true'}});
const shell=`import 'package:flutter/material.dart';
import 'entry.dart';
void main()=>runApp(const MaterialApp(home:SizeHost()));
class SizeHost extends StatefulWidget {const SizeHost({super.key});@override State<SizeHost> createState()=>_State();}
class _State extends State<SizeHost>{final url=TextEditingController(text:'https://dev.durianswap.org');Widget? browser;String? error;
 Future<void> open()async{try{final b=await openBrowser(Uri.parse(url.text));if(mounted)setState(()=>browser=b);}catch(e){if(mounted)setState(()=>error='Wallet not configured');}}
 @override Widget build(BuildContext context)=>Scaffold(appBar:AppBar(title:const Text('Partner Wallet')),body:Column(children:[TextField(controller:url),ElevatedButton(onPressed:open,child:const Text('Open DApp')),if(error!=null)Text(error!),Expanded(child:browser??const SizedBox())]));}
`;
const common=`import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
`;
const oldEntry=`import 'package:flutter/material.dart';
import 'dart:async';
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:tbc_kit_flutter/wallet.dart';
import 'package:tbc_kit_flutter/permission_store_sqlite.dart';
import 'partner_wallet_host.dart';
const vault=MethodChannel('io.tbc.size/existing-wallet');
Future<Widget> openBrowser(Uri url)async=>PartnerTbcDappView(host:SizeWallet(),initialUrl:url);
class SizeWallet implements PartnerWalletHost {
 int revision=0;bool active=true;
 @override void invalidateNativeScope(){revision++;active=false;unawaited(vault.invokeMethod('invalidate'));}
 @override Stream<void> get externalInvalidations=>const EventChannel('io.tbc.size/wallet-changes').receiveBroadcastStream().map((_){});
 @override Future<PartnerWalletBindings> open(TbcWebViewNavigation navigation)async{
  active=true;final network=TbcNetworkConfiguration.official(TbcNetwork.testnet);
  final permissions=TbcSqlitePermissionStore(sqlite3.openInMemory())..initialize();
  final journal=TbcSqliteRuntimeStore(sqlite3.openInMemory())..initialize();
  return PartnerWalletBindings(configuration:TbcWalletConfiguration(productId:'io.tbc.size',name:'Partner Wallet',profile:'size',network:network,legacy:true),
   environment:TbcHostEnvironment(network:network,readAccounts:(_)async{
    final a=await vault.invokeMapMethod<String,dynamic>('account');
    if(a==null)return <TbcAccount>[];
    return [TbcAccount(network:TbcNetwork.testnet,address:a['address'] as String,publicKey:a['publicKey'] as String)];}),
   signer:TbcDartWalletSigner(algorithms:{TbcDigestAlgorithm.ecdsa,TbcDigestAlgorithm.recoverableEcdsa},isUnlockedForTask:(_,__)=>false,signDigest:(_)=>throw StateError('VAULT_NOT_CONFIGURED'),revokePending:(){}),
   permissionStore:permissions,broadcastStore:journal,
   preparationUi:TbcApprovalPreparationUi(onBegin:(_){},onReview:(_)async=>const TbcEarlyConsent.reject(),onFinish:(_){}),
   review:(_)async=>TbcApprovalDecision.reject,readWalletRevision:()=>revision,isNativeCurrent:()=>active,
   expectedRuntimeArtifact:Platform.isIOS?'ac1a11a350ca4acdc857ea4b46e8b3df6aefa8b016d3776032e594104d029670':'d51903ae8bc24899909310d3f9c580a49945f3237334ebbff842ca580ab5f292',
   expectedEngineArtifact:'4f4aea5e19650653a3beeac863dad6f0422a72204722629980311281f78ee1ef',dispose:()async{});
 }
}
`;
for(const variant of ['baseline','old','latest']){
 if(process.env.SIZE_ONLY && process.env.SIZE_ONLY!==variant)continue;
 const out=join(root,variant);try{await access(out);throw Error('Existing consumer');}catch(e){if(e.code!=='ENOENT')throw e;}
 run(join(sdk,'bin/flutter'),['create','--no-pub','--platforms=android,ios','--org','io.tbc','--project-name','sizehost',out],root);
 const dependency=variant==='old'?`  sqlite3_flutter_libs: 0.5.41\n  tbc_kit_flutter:\n    path: ${JSON.stringify(oldPkg)}\n`:variant==='latest'?`  tbc_kit_flutter_dart:\n    path: ${JSON.stringify(newPkg)}\n`:'';
 await writeFile(join(out,'pubspec.yaml'),`name: sizehost\npublish_to: none\nversion: 1.0.0+1\nenvironment:\n  sdk: '>=3.7.2 <4.0.0'\ndependencies:\n  flutter:\n    sdk: flutter\n  flutter_inappwebview: 6.1.5\n${dependency}dev_dependencies:\n  flutter_test:\n    sdk: flutter\nflutter:\n  uses-material-design: true\n`);
 await writeFile(join(out,'lib/main.dart'),shell);
 if(variant==='old'){
  await cp(join(oldRoot,'example/lib/partner_wallet_host.dart'),join(out,'lib/partner_wallet_host.dart'));
  await writeFile(join(out,'lib/entry.dart'),oldEntry);
 }else if(variant==='latest'){
  await cp(join(newPkg,'example/lib/partner_browser.dart'),join(out,'lib/partner_browser.dart'));
  await writeFile(join(out,'lib/entry.dart'),`import 'package:flutter/material.dart';\nimport 'partner_browser.dart';\nFuture<Widget> openBrowser(Uri url)async{final wallet=await openPartnerWallet(productId:'io.tbc.size',displayName:'Partner Wallet',profile:'size');return PartnerBrowser(wallet:wallet,url:url);}\n`);
 }else await writeFile(join(out,'lib/entry.dart'),`${common}\nFuture<Widget> openBrowser(Uri url)async=>InAppWebView(initialUrlRequest:URLRequest(url:WebUri(url.toString())));\n`);
 // Retain all published native host paths on BOTH wallet variants. This avoids
 // a deliberately unconfigured Vault causing R8 to erase the entire host.
 await writeFile(join(out,'android/app/size-rules.pro'),'-keep class io.tbc.** { *; }\n');
 await writeFile(join(out,'android/app/build.gradle.kts'),`plugins{id("com.android.application");id("kotlin-android");id("dev.flutter.flutter-gradle-plugin")}
android{namespace="io.tbc.sizehost";compileSdk=36;ndkVersion="27.1.12297006"
 defaultConfig{applicationId="io.tbc.sizehost";minSdk=26;targetSdk=36;versionCode=1;versionName="1.0";ndk{abiFilters+="arm64-v8a"}}
 compileOptions{sourceCompatibility=JavaVersion.VERSION_17;targetCompatibility=JavaVersion.VERSION_17};kotlinOptions{jvmTarget="17"}
 packaging{jniLibs{useLegacyPackaging=true;keepDebugSymbols+="**/libtbc*.so"}}
 buildTypes{getByName("release"){signingConfig=signingConfigs.getByName("debug");isMinifyEnabled=true;isShrinkResources=true;proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"),"size-rules.pro")}}
}
flutter{source="../.."}
dependencies{implementation("androidx.webkit:webkit:1.12.1")}
`);
 run(join(sdk,'bin/flutter'),['pub','get','--offline'],out);
 const podfile=join(out,'ios/Podfile');let p=await readFile(podfile,'utf8');
 p=p.replace("# platform :ios, '12.0'","platform :ios, '15.0'").replace('flutter_additional_ios_build_settings(target)',"flutter_additional_ios_build_settings(target)\n    target.build_configurations.each{|c|c.build_settings['IPHONEOS_DEPLOYMENT_TARGET']='15.0'}");
 await writeFile(podfile,p);
 run('ruby',['-rxcodeproj','-e',`p=Xcodeproj::Project.open('ios/Runner.xcodeproj');p.targets.each{|t|t.build_configurations.each{|c|c.build_settings['IPHONEOS_DEPLOYMENT_TARGET']='15.0';c.build_settings['ARCHS']='arm64';c.build_settings['ENABLE_USER_SCRIPT_SANDBOXING']='NO'}};p.save`],out);
 run('pod',['install','--no-repo-update'],join(out,'ios'));
 if(variant==='latest')run('ruby',[join(newPkg,'tool/install_ios.rb'),join(out,'ios/Runner.xcodeproj')],out);
 run(join(sdk,'bin/flutter'),['analyze','lib','--no-fatal-infos'],out);
}
await writeFile(join(root,'comparison-inputs.json'),JSON.stringify({sdk,oldPkg,newPkg,variants:['baseline','old','latest'],mode:'Build-only full dispatcher host, locked/unconfigured external Vault; no business execution',nativeRetention:'Same R8 keep io.tbc.** on both wallet builds; iOS CocoaPods native hosts retained in framework or Runner binary',broadcasts:0},null,2));
