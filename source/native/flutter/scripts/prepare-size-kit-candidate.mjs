// Derive a new package from an independently verified frozen candidate. No
// source rebuild, protocol change, publication or mutation of the baseline.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {verifiedKitCandidate,sha256} from './candidate-inputs.mjs';
import {stripWasmNameSection} from '../../../packages/kit/scripts/wasm-metadata.mjs';
const [baseArg,outArg,version]=process.argv.slice(2);
assert.ok(baseArg&&outArg&&/^0\.1\.0-flutter-slim\.\d{8}\.\d+$/.test(version),'FROZEN_KIT NEW_OUTPUT LOCAL_VERSION');
const base=resolve(baseArg),out=resolve(outArg),kit=join(out,'package');
const baseline=await verifiedKitCandidate(base);
await mkdir(out);await cp(base,kit,{recursive:true});
const transforms=[];
for(const name of ['tbc_engine_wasm.wasm','tbc_keyless_wasm.wasm']){
 const path='artifacts/wasm/'+name,before=await readFile(join(kit,path)),after=stripWasmNameSection(before);
 await writeFile(join(kit,path),after);
 transforms.push({path,beforeSha256:sha256(before),afterSha256:sha256(after),beforeBytes:before.length,afterBytes:after.length,
  removed:'name custom section only',executableSectionsUnchanged:true});
}
const pkg=JSON.parse(await readFile(join(kit,'package.json')));pkg.version=version;pkg.private=true;
await writeFile(join(kit,'package.json'),JSON.stringify(pkg,null,2)+'\n');
const provenance=JSON.parse(await readFile(join(kit,'artifacts/provenance.json')));
provenance.package=`@tbc/kit@${version}`;
provenance.localSizeCandidate={baseline,transforms,deviceAcceptance:false,published:false,
 generatorSha256:sha256(await readFile(import.meta.filename)),
 transformSha256:sha256(await readFile(new URL('../../../packages/kit/scripts/wasm-metadata.mjs',import.meta.url)))};
for(const artifact of provenance.artifacts)artifact.sha256=sha256(await readFile(join(kit,artifact.path)));
if(provenance.publicMerge?.nativeDelivery)provenance.publicMerge.nativeDelivery.wasmSha256=transforms[0].afterSha256;
await writeFile(join(kit,'artifacts/provenance.json'),JSON.stringify(provenance,null,2)+'\n');
const previous=JSON.parse(await readFile(join(base,'artifacts/flutter-kit-candidate.json')));
const identity={schema:1,version,sourceVersion:baseline.version,protocolFingerprint:baseline.protocolFingerprint,
 rustSourceSha256:baseline.rustSourceSha256,files:{}};
for(const path of Object.keys(previous.files).sort())identity.files[path]=sha256(await readFile(join(kit,path)));
await writeFile(join(kit,'artifacts/flutter-kit-candidate.json'),JSON.stringify({artifactId:sha256(JSON.stringify(identity)),...identity},null,2)+'\n');
const verified=await verifiedKitCandidate(kit),tarball=`tbc-kit-${version}.tgz`;
execFileSync('tar',['-czf',join(out,tarball),'-C',out,'package']);
await writeFile(join(out,'candidate.json'),JSON.stringify({status:'FROZEN_LOCAL_NOT_DEVICE_ACCEPTED',...verified,baseline,transforms,
 tarball,tarballSha256:sha256(await readFile(join(out,tarball))),published:false,realChain:false},null,2)+'\n');
console.log(JSON.stringify({out,...verified,transforms}));
