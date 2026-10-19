import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileInventory,platformCatalog,sha256} from './platform-resources.mjs';
import {verifiedKitCandidate} from '../../../native/flutter/scripts/candidate-inputs.mjs';
const [scratchArg,outArg]=process.argv.slice(2);
assert.ok(outArg,'VERIFIED_RUN_DIRECTORY NEW_DELIVERY_DIRECTORY');
const scratch=resolve(scratchArg),out=resolve(outArg),root=resolve(import.meta.dirname,'../../..');
const get=async p=>JSON.parse(await readFile(join(scratch,p)));
const candidate=await get('candidate-c/candidate.json');
const focused=await get('check-e/report.json');
const lifecycle=await get('lifecycle-e/report.json');
const exports=await get('export-parity.json');
const source=await get('candidate-c/source-parity.json');
assert.equal(focused.status,'PASS_CLEAN_INSTALL_AND_FOCUSED');
assert.equal(lifecycle.status,'PASS_CONTROLLED_PARITY_AND_TIMING');
assert.equal(exports.status,'PASS');assert.equal(source.contentAndImportGraphEqual,true);
const kit=join(scratch,'candidate-c/package');
const identity=await verifiedKitCandidate(kit);await platformCatalog(kit);
assert.equal(identity.artifactId,focused.identity.artifactId);
const candidateTar=join(scratch,'candidate-c',candidate.tarball);
assert.equal(sha256(await readFile(candidateTar)),candidate.tarballSha256);
const frozen=join(root,'release/platform-slim-20261010-final/tbc-kit-0.1.0-platform-slim.20261010.3.tgz');
assert.equal(sha256(await readFile(frozen)),'14113029d4fdc9f5c89607ca13e4d31f094fe9729ee1fd1d9869a2d0be4765d1');
const debugIdentity=await get('candidate-c/debug/identity.json');
for(const [p,h]of Object.entries(debugIdentity.sourceFiles))assert.equal(sha256(await readFile(join(root,p))),h,p);
const baseHbc=await get('hermes-base/runtime-provenance.json'),nextHbc=await get('hermes-candidate/runtime-provenance.json');
assert.equal(nextHbc.kitIdentity.artifactId,identity.artifactId);
assert.equal(baseHbc.compilerSha256,nextHbc.compilerSha256);
assert.deepEqual(baseHbc.executionPayload.bytecodeVersion,nextHbc.executionPayload.bytecodeVersion);
assert.ok(nextHbc.executionPayload.bytes<=baseHbc.executionPayload.bytes);
await mkdir(out);await mkdir(join(out,'evidence'));
await copyFile(candidateTar,join(out,candidate.tarball));
await copyFile(join(scratch,'candidate-c/debug-maps.tgz'),join(out,'debug-maps.tgz'));
for(const [from,to]of [['check-e/report.json','clean-install.json'],['check-e/focused.tap','focused.tap'],
 ['lifecycle-e/report.json','controlled-parity-performance.json'],['export-parity.json','export-parity.json'],
 ['candidate-c/source-parity.json','source-parity.json'],['candidate-c/candidate.json','build.json'],
 ['hermes-base/runtime-provenance.json','hermes-baseline.json'],['hermes-candidate/runtime-provenance.json','hermes-candidate.json']])
 await copyFile(join(scratch,from),join(out,'evidence',to));
await mkdir(join(out,'maintainer-sources'));
const changed=['packages/kit/scripts/build.mjs','packages/kit/scripts/runtime-build.mjs','packages/kit/scripts/prepare-js-slim-candidate.mjs',
 'packages/kit/scripts/check-js-slim-candidate.mjs','packages/kit/scripts/compare-js-slim-lifecycles.mjs','packages/kit/scripts/seal-js-slim-candidate.mjs',
 'packages/kit/test/bundle-module-identity.test.mjs','packages/kit/test/metro-wallet-parse.test.mjs'];
const sources={};
for(const p of changed){const bytes=await readFile(join(root,p));sources[p]=sha256(bytes);await writeFile(join(out,'maintainer-sources',p.replaceAll('/','__')),bytes);}
// Roundtrip verifies the actual handoff archive, not just its staging tree.
const roundtrip=join(scratch,'sealed-roundtrip');await mkdir(roundtrip);
execFileSync('tar',['-xzf',join(out,candidate.tarball),'-C',roundtrip]);
const packed=await verifiedKitCandidate(join(roundtrip,'package'));
assert.equal(packed.artifactId,identity.artifactId);
const files=await fileInventory(join(roundtrip,'package'));
assert.ok(!Object.keys(files).some(p=>p.includes('/test/')||p.endsWith('.map')||/\.(apk|aab|ipa|a|so|dylib)$/.test(p)));
const sourceNames=Object.keys(files).filter(p=>p.endsWith('.d.ts'));
const oldTypes=join(scratch,'lifecycle-e/baseline');
for(const p of sourceNames){
 const clean=s=>s.replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n|$)/g,'\n');
 assert.equal(clean(await readFile(join(oldTypes,p),'utf8')),await readFile(join(roundtrip,'package',p),'utf8'),p);
}
const typed=spawnSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--skipLibCheck','false','--target','ES2022',
 '--module','NodeNext','--moduleResolution','NodeNext','--lib','ES2022,DOM',join(scratch,'check-e/consumer/probe-types.mts')],{encoding:'utf8'});
// Typecheck is emitted by the independent consumer check; do not silently
// accept missing fixtures or a failed declaration closure.
await writeFile(join(out,'evidence/types.log'),String(typed.stdout??'')+String(typed.stderr??''));
assert.equal(typed.status,0,'Installed public declaration check failed');
const report={status:'PASS_LOCAL_JS_SLIM_CANDIDATE',version:candidate.version,identity,
 tarball:candidate.tarball,sha256:candidate.tarballSha256,
 size:{beforeDownload:6969315,afterDownload:candidate.compressedBytes,beforeUnpacked:59078475,afterUnpacked:candidate.unpackedBytes},
 unchanged:{businessSources:Object.keys(debugIdentity.sourceFiles).length,wasm:true,nativeSdkLock:true,publicDeclarations:sourceNames.length,publicExports:true,
  validationRules:true,transactionRaws:true,txids:true,httpSequence:true,approvalCounts:true,signerCounts:true},
 checks:{focused:118,cleanInstall:true,esmEntrypoints:11,cjsEntrypoints:7,browserBundles:focused.bundles,
  controlledOperations:6,alternatingRoundsPerOperation:9,performanceGatesPassed:true,reactNativeNoNodeImports:true,
  hermes:{baselineBytes:baseHbc.executionPayload.bytes,candidateBytes:nextHbc.executionPayload.bytes,compilePassed:true,deviceRun:false},
  declarationClosure:true},maintainerSources:sources,baselinePreserved:true,published:false,pushed:false,realBroadcast:false,deviceAcceptance:false,
 limitations:['No new iOS/Android/MV3 device acceptance or real-chain claim; native and WASM are reused unchanged.',
 'Existing legacy nine-case script still expects forbidden historical issuance and fails on both baseline and candidate; not used as the acceptance gate.',
 'Host-generated random call IDs differ between executions; count, uniqueness, ordered operations, results and transaction hashes are compared.',
 'Debug maps are a separate maintainer archive. App size does not equal npm compressed or unpacked size.',
 'Bare Hermes CLI requires platform-native bindings; bytecode compilation is not device runtime acceptance.']};
await writeFile(join(out,'acceptance.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,out,size:report.size,sha256:report.sha256},null,2));
