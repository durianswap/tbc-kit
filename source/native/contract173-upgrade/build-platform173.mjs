// Reuse the verified staged source/cache, but create new immutable resource sets.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {fileInventory} from '../../packages/kit/scripts/platform-resources.mjs';
import {sha256} from '../flutter/scripts/candidate-inputs.mjs';
const [computeArg,ndkArg,outArg]=process.argv.slice(2);assert(computeArg&&ndkArg&&outArg,'COMPUTE_BUILD NDK NEW_OUTPUT');
const compute=resolve(computeArg),out=resolve(outArg),staged=join(compute,'source'),workspace=join(staged,'packages/tbc-engine/rust');
const report=JSON.parse(await readFile(join(compute,'build-report.json')));assert.equal(report.status,'BUILT_NOT_DEVICE_ACCEPTED');
// Workspace membership/lock changes for the deduplicated ABI are intentional;
// the compiled crate sources must still match the recorded source snapshot.
for(const [path,hash]of Object.entries(report.sourceFiles))if(!['packages/tbc-engine/rust/Cargo.toml','packages/tbc-engine/rust/Cargo.lock'].includes(path))assert.equal(sha256(await readFile(join(staged,path))),hash,path);
await mkdir(out);const tools=join(resolve(ndkArg),'toolchains/llvm/prebuilt/darwin-x86_64/bin'),evidence=[];
async function build(target,sdk,clang){
 const env={...process.env,CARGO_TARGET_DIR:join(compute,'target')};
 for(const k of Object.keys(env))if(k.startsWith('CARGO_PROFILE_')||k==='RUSTFLAGS'||k==='CARGO_ENCODED_RUSTFLAGS')delete env[k];
 const flags=`--remap-path-prefix=${staged}=/tbc-source --remap-path-prefix=${process.env.HOME}/.cargo=/cargo`;
 if(sdk){env.SDKROOT=execFileSync('xcrun',['--sdk',sdk,'--show-sdk-path'],{encoding:'utf8'}).trim();env.RUSTFLAGS=flags;if(sdk!=='macosx')env.IPHONEOS_DEPLOYMENT_TARGET='15.0';}
 else {const lower=target.replaceAll('-','_'),upper=lower.toUpperCase();Object.assign(env,{[`CARGO_TARGET_${upper}_LINKER`]:join(tools,clang),[`CC_${lower}`]:join(tools,clang),[`AR_${lower}`]:join(tools,'llvm-ar'),[`CARGO_TARGET_${upper}_RUSTFLAGS`]:flags+' -C link-arg=-Wl,-z,max-page-size=16384'});}
 const crates=['tbc-engine-native',...(sdk==='macosx'?['tbc-keyless-native']:[])];
 const args=['build','--locked','--offline','--release',...crates.flatMap(c=>['-p',c]),'--target',target];
 console.log('Building platform resource '+target);const chunks=[];
 const p=spawn('cargo',args,{cwd:workspace,env,stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>chunks.push(b));p.stderr.on('data',b=>chunks.push(b));
 const code=await new Promise((res,rej)=>{p.on('error',rej);p.on('close',res)});
 await writeFile(join(out,target+'.log'),Buffer.concat(chunks));assert.equal(code,0,'Build failed '+target);
 const ext=sdk==='macosx'?'dylib':sdk?'a':'so',path=join(compute,'target',target,'release','libtbc_engine_native.'+ext);
 const bytes=await readFile(path);evidence.push({target,path,sha256:sha256(bytes),bytes:bytes.length});return path;
}
async function copy(source,path){await mkdir(dirname(join(out,path)),{recursive:true});await cp(source,join(out,path),{errorOnExist:true,force:false});}
await copy(await build('aarch64-apple-darwin','macosx'), 'macos-arm64/artifacts/native/aarch64-apple-darwin/libtbc_engine_native.dylib');
for(const file of ['libtbc_keyless_native.dylib','tbc_keyless.h','module.modulemap'])await copy(file.endsWith('.dylib')?join(compute,'target/aarch64-apple-darwin/release',file):join(workspace,'crates/tbc-keyless-native/include',file),'macos-arm64/artifacts/keyless-native/aarch64-apple-darwin/'+file);
for(const [target,abi,clang]of [['aarch64-linux-android','arm64-v8a','aarch64-linux-android23-clang'],['armv7-linux-androideabi','armeabi-v7a','armv7a-linux-androideabi23-clang'],['x86_64-linux-android','x86_64','x86_64-linux-android23-clang']])await copy(await build(target,null,clang),`android/artifacts/native/android/jniLibs/${abi}/libtbc_engine_native.so`);
const libs=[];for(const [target,sdk]of [['aarch64-apple-ios','iphoneos'],['aarch64-apple-ios-sim','iphonesimulator']])libs.push(await build(target,sdk));
await mkdir(join(out,'ios/artifacts/native/ios'),{recursive:true});
execFileSync('xcodebuild',['-create-xcframework',...libs.flatMap(p=>['-library',p,'-headers',join(workspace,'crates/tbc-engine-native/include')]),'-output',join(out,'ios/artifacts/native/ios/TbcEngineNative.xcframework')],{stdio:'pipe'});
const platforms={};for(const p of ['macos-arm64','android','ios'])platforms[p]=await fileInventory(join(out,p));
const result={status:'BUILT_NOT_DEVICE_ACCEPTED',source:report.source,computeReportSha256:sha256(await readFile(join(compute,'build-report.json'))),evidence,platforms};
await writeFile(join(out,'platform-build.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,out,source:result.source,evidence}));
