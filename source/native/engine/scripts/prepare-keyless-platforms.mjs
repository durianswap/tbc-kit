// Maintainer-only companion artifacts for the existing keyless Rust code.
// Never overwrites an Engine/Kit candidate; no network, key or signing service.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,cp,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {iosBuildEnvironment,assertIosDeployment} from '../../../packages/tbc-engine/scripts/ios-deployment.mjs';
import {prepareKeylessAppleHeaders} from './keyless-apple-headers.mjs';
const [outArg,ndkArg]=process.argv.slice(2);
assert.ok(outArg&&ndkArg,'Usage: NEW_OUTPUT ANDROID_NDK');
const output=resolve(outArg),ndk=resolve(ndkArg),repo=resolve(import.meta.dirname,'../../..');
await mkdir(output);await mkdir(join(output,'source'));
const workspace=join(output,'source/packages/tbc-engine/rust');
const archive=join(output,'source.tgz');
// Preserve repository-relative fixture paths used by the Reviewed integration
// test; the isolated source archive must be sufficient to run its own tests.
execFileSync('tar',['-czf',archive,'-C',repo,
 ...['Cargo.toml','Cargo.lock','crates','vendor','fixtures'].map(p=>'packages/tbc-engine/rust/'+p),
 'packages/kit/test/fixtures/controlled-pool.json']);
execFileSync('tar',['-xzf',archive,'-C',join(output,'source')]);
const sha=b=>createHash('sha256').update(b).digest('hex');
const sourceSha256=sha(await readFile(archive));
const env={...process.env,CARGO_TARGET_DIR:join(output,'target')};
const run=(cmd,args,extra={})=>execFileSync(cmd,args,{cwd:workspace,env,stdio:'inherit',...extra});
const text=(cmd,args)=>run(cmd,args,{encoding:'utf8',stdio:'pipe',maxBuffer:64*1024*1024});
const build=(target,extra={})=>run('cargo',['build','--locked','--offline','--release','-p','tbc-keyless-native','--target',target],{env:{...env,...extra}});
const copy=async(a,b)=>{await mkdir(dirname(b),{recursive:true});await cp(a,b,{recursive:true});};
const include=join(workspace,'crates/tbc-keyless-native/include');
const host=text('rustc',['-vV']).match(/^host: (.+)$/m)?.[1];assert.equal(host,'aarch64-apple-darwin');
run('cargo',['test','--locked','--offline','-p','tbc-keyless-core','-p','tbc-keyless-native']);
build(host);await copy(join(output,'target',host,'release/libtbc_keyless_native.dylib'),join(output,'artifacts/desktop/libtbc_keyless_native.dylib'));
await copy(include,join(output,'artifacts/include'));
const ios=[];
for(const target of ['aarch64-apple-ios','aarch64-apple-ios-sim']){
 const sdk=text('xcrun',['--sdk',target.endsWith('-sim')?'iphonesimulator':'iphoneos','--show-sdk-path']).trim();
 build(target,iosBuildEnvironment(target,sdk,env));
 const library=join(output,'target',target,'release/libtbc_keyless_native.a');
 ios.push({target,...assertIosDeployment(text('xcrun',['otool','-l',library]))});
}
const appleHeaders=join(output,'apple-headers');
await prepareKeylessAppleHeaders(include,appleHeaders);
run('xcodebuild',['-create-xcframework',...['aarch64-apple-ios','aarch64-apple-ios-sim'].flatMap(t=>['-library',join(output,'target',t,'release/libtbc_keyless_native.a'),'-headers',appleHeaders]),'-output',join(output,'artifacts/TbcKeylessNative.xcframework')]);
const tools=join(ndk,'toolchains/llvm/prebuilt/darwin-x86_64/bin');
for(const [target,abi,cc] of [['aarch64-linux-android','arm64-v8a','aarch64-linux-android'],['armv7-linux-androideabi','armeabi-v7a','armv7a-linux-androideabi'],['x86_64-linux-android','x86_64','x86_64-linux-android']]){
 const key=target.replaceAll('-','_');build(target,{[`CARGO_TARGET_${key.toUpperCase()}_LINKER`]:join(tools,cc+'24-clang'),[`CC_${key}`]:join(tools,cc+'24-clang'),[`AR_${key}`]:join(tools,'llvm-ar'),[`CARGO_TARGET_${key.toUpperCase()}_RUSTFLAGS`]:'-C link-arg=-Wl,-z,max-page-size=16384'});
 await copy(join(output,'target',target,'release/libtbc_keyless_native.so'),join(output,'artifacts/android',abi,'libtbc_keyless_native.so'));
}
const hashes={};async function scan(relative=''){for(const e of await readdir(join(output,'artifacts',relative),{withFileTypes:true})){const p=join(relative,e.name);if(e.isDirectory())await scan(p);else hashes[p]=sha(await readFile(join(output,'artifacts',p)));}}await scan();
const coreSource=await readFile(join(workspace,'crates/tbc-keyless-core/src/lib.rs'),'utf8');
const operationBlock=coreSource.match(/pub const OPERATIONS: &\[&str\] = &\[([\s\S]*?)\];/)?.[1];
assert.ok(operationBlock,'Missing source operation registry');
const operations=[...operationBlock.matchAll(/"([A-Za-z]+)"/g)].map(m=>m[1]);
assert.ok(operations.includes('prepareMultisig')&&operations.includes('finalizeMultisig'));
const identity={status:'BUILT_NOT_ACCEPTED',sourceSha256,sourceArchive:archive,artifactSetId:sha(JSON.stringify(hashes)),hashes,ios,rustc:text('rustc',['-vV']),operations,sourceLogicChanged:true,signing:false,network:false};
await writeFile(join(output,'identity.json'),JSON.stringify(identity,null,2)+'\n');console.log(JSON.stringify({output,artifactSetId:identity.artifactSetId,status:identity.status}));
