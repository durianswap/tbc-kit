// A disposable complete test workspace. Do not write to shared node_modules or frozen packages.
import {readFile,writeFile,mkdir,mkdtemp,cp,readdir,symlink,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
const repo=resolve(import.meta.dirname,'..'),installed=resolve(process.argv[2]);
const scratch=await mkdtemp(join(repo,'.verify/extreme-source-')),root=join(scratch,'source');await mkdir(root);
const files=[...new Set(execFileSync('git',['ls-files','-c','-o','--exclude-standard','-z','source'],{cwd:repo}).toString().split('\0').filter(Boolean))];
for(const p of files){const dest=join(scratch,p);await mkdir(dirname(dest),{recursive:true});await cp(join(repo,p),dest)}
const deps=await realpath(join(repo,'source/node_modules')),modules=join(root,'node_modules');await mkdir(modules);
for(const name of await readdir(deps)){if(name==='@tbc-wallet')continue;await symlink(join(deps,name),join(modules,name));}
await mkdir(join(modules,'@tbc-wallet'));
for(const name of ['core','host','provider','wallet-standard','tbc-engine'])await symlink(join(root,'packages',name),join(modules,'@tbc-wallet',name));
await symlink(join(installed,'dist'),join(root,'packages/kit/dist'));
await mkdir(join(root,'packages/kit/artifacts'),{recursive:true});
// Source-only exports can contain older generated fixtures. The disposable
// workspace must run the installed candidate's exact compute bytes instead.
await cp(join(installed,'artifacts/wasm'),join(root,'packages/kit/artifacts/wasm'),{recursive:true,force:true});
const wasmTarget=join(root,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release');await mkdir(wasmTarget,{recursive:true});
for(const name of ['tbc_keyless_wasm.wasm','tbc_engine_wasm.wasm'])await symlink(join(installed,'artifacts/wasm',name),join(wasmTarget,name));
const {build}=createRequire(join(root,'package.json'))('esbuild');
for(const [name,entries]of [['core',['index','release']],['host',['index','sqlite','indexeddb']],['provider',['index','in-memory','webview']],['wallet-standard',['index']],['tbc-engine',['index','native','wasm']]]){
 for(const format of ['esm','cjs'])await build({entryPoints:entries.map(n=>join(root,'packages',name,'src',n+'.ts')),outdir:join(root,'packages',name,'dist',format),bundle:true,format,platform:'node',external:['@tbc-wallet/*','@wallet-standard/*','@noble/*'],...(format==='cjs'?{outExtension:{'.js':'.cjs'}}:{}),logLevel:'silent'});
}
const record={root,installed,sourceFiles:files.length,liveSourceChanged:false,frozenDistChanged:false};await writeFile(join(scratch,'workspace.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record));
