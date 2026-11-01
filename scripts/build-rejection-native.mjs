// Independent candidate build. Never writes accepted artifacts or reads keys.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {fileInventory,sha256} from '../source/packages/kit/scripts/platform-resources.mjs';
const repo=resolve(import.meta.dirname,'..'),[outArg,ndkArg]=process.argv.slice(2);
assert(outArg&&ndkArg,'NEW_BUILD_DIR NDK');
const out=resolve(outArg),workspace=join(out,'rust'),target=join(out,'target');
await mkdir(out);await mkdir(workspace);
for(const p of ['Cargo.toml','Cargo.lock','crates','vendor','fixtures'])await cp(join(repo,'source/packages/tbc-engine/rust',p),join(workspace,p),{recursive:true});
const files=await fileInventory(workspace),report={status:'BUILDING',sourceDigest:sha256(JSON.stringify(files)),files,artifacts:[],broadcasts:0};
const save=()=>writeFile(join(out,'build.json'),JSON.stringify(report,null,2)+'\n');await save();
try {
 for(const [triple,sdk,clang]of [['wasm32-unknown-unknown'],['aarch64-apple-darwin','macosx'],['aarch64-apple-ios','iphoneos'],['aarch64-apple-ios-sim','iphonesimulator'],
  ['aarch64-linux-android',null,'aarch64-linux-android23'],['armv7-linux-androideabi',null,'armv7a-linux-androideabi23'],['x86_64-linux-android',null,'x86_64-linux-android23']]) {
  const env={...process.env,CARGO_TARGET_DIR:target};
  for(const key of Object.keys(env))if(key.startsWith('CARGO_PROFILE_')||['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS'].includes(key))delete env[key];
  const flags=`--remap-path-prefix=${out}=/tbc-candidate --remap-path-prefix=${process.env.HOME}/.cargo=/cargo`;
  const wasm=triple.startsWith('wasm');
  if(wasm)env.RUSTFLAGS=flags+' --cfg getrandom_backend="unsupported"';
  else if(sdk){env.SDKROOT=execFileSync('xcrun',['--sdk',sdk,'--show-sdk-path'],{encoding:'utf8'}).trim();env.RUSTFLAGS=flags;if(sdk!=='macosx')env.IPHONEOS_DEPLOYMENT_TARGET='15.1';}
  else {const bin=join(resolve(ndkArg),'toolchains/llvm/prebuilt/darwin-x86_64/bin'),key=triple.replaceAll('-','_');
   env['CARGO_TARGET_'+key.toUpperCase()+'_LINKER']=join(bin,clang+'-clang');env['CC_'+key]=join(bin,clang+'-clang');env['AR_'+key]=join(bin,'llvm-ar');
   env['CARGO_TARGET_'+key.toUpperCase()+'_RUSTFLAGS']=flags+' -C link-arg=-Wl,-z,max-page-size=16384';}
  console.log('Building '+triple);
  const chunks=[],p=spawn('cargo',['build','--offline','--locked','--release','-p',wasm?'tbc-engine-wasm':'tbc-engine-native','--target',triple],{cwd:workspace,env,stdio:['ignore','pipe','pipe']});
  p.stdout.on('data',b=>chunks.push(b));p.stderr.on('data',b=>chunks.push(b));
  const code=await new Promise((r,j)=>{p.on('error',j);p.on('close',r)});await writeFile(join(out,triple+'.log'),Buffer.concat(chunks));assert.equal(code,0,triple+' failed');
  const path=join(target,triple,'release',wasm?'tbc_engine_wasm.wasm':'libtbc_engine_native.'+(sdk==='macosx'?'dylib':sdk?'a':'so')),bytes=await readFile(path);
  report.artifacts.push({target:triple,path,sha256:sha256(bytes),bytes:bytes.length});await save();console.log(JSON.stringify(report.artifacts.at(-1)));
 }
 assert.deepEqual(await fileInventory(workspace),files,'Staged Rust changed during build');report.status='BUILT_NOT_DEVICE_ACCEPTED';await save();
} catch(e){report.status='FAIL';report.error=String(e);await save();throw e;}
