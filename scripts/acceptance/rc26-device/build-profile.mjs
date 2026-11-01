import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../../..'),req=createRequire(join(root,'source/package.json'));
const {build}=req('esbuild'),tbc=req('tbc-lib-js');
const mode=process.argv[2]??'baseline',installed=resolve(process.argv[3]??join(root,'.verify/nft-job-install-f1sefH/node_modules/@tbc/kit'));
assert.match(mode,/^[a-z0-9-]+$/);
const nativeSha=mode.startsWith('native-sha'),targeted=mode.endsWith('-targeted');
const out=join(root,'.verify/rc26-profile'),variant=join(out,mode);await mkdir(variant,{recursive:true});
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',script=tbc.Script.buildPublicKeyHashOut(address).toHex();
function raw(outputs){const tx=new tbc.Transaction().from({txId:'ab'.repeat(32),outputIndex:0,script,satoshis:10000000});tx.version=10;for(const o of outputs)tx.addOutput(new tbc.Transaction.Output(o));return tx.uncheckedSerialize();}
const collections={};for(const n of [1,2,4,11,12,101])collections[n]=raw([{satoshis:0,script:tbc.Script.buildSafeDataOut([Buffer.from(JSON.stringify({collectionName:'Stress',description:'public synthetic',supply:n,file:''})),Buffer.from('NTape')])},...Array.from({length:n},()=>({satoshis:100,script:tbc.Script.fromHex(script+'6a0d5630204d696e74204e486f6c64')}))]);
const funding=raw([{satoshis:9000000,script:tbc.Script.fromHex(script)}]);
let h=await readFile(join(root,'source/packages/kit/test/nft-job-stress-fixture.mjs'),'utf8');
h=h.slice(h.indexOf("const address='1Bg"),h.indexOf('\nexport {'));
h=h.replace(h.slice(h.indexOf('function raw('),h.indexOf('async function harness(')),'');
h=h.replace(h.slice(h.indexOf(' const collection=raw('),h.indexOf(' const unused=')),` const collection=fixtures.collections[count],funding=fixtures.funding,collectionId=kit.turingTransactionId(collection),fundingId=kit.turingTransactionId(funding);\n`);
h=h.replaceAll('if(process.env.TBC_STRESS_DIAG)','if(false)');
let portable=await readFile(join(root,'scripts/acceptance/rc23-device/portable.mjs'),'utf8');
portable=portable.slice(0,portable.indexOf('/*FIXTURES*/'))+`const fixtures=${JSON.stringify({collections,funding})};\n`+h+'\n'+await readFile(join(import.meta.dirname,'profile-cases.mjs'),'utf8')+(targeted?'\n'+await readFile(join(import.meta.dirname,'targeted-cases.mjs'),'utf8'):'')+portable.slice(portable.indexOf('async function main()'));
portable=portable.replace("kit:'0.1.0-rc.23'",`kit:${JSON.stringify(JSON.parse(await readFile(join(installed,'package.json'))).version)},variant:${JSON.stringify(mode)},profileRuns`);
portable=portable.replace('const kit={...clientKit,...walletKit,...engineKit};','const kit={...clientKit,...walletKit,...engineKit,assertTestnetAddress,turingTransactionId,inspectTbcTransaction};');
if(nativeSha){
 const vectors=[0,1,31,32,55,56,63,64,65,127,128,1000,65536].map(length=>{const b=Buffer.from(Array.from({length},(_,i)=>(i*17+31)%256));return{length,hash:createHash('sha256').update(b).digest('hex')}});
 portable=`import {createNativeSha256Backend} from ${JSON.stringify(join(root,'source/native/runtime-support/native-sha256.mjs'))};\n`+portable.replace('const {createDefaultTbcChainDataResolver,hashCanonical}=kit;',`const nativeHash=createNativeSha256Backend(globalThis.__tbcNativeSha256);kit.configureTbcKitSha256Backend(nativeHash);\nconst {createDefaultTbcChainDataResolver,hashCanonical}=kit;`);
 portable=portable.replace('async function main(){',`test('native SHA exact subviews, independent vectors, unchanged inputs',async()=>{for(const v of ${JSON.stringify(vectors)}){const b=Uint8Array.from({length:v.length+4},(_,i)=>i>=2&&i<v.length+2?((i-2)*17+31)%256:255);const before=Array.from(b);const d=nativeHash(b.subarray(2,v.length+2));assert.equal(Buffer.from(d).toString('hex'),v.hash);assert.deepEqual(Array.from(b),before);assert.equal(d.length,32)}for(const args of [[new ArrayBuffer(1),-1,1],[new ArrayBuffer(1),0,2],[new ArrayBuffer(1),0.5,0]]){let rejected=false;try{__tbcNativeSha256(...args)}catch{rejected=true}assert.ok(rejected)}});\nasync function main(){`);
}
portable=portable.replace("import * as clientKit from '@frozen/client';",`import * as clientKit from ${JSON.stringify(join(installed,'dist/esm/client.js'))};`);
const profiling=`const profileRuns=[];const profileStats={};let profileStack=[];globalThis.__profileStart=name=>{const frame={name,start:performance.now(),child:0};profileStack.push(frame);return frame};globalThis.__profileEnd=frame=>{const ms=performance.now()-frame.start;profileStack.pop();if(profileStack.length)profileStack[profileStack.length-1].child+=ms;const s=profileStats[frame.name]??={calls:0,totalMs:0,selfMs:0};s.calls++;s.totalMs+=ms;s.selfMs+=ms-frame.child};const takeProfile=()=>{const result=JSON.parse(JSON.stringify(profileStats));for(const k of Object.keys(profileStats))delete profileStats[k];return result};\n`;
const base=await build({stdin:{contents:profiling+portable,resolveDir:root},bundle:true,write:false,platform:'browser',format:'iife',target:'es2022',alias:{'@frozen/client':join(installed,'dist/esm/index.js'),'@frozen/wallet':join(installed,'dist/esm/wallet.js'),'@frozen/engine':join(installed,'dist/esm/engine.js'),'@frozen/api':join(installed,'dist/esm/api.js'),'buffer':req.resolve('buffer/'),'@fixture/signer':join(root,'source/packages/kit/examples/shared/controlled-signer.mjs'),'@noble/curves/secp256k1.js':req.resolve('@noble/curves/secp256k1.js')},logLevel:'warning'});
// Instrument only the isolated benchmark, never the candidate or current package.
const rnReq=createRequire('/Users/alex/Documents/Codex/2026-08-29/wo/outputs/ft-nft-rc11-device/android-build-deps/package.json');
const parser=rnReq('@babel/parser'),traverse=rnReq('@babel/traverse').default;
let code=base.outputFiles[0].text;
const ast=parser.parse(code),edits=[];
const names=new Set(['canonicalize','hashCanonical','sha256Bytes','createCheckpoint','verifyCheckpoint','assertValidTws','snapshotTransition','deriveHostTransitionIdentity','signControlledTask']);
traverse(ast,{FunctionDeclaration(p){const name=p.node.id?.name?.replace(/\d+$/,'');if(!names.has(name)||p.node.async)return;const b=p.node.body;edits.push([b.start+1,`const __profileFrame=globalThis.__profileStart(${JSON.stringify(name)});try{`],[b.end-1,'}finally{globalThis.__profileEnd(__profileFrame);}']);}});
for(const [at,text]of edits.sort((a,b)=>b[0]-a[0]))code=code.slice(0,at)+text+code.slice(at);
await writeFile(join(variant,'web-suite.js'),code);
if(mode.startsWith('ios-')){console.log(variant);process.exit(0);}
// Hermes syntax lowering using the same preset as the real Native acceptance App.
const android=JSON.parse(await readFile(join(root,'.verify/rc25-real/candidate.json'))).android;
const prior=await readFile(join(android,'gradle.properties'),'utf8');
const rnSource=(await readFile(join(root,'.verify/rc25-real/android-builder.log'),'utf8'));
const babel=rnReq('@babel/core');
const preset=rnReq.resolve('@react-native/babel-preset');
code=babel.transformSync(code,{configFile:false,babelrc:false,sourceType:'script',compact:true,presets:[[preset,{unstable_transformProfile:'hermes-stable',enableBabelRuntime:false}]]}).code;
await writeFile(join(variant,'suite.js'),code);
let bootstrap=await readFile(join(root,'.verify/rc25-real/native/kit-runtime/closed-loop/bootstrap.js'),'utf8');bootstrap=bootstrap.slice(0,bootstrap.indexOf('const pending ='));
bootstrap=`const host=(op,v)=>JSON.parse(__host(op,JSON.stringify(v)));globalThis.__encode=v=>host('encode',v);globalThis.__decode=v=>host('decode',v);globalThis.__url=v=>JSON.stringify(host('url',v));globalThis.__now=()=>host('now',null);globalThis.__schedule=(id,ms)=>host('schedule',[id,ms]);globalThis.__cancelTimer=()=>{};`+bootstrap+`globalThis.navigator={userAgent:'Android private Hermes 0.81.5; isolated synthetic profile'};globalThis.document={querySelector:()=>({textContent:''})};globalThis.TbcProbe={postMessage:raw=>host('message',JSON.parse(raw))};`;
const networkBootstrap=await readFile(join(root,'.verify/rc25-real/native/kit-runtime/closed-loop/network-bootstrap.js'),'utf8');
bootstrap+=networkBootstrap.slice(networkBootstrap.indexOf('globalThis.AbortController'));
bootstrap=babel.transformSync(bootstrap,{configFile:false,babelrc:false,sourceType:'script',compact:true,presets:[[preset,{unstable_transformProfile:'hermes-stable',enableBabelRuntime:false}]]}).code;
await writeFile(join(variant,'hermes-bootstrap.js'),bootstrap);
const project=join(out,nativeSha?'android-native-sha':'android');await mkdir(join(project,'src/main/java/io/tbc/kitloop'),{recursive:true});await mkdir(join(project,'src/main/assets'),{recursive:true});await mkdir(join(project,'src/main/jniLibs/arm64-v8a'),{recursive:true});
await cp(join(import.meta.dirname,'ProfileHost.kt'),join(project,'src/main/java/io/tbc/kitloop/ProfileHost.kt'));
await cp(join(root,'source/native/runtime-support/NativeSessionFence.kt'),join(project,'src/main/java/io/tbc/kitloop/NativeSessionFence.kt'));
for(const f of ['suite.js','hermes-bootstrap.js'])await cp(join(variant,f),join(project,'src/main/assets',f));
const apk=join(android,'build/outputs/apk/release/tbc-native-wallet-closed-loop-release.apk');
if(!nativeSha)for(const f of ['libtbc_kit_loop.so','libjsi.so'])await writeFile(join(project,'src/main/jniLibs/arm64-v8a',f),execFileSync('unzip',['-p',apk,'lib/arm64-v8a/'+f]));
else {
 const cpp=join(project,'src/main/cpp');await mkdir(cpp,{recursive:true});
 let bridge=await readFile(join(root,'.verify/rc25-real/native/kit-runtime/kotlin-probe/src/main/cpp/bridge.cpp'),'utf8');
 bridge=bridge.replaceAll('Java_io_tbc_kitprobe_ProbeHost_','Java_io_tbc_kitloop_NativeHost_').replace('#include <thread>','#include <thread>\n#include "sha256-jsi.hpp"').replace('auto &rt = *host->runtime;','auto &rt = *host->runtime;\n    installTbcSha256(rt, env);');
 await writeFile(join(cpp,'bridge.cpp'),bridge);
 await cp(join(root,'source/native/runtime-support/sha256-jsi.hpp'),join(cpp,'sha256-jsi.hpp'));
 await cp(join(android,'src/main/cpp/CMakeLists.txt'),join(cpp,'CMakeLists.txt'));
}
await writeFile(join(project,'settings.gradle'),`pluginManagement { repositories {google();mavenCentral();gradlePluginPortal()} }\ndependencyResolutionManagement {repositories {maven {url=uri('${join(root,'.verify/rc23-native/sdk/maven-repository')}')};google();mavenCentral()}}\nrootProject.name='rc26-local-profile'`);
await writeFile(join(project,'build.gradle'),`plugins { id 'com.android.application' version '8.11.0';id 'org.jetbrains.kotlin.android' version '2.1.20' }\nandroid {namespace 'io.tbc.kitloop';compileSdk 36;defaultConfig {applicationId 'io.tbc.rc26.profile';minSdk 26;targetSdk 36;versionCode 1;versionName 'probe';ndk {abiFilters 'arm64-v8a'}};compileOptions {sourceCompatibility JavaVersion.VERSION_17;targetCompatibility JavaVersion.VERSION_17};kotlinOptions {jvmTarget='17'}}\ndependencies {implementation 'io.tbc.local:engine:0.1.0-rc.23.native.2';implementation 'com.facebook.react:hermes-android:0.81.5';implementation 'com.facebook.soloader:nativeloader:0.10.5';implementation 'org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0'}`);
await writeFile(join(project,'gradle.properties'),'android.useAndroidX=true\norg.gradle.jvmargs=-Xmx1024m\norg.gradle.workers.max=2\n');
await writeFile(join(project,'build.gradle'),(await readFile(join(project,'build.gradle'),'utf8')).replace("kotlinOptions {jvmTarget='17'}}", "kotlinOptions {jvmTarget='17'};buildTypes {release {signingConfig signingConfigs.debug;debuggable true}}}"));
if(nativeSha)await writeFile(join(project,'build.gradle'),(await readFile(join(project,'build.gradle'),'utf8'))
 .replace("compileSdk 36;","compileSdk 36;ndkVersion '27.2.12479018';buildFeatures {prefab true};externalNativeBuild {cmake {path file('src/main/cpp/CMakeLists.txt');version '3.22.1'}};")
 .replace("minSdk 26;",`minSdk 26;externalNativeBuild {cmake {arguments '-DANDROID_STL=c++_shared','-DJSI_SOURCE=${join(android,'jsi')}'}};`));
await writeFile(join(project,'src/main/AndroidManifest.xml'),'<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="NFT local profile" android:allowBackup="false"><activity android:name="io.tbc.kitloop.ProfileActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>');
console.log(project);
