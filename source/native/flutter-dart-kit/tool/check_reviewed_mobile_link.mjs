// Compile/link the exact thin bridge against the frozen Android/iOS binaries.
// Does not install, execute a mobile App, or copy another Rust/Hermes runtime.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {buildReviewedAndroid,stageReviewedIos,reviewedInputs,reviewedFlags} from './reviewed_bridge_build.mjs';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),output=process.argv[2],sha=b=>createHash('sha256').update(b).digest('hex');
const scratch=await mkdtemp(join(tmpdir(),'tbc-dart-reviewed-mobile-link-'));
try{
 const input=await reviewedInputs();const iosSources=await stageReviewedIos(join(scratch,'ios-source'));
 const android=await buildReviewedAndroid(join(scratch,'libtbc_dart_reviewed.so'),process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk'));
 const ios=[];
 for(const [sdkName,arch,target]of [['iphonesimulator','ios-arm64-simulator','arm64-apple-ios15.0-simulator'],['iphoneos','ios-arm64','arm64-apple-ios15.0']]){
  const library=await input.binary(`ios/Frameworks/TbcFlutterEngine.xcframework/${arch}/TbcFlutterEngine.framework/TbcFlutterEngine`);
  const sdk=(await run('/usr/bin/xcrun',['--sdk',sdkName,'--show-sdk-path'])).stdout.trim(),artifact=join(scratch,arch+'.dylib');
  await run('/usr/bin/xcrun',['clang++',...reviewedFlags,'-nostdlib++','-dynamiclib','-isysroot',sdk,'-target',target,'-I'+join(scratch,'ios-source'),join(scratch,'ios-source/reviewed_compute.cpp'),library,'-o',artifact],{timeout:120000,maxBuffer:2**20});
  const linked=(await run('/usr/bin/xcrun',['otool','-L',artifact])).stdout;
  assert(linked.includes('TbcFlutterEngine.framework/TbcFlutterEngine'));assert(!linked.includes('libc++')&&!linked.includes('Hermes'));
  const bytes=await readFile(artifact);ios.push({target,bytes:bytes.length,sha256:sha(bytes),dependency:'unchanged TbcFlutterEngine.framework',extraCxxRuntime:false});
 }
 const sources={};
 for(const p of ['platform/native/reviewed_compute.cpp','platform/native/reviewed_compute.h','platform/native/module.modulemap','platform/android/src/main/cpp/reviewed-jni.cpp','platform/android/consumer-rules.pro','tool/reviewed_bridge_build.mjs','tool/check_reviewed_mobile_link.mjs','tool/prepare_consumer.mjs','tool/collect_consumer.mjs'])sources[p]=sha(await readFile(join(base,p)));
 const report={status:'F3_REVIEWED_MOBILE_LINK_PASS',recordedAt:new Date().toISOString(),android,ios,iosSources,sources,scratch,
  proofLimit:'Android arm64 API26 and iOS arm64 device/simulator15.0 compile/link only. Not installed execution, minimum-OS validation, Vault signing or App size.',
  unchangedFrozenRuntime:true,extraHermes:false,chainHttp:0,broadcasts:0,acceptedDeliveryChanged:false,goalComplete:false};
 const bytes=JSON.stringify(report,null,2)+'\n';if(output)await writeFile(resolve(base,output),bytes,{flag:'wx'});
 console.log(JSON.stringify({status:report.status,android,ios,sha256:sha(bytes),scratch}));
}catch(e){console.error(JSON.stringify({status:'FAIL',code:e.code,message:e.stderr?undefined:e.message,stderr:e.stderr?.slice(-6000),scratch}));process.exitCode=1;}
