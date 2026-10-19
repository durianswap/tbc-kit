import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const [baselineArg,androidArg,iosArg,outArg]=process.argv.slice(2);
assert(baselineArg&&androidArg&&iosArg&&outArg);
const baseline=resolve(baselineArg),android=resolve(androidArg),ios=resolve(iosArg);
const hash=b=>createHash('sha256').update(b).digest('hex');
const metadata=b=>({bytes:b.length,sha256:hash(b)});
const unzip=(apk,p)=>execFileSync('/usr/bin/unzip',['-p',apk,p],{maxBuffer:128e6});
async function tree(dir,prefix=''){
 const entries=[];
 for(const d of await readdir(dir,{withFileTypes:true})){
  if(d.isDirectory())entries.push(...await tree(join(dir,d.name),join(prefix,d.name)));
  else if(d.isFile())entries.push({name:join(prefix,d.name),...metadata(await readFile(join(dir,d.name)))});
 }
 return entries;
}
const variants={};
for(const [name,androidRoot,iosRoot]of [['noKit',baseline,baseline],['current',android,ios]]){
 const apk=join(androidRoot,'build/app/outputs/apk/release/app-release.apk');
 const app=join(iosRoot,'derived-size-release/Build/Products/Release-iphoneos/Runner.app');
 const apkNames=execFileSync('/usr/bin/unzip',['-Z1',apk],{encoding:'utf8'}).trim().split('\n');
 const natives=Object.fromEntries(apkNames.filter(f=>/^lib\/arm64-v8a\/.*\.so$/.test(f)).map(f=>[f,metadata(unzip(apk,f))]));
 assert(apkNames.every(f=>!/^lib\/(x86|armeabi|arm64-v8a\/.*hermes)/.test(f)));
 const iosFiles=await tree(app);
 if(name==='noKit'){
  assert(!apkNames.some(f=>/tbc|fixture|pilot/i.test(f)),'No TBC payload in baseline APK');
  assert(!iosFiles.some(f=>/tbc|fixture|pilot/i.test(f.name)),'No TBC payload in baseline iOS App');
 }else{
  const paired=resolve(import.meta.dirname,'../../release/dart-native-contract173-20261014-a');
  const page=await readFile(join(paired,'android/src/main/assets/tbc-kit/tbc-webview-page.js'));
  assert.equal(hash(unzip(apk,'assets/tbc-kit/tbc-webview-page.js')),hash(page));
  assert.equal(hash(await readFile(join(app,'tbc-webview-page.js'))),hash(page));
  // Android source copies were stripped before the accepted live build.
  for(const f of ['libtbc_compute_native.so','libtbc_signer_kernel.so'])assert.equal(natives['lib/arm64-v8a/'+f].sha256,hash(await readFile(join(androidRoot,'android/app/src/main/jniLibs/arm64-v8a',f))));
  assert(!apkNames.some(f=>/hermes|\.hbc$|assets\/flutter_assets\/assets\/(pilot|.*fixture)/i.test(f)));
  assert(!iosFiles.some(f=>/hermes|\.hbc$|flutter_assets\/assets\/(pilot|.*fixture)/i.test(f.name)));
 }
 variants[name]={android:{apk,...metadata(await readFile(apk)),native:natives},
  ios:{app,uncompressedBytes:iosFiles.reduce((n,f)=>n+f.bytes,0),files:iosFiles}};
}
assert.deepEqual(variants.noKit.android.native['lib/arm64-v8a/libflutter.so'],variants.current.android.native['lib/arm64-v8a/libflutter.so']);
const iosFile=(variant,name)=>variants[variant].ios.files.find(f=>f.name===name);
assert.equal(iosFile('noKit','Frameworks/Flutter.framework/Flutter').sha256,iosFile('current','Frameworks/Flutter.framework/Flutter').sha256);
const components={android:Object.fromEntries(Object.entries(variants.current.android.native).filter(([p])=>p.includes('/libtbc_'))),
 ios:variants.current.ios.files.filter(f=>/^Frameworks\/Tbc.*\.framework\/Tbc[^/]+$/.test(f.name))};
const result={status:'CURRENT_FULL_HOST_RELEASE_SIZE_ESTIMATE',recordedAt:new Date().toISOString(),variants,components,
 increment:{androidArm64ApkBytes:variants.current.android.bytes-variants.noKit.android.bytes,
 androidDartAotBytes:variants.current.android.native['lib/arm64-v8a/libapp.so'].bytes-variants.noKit.android.native['lib/arm64-v8a/libapp.so'].bytes,
 iosArm64AppUncompressedBytes:variants.current.ios.uncompressedBytes-variants.noKit.ios.uncompressedBytes,
 iosDartAotBytes:iosFile('current','Frameworks/App.framework/App').bytes-iosFile('noKit','Frameworks/App.framework/App').bytes},
 assumptions:['Partner already uses Flutter3.29.3/Dart3.7.2 and flutter_inappwebview6.1.5. Same compiler/ABI/minimum-target and base Flutter engine.',
 'Android arm64 Release APK with R8 and compressed native payloads; iOS unsigned device-arm64 Release App, NOT simulator Debug or App Store download size.',
 'Full current host includes maintainer live-test UI/provisioning/report glue, but no bundled test keys or fixture transactions. Delta is an integration estimate, not the exact partner package increment.',
 'All present Dart handlers are retained by the dynamic Provider dispatcher; deferred switchChain/Legacy completion may alter final size.',
 'Baseline contains no TBC dependencies, native engines, signer or page runtime. Existing older empty P2 shells contained them and were not used as a no-Kit baseline.',
 'No installed wallet or frozen artifact was replaced by the unsigned size builds. No transaction was executed.'],
 broadcastCount:0,productionReady:false};
await writeFile(resolve(outArg),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,increment:result.increment,components,out:resolve(outArg)}));
