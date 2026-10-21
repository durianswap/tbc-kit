// Simulator/emulator execution of exact package Engine binaries; public data,
// no signing key, network, wallet journal or broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const repo=resolve(import.meta.dirname,'../../../..'),candidate=resolve(process.argv[2]),out=resolve(process.argv[3]);await mkdir(out,{recursive:true});
const ios='C2C010B8-4071-4888-9E25-D91BF88EB461',serial='emulator-5556',adb='/Users/alex/Library/Android/sdk/platform-tools/adb';
const ndk='/Users/alex/Library/Android/sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/darwin-x86_64/bin';
const cpp=join(import.meta.dirname,'approval-output-native-check.cpp'),run=(cmd,args,input)=>execFileSync(cmd,args,{input,encoding:'utf8',maxBuffer:24e6,timeout:60000});
const sdk=run('xcrun',['--sdk','iphonesimulator','--show-sdk-path']).trim(),iosRunner=join(out,'native-call-ios'),androidRunner=join(out,'native-call-android');
run('xcrun',['clang++','-O2','-std=c++17','-target','arm64-apple-ios15.0-simulator','-isysroot',sdk,cpp,'-o',iosRunner]);run('codesign',['--force','--sign','-',iosRunner]);
run(join(ndk,'aarch64-linux-android23-clang++'),['-O2','-std=c++17','-static-libstdc++',cpp,'-ldl','-o',androidRunner]);
const remote='/data/local/tmp/tbc-approval-output-rc5';run(adb,['-s',serial,'shell','mkdir','-p',remote]);run(adb,['-s',serial,'push',androidRunner,remote+'/native-call']);run(adb,['-s',serial,'shell','chmod','700',remote+'/native-call']);
const libs={};
for(const[name,base]of [['old',join(repo,'packages/flutter')],['candidate',join(candidate,'tbc_kit_flutter_dart')]]){
 const iosFile=join(out,name+'-engine-ios'),androidFile=join(base,'android/src/main/jniLibs/arm64-v8a/libtbc_compute_native.so');
 const source=join(base,'ios/Frameworks/TbcFlutterEngine.xcframework/ios-arm64-simulator/TbcFlutterEngine.framework/TbcFlutterEngine');
 await cp(source,iosFile);run('codesign',['--force','--sign','-',iosFile]);run(adb,['-s',serial,'push',androidFile,remote+'/'+name+'.so']);
 libs[name]={ios:iosFile,android:remote+'/'+name+'.so',sha256:{iosBeforeAdhoc:hash(await readFile(source)),android:hash(await readFile(androidFile))}};
}
function hash(b){return createHash('sha256').update(b).digest('hex');}
const {createWasmTbcEngineBackend}=await import(pathToFileURL(join(candidate,'consumer/node_modules/@tbc/kit/dist/esm/engine.js'))),engine=await createWasmTbcEngineBackend(await readFile(join(candidate,'package/artifacts/wasm/tbc_engine_wasm.wasm')));
const call=async(m,p)=>{const r=JSON.parse(await engine.call(m,JSON.stringify(p)));assert(r.ok,JSON.stringify(r.error));return r.result;};
const fixtures=JSON.parse(await readFile(join(repo,'source/native/flutter-dart-kit/test/fixtures/workflow-planning.json'))).cases,seen=new Set(),report={scope:'20 warm native plan calls on actual simulator/emulator, no API or cryptographic signing',ios,serial,libs,cases:[],broadcasts:0,reads:0};
for(const c of fixtures)for(const e of c.plan.payload.transactionPlans){
 const s=c.request.steps.find(s=>s.id===e.stepId),m=c.materials[e.stepId];if(!m)continue;
 const request={version:'1.0',chainId:c.request.chainId,from:c.request.from,intent:s.intent,...s.constraints?{constraints:s.constraints}:{},...s.signingRoles?{signingRoles:s.signingRoles}:{}};
 const input={version:'1.0',...await call('normalizeRequest',{version:'1.0',request}),...m},key=hash(JSON.stringify(input));if(seen.has(key))continue;seen.add(key);
 const expected=await call('plan',input),times={};
 for(const platform of ['ios','android']){times[platform]={};for(const name of ['old','candidate']){
  const args=[libs[name][platform],'plan','20'],result=JSON.parse(platform==='ios'?run('xcrun',['simctl','spawn',ios,iosRunner,...args],JSON.stringify(input)):run(adb,['-s',serial,'shell',remote+'/native-call',...args],JSON.stringify(input)));
  assert(result.result.ok);const p=structuredClone(expected);if(name==='old'){
   for(const t of p.plan.payload.transactions)delete t.outputReview;p.plan.planHash=result.result.result.plan.planHash;
  }assert.deepEqual(result.result.result,p,`${c.name} ${platform} ${name}`);
  times[platform][name]=result.warmMs;
 }}report.cases.push({name:c.name,nativeMatchesWasm:true,times});
}
report.status='PASS_MOBILE_ENGINE_PARITY';await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];console.log(JSON.stringify({status:report.status,cases:report.cases.map(c=>({name:c.name,timings:Object.fromEntries(Object.entries(c.times).map(([p,t])=>[p,Object.fromEntries(Object.entries(t).map(([n,a])=>[n,median(a)]))]))}))}));
