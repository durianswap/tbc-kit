// New template-only candidate. Every transaction/runtime byte is retained.
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileInventory,platformCatalog,sha256} from './platform-resources.mjs';
import {verifiedKitCandidate} from '../../../native/flutter/scripts/candidate-inputs.mjs';
const [baseArg,outArg,version]=process.argv.slice(2);
assert.ok(version,'FROZEN_KIT NEW_OUTPUT NEW_VERSION');
assert.match(version,/^0\.1\.0-platform-slim\.\d{8}\.\d+$/);
const root=resolve(import.meta.dirname,'../../..'),base=resolve(baseArg),out=resolve(outArg),kit=join(out,'package');
const baseline=await verifiedKitCandidate(base);assert.notEqual(version,baseline.version);
await mkdir(out);await cp(base,kit,{recursive:true,errorOnExist:true,force:false});
const updates=['install.mjs','README.md','module/scripts/sync-native.mjs','module/TbcKitEngine.podspec','module/android/build.gradle']
  .map(p=>'examples/react-native-engine/'+p);
for(const path of updates)await cp(join(root,'packages/kit',path),join(kit,path));
const pkg=JSON.parse(await readFile(join(kit,'package.json')));pkg.version=version;
await writeFile(join(kit,'package.json'),JSON.stringify(pkg,null,2)+'\n');
const provenance=JSON.parse(await readFile(join(kit,'artifacts/provenance.json')));
provenance.package=`@tbc/kit@${version}`;
provenance.onDemandDelivery={baseline,platforms:['all','ios','android'],defaultPlatform:'all',templateFiles:updates,runtimeChanged:false,nativeChanged:false};
const catalog=await platformCatalog(base);catalog.package=provenance.package;
const bytes=JSON.stringify(catalog,null,2)+'\n';
await writeFile(join(kit,'artifacts/platform-resources.json'),bytes);provenance.platformResources.sha256=sha256(bytes);
await writeFile(join(kit,'artifacts/provenance.json'),JSON.stringify(provenance,null,2)+'\n');
const before=await fileInventory(base),after=await fileInventory(kit);
assert.deepEqual(Object.keys(before),Object.keys(after));
const changed=Object.keys(before).filter(p=>before[p].sha256!==after[p].sha256).sort();
assert.deepEqual(changed,[...updates,'package.json','artifacts/provenance.json','artifacts/platform-resources.json'].sort());
const identity={schema:1,version,sourceVersion:baseline.version,protocolFingerprint:baseline.protocolFingerprint,rustSourceSha256:baseline.rustSourceSha256,
  files:Object.fromEntries(Object.entries(after).filter(([p])=>p!=='artifacts/flutter-kit-candidate.json').map(([p,v])=>[p,v.sha256]))};
await writeFile(join(kit,'artifacts/flutter-kit-candidate.json'),JSON.stringify({artifactId:sha256(JSON.stringify(identity)),...identity},null,2)+'\n');
await verifiedKitCandidate(kit);await platformCatalog(kit);
const [packed]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',out],{cwd:kit,encoding:'utf8',maxBuffer:4*1024*1024}));
const report={status:'BUILT_NOT_ACCEPTED',baseline,version,tarball:packed.filename,tarballSha256:sha256(await readFile(join(out,packed.filename))),
  compressedBytes:packed.size,unpackedBytes:packed.unpackedSize,changed,runtimeChanged:false,nativeAndWasmChanged:false,published:false};
await writeFile(join(out,'candidate.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
