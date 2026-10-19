// Verify package composition and the unchanged execution path against the last
// installed-device evidence. No claim of new transaction timing or chain proof.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const base=resolve(import.meta.dirname,'..'),[packageArg,output]=process.argv.slice(2);
assert(packageArg&&output);const pkg=resolve(packageArg),sha=b=>createHash('sha256').update(b).digest('hex');
const inventory=JSON.parse(await readFile(join(pkg,'package-files.json'))),manifest=JSON.parse(await readFile(join(pkg,'distribution.json')));
async function list(directory,prefix=''){
 const found=[];for(const entry of await readdir(directory,{withFileTypes:true})){
  assert(!entry.isSymbolicLink(),'Unexpected package symlink');const p=prefix+entry.name;
  if(entry.isDirectory())found.push(...await list(join(directory,entry.name),p+'/'));else found.push(p);
 }return found.sort();
}
assert.deepEqual(await list(pkg),[...Object.keys(inventory.files),'package-files.json'].sort(),'Unexpected package build/private files');
for(const [p,h]of Object.entries(inventory.files))assert.equal(sha(await readFile(join(pkg,p))),h,p);
for(const [p,h]of Object.entries(manifest.nativeArtifacts))assert.equal(sha(await readFile(join(pkg,p))),h,p);
for(const p of ['android/src/main/assets/tbc-kit/tbc-webview-page.js','ios/Resources/tbc-webview-page.js'])assert.equal(sha(await readFile(join(pkg,p))),manifest.pageSha256);
assert(inventory.files['android/src/main/kotlin/io/tbc/kit/dart/TbcDartKitPlugin.kt']);
assert.match(await readFile(join(pkg,'android/build.gradle'),'utf8'),/api 'androidx.webkit:webkit:1.12.1'/);
for(const p of Object.keys(inventory.files)){
 assert(!/(^|\/)(acceptance|fixtures?|test|node_modules|\.dart_tool|build)(\/|$)/i.test(p),p);
 if(/\.(?:dart|swift|kt|json|md|rb|gradle|yaml|podspec)$/.test(p)){
  const text=await readFile(join(pkg,p),'utf8');
  assert(!/\/Users\/alex\/|\/private\/tmp\//.test(text),'Host-specific path in '+p);
  assert(!/1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH|0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798|FixtureWallet|fixture_signer/.test(text),'Fixture leaked into '+p);
 }
}
const previous=JSON.parse(await readFile(join(base,'evidence/f3-maintenance-rounds-paired-device-20261014-a.json')));
const publicAccessFiles=['platform/ios/Classes/NativePermissions.swift','platform/ios/Classes/NativeCrypto.swift','platform/ios/Classes/NativeCustody.swift'];
const sources={},accessOnly=[];let byteIdentical=0;
for(const [p,h] of Object.entries(previous.sources)){
 if(!/^(lib|platform|runtime)\//.test(p))continue;
 const bytes=await readFile(join(base,p));sources[p]=sha(bytes);
 if(sources[p]===h){byteIdentical++;continue;}
 assert(publicAccessFiles.includes(p),'Execution source changed: '+p);
 // Restore only these public-access declarations and the public memberwise
 // initializer; the resulting complete file MUST match the frozen old hash.
 let old=bytes.toString().replace(/^([ \t]*(?:@MainActor )?)public /gm,'$1');
 old=old.replace(' init(address:String,publicKey:String,chainId:String){self.address=address;self.publicKey=publicKey;self.chainId=chainId}\n','');
 assert.equal(sha(old),h,'More than API visibility changed: '+p);accessOnly.push(p);
}
for(const p of ['lib/packaged_wallet.dart','distribution/ios/TbcPartnerWalletHost.swift','distribution/android/TbcPartnerWalletHost.kt'])sources[p]=sha(await readFile(join(base,p)));
const protectedPin=JSON.parse(await readFile(join(base,'evidence/f0-baseline.json')));
for(const [p,h]of Object.entries(protectedPin.protectedFiles))assert.equal(sha(await readFile(p)),h);
const report={status:'PARTNER_PACKAGE_STRUCTURE_AND_EXECUTION_CONTINUITY_PASS',recordedAt:new Date().toISOString(),
 packageManifestSha256:sha(await readFile(join(pkg,'distribution.json'))),packageInventorySha256:sha(await readFile(join(pkg,'package-files.json'))),
 packageFiles:Object.keys(inventory.files).length,uncompressedBytes:inventory.bytes,kitIdentity:manifest.kitIdentity,nativeArtifactId:manifest.artifactId,
 unchangedExecutionFiles:byteIdentical,publicAccessOnly:accessOnly,sources,protectedFiles:Object.keys(protectedPin.protectedFiles).length,
 boundary:manifest.nativePostprocessing?'Native package has explicitly recorded postprocessing; separate allocated-section/ABI and device evidence is mandatory. Existing business execution, reads and validation source continuity is checked here, not byte identity of Engine/Signer. This is not a timing or real-chain measurement.':'Only startup registration, packaging and native type visibility changed. Existing execution, reads, validation and native Engine/Signer bytes retained. This is not a new timing or real-chain measurement.',
 fixtureDefaults:false,published:false,goalComplete:false};
await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,packageFiles:report.packageFiles,unchangedExecutionFiles:byteIdentical,publicAccessOnly:accessOnly.length,protectedFiles:report.protectedFiles}));
