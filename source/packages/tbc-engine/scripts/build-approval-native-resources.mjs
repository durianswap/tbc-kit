// Pair standalone native resources with the exact staged candidate sources.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const compute=resolve(process.argv[2]),ndk=resolve(process.argv[3]),workspace=join(compute,'source/packages/tbc-engine/rust'),target=join(compute,'target');
const parent=JSON.parse(await readFile(join(compute,'build-report.json')));assert.equal(parent.status,'BUILT_PENDING_ACCEPTANCE');
const report={sourceSha256:parent.sourceSha256,artifacts:[],status:'BUILDING'};
for(const[triple,sdk,clang]of [['aarch64-apple-darwin','macosx'],['aarch64-apple-ios','iphoneos'],['aarch64-apple-ios-sim','iphonesimulator'],
 ['aarch64-linux-android',null,'aarch64-linux-android23'],['armv7-linux-androideabi',null,'armv7a-linux-androideabi23'],['x86_64-linux-android',null,'x86_64-linux-android23']]){
 const env={...process.env,CARGO_TARGET_DIR:target};for(const k of Object.keys(env))if(k.startsWith('CARGO_PROFILE_')||['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS'].includes(k))delete env[k];
 const flags=`--remap-path-prefix=${compute}=/tbc-candidate --remap-path-prefix=${process.env.HOME}/.cargo=/cargo`;
 if(sdk){env.SDKROOT=execFileSync('xcrun',['--sdk',sdk,'--show-sdk-path'],{encoding:'utf8'}).trim();env.RUSTFLAGS=flags;if(sdk!=='macosx')env.IPHONEOS_DEPLOYMENT_TARGET='15.0';}
 else{const bin=join(ndk,'toolchains/llvm/prebuilt/darwin-x86_64/bin'),key=triple.replaceAll('-','_');
  env['CARGO_TARGET_'+key.toUpperCase()+'_LINKER']=join(bin,clang+'-clang');env['CC_'+key]=join(bin,clang+'-clang');env['AR_'+key]=join(bin,'llvm-ar');
  env['CARGO_TARGET_'+key.toUpperCase()+'_RUSTFLAGS']=flags+' -C link-arg=-Wl,-z,max-page-size=16384';}
 console.log('Standalone Engine '+triple);const chunks=[];const proc=spawn('cargo',['build','--offline','--locked','--release','-p','tbc-engine-native','--target',triple],{cwd:workspace,env,stdio:['ignore','pipe','pipe']});
 proc.stdout.on('data',b=>chunks.push(b));proc.stderr.on('data',b=>chunks.push(b));const code=await new Promise((r,j)=>{proc.on('error',j);proc.on('close',r)});
 await writeFile(join(compute,'standalone-'+triple+'.log'),Buffer.concat(chunks));assert.equal(code,0,triple);
 const path=join(target,triple,'release/libtbc_engine_native.'+(sdk==='macosx'?'dylib':sdk?'a':'so')),bytes=await readFile(path);
 report.artifacts.push({target:triple,path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
}
report.status='BUILT';await writeFile(join(compute,'native-resources-build.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,targets:report.artifacts.length}));
