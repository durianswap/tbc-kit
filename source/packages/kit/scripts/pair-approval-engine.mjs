// Candidate-only pairing. Source-built Engine, frozen Signer/keyless/page.
import assert from 'node:assert/strict';
import {readFile,writeFile,cp,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {applePublicLinkFlags,verifyApplePublicAbi,stripAppleDebugSymbols} from '../../../native/flutter/scripts/portable-apple-binary.mjs';
import {stripWasmNameSection} from './wasm-metadata.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),json=async p=>JSON.parse(await readFile(p));
const save=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
function elfAllocated(b){
 assert.equal(b.subarray(0,4).toString('hex'),'7f454c46');assert.equal(b[5],1);const wide=b[4]===2;assert(wide||b[4]===1);
 const num=(o,n)=>n===8?Number(b.readBigUInt64LE(o)):b.readUInt32LE(o),table=num(wide?40:32,wide?8:4),stride=b.readUInt16LE(wide?58:46),count=b.readUInt16LE(wide?60:48),names=b.readUInt16LE(wide?62:50);
 const nameOffset=num(table+names*stride+(wide?24:16),wide?8:4),result=[];
 for(let i=0;i<count;i++){const p=table+i*stride,flags=num(p+8,wide?8:4);if(!(flags&2))continue;
  const n=nameOffset+b.readUInt32LE(p),end=b.indexOf(0,n),type=b.readUInt32LE(p+4),offset=num(p+(wide?24:16),wide?8:4),size=num(p+(wide?32:20),wide?8:4);
  result.push({name:b.subarray(n,end).toString(),flags,type,size,sha256:type===8?null:sha(b.subarray(offset,offset+size))});
 }return result;
}
async function stripAndroid(path){const before=await readFile(path);
 execFileSync('/Users/alex/Library/Android/sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-strip',['--strip-unneeded',path]);
 const after=await readFile(path);assert.deepEqual(elfAllocated(after),elfAllocated(before),'Android allocated code/data/ABI changed');
 return {beforeSha256:sha(before),afterSha256:sha(after),beforeBytes:before.length,afterBytes:after.length,allocatedSectionsUnchanged:true};
}
export async function pairApprovalEngine({repo,out,kit,flutter,compute,version}){
 const report=await json(join(compute,'build-report.json')),standalone=await json(join(compute,'native-resources-build.json'));
 assert.equal(report.status,'BUILT_PENDING_ACCEPTANCE');assert.equal(standalone.status,'BUILT');assert.equal(standalone.sourceSha256,report.sourceSha256);
 for(const a of [...report.artifacts,...standalone.artifacts])assert.equal(sha(await readFile(a.path)),a.sha256,a.path);
 const artifact=(items,t)=>{const a=items.find(a=>a.target===t);assert(a,t);return a;};
 const fingerprint=(await readFile(join(repo,'source/packages/core/src/generated/v1-candidate-release.ts'),'utf8')).match(/FINGERPRINT\s*=\s*"([a-f0-9]{64})"/)[1];
 const allowedKit=['artifacts/wasm/tbc_engine_wasm.wasm'],allowedFlutter=['android/src/main/jniLibs/arm64-v8a/libtbc_compute_native.so'];
 const originalWasm=await readFile(artifact(report.artifacts,'wasm32-unknown-unknown').path),strippedWasm=stripWasmNameSection(originalWasm);
 await writeFile(join(kit,allowedKit[0]),strippedWasm);
 await cp(artifact(report.artifacts,'aarch64-linux-android').path,join(flutter,allowedFlutter[0]));
 const postprocessing={wasm:{removed:'debug name section only',beforeSha256:sha(originalWasm),afterSha256:sha(strippedWasm),executableSectionsUnchanged:true},android:await stripAndroid(join(flutter,allowedFlutter[0]))};
 for(const n of ['protocol-types','v1-candidate-release'])await cp(join(repo,'source/packages/core/dist/types/generated',n+'.d.ts'),join(kit,'dist/types/internal/core/generated',n+'.d.ts'));
 const catalog=await json(join(kit,'artifacts/platform-resources.json'));catalog.package=`@tbc/kit@${version}`;catalog.protocolFingerprint=fingerprint;
 const archives=[];await mkdir(join(out,'native'));
 for(const[platform,entry]of Object.entries(catalog.platforms)){
  const dir=join(out,'native-stage-'+platform);await mkdir(dir);
  execFileSync('tar',['-xzf',join(repo,'artifacts/native',platform+'-resources.tgz'),'-C',dir]);
  for(const[p,h]of Object.entries(entry.files))assert.equal(sha(await readFile(join(dir,p))),h,p);
  const mapping=platform==='macos-arm64'?{'artifacts/native/aarch64-apple-darwin/libtbc_engine_native.dylib':'aarch64-apple-darwin'}:
   platform==='ios'?Object.fromEntries(['ios-arm64','ios-arm64-simulator'].map((arch,i)=>[`artifacts/native/ios/TbcEngineNative.xcframework/${arch}/libtbc_engine_native.a`,i?'aarch64-apple-ios-sim':'aarch64-apple-ios'])):
   Object.fromEntries([['arm64-v8a','aarch64-linux-android'],['armeabi-v7a','armv7-linux-androideabi'],['x86_64','x86_64-linux-android']].map(([arch,t])=>[`artifacts/native/android/jniLibs/${arch}/libtbc_engine_native.so`,t]));
  for(const[p,t]of Object.entries(mapping)){await cp(artifact(standalone.artifacts,t).path,join(dir,p));if(platform==='android')await stripAndroid(join(dir,p));}
  let bytes=0;for(const p of Object.keys(entry.files)){const b=await readFile(join(dir,p));entry.files[p]=sha(b);bytes+=b.length;}
  entry.archive=`tbc-kit-resources-${platform}-${version}.tgz`;const path=join(out,'native',entry.archive);
  execFileSync('tar',['--no-xattrs','-czf',path,'-C',dir,'artifacts'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
  const b=await readFile(path);entry.archiveSha256=sha(b);entry.archiveBytes=b.length;entry.unpackedNativeBytes=bytes;
  archives.push({name:'native/'+entry.archive,sha256:sha(b),bytes:b.length});
 }
 await save(join(kit,'artifacts/platform-resources.json'),catalog);
 const provenance=await json(join(kit,'artifacts/provenance.json'));
 provenance.protocolFingerprint=fingerprint;provenance.rustSourceSha256=report.sourceSha256;
 const wasm=await readFile(join(kit,allowedKit[0]));Object.assign(provenance.artifacts.find(a=>a.role==='engine'),{sha256:sha(wasm),bytes:wasm.length});
 for(const a of provenance.externalArtifacts)a.sha256=catalog.platforms[a.platform].files[a.path];
 provenance.platformResources.sha256=sha(await readFile(join(kit,'artifacts/platform-resources.json')));
 await save(join(kit,'artifacts/provenance.json'),provenance);
 const manifest=await json(join(flutter,'distribution.json'));
 manifest.artifactId=sha(JSON.stringify({parent:manifest.artifactId,source:report.sourceSha256,version}));
 manifest.kitIdentity={...manifest.kitIdentity,protocolFingerprint:fingerprint,rustSourceSha256:report.sourceSha256};
 manifest.androidEngineSha256=sha(await readFile(join(flutter,allowedFlutter[0])));
 const engine=join(repo,'source/native/flutter/ios/engine'),headers=['tbc-engine-native/include/tbc_engine.h','tbc-keyless-native/include/tbc_keyless.h'].map(p=>join(compute,'source/packages/tbc-engine/rust/crates',p));
 for(const[arch,target,sdk]of [['ios-arm64','aarch64-apple-ios','iphoneos'],['ios-arm64-simulator','aarch64-apple-ios-sim','iphonesimulator']]){
  const p=`ios/Frameworks/TbcFlutterEngine.xcframework/${arch}/TbcFlutterEngine.framework/TbcFlutterEngine`,exports=join(out,arch+'-engine.exports');allowedFlutter.push(p);
  const sdkpath=execFileSync('xcrun',['--sdk',sdk,'--show-sdk-path'],{encoding:'utf8'}).trim();
  execFileSync('xcrun',['clang++','-std=c++17','-fobjc-arc','-dynamiclib','-target',`arm64-apple-ios15.0${sdk==='iphonesimulator'?'-simulator':''}`,'-isysroot',sdkpath,
   `-ffile-prefix-map=${repo}=/tbc-kit`,`-ffile-prefix-map=${compute}=/tbc-build`,...applePublicLinkFlags(exports,headers,['TbcFlutterEngine']),
   `-DTBC_FLUTTER_ARTIFACT_ID="${manifest.artifactId}"`,'-I',join(compute,'source/packages/tbc-engine/rust/crates/tbc-engine-native/include'),
   '-framework','Foundation','-framework','Security',join(engine,'TbcFlutterEngine.mm'),artifact(report.artifacts,target).path,
   '-Wl,-install_name,@rpath/TbcFlutterEngine.framework/TbcFlutterEngine','-o',join(flutter,p)],{stdio:'pipe'});
  verifyApplePublicAbi(join(flutter,p),exports);stripAppleDebugSymbols(join(flutter,p));
 }
 for(const p of allowedFlutter)manifest.nativeArtifacts[p]=sha(await readFile(join(flutter,p)));
 await save(join(flutter,'distribution.json'),manifest);
 manifest.approvalOutputPostprocessing=postprocessing;await save(join(flutter,'distribution.json'),manifest);
 return {fingerprint,sourceSha256:report.sourceSha256,allowedKit,allowedFlutter,archives,postprocessing,signerChanged:false,pageChanged:false};
}
