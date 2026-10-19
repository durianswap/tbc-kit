// Authorized 1.7.3 source snapshot, never an in-place update of the accepted
// kernels. Reuse the accepted deduplicated ABI and compilation policy.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,stat} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {join,resolve,dirname} from 'node:path';
import {rustSourceIdentity,sha256} from '../flutter/scripts/candidate-inputs.mjs';
const root=resolve(import.meta.dirname,'../..');
const [ndkArg,outArg]=process.argv.slice(2);assert(ndkArg&&outArg,'NDK NEW_OUTPUT required');
const out=resolve(outArg),ndk=resolve(ndkArg),staged=join(out,'source'),workspace=join(staged,'packages/tbc-engine/rust');
const before=await rustSourceIdentity(root);
const baseline=await rustSourceIdentity('/private/tmp/tbc-amm-funding-compute-20261011-a/source');
for(const [path,hash]of Object.entries(before.files))if(path.startsWith('native/signer/kernel/'))
  assert.equal(hash,baseline.files[path],'Signer source changed: '+path);
await mkdir(out); // Unique candidate only, no reuse of an unfinished directory.
for(const path of Object.keys(before.files)){
  await mkdir(dirname(join(staged,path)),{recursive:true});await cp(join(root,path),join(staged,path),{errorOnExist:true,force:false});
}
await cp(join(root,'packages/tbc-engine/rust/fixtures'),join(workspace,'fixtures'),{recursive:true,errorOnExist:true,force:false});
assert.equal((await rustSourceIdentity(staged)).sha256,before.sha256,'Source changed while staging');
await cp(join(root,'native/flutter-compat/compute-dedup'),join(workspace,'crates/tbc-compute-native'),{recursive:true});
const cargoPath=join(workspace,'Cargo.toml'),cargo=await readFile(cargoPath,'utf8');
assert.equal(cargo.split('members = [').length,2);
await writeFile(cargoPath,cargo.replace('members = [','members = [\n  "crates/tbc-compute-native",'));
const lockPath=join(workspace,'Cargo.lock'),lock=await readFile(lockPath,'utf8');
const entry='[[package]]\nname = "tbc-compute-native"\nversion = "0.1.0"\ndependencies = [\n "serde_json",\n "tbc-engine-core",\n "tbc-keyless-core",\n "tbc-wallet-private-core",\n]\n\n';
assert(!lock.includes('name = "tbc-compute-native"'));
await writeFile(lockPath,lock.replace('[[package]]\nname = "tbc-engine-',entry+'[[package]]\nname = "tbc-engine-'));
const report={status:'BUILDING',upstream:'1.7.3',source:before.sha256,sourceFiles:before.files,
  baselineSource:baseline.sha256,template:{},builds:[],wasm:[],signerModified:false,deviceAccepted:false,
  networkRequests:0,broadcasts:0,scope:'Local cross-built candidate only, not partner handoff or installed acceptance'};
for(const p of ['Cargo.toml','src/lib.rs'])report.template[p]=sha256(await readFile(join(root,'native/flutter-compat/compute-dedup',p)));
const save=()=>writeFile(join(out,'build-report.json'),JSON.stringify(report,null,2)+'\n');await save();
async function run(label,args,env){
  console.log('Building '+label);const chunks=[];
  const p=spawn('cargo',args,{cwd:workspace,env,stdio:['ignore','pipe','pipe']});
  p.stdout.on('data',b=>chunks.push(b));p.stderr.on('data',b=>chunks.push(b));
  const code=await new Promise((res,rej)=>{p.on('error',rej);p.on('close',res);});
  await writeFile(join(out,label+'.log'),Buffer.concat(chunks));assert.equal(code,0,label+' build failed; inspect retained log');
}
const tools=join(ndk,'toolchains/llvm/prebuilt/darwin-x86_64/bin');
const cleanEnv=()=>{const env={...process.env,CARGO_TARGET_DIR:join(out,'target')};
  for(const key of Object.keys(env))if(key.startsWith('CARGO_PROFILE_')||key==='RUSTFLAGS'||key==='CARGO_ENCODED_RUSTFLAGS')delete env[key];return env;};
try{
  for(const [target,sdk]of [['aarch64-apple-darwin','macosx'],['aarch64-linux-android',null],['aarch64-apple-ios','iphoneos'],['aarch64-apple-ios-sim','iphonesimulator']]){
    const env=cleanEnv(),flags=`--remap-path-prefix=${staged}=/tbc-source --remap-path-prefix=${process.env.HOME}/.cargo=/cargo`;
    if(sdk){env.SDKROOT=execFileSync('xcrun',['--sdk',sdk,'--show-sdk-path'],{encoding:'utf8'}).trim();env.RUSTFLAGS=flags;if(sdk!=='macosx')env.IPHONEOS_DEPLOYMENT_TARGET='15.0';}
    else Object.assign(env,{CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER:join(tools,'aarch64-linux-android23-clang'),
      CC_aarch64_linux_android:join(tools,'aarch64-linux-android23-clang'),AR_aarch64_linux_android:join(tools,'llvm-ar'),
      CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS:flags+' -C link-arg=-Wl,-z,max-page-size=16384'});
    await run(target,['build','--locked','--offline','--release','-p','tbc-compute-native','--target',target],env);
    const ext=target.includes('android')?'so':target.endsWith('darwin')?'dylib':'a';
    const path=join(out,'target',target,'release',`libtbc_compute_native.${ext}`);
    report.builds.push({target,path,bytes:(await stat(path)).size,sha256:sha256(await readFile(path))});await save();
    console.log(JSON.stringify(report.builds.at(-1)));
  }
  await run('wasm',['build','--locked','--offline','--release','-p','tbc-engine-wasm','-p','tbc-keyless-wasm','--target','wasm32-unknown-unknown'],
    {...cleanEnv(),RUSTFLAGS:'--cfg getrandom_backend="unsupported"'});
  for(const lane of ['engine','keyless']){
    const path=join(out,'target/wasm32-unknown-unknown/release',`tbc_${lane}_wasm.wasm`);
    report.wasm.push({lane,path,bytes:(await stat(path)).size,sha256:sha256(await readFile(path))});
  }
  const after=await rustSourceIdentity(staged);
  for(const [p,hash]of Object.entries(before.files))if(!['packages/tbc-engine/rust/Cargo.toml','packages/tbc-engine/rust/Cargo.lock'].includes(p))assert.equal(after.files[p],hash,p);
  assert.equal((await readFile(cargoPath,'utf8')).replace('members = [\n  "crates/tbc-compute-native",','members = ['),cargo);
  assert.equal((await readFile(lockPath,'utf8')).replace(entry,''),lock);
  report.stagedSourceSha256=after.sha256;report.status='BUILT_NOT_DEVICE_ACCEPTED';await save();
  console.log(JSON.stringify({status:report.status,out,source:report.source,builds:report.builds,wasm:report.wasm}));
}catch(error){report.status='FAILED';report.error=String(error);await save();throw error;}
