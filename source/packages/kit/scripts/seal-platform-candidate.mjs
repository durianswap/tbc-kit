// Local acceptance receipt only. Does not publish, transact or replace a candidate.
import assert from 'node:assert/strict';
import {readFile, writeFile, readdir, mkdir, copyFile, cp, constants} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {fileInventory, sha256} from './platform-resources.mjs';

const [workArg, assetsArg, resume] = process.argv.slice(2);
assert.ok(resume === undefined || resume === '--resume');
assert.ok(assetsArg, 'VERIFIED_STAGE2_WORK_ROOT CLEAN_PARTNER_ASSET_ROOT');
const work = resolve(workArg), assets = resolve(assetsArg), repo = resolve(import.meta.dirname,'../../..');
const out=join(repo,'docs/distribution/evidence/kit-size-stage2-final-2026-10-10');
const release=join(repo,'release/platform-slim-20261010-final');
const json = async p => JSON.parse(await readFile(p));
const candidate = join(work,'candidate-3'), sdk = join(work,'native-sdk');
const build = await json(join(candidate,'candidate.json'));
assert.equal(build.version,'0.1.0-platform-slim.20261010.3');
const single = async prefix => {
  const matches = (await readdir(sdk)).filter(p => p.startsWith(prefix));
  assert.equal(matches.length,1,`Ambiguous ${prefix} receipt`); return join(sdk,matches[0]);
};
const core = await single('device-check-'), keyless = await single('keyless-check-'), consumer = await single('consumer-check-');
const files = {
  'build.json':join(candidate,'candidate.json'),
  'split-resource-check.json':join(work,'verification-3/report.json'),
  'wasm-parity.json':join(work,'wasm-parity-3.json'),
  'native-consumer.json':join(consumer,'report.json'),
  'native-core-runtime.json':join(core,'report.json'),
  'native-keyless-runtime.json':join(keyless,'report.json'),
  'keyless-source.json':join(work,'keyless-companion/identity.json'),
  'native-core-vectors.json':join(core,'vectors.json'),
  'native-keyless-vectors.json':join(keyless,'vectors.json'),
  'rn-runtime.json':join(work,'rn-runtime-evidence/report.json'),
  'rn-ios-runtime.json':join(work,'rn-runtime-evidence/ios-runtime.json'),
  'rn-android-runtime.json':join(work,'rn-runtime-evidence/android-runtime.json'),
  'rn-android-runtime.log':join(work,'rn-runtime-evidence/android-runtime.log'),
  'rn-probe-provenance.json':join(work,'rn-app/probe-provenance.json'),
  'rn-keyless-vectors.json':join(work,'rn-app/keyless-vectors.json'),
  'partner-asset-check.json':join(assets,'asset-check.json'),
  'sdk-identity.json':join(sdk,'identity.json'),
  'native-sdk-lock.json':join(work,'native-sdk-lock.json'),
  'platform-resources.json':join(candidate,'package/artifacts/platform-resources.json'),
};
const r = {};
for (const [name,path] of Object.entries(files)) if (name.endsWith('.json')) r[name] = await json(path);
const split=r['split-resource-check.json'], rn=r['rn-runtime.json'], identity=r['sdk-identity.json'];
assert.equal(split.status,'PASS_SPLIT_INSTALL_RESOURCES_AND_HOST_NATIVE_PARITY');
assert.equal(split.identities[1].artifactId,build.artifactId);
assert.equal(split.unchangedExecutableFiles,542); assert.equal(split.unchangedNativeFiles,14);
assert.equal(split.rnTemplate.sdkLockStale,false);
assert.equal(r['wasm-parity.json'].identities[1].artifactId,build.artifactId);
assert.equal(r['wasm-parity.json'].status,'PASS_WASM_SIZE_DIFFERENTIAL');
assert.equal(rn.status,'PASS_INSTALLED_SPLIT_KIT_RN_HERMES_BOTH');
assert.equal(rn.proof.kitSha256,build.tarballSha256);
assert.equal(rn.identity.artifactSetId,identity.artifactSetId);
assert.equal(rn.templatePatched,false); assert.equal(rn.networkRequests,0); assert.equal(rn.broadcasts,0);
for (const name of ['native-consumer.json','native-core-runtime.json','native-keyless-runtime.json']) {
  assert.equal(r[name].status,'PASS'); assert.equal(r[name].artifactSetId,identity.artifactSetId);
}
assert.equal(r['native-keyless-runtime.json'].keylessArtifactSetId,r['keyless-source.json'].artifactSetId);
assert.equal(r['keyless-source.json'].rustSourceSha256,build.rustSourceSha256);
assert.equal(r['partner-asset-check.json'].kitVersion,build.version);
assert.equal(r['partner-asset-check.json'].status,'PASS_ASSETS_NOT_TEMPLATE_BUILD');
const deliverySource=join(work,'partner-delivery-3'), delivery=await json(join(deliverySource,'delivery.json'));
assert.equal(delivery.kitSha256,build.tarballSha256);
assert.equal(sha256(await readFile(join(deliverySource,'delivery.json'))),r['partner-asset-check.json'].deliverySha256);
for (const asset of delivery.assets) {
  const bytes=await readFile(join(deliverySource,asset.file));
  assert.equal(sha256(bytes),asset.sha256); assert.equal(bytes.length,asset.bytes);
}
for (const [path,hash] of Object.entries(r['native-sdk-lock.json'].files))
  assert.equal(sha256(await readFile(join(assets,path))),hash);
const flutter=join(repo,'release/tbc-flutter-partner-slim-candidate-20261010-a.tgz');
const flutterBytes=await readFile(flutter);
assert.equal(sha256(flutterBytes),'eba07643f802c5f547e599a10e9ac8813991744c6ef2d233224767adabfdefcf');
// Re-run the actual clean-install gate and preserve its result rather than
// manufacturing a receipt from a remembered console output.
const run=(script,args)=>execFileSync(process.execPath,[script,...args],{cwd:repo,encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024});
const installLog=resume ? await readFile(join(out,'clean-install.log'),'utf8') :
  run('packages/kit/scripts/check-install-candidate.mjs',[join(candidate,build.tarball),build.version,build.tarballSha256]);
const install=JSON.parse(installLog.trim().split('\n').at(-1));
assert.equal(install.status,'passed'); assert.equal(install.gates.length,17);
assert.equal(install.sha256,build.tarballSha256); assert.equal(install.version,build.version);
const focusedLog=resume ? await readFile(join(out,'focused-tests.log'),'utf8') : execFileSync(process.execPath,['--test','packages/kit/test/platform-resources.test.mjs',
  'packages/kit/test/react-native-engine-template.test.mjs'],{cwd:repo,encoding:'utf8',timeout:60000});
assert.match(focusedLog,/# pass 7/); assert.match(focusedLog,/# fail 0/);
if (resume) {
  // Resume only the known partial seal; never modify existing receipts.
  assert.deepEqual((await readdir(out)).sort(),[...Object.keys(files),'clean-install.log','clean-install.json','focused-tests.log'].sort());
  assert.deepEqual(await readdir(release),[]);
  for (const [name,path] of Object.entries(files)) assert.equal(sha256(await readFile(join(out,name))),sha256(await readFile(path)));
} else {
  await mkdir(out); await mkdir(release);
  for (const [name,path] of Object.entries(files)) await copyFile(path,join(out,name),constants.COPYFILE_EXCL);
  await writeFile(join(out,'clean-install.log'),installLog,{flag:'wx'});
  await writeFile(join(out,'clean-install.json'),JSON.stringify(install,null,2)+'\n',{flag:'wx'});
  await writeFile(join(out,'focused-tests.log'),focusedLog,{flag:'wx'});
}
for (const name of await readdir(deliverySource))
  await cp(join(deliverySource,name),join(release,name),{recursive:true,force:false,errorOnExist:true});
for (const group of Object.values(build.platforms)) {
  assert.equal(sha256(await readFile(join(candidate,group.archive))),group.archiveSha256);
  await copyFile(join(candidate,group.archive),join(release,group.archive),constants.COPYFILE_EXCL);
}
await copyFile(join(repo,'docs/distribution/kit-platform-slim-handoff-2026-10-10.md'),join(release,'README.md'),constants.COPYFILE_EXCL);
const sourcePaths=[
  'packages/kit/scripts/platform-resources.mjs','packages/kit/scripts/prepare-platform-candidate.mjs',
  'packages/kit/scripts/check-platform-candidate.mjs','packages/kit/scripts/seal-platform-candidate.mjs',
  'packages/kit/scripts/check-install-candidate.mjs','packages/kit/test/platform-resources.test.mjs',
  'packages/kit/test/react-native-engine-template.test.mjs','packages/kit/scripts/build.mjs',
  'packages/kit/examples/react-native-engine/module/scripts/sync-native.mjs',
  'packages/kit/examples/react-native-engine/module/native-sdk-lock.json',
  'native/engine/scripts/prepare-native-engine.mjs','native/engine/scripts/prepare-full-native-engine.mjs',
  'native/engine/scripts/prepare-frozen-keyless-companion.mjs','native/engine/scripts/write-native-sdk-lock.mjs',
  'native/engine/scripts/prepare-partner-delivery.mjs','native/engine/scripts/check-partner-assets.mjs',
  'native/engine/scripts/check-native-engine-consumers.mjs','native/engine/scripts/check-keyless-platforms.mjs',
  'native/engine/consumers/react-native/prepare-platform-probe.mjs','native/engine/consumers/react-native/check-platform-probe.mjs',
  'native/engine/consumers/react-native/KeylessProbe.tsx','native/flutter-compat/check-size-wasm-parity.mjs',
];
const sources={};for(const p of sourcePaths)sources[p]=sha256(await readFile(join(repo,p)));
const assetInventory=await fileInventory(assets);
const unpackedFor=prefix=>Object.entries(assetInventory).filter(([p])=>p.startsWith(prefix+'/')).reduce((n,[,v])=>n+v.bytes,0);
const report={status:'PASS_STAGE2_LOCAL_DISTRIBUTION_ACCEPTANCE',kitVersion:build.version,kitSha256:build.tarballSha256,
  artifactId:build.artifactId,sdkVersion:identity.sdkVersion,sdkArtifactSetId:identity.artifactSetId,
  sizes:{npmBeforeBytes:39510404,npmAfterBytes:build.compressedBytes,
    unpackedBeforeBytes:split.sizes.baselineUnpacked,unpackedAfterBytes:build.unpackedBytes,
    sdkDownloads:delivery.assets,appleSdkUnpackedBytes:unpackedFor('apple'),mavenUnpackedBytes:unpackedFor('maven-repository'),
    flutterArchiveBytes: flutterBytes.length,additionalAppSizeReductionClaimed:false},
  requirements:{onePackageSevenExports:install.gates.length===17,platformResourcesPinned:true,
    executableByteParity:split.unchangedExecutableFiles,nativeByteParity:split.unchangedNativeFiles,
    actualCleanInstall:true,wasmDifferentialCalls:r['wasm-parity.json'].results.reduce((n,x)=>n+x.checks.length,0),
    hostNativeWasmCalls:split.parity.length,swiftKotlinNativeExecution:true,rnReleaseIosAndroid:true,
    flutterFrozenArchiveUnchanged:true,templateLockPaired:true,docsAndLocalArtifactsSaved:true},
  runtimeChanges:{businessLogic:false,networkReads:false,validationRemoved:false,approvalOrSigning:false,
    fixtureBackendSignReads:2,fixtureBackendSendReads:2,fixtureSignCalls:1,rnFetches:0,realBroadcasts:0,
    performanceEvidence:'Executable bytes and orchestration are unchanged; request counts checked. Not a new wallet latency benchmark.'},
  sources,receipts:await fileInventory(out),deliveryFiles:await fileInventory(release),
  limitations:['Local distribution, not npm/SPM/Maven publication','No fresh real-chain or production Vault acceptance',
    'iOS26.5 simulator and Android API36 arm64; not minimum-OS or physical-device certification',
    'Native SDK provides Core/Keyless calculation bridges, not a complete wallet host',
    'Flutter keeps exact stage1 pairing and evidence; this stage did not rebuild Flutter',
    'Frozen build-time pending flags are superseded by this separate receipt, not edited in place',
    'Upstream source/license audit and release hosting remain separate release prerequisites'],
  published:false,pushed:false,existingWalletChanged:false};
await writeFile(join(out,'acceptance.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
await copyFile(join(out,'acceptance.json'),join(release,'acceptance.json'),constants.COPYFILE_EXCL);
console.log(JSON.stringify({status:report.status,out,release,version:build.version,sizes:report.sizes}));
