// Private-boundary fix candidate; retain the slim distribution and native bytes.
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildKitRuntime} from './runtime-build.mjs';
import {fileInventory,platformCatalog,sha256} from './platform-resources.mjs';
import {verifiedKitCandidate} from '../../../native/flutter/scripts/candidate-inputs.mjs';
const [baseArg,outArg,version]=process.argv.slice(2);
assert.ok(version,'FROZEN_KIT NEW_OUTPUT NEW_VERSION');
assert.match(version,/^0\.1\.0-platform-slim\.\d{8}\.\d+$/);
const root=resolve(import.meta.dirname,'../../..'),base=resolve(baseArg),out=resolve(outArg),kit=join(out,'package');
const baseline=await verifiedKitCandidate(base),before=await fileInventory(base);assert.notEqual(version,baseline.version);
const sourcePaths=['packages/core/src/reducers/workflows.ts','packages/kit/src/approved-host-task.ts',
 'native/kit-runtime/host-boundary/wallet-runtime.mjs'];
const sources=Object.fromEntries(await Promise.all(sourcePaths.map(async p=>[p,sha256(await readFile(join(root,p)))])));
await mkdir(out);await cp(base,kit,{recursive:true,errorOnExist:true,force:false});
// Remove generated outputs only inside the new, isolated staging directory.
for(const format of ['esm','cjs'])for(const name of await readdir(join(kit,'dist',format)))
 if(name!=='vendor')await rm(join(kit,'dist',format,name),{recursive:true});
await buildKitRuntime({root,packageRoot:kit,minifyWhitespace:true});
await cp(join(root,'packages/kit/dist/types'),join(kit,'dist/types'),{recursive:true});
async function separate(dir){for(const e of await readdir(join(kit,dir),{withFileTypes:true})){
 const p=join(dir,e.name);if(e.isDirectory()){await separate(p);continue;}
 if(e.name.endsWith('.map')){await mkdir(dirname(join(out,'debug',p)),{recursive:true});await cp(join(kit,p),join(out,'debug',p));await rm(join(kit,p));}
 else if(/\.(js|cjs|ts)$/.test(e.name)){const text=await readFile(join(kit,p),'utf8');
  await writeFile(join(kit,p),text.replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n|$)/g,'\n'));}
}}await separate('dist');
const pkg=JSON.parse(await readFile(join(kit,'package.json')));pkg.version=version;
await writeFile(join(kit,'package.json'),JSON.stringify(pkg,null,2)+'\n');
const provenance=JSON.parse(await readFile(join(kit,'artifacts/provenance.json')));provenance.package=`@tbc/kit@${version}`;
provenance.deferredLegacyFix={baseline,sources,scope:'Re-derive approved Legacy dependent-message task using the same host-owned digest authority',
 newNetworkReads:0,validationRemoved:false,nativeAndWasmChanged:false,acceptance:'pending separate receipt'};
const catalog=await platformCatalog(base);catalog.package=provenance.package;
const catalogBytes=JSON.stringify(catalog,null,2)+'\n';await writeFile(join(kit,'artifacts/platform-resources.json'),catalogBytes);
provenance.platformResources.sha256=sha256(catalogBytes);
await writeFile(join(kit,'artifacts/provenance.json'),JSON.stringify(provenance,null,2)+'\n');
const after=await fileInventory(kit);
for(const [p,v]of Object.entries(before))if(p.startsWith('artifacts/')&&!['artifacts/flutter-kit-candidate.json','artifacts/provenance.json','artifacts/platform-resources.json'].includes(p))
 assert.equal(after[p]?.sha256,v.sha256,`Frozen native/resource bytes ${p}`);
for(const [p,h]of Object.entries(sources))assert.equal(sha256(await readFile(join(root,p))),h);
const identity={schema:1,version,sourceVersion:baseline.version,protocolFingerprint:baseline.protocolFingerprint,rustSourceSha256:baseline.rustSourceSha256,
 files:Object.fromEntries(Object.entries(after).filter(([p])=>p!=='artifacts/flutter-kit-candidate.json').map(([p,v])=>[p,v.sha256]))};
await writeFile(join(kit,'artifacts/flutter-kit-candidate.json'),JSON.stringify({artifactId:sha256(JSON.stringify(identity)),...identity},null,2)+'\n');
await verifiedKitCandidate(kit);await platformCatalog(kit);
const [packed]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',out],{cwd:kit,encoding:'utf8',maxBuffer:8*1024*1024}));
const report={status:'BUILT_NOT_ACCEPTED',baseline,version,sources,tarball:packed.filename,tarballSha256:sha256(await readFile(join(out,packed.filename))),
 compressedBytes:packed.size,unpackedBytes:packed.unpackedSize,nativeAndWasmChanged:false,published:false};
await writeFile(join(out,'candidate.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
