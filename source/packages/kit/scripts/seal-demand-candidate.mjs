import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileInventory,platformCatalog,sha256} from './platform-resources.mjs';
import {verifiedKitCandidate} from '../../../native/flutter/scripts/candidate-inputs.mjs';
const [runArg,baseArg,outArg]=process.argv.slice(2);assert.ok(outArg,'VERIFIED_RUN BASE_KIT NEW_DELIVERY');
const run=resolve(runArg),base=resolve(baseArg),out=resolve(outArg),root=resolve(import.meta.dirname,'../../..');
const json=async p=>JSON.parse(await readFile(join(run,p)));
const build=await json('candidate/candidate.json'),check=await json('check/report.json'),loading=await json('loading-b/report.json'),native=await json('native/report.json');
assert.equal(check.status,'PASS_CLEAN_INSTALL_AND_FOCUSED');assert.equal(loading.status,'PASS_ON_DEMAND_LOADING');assert.equal(native.status,'PASS_REAL_SINGLE_PLATFORM_INSTALL');
const kit=join(run,'candidate/package'),identity=await verifiedKitCandidate(kit);await platformCatalog(kit);
assert.deepEqual(await verifiedKitCandidate(base),build.baseline);
for(const r of [check,loading,native])assert.deepEqual(r.identity,identity);
const before=await fileInventory(base),after=await fileInventory(kit);
const runtime=Object.keys(before).filter(p=>p.startsWith('dist/')||p.startsWith('artifacts/wasm/')||p.endsWith('native-sdk-lock.json'));
for(const p of runtime)assert.equal(after[p].sha256,before[p].sha256,p);
const tar=await readFile(join(run,'candidate',build.tarball));assert.equal(sha256(tar),build.tarballSha256);
const tap=await readFile(join(run,'check/focused.tap'),'utf8');assert.match(tap,/# fail 0\n/);
await mkdir(out);await mkdir(join(out,'evidence'));await mkdir(join(out,'maintainer-sources'));
await copyFile(join(run,'candidate',build.tarball),join(out,build.tarball));
for(const [from,to]of [['candidate/candidate.json','build.json'],['check/report.json','clean-install.json'],['check/focused.tap','focused.tap'],
  ['loading-b/report.json','demand-loading.json'],['native/report.json','single-platform-install.json']])await copyFile(join(run,from),join(out,'evidence',to));
const paths=[...build.changed.filter(p=>p.startsWith('examples/')).map(p=>'packages/kit/'+p),
  'packages/kit/scripts/prepare-demand-candidate.mjs','packages/kit/scripts/check-demand-loading.mjs','packages/kit/scripts/check-demand-native.mjs',
  'packages/kit/scripts/seal-demand-candidate.mjs','packages/kit/scripts/check-js-slim-candidate.mjs','packages/kit/test/react-native-engine-template.test.mjs'];
const sources={};for(const p of paths){const b=await readFile(join(root,p));sources[p]=sha256(b);await writeFile(join(out,'maintainer-sources',p.replaceAll('/','__')),b);}
const report={status:'PASS_LOCAL_ON_DEMAND_DISTRIBUTION',identity,baseline:build.baseline,tarball:build.tarball,sha256:build.tarballSha256,
  compressedBytes:build.compressedBytes,unpackedBytes:build.unpackedBytes,unchangedRuntimeFiles:runtime.length,
  checks:{focused:Number(tap.match(/# pass (\d+)\n/)[1]),onDemand:loading,realArchiveInstall:native},maintainerSources:sources,
  platformDownloads:native.results.map(r=>({platform:r.platform,bytes:r.downloadBytes,stagedBytes:r.copiedBytes})),
  published:false,pushed:false,deviceAcceptance:false,realBroadcast:false,
  limitations:['This candidate changes RN installation templates and delivery metadata only; all dist, WASM and SDK-lock bytes equal the prior accepted candidate.',
    'iOS/Android SDK archive installation and build preflight pass. No new native app build or device runtime is claimed.',
    'Download and staging reductions are not App-size reductions. Flutter delivery is unchanged.',
    'Client retains a lazy Keyless adapter for optional receipt verification; zero eager WASM fetching/initialization is tested.',
    'Total partner App increase still requires paired Release builds in the partner application; dependency-install sizes are not that measurement.']};
await writeFile(join(out,'acceptance.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,out,version:identity.version,focused:report.checks.focused,unchangedRuntimeFiles:runtime.length},null,2));
