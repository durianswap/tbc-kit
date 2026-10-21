// Independent output-disclosure candidate. Retain the accepted Signer and all
// frozen archives. Stage sources once, excluding unrelated pending multisig work.
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const source=resolve(import.meta.dirname,'../../..'),repo=resolve(source,'..');
// The excluded keyless implementation belongs to the frozen delivery, not a
// moving HEAD that may later include unrelated work.
const frozenSourceCommit='23ab0bd5294dd19f4746011215c8b3e9c76a1470';
const [outArg,ndkArg]=process.argv.slice(2);assert(outArg&&ndkArg,'NEW_OUTPUT NDK');
const out=resolve(outArg),workspace=join(out,'source/packages/tbc-engine/rust'),target=join(out,'target');
const sha=b=>createHash('sha256').update(b).digest('hex');
await mkdir(dirname(out),{recursive:true});await mkdir(out);await mkdir(workspace,{recursive:true});
for(const p of ['Cargo.toml','Cargo.lock','crates','vendor','fixtures'])await cp(join(source,'packages/tbc-engine/rust',p),join(workspace,p),{recursive:true});
const excluded=['crates/tbc-keyless-core/src/lib.rs','crates/tbc-keyless-core/src/multisig.rs','crates/tbc-keyless-core/tests/multisig.rs'];
for(const p of excluded)await writeFile(join(workspace,p),execFileSync('git',['show',frozenSourceCommit+':source/packages/tbc-engine/rust/'+p],{cwd:repo}));
await cp(join(source,'native/flutter-compat/compute-dedup'),join(workspace,'crates/tbc-compute-native'),{recursive:true});
const cargo=await readFile(join(workspace,'Cargo.toml'),'utf8');
await writeFile(join(workspace,'Cargo.toml'),cargo.replace('members = [','members = [\n  "crates/tbc-compute-native",'));
const lock=await readFile(join(workspace,'Cargo.lock'),'utf8');
const entry='[[package]]\nname = "tbc-compute-native"\nversion = "0.1.0"\ndependencies = [\n "serde_json",\n "tbc-engine-core",\n "tbc-keyless-core",\n "tbc-wallet-private-core",\n]\n\n';
assert(!lock.includes('name = "tbc-compute-native"'));await writeFile(join(workspace,'Cargo.lock'),lock.replace('[[package]]\nname = "tbc-engine-',entry+'[[package]]\nname = "tbc-engine-'));
const files={};async function inventory(p){for(const e of await readdir(join(workspace,p),{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())await inventory(f);else files[f]=sha(await readFile(join(workspace,f)));}}
await inventory('');
const report={status:'BUILDING',files,sourceSha256:sha(JSON.stringify(files)),excludedWorkingChanges:excluded,artifacts:[],signerChanged:false,published:false};
const save=()=>writeFile(join(out,'build-report.json'),JSON.stringify(report,null,2)+'\n');await save();
async function run(label,args,env){
 console.log('Building '+label);const chunks=[];const p=spawn('cargo',args,{cwd:workspace,env,stdio:['ignore','pipe','pipe']});
 p.stdout.on('data',b=>chunks.push(b));p.stderr.on('data',b=>chunks.push(b));
 const code=await new Promise((r,j)=>{p.on('error',j);p.on('close',r)});
 await writeFile(join(out,label+'.log'),Buffer.concat(chunks));assert.equal(code,0,label+' failed; inspect log');
}
function env(){const e={...process.env,CARGO_TARGET_DIR:target};for(const k of Object.keys(e))if(k.startsWith('CARGO_PROFILE_')||['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS'].includes(k))delete e[k];return e;}
try{
 for(const [triple,sdk]of [['aarch64-apple-darwin','macosx'],['aarch64-linux-android',null],['aarch64-apple-ios','iphoneos'],['aarch64-apple-ios-sim','iphonesimulator']]){
  const e=env(),flags=`--remap-path-prefix=${out}=/tbc-candidate --remap-path-prefix=${process.env.HOME}/.cargo=/cargo`;
  if(sdk){e.SDKROOT=execFileSync('xcrun',['--sdk',sdk,'--show-sdk-path'],{encoding:'utf8'}).trim();e.RUSTFLAGS=flags;if(sdk!=='macosx')e.IPHONEOS_DEPLOYMENT_TARGET='15.0';}
  else {const bin=join(resolve(ndkArg),'toolchains/llvm/prebuilt/darwin-x86_64/bin');Object.assign(e,{CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER:join(bin,'aarch64-linux-android23-clang'),CC_aarch64_linux_android:join(bin,'aarch64-linux-android23-clang'),AR_aarch64_linux_android:join(bin,'llvm-ar'),CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS:flags+' -C link-arg=-Wl,-z,max-page-size=16384'});}
  await run(triple,['build','--locked','--offline','--release','-p','tbc-compute-native','--target',triple],e);
  const p=join(target,triple,'release','libtbc_compute_native.'+(sdk==='macosx'?'dylib':sdk?'a':'so')),bytes=await readFile(p);
  report.artifacts.push({target:triple,path:p,sha256:sha(bytes),bytes:bytes.length});await save();
 }
 await run('wasm',['build','--locked','--offline','--release','-p','tbc-engine-wasm','--target','wasm32-unknown-unknown'],{...env(),RUSTFLAGS:'--cfg getrandom_backend="unsupported"'});
 const p=join(target,'wasm32-unknown-unknown/release/tbc_engine_wasm.wasm'),bytes=await readFile(p);
 report.artifacts.push({target:'wasm32-unknown-unknown',path:p,sha256:sha(bytes),bytes:bytes.length});
 report.status='BUILT_PENDING_ACCEPTANCE';await save();console.log(JSON.stringify({status:report.status,out}));
}catch(e){report.status='FAIL';report.error=String(e);await save();throw e;}
