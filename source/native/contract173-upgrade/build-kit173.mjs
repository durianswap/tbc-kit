// New local package, no overwrite, publish or source-tree dist mutation.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,readdir,rm} from 'node:fs/promises';
import {resolve,join,dirname,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildKitRuntime} from '../../packages/kit/scripts/runtime-build.mjs';
import {fileInventory,platformCatalog,sha256} from '../../packages/kit/scripts/platform-resources.mjs';
import {stripWasmNameSection} from '../../packages/kit/scripts/wasm-metadata.mjs';
import {patchContract173Parser} from '../../packages/kit/scripts/contract173-parser-patch.mjs';
import {closePortableParserDependencies} from '../../packages/kit/scripts/portable-parser-dependencies.mjs';
import {rustSourceIdentity,verifiedKitCandidate} from '../flutter/scripts/candidate-inputs.mjs';
const [baseArg,computeArg,platformArg,outArg]=process.argv.slice(2);assert(outArg,'BASELINE COMPUTE_BUILD PLATFORM_BUILD NEW_OUTPUT');
const root=resolve(import.meta.dirname,'../..'),base=resolve(baseArg),compute=resolve(computeArg),platform=resolve(platformArg),out=resolve(outArg),kit=join(out,'package');
const version=process.argv[6]??'0.1.0-platform-slim.20261014.1',baseline=await verifiedKitCandidate(base);
assert.match(version,/^0\.1\.0-platform-slim\.\d{8}\.\d+$/);
const native=JSON.parse(await readFile(join(compute,'build-report.json'))),resources=JSON.parse(await readFile(join(platform,'platform-build.json')));
assert.equal(native.status,'BUILT_NOT_DEVICE_ACCEPTED');assert.equal(resources.source,native.source);
assert.equal((await rustSourceIdentity(root)).sha256,native.source,'Source drift since Native build');
const sourceFiles={};
for(const name of ['core','host','provider','wallet-standard','tbc-engine','kit'])for(const [p,v]of Object.entries(await fileInventory(join(root,'packages',name,'src'))))sourceFiles[`packages/${name}/src/${p}`]=v.sha256;
const releaseSource=await readFile(join(root,'packages/core/src/generated/v1-candidate-release.ts'),'utf8');
const protocolFingerprint=releaseSource.match(/GENERATED_TWS_RELEASE_FINGERPRINT\s*=\s*"([0-9a-f]{64})"/)?.[1];assert(protocolFingerprint);
// A reader-only candidate may keep its public protocol fingerprint. Its source
// and native hashes still provide a unique, paired immutable package identity.
await mkdir(out);await mkdir(kit);
for(const path of ['docs','examples','README.md','SUPPORT.md','LICENSE'])await cp(join(root,'packages/kit',path),join(kit,path),{recursive:true});
await mkdir(join(kit,'artifacts/wasm'),{recursive:true});
await cp(join(root,'packages/kit/artifacts/api-rpc-coverage.json'),join(kit,'artifacts/api-rpc-coverage.json'));
const pkg=JSON.parse(await readFile(join(base,'package.json')));pkg.version=version;delete pkg.scripts;
await writeFile(join(kit,'package.json'),JSON.stringify(pkg,null,2)+'\n');
// Current declarations, not the accepted candidate's now-stale fee schema.
for(const name of ['core','host','provider','kit']){
 const dest=name==='kit'?join(kit,'dist/types'):join(out,'types',name);
 execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p',join(root,'packages',name,'tsconfig.json'),'--declarationDir',dest,'--declarationMap','false'],{cwd:root,stdio:'pipe'});
}
for(const name of ['core','host','provider'])await cp(join(out,'types',name),join(kit,'dist/types/internal',name),{recursive:true});
async function closeTypes(directory){for(const e of await readdir(directory,{withFileTypes:true})){
 const p=join(directory,e.name);if(e.isDirectory()){await closeTypes(p);continue;}if(!p.endsWith('.d.ts'))continue;
 const text=await readFile(p,'utf8'),closed=text.replace(/(["'])@tbc-wallet\/(core|host|provider)(\/[^"']+)?\1/g,(_m,q,name,subpath)=>{
  let target=relative(dirname(p),join(kit,'dist/types/internal',name,(subpath?.slice(1)??'index')+'.js'));if(!target.startsWith('.'))target='./'+target;return q+target+q;
 });assert(!/(?:from|import\()\s*["'](?:@tbc-wallet\/|tbc-tx-parser)/.test(closed),'Unclosed declaration '+p);await writeFile(p,closed);
}}await closeTypes(join(kit,'dist/types'));
await buildKitRuntime({root,packageRoot:kit,minifyWhitespace:true});
const parser={};for(const format of ['esm','cjs']){
 const dest=join(kit,'dist',format,'vendor/tbc-tx-parser');await cp(join(base,'dist',format,'vendor/tbc-tx-parser'),dest,{recursive:true});
 await closePortableParserDependencies(dest);parser[format]=await patchContract173Parser(dest);
}
// Debug maps stay outside the runtime archive, as in the accepted slim build.
async function maps(dir){for(const e of await readdir(join(kit,dir),{withFileTypes:true})){
 const p=join(dir,e.name);if(e.isDirectory()){await maps(p);continue;}
 if(e.name.endsWith('.map')){await mkdir(dirname(join(out,'debug',p)),{recursive:true});await cp(join(kit,p),join(out,'debug',p));await rm(join(kit,p));}
 else if(/\.(?:js|cjs|ts)$/.test(e.name)){const text=await readFile(join(kit,p),'utf8');await writeFile(join(kit,p),text.replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n|$)/g,'\n'));}
}}await maps('dist');
const artifacts=[];for(const w of native.wasm){
 const input=await readFile(w.path);assert.equal(sha256(input),w.sha256);const bytes=stripWasmNameSection(input),path=`artifacts/wasm/tbc_${w.lane}_wasm.wasm`;
 await writeFile(join(kit,path),bytes);artifacts.push({role:w.lane,path,sha256:sha256(bytes),bytes:bytes.length,sourceArtifactSha256:w.sha256,transformation:'remove debugging name section only'});
}
const catalog={schema:1,package:`@tbc/kit@${version}`,protocolFingerprint,platforms:{}},externalArtifacts=[];
for(const [name,inventory]of Object.entries(resources.platforms)){
 for(const [p,item]of Object.entries(inventory)){assert.equal(sha256(await readFile(join(platform,name,p))),item.sha256);if(/\.(?:a|so|dylib)$/.test(p))externalArtifacts.push({path:p,sha256:item.sha256});}
 const archive=`tbc-kit-resources-${name}-${version}.tgz`;
 execFileSync('tar',['-czf',join(out,archive),'-C',join(platform,name),'artifacts'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
 const bytes=await readFile(join(out,archive));catalog.platforms[name]={archive,archiveSha256:sha256(bytes),archiveBytes:bytes.length,unpackedNativeBytes:Object.values(inventory).reduce((s,v)=>s+v.bytes,0),files:Object.fromEntries(Object.entries(inventory).map(([p,v])=>[p,v.sha256]))};
}
await writeFile(join(kit,'artifacts/platform-resources.json'),JSON.stringify(catalog,null,2)+'\n');
const provenance={schemaVersion:3,package:catalog.package,protocolFingerprint,rustSourceSha256:native.source,baseline,
 upstream:{version:'1.7.3',commit:'2f3fe7873e05d8b6f1f53b8720f066776b847b03',npmSha256:'32c3d291e9f566a9ccfcca73d42fe54a25c592361004b2acf3946f04547f028e',ctSource:'pinned upstream worktree metadata; not asserted identical to committed source'},
 artifacts,externalArtifacts,platformResources:{path:'artifacts/platform-resources.json',sha256:sha256(await readFile(join(kit,'artifacts/platform-resources.json')))},parser,
 scope:'Current source rebuild with paired protocol/native identities; trusted-index Pool2 material removes non-witness origin reads, preserves LP6 330/200 and all actual spending proofs',
 sourceCommit:null,status:'BUILT_NOT_DEVICE_ACCEPTED',published:false};
await writeFile(join(kit,'artifacts/provenance.json'),JSON.stringify(provenance,null,2)+'\n');
for(const [p,h]of Object.entries(sourceFiles))assert.equal(sha256(await readFile(join(root,p))),h,'Source changed while building '+p);
await writeFile(join(kit,'artifacts/source-build.json'),JSON.stringify({version,protocolFingerprint,rustSourceSha256:native.source,sourceFiles,status:provenance.status},null,2)+'\n');
const inventory=await fileInventory(kit),identity={schema:1,version,sourceVersion:baseline.version,protocolFingerprint,rustSourceSha256:native.source,files:Object.fromEntries(Object.entries(inventory).map(([p,v])=>[p,v.sha256]))};
await writeFile(join(kit,'artifacts/flutter-kit-candidate.json'),JSON.stringify({artifactId:sha256(JSON.stringify(identity)),...identity},null,2)+'\n');
await verifiedKitCandidate(kit);await platformCatalog(kit);
const [pack]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',out],{cwd:kit,encoding:'utf8',maxBuffer:8e6}));
const result={status:provenance.status,identity:await verifiedKitCandidate(kit),tarball:pack.filename,sha256:sha256(await readFile(join(out,pack.filename))),compressedBytes:pack.size,unpackedBytes:pack.unpackedSize,wasm:artifacts,platforms:catalog.platforms,published:false};
await writeFile(join(out,'candidate.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,identity:result.identity,tarball:result.tarball,sha256:result.sha256,compressedBytes:result.compressedBytes,unpackedBytes:result.unpackedBytes}));
