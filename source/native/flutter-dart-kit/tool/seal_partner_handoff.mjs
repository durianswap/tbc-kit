// Local integration handoff only. No publication, signing or broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,mkdtemp,stat,access} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const base=resolve(import.meta.dirname,'..'),repo=resolve(base,'../..');
const [outArg,structureArg,installArg]=process.argv.slice(2);assert(outArg&&structureArg&&installArg);
const out=resolve(outArg),pkg=join(out,'tbc_kit_flutter_dart'),sha=b=>createHash('sha256').update(b).digest('hex');
const json=async p=>JSON.parse(await readFile(p));
const structure=await json(resolve(structureArg)),installed=await json(resolve(installArg));
assert.equal(structure.status,'PARTNER_PACKAGE_STRUCTURE_AND_EXECUTION_CONTINUITY_PASS');
assert.equal(installed.status,'PARTNER_PACKAGE_PAIRED_CLEAN_INSTALL_PASS');
const manifest=await json(join(pkg,'distribution.json')),inventory=await json(join(pkg,'package-files.json'));
const manifestSha=sha(await readFile(join(pkg,'distribution.json')));
assert.equal(manifestSha,structure.packageManifestSha256);assert.equal(manifestSha,installed.packageManifestSha256);
assert.equal(sha(await readFile(join(pkg,'package-files.json'))),structure.packageInventorySha256);
assert.equal(installed.packageVersion,'0.0.0-partner.20261014.3');
assert.equal(manifest.artifactId,installed.nativeArtifactId);
assert.deepEqual(manifest.kitIdentity,installed.kitIdentity);
const archiveName='tbc-flutter-dart-partner-20261014.3.tgz';
for(const name of ['START_HERE.md','ACCEPTANCE.md','acceptance-summary.json','SHA256SUMS',archiveName,'seal.json']){
 try{await access(join(out,name));throw Error('Refuse to overwrite '+name);}catch(e){if(e.code!=='ENOENT')throw e;}
}
async function files(root,prefix=''){
 const result=[];
 for(const entry of await readdir(root,{withFileTypes:true})){
  assert(!entry.isSymbolicLink(),'No symlinks');const p=prefix+entry.name;
  if(entry.isDirectory())result.push(...await files(join(root,entry.name),p+'/'));else result.push(p);
 }return result.sort();
}
assert.deepEqual(await files(pkg),[...Object.keys(inventory.files),'package-files.json'].sort());
for(const [p,h]of Object.entries(inventory.files))assert.equal(sha(await readFile(join(pkg,p))),h,p);
const evidence={};
async function record(p){const bytes=await readFile(join(repo,p));evidence[p]=sha(bytes);return JSON.parse(bytes);}
await record(relative(repo,resolve(structureArg)));await record(relative(repo,resolve(installArg)));
const network=await record('native/flutter-dart-kit/evidence/f3-network-integration-checkpoint.json');
const legacy=await record('native/flutter-dart-kit/evidence/f3-legacy-edges-paired-device-20261014-a.json');
await record('native/flutter-dart-kit/evidence/f3-maintenance-rounds-paired-device-20261014-a.json');
const chain=await record('release/contract173-live-20261014-a/paired-confirmation-refresh-20261014-c.json');
assert.equal(chain.allConfirmed,true);
const speed={};
for(const platform of ['ios','android']){
 const measured=await record('release/contract173-benchmark-'+platform+'-comparison-20261014-a.json');
 assert.equal(measured.status,'MATCHED_CURRENT_TBC20_MEASURED');
 speed[platform]={recordedAt:measured.recordedAt,build:measured.build,currentWarm:measured.lanes.current.warm,frozenJsWarm:measured.lanes.frozenKit.warm,
  exactSignedTransactions:measured.exactSignedTransactions,exactFee:measured.exactFee,oneApprovalBoth:measured.oneApprovalBoth,
  getsCold:measured.getsCold,getsWarm:measured.getsWarm,parallelPrefetch:measured.warmParallelPrefetchBoth};
}
await record('release/contract173-size-20261014-a.json');
const report={schema:1,status:'LOCAL_PARTNER_INTEGRATION_CANDIDATE_CLEAN_INSTALL_PASS',recordedAt:new Date().toISOString(),
 packageVersion:installed.packageVersion,kitIdentity:manifest.kitIdentity,nativeArtifactId:manifest.artifactId,packageManifestSha256:manifestSha,
 buildMetadata:'Package manifests retain BUILD_INPUT_NOT_ACCEPTED as immutable build-time state. This report attaches the later installation evidence to their exact hashes.',
 installation:{ios:{status:installed.ios.report.status,build:installed.ios.build,os:'iOS 26.5 simulator',pins:installed.ios.pins,executableSha256:installed.ios.appExecutableSha256},
  android:{status:installed.android.report.status,build:installed.android.build,os:'API 36 arm64 emulator',apkSha256:installed.android.apkSha256,engineSha256:installed.android.apkEngineSha256},
  tests:['native plugin registration','native library hash and 4 ABI symbols','unconfigured wallet unavailable','package channel cannot sign','consumer Swift/Kotlin/Dart template compilation'],
  limitations:['No partner account or production Vault is configured in the clean checker','No new business transaction, chain acceptance, minimum-OS or timing proof from installation']},
 continuity:{unchangedExecutionFiles:structure.unchangedExecutionFiles,publicAccessOnly:structure.publicAccessOnly,protectedFiles:structure.protectedFiles,engineSignerUnchanged:true},
 inherited:{providerProof:network.installedMethodProofRemains,legacyStatus:legacy.status,chain:{status:chain.status,allConfirmed:chain.allConfirmed,evidence:'release/contract173-live-20261014-a/paired-confirmation-refresh-20261014-c.json'},speed,
  speedScope:'Historical same-day TBC20 fixture comparison, 3 warm samples; not a new final-package benchmark or all-business guarantee',
  sizeScope:'Earlier full-host Release delta estimate only, before final Legacy/package closure; Android compressed APK and iOS uncompressed App are different measures'},
 packageUncompressedBytes:inventory.bytes,excludes:['APK/IPA','test credentials','fixture data','Flutter SDK','build cache','automatic approval'],
 remaining:['Partner Vault and UI integration','Physical and minimum-OS validation','Full-goal scoped private Testnet delta, final matched speed and full-host Release increment','Complete third-party and upstream license/build provenance before public distribution'],
 evidence,published:false,externalSending:false,newBroadcasts:0,fullGoalComplete:false};
for(const name of ['START_HERE.md','ACCEPTANCE.md'])await writeFile(join(out,name),await readFile(join(base,'distribution/handoff',name)),{flag:'wx'});
await writeFile(join(out,'acceptance-summary.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
const names=['START_HERE.md','ACCEPTANCE.md','acceptance-summary.json',... (await files(pkg)).map(p=>'tbc_kit_flutter_dart/'+p)].sort();
const sums={};for(const name of names)sums[name]=sha(await readFile(join(out,name)));
await writeFile(join(out,'SHA256SUMS'),Object.entries(sums).map(([p,h])=>h+'  '+p).join('\n')+'\n',{flag:'wx'});
execFileSync('/usr/bin/tar',['--disable-copyfile','-czf',join(out,archiveName),'-C',out,'START_HERE.md','ACCEPTANCE.md','acceptance-summary.json','SHA256SUMS','tbc_kit_flutter_dart'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
const unpacked=await mkdtemp('/private/tmp/tbc-partner-archive-verify-');
execFileSync('/usr/bin/tar',['-xzf',join(out,archiveName),'-C',unpacked]);
assert.deepEqual(await files(unpacked),[...names,'SHA256SUMS'].sort());
for(const [p,h]of Object.entries(sums))assert.equal(sha(await readFile(join(unpacked,p))),h,p);
assert.equal(sha(await readFile(join(unpacked,'SHA256SUMS'))),sha(await readFile(join(out,'SHA256SUMS'))));
const seal={status:'LOCAL_INTEGRATION_ARCHIVE_READBACK_VERIFIED',recordedAt:new Date().toISOString(),archive:archiveName,
 bytes:(await stat(join(out,archiveName))).size,sha256:sha(await readFile(join(out,archiveName))),files:names.length+1,
 summarySha256:sums['acceptance-summary.json'],packageInventorySha256:sums['tbc_kit_flutter_dart/package-files.json'],
 readback:true,published:false,fullGoalComplete:false};
await writeFile(join(out,'seal.json'),JSON.stringify(seal,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(seal));
