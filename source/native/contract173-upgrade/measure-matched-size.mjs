import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [rootArg,outArg]=process.argv.slice(2),root=resolve(rootArg),out=resolve(outArg);
const inputs=JSON.parse(await readFile(join(root,'comparison-inputs.json'),'utf8'));
const digest=b=>createHash('sha256').update(b).digest('hex');
const meta=b=>({bytes:b.length,sha256:digest(b)});
const extract=(apk,name)=>execFileSync('/usr/bin/unzip',['-p',apk,name],{maxBuffer:128e6});
async function tree(path,prefix=''){
 const files=[];for(const f of await readdir(path,{withFileTypes:true})){
  if(f.isDirectory())files.push(...await tree(join(path,f.name),join(prefix,f.name)));
  else if(f.isFile())files.push({name:join(prefix,f.name),...meta(await readFile(join(path,f.name)))});
 }return files;
}
// Read-only verification of every inventoried latest package file.
const inventory=JSON.parse(await readFile(join(inputs.newPkg,'package-files.json'),'utf8'));
for(const [p,h]of Object.entries(inventory.files))assert.equal(digest(await readFile(join(inputs.newPkg,p))),h,p);
const variants={};
for(const name of inputs.variants){
 const path=join(root,name),apk=join(path,'build/app/outputs/apk/release/app-release.apk');
 const app=join(path,'derived-size-release/Build/Products/Release-iphoneos/Runner.app');
 const names=execFileSync('unzip',['-Z1',apk],{encoding:'utf8'}).trim().split('\n');
 const zipEntries=execFileSync('unzip',['-lv',apk],{encoding:'utf8'}).split('\n').flatMap(line=>{
  const m=line.match(/^\s*(\d+)\s+(Stored|Defl:\S+)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+[a-f\d]+\s+(.+)$/i);
  return m?[{name:m[4],bytes:Number(m[1]),compressedBytes:Number(m[3])}]:[];
 });assert.equal(zipEntries.length,names.length);
 assert(names.filter(p=>p.startsWith('lib/')).every(p=>p.startsWith('lib/arm64-v8a/')));
 const native=Object.fromEntries(names.filter(p=>/^lib\/.*\.so$/.test(p)).map(p=>[p,meta(extract(apk,p))]));
 const assets=Object.fromEntries(names.filter(p=>/^assets\/tbc-kit\//.test(p)&&!p.endsWith('/')).map(p=>[p,meta(extract(apk,p))]));
 const ios=await tree(app);
 if(name!=='baseline'){
  const hostBinary=name==='latest'?join(app,'Runner'):join(app,'Frameworks/tbc_kit_flutter.framework/tbc_kit_flutter');
  const symbols=execFileSync('nm',['-g',hostBinary],{encoding:'utf8',maxBuffer:32e6});
  assert(symbols.includes(name==='latest'?'TbcPartnerWalletHost':'TbcFlutterWebViewHost'),'Native host implementation was stripped');
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app]);
 }
 if(name==='baseline'){
  assert(!names.some(p=>/tbc|hermes|\.hbc$/i.test(p)));
  assert(!ios.some(p=>/tbc|hermes|\.hbc$/i.test(p.name)));
 }else{
  assert(names.some(p=>p.endsWith('/tbc-webview-page.js')));
  assert(ios.some(p=>p.name.endsWith('/tbc-webview-page.js')||p.name==='tbc-webview-page.js'));
  assert(names.some(p=>p.includes('libtbc_')));
  assert(ios.some(p=>/Frameworks\/Tbc/.test(p.name)));
  const pkg=name==='old'?inputs.oldPkg:inputs.newPkg;
  const expected=await readFile(join(pkg,'android/src/main/assets/tbc-kit/tbc-webview-page.js'));
  assert.equal(assets['assets/tbc-kit/tbc-webview-page.js'].sha256,digest(expected));
  const aot=extract(apk,'lib/arm64-v8a/libapp.so').toString('latin1');
  if(name==='latest'){
   assert(!names.some(p=>/hermes|\.hbc$/.test(p)));
   assert(!ios.some(p=>/hermes|\.hbc$/.test(p.name)));
   for(const marker of ['tbc-amm','tbc_signMessage','tbc_signTransaction','legacy-window-turing'])assert(aot.includes(marker),`Missing retained dispatcher marker ${marker}`);
   for(const file of ['libtbc_compute_native.so','libtbc_signer_kernel.so','libtbc_dart_reviewed.so'])assert.equal(native['lib/arm64-v8a/'+file].sha256,digest(await readFile(join(pkg,'android/src/main/jniLibs/arm64-v8a',file))));
  }else{
   assert(names.some(p=>p.endsWith('private-kit.hbc')));
   assert(names.some(p=>p.includes('libhermes')));
  }
 }
 variants[name]={source:{main:meta(await readFile(join(path,'lib/main.dart'))),gradle:meta(await readFile(join(path,'android/app/build.gradle.kts'))),pubspecLock:meta(await readFile(join(path,'pubspec.lock')))},
  android:{apk,...meta(await readFile(apk)),native,assets,zipEntries},ios:{app,bytes:ios.reduce((s,p)=>s+p.bytes,0),files:ios}};
}
const iosFile=(v,p)=>variants[v].ios.files.find(f=>f.name===p);
for(const v of ['old','latest']){
 assert.deepEqual(variants[v].source.main,variants.baseline.source.main);
 assert.deepEqual(variants[v].source.gradle,variants.baseline.source.gradle);
 assert.deepEqual(variants[v].android.native['lib/arm64-v8a/libflutter.so'],variants.baseline.android.native['lib/arm64-v8a/libflutter.so']);
 assert.equal(iosFile(v,'Frameworks/Flutter.framework/Flutter').sha256,iosFile('baseline','Frameworks/Flutter.framework/Flutter').sha256);
}
const comparison={};for(const platform of ['android','ios']){
 const baseline=variants.baseline[platform].bytes,old=variants.old[platform].bytes,latest=variants.latest[platform].bytes;
 const oldIncrement=old-baseline,latestIncrement=latest-baseline,saved=old-latest;
 comparison[platform]={baselineBytes:baseline,oldAppBytes:old,latestAppBytes:latest,oldIncrementBytes:oldIncrement,latestIncrementBytes:latestIncrement,savedBytes:saved,incrementReductionPercent:100*saved/oldIncrement,fullAppReductionPercent:100*saved/old};
}
const result={status:'MATCHED_RELEASE_FULL_DISPATCHER_SIZE_PASS',recordedAt:new Date().toISOString(),inputs,comparison,variants,
 oldInventorySha256:digest(await readFile(join(root,'tbc-flutter-partner/SHA256SUMS'))),latestInventorySha256:digest(await readFile(join(inputs.newPkg,'package-files.json'))),
 latestInventoryFilesVerified:Object.keys(inventory.files).length,
 measurement:['Android arm64 Release APK bytes, signed with same local debug identity, R8/resource shrinking on, native ZIP compression on.',
 'iOS device arm64 Release App logical file bytes, same local ad-hoc signing for all variants; excludes dSYM, build cache and IPA compression. Not provisioned for installation and not App Store download bytes.',
 'Same Flutter3.29.3/Dart3.7.2, WebView6.1.5, common UI, Android API26 minimum / target36, iOS15.0 minimum.',
 'Both wallet hosts keep dynamic Standard/Legacy dispatcher; same native R8 keep rule prevents unconfigured Vault stripping wallet host. This is a conservative complete native API retention scenario.',
 'Old: Kit20261011.4 amm4-handoff2 JS/Hermes + Rust; Latest: Dart partner20261014.3 paired Kit20261014.3 contract1.7.3 + Rust.',
 'Vault/account/approval integration is unconfigured and deny-only. No signing or network acceptance performed. This is a reproducible integration host, not the actual partner production App.',
 'Baseline has Flutter and WebView only. Existing partner crypto or database dependency overlap may reduce the real incremental cost further.',
 'Reduction denominator is old TBC increment for incrementReductionPercent, and old complete App for fullAppReductionPercent. MB=1000000 bytes.'],broadcasts:0};
await writeFile(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,comparison},null,2));
