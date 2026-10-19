import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const [kitArg,sdkArg,reportArg,outArg,buildInputArg]=process.argv.slice(2);
assert.ok(kitArg && sdkArg && reportArg && outArg,'Usage: KIT_TGZ PINNED_SDK CONSUMER_REPORT NEW_OUTPUT');
const kit=resolve(kitArg),sdk=resolve(sdkArg),out=resolve(outArg);
const root=resolve(import.meta.dirname,'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const extract=p=>execFileSync('tar',['-xOf',kit,`package/${p}`],{maxBuffer:10*1024*1024});
const lock=JSON.parse(extract('examples/react-native-engine/module/native-sdk-lock.json'));
const manifest=JSON.parse(extract('package.json')),provenance=JSON.parse(extract('artifacts/provenance.json'));
const identity=await json(join(sdk,'identity.json')),report=await json(resolve(reportArg));
assert.equal(report.status,'PASS');
assert.equal(identity.artifactSetId,lock.artifactSetId);
assert.equal(report.artifactSetId,lock.artifactSetId);
assert.equal(lock.protocolFingerprint,provenance.protocolFingerprint);
for(const [file,hash] of Object.entries(lock.files)) assert.equal(sha(await readFile(join(sdk,file))),hash,file);
const aar=join(sdk,'android/engine/build/outputs/aar/engine-release.aar');
assert.equal(sha(await readFile(aar)),report.aarSha256);
if(buildInputArg) assert.equal(sha(await readFile(resolve(buildInputArg))),identity.kitTarSha256,'Native build-input provenance');
await mkdir(out); // Exclusive new directory. Never overwrite an earlier release.
await cp(join(sdk,'apple'),join(out,'apple'),{recursive:true,filter:p=>!p.split('/').some(x=>['.build','build','.swiftpm'].includes(x))});
await cp(join(sdk,'maven-repository'),join(out,'maven-repository'),{recursive:true});
await cp(join(root,'templates'),join(out,'templates'),{recursive:true});
async function pin(dir) {
  for(const e of await readdir(dir,{withFileTypes:true})) {
    const file=join(dir,e.name);
    if(e.isDirectory()) await pin(file);
    else if(/\.(swift|kt|gradle)$/.test(file)) {
      const source=await readFile(file,'utf8');
      await writeFile(file,source.replaceAll('__ARTIFACT_SET_ID__',lock.artifactSetId).replaceAll('__SDK_VERSION__',lock.sdkVersion));
    }
  }
}
await pin(join(out,'templates'));
await cp(join(sdk,'identity.json'),join(out,'identity.json'));
await writeFile(join(out,'native-sdk-lock.json'),JSON.stringify(lock,null,2)+'\n');
await cp(resolve(reportArg),join(out,'native-consumer-report.json'));
if(buildInputArg) {
  await mkdir(join(out,'provenance'));
  await cp(resolve(buildInputArg),join(out,'provenance/native-build-input.tgz'));
}
const assets=[];
// Keep the exact final install artifact beside the platform assets. The SDK
// bootstrap below is provenance only and must never stand in for this file.
const kitFile=`tbc-kit-${manifest.version}.tgz`;
await cp(kit,join(out,kitFile));
assert.equal(sha(await readFile(join(out,kitFile))),sha(await readFile(kit)));
assets.push({file:kitFile,bytes:(await readFile(kit)).length,sha256:sha(await readFile(kit))});
for(const [file,directory] of [['apple-sdk.tgz','apple'],['maven-repository.tgz','maven-repository'],['wallet-starters.tgz','templates']]) {
  execFileSync('tar',['-czf',join(out,file),'-C',out,directory]);
  const bytes=await readFile(join(out,file)); assets.push({file,bytes:bytes.length,sha256:sha(bytes)});
}
// Shared small pairing metadata lets a clean recipient assemble the SDK from
// selected platform archives without relying on a maintainer's staging tree.
execFileSync('tar',['-czf',join(out,'sdk-metadata.tgz'),'-C',out,'identity.json','native-sdk-lock.json']);
const metadataBytes=await readFile(join(out,'sdk-metadata.tgz'));
assets.push({file:'sdk-metadata.tgz',bytes:metadataBytes.length,sha256:sha(metadataBytes)});
const result={schemaVersion:1,status:'local-candidate-not-published',kitVersion:manifest.version,
  kitSha256:sha(await readFile(kit)),sdkVersion:lock.sdkVersion,artifactSetId:lock.artifactSetId,
  protocolFingerprint:lock.protocolFingerprint,assets,
  nativeBuildSourceKitSha256:identity.kitTarSha256,
  nativeBuildInputPreserved:Boolean(buildInputArg),
  sourceNote:'SDK was built before final Kit lock assembly. Final Kit pins this exact SDK; no circular rebuild or same-version replacement.',
  currentTemplateBuildVerified:false,fullNativeWalletKit:false,productionVault:false,
  releaseBlockers:['license/source audit','remote immutable hosting','production native Kit host authority/approval/Vault acceptance','physical-device support scope']};
await writeFile(join(out,'delivery.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({out,...result},null,2));
