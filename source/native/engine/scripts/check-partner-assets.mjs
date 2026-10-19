// Verify local platform archives and extract a clean consumer tree. No network,
// signing, device installation or mutation of the immutable delivery directory.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [arg]=process.argv.slice(2);assert.ok(arg&&process.argv.length===3);
const root=resolve(arg),sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=await readFile(join(root,'delivery.json')),delivery=JSON.parse(bytes);
assert.equal(delivery.status,'local-candidate-not-published');
const kitName=`tbc-kit-${delivery.kitVersion}.tgz`;
const hasMetadata=delivery.assets.some(a=>a.file==='sdk-metadata.tgz');
assert.deepEqual(delivery.assets.map(a=>a.file).sort(),[kitName,'apple-sdk.tgz','maven-repository.tgz','wallet-starters.tgz',...(hasMetadata?['sdk-metadata.tgz']:[])].sort());
const directory=await mkdtemp(join(tmpdir(),'tbc-partner-assets-'));
const archives=[];
for(const asset of delivery.assets){
 assert.equal(basename(asset.file),asset.file);
 const file=join(root,asset.file),content=await readFile(file);
 assert.equal(content.length,asset.bytes);assert.equal(sha(content),asset.sha256);
 if(asset.file===kitName){assert.equal(asset.sha256,delivery.kitSha256);continue;}
 const entries=execFileSync('tar',['-tzf',file],{encoding:'utf8'}).trim().split('\n');
 const prefix=asset.file==='apple-sdk.tgz'?'apple':asset.file==='maven-repository.tgz'?'maven-repository':'templates';
 for(const name of entries){assert.ok(asset.file==='sdk-metadata.tgz'?['identity.json','native-sdk-lock.json'].includes(name):(name===prefix||name.startsWith(prefix+'/')));assert.ok(!name.split('/').some(p=>['..','.swiftpm','.build','build'].includes(p)));}
 const types=execFileSync('tar',['-tvzf',file],{encoding:'utf8'}).trim().split('\n');
 assert.ok(types.every(line=>['-','d'].includes(line[0])),'No archive links or special files');
 execFileSync('tar',['-xzf',file,'-C',directory]);archives.push({file:asset.file,entries:entries.length,sha256:asset.sha256});
}
const sdk=JSON.parse(await readFile(join(root,'identity.json'))),lock=JSON.parse(await readFile(join(root,'native-sdk-lock.json')));
assert.equal(sdk.sdkVersion,delivery.sdkVersion);assert.equal(sdk.artifactSetId,delivery.artifactSetId);
assert.equal(sdk.kitTarSha256,delivery.nativeBuildSourceKitSha256);
assert.equal(lock.protocolFingerprint,delivery.protocolFingerprint);assert.equal(lock.artifactSetId,delivery.artifactSetId);
if(hasMetadata) {
 for(const file of ['identity.json','native-sdk-lock.json']) assert.equal(sha(await readFile(join(root,file))),sha(await readFile(join(directory,file))));
 for(const [file,hash] of Object.entries(lock.files)) assert.equal(sha(await readFile(join(directory,file))),hash,file);
}
let verifiedAppleFiles=0;
for(const [file,hash] of Object.entries(lock.files))if(file.startsWith('apple/')){
 assert.equal(sha(await readFile(join(directory,file))),hash,file);verifiedAppleFiles++;
}
assert.ok(verifiedAppleFiles>0);
const aar=join(directory,'maven-repository/io/tbc/local/engine',delivery.sdkVersion,`engine-${delivery.sdkVersion}.aar`);
const previous=JSON.parse(await readFile(join(root,'native-consumer-report.json')));
assert.equal(sha(await readFile(aar)),previous.aarSha256);
for(const file of ['templates/swift/Sources/TbcWalletStarter/EngineAdapter.swift','templates/kotlin/src/main/java/io/tbc/starter/EngineAdapter.kt']){
 const source=await readFile(join(directory,file),'utf8');assert.ok(source.includes(delivery.artifactSetId));assert.ok(!source.includes('__ARTIFACT_SET_ID__'));
}
assert.ok((await readFile(join(directory,'templates/kotlin/build.gradle'),'utf8')).includes(delivery.sdkVersion));
const report={status:'PASS_ASSETS_NOT_TEMPLATE_BUILD',deliverySha256:sha(bytes),kitVersion:delivery.kitVersion,sdkVersion:delivery.sdkVersion,archives,verifiedAppleFiles,aarSha256:previous.aarSha256,
 limits:['Archive hash checks are not independent authenticity proof','No template compilation, device execution, custody or chain acceptance in this script']};
const reportBytes=JSON.stringify(report,null,2)+'\n';await writeFile(join(directory,'asset-check.json'),reportBytes,{flag:'wx'});
console.log(JSON.stringify({directory,...report,reportSha256:sha(reportBytes)}));
