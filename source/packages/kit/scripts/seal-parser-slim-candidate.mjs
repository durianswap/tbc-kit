import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,readdir,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileInventory,platformCatalog,sha256} from './platform-resources.mjs';
import {verifiedKitCandidate} from '../../../native/flutter/scripts/candidate-inputs.mjs';
const [runArg,baselineConsumerArg,outArg]=process.argv.slice(2);
assert.ok(outArg,'VERIFIED_RUN BASELINE_CONSUMER NEW_DELIVERY_DIRECTORY');
const run=resolve(runArg),baselineConsumer=resolve(baselineConsumerArg),out=resolve(outArg),root=resolve(import.meta.dirname,'../../..');
const json=async p=>JSON.parse(await readFile(p));
const build=await json(join(run,'candidate/candidate.json'));
const checks=await json(join(run,'check/report.json'));
const parity=await json(join(run,'parser-parity-b/report.json'));
const lifecycle=await json(join(run,'lifecycles/report.json'));
const hermes=await json(join(run,'hermes/runtime-provenance.json'));
assert.equal(checks.status,'PASS_CLEAN_INSTALL_AND_FOCUSED');
assert.equal(parity.status,'PASS_PARSER_DEPENDENCY_PARITY');
assert.equal(lifecycle.status,'PASS_CONTROLLED_PARITY_AND_TIMING');
const kit=join(run,'candidate/package'),consumer=join(run,'check/consumer');
const identity=await verifiedKitCandidate(kit);await platformCatalog(kit);
for(const value of [checks.identity,parity.identities[1],hermes.kitIdentity])assert.deepEqual(value,identity);
assert.equal(sha256(await readFile(join(run,'candidate',build.tarball))),build.tarballSha256);
const baselineKit=join(baselineConsumer,'node_modules/@tbc/kit');
assert.deepEqual(await verifiedKitCandidate(baselineKit),build.baseline);
const before=await fileInventory(join(baselineKit,'dist/types')),after=await fileInventory(join(kit,'dist/types'));
assert.deepEqual(before,after,'Public types changed');
const focused=await readFile(join(run,'check/focused.tap'),'utf8');
assert.match(focused,/# fail 0\n/);const testCount=Number(focused.match(/# pass (\d+)\n/)[1]);
const types=execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--skipLibCheck','false','--target','ES2022',
  '--module','NodeNext','--moduleResolution','NodeNext','--lib','ES2022,DOM',join(consumer,'probe-types.mts')],{encoding:'utf8'});
async function ownBytes(directory){
  let total=0;
  for(const e of await readdir(directory,{withFileTypes:true})){
    if(e.name==='node_modules')continue;
    const p=join(directory,e.name);
    if(e.isDirectory())total+=await ownBytes(p);else if(e.isFile())total+=(await lstat(p)).size;
  }return total;
}
async function dependencies(directory){
  const lock=await json(join(directory,'package-lock.json')),rows=[];
  for(const path of Object.keys(lock.packages).filter(p=>p&&p!=='node_modules/@tbc/kit'))rows.push({path,version:lock.packages[path].version,bytes:await ownBytes(join(directory,path))});
  return {packages:rows.length,bytes:rows.reduce((n,r)=>n+r.bytes,0),rows};
}
const dependencySizes={before:await dependencies(baselineConsumer),after:await dependencies(consumer)};
assert.ok(!dependencySizes.after.rows.some(r=>/node_modules\/(tbc-lib-js|tbc-contract|tbc-tx-parser)$/.test(r.path)));
await mkdir(out);await mkdir(join(out,'evidence'));await mkdir(join(out,'maintainer-sources'));
await copyFile(join(run,'candidate',build.tarball),join(out,build.tarball));
for(const [from,to]of [['candidate/candidate.json','build.json'],['check/report.json','clean-install.json'],['check/focused.tap','focused.tap'],
  ['parser-parity-b/report.json','parser-parity.json'],['lifecycles/report.json','controlled-parity-performance.json'],['hermes/runtime-provenance.json','hermes-compile.json'],
  ['check/consumer/package-lock.json','consumer-package-lock.json']])await copyFile(join(run,from),join(out,'evidence',to));
await writeFile(join(out,'evidence/types.log'),types);
await writeFile(join(out,'evidence/dependency-sizes.json'),JSON.stringify(dependencySizes,null,2)+'\n');
const sourceFiles=['packages/kit/scripts/build.mjs','packages/kit/scripts/portable-parser-dependencies.mjs',
  'packages/kit/scripts/prepare-parser-slim-candidate.mjs','packages/kit/scripts/check-parser-slim-parity.mjs',
  'packages/kit/scripts/seal-parser-slim-candidate.mjs','packages/kit/scripts/prepare-js-slim-candidate.mjs',
  'packages/kit/scripts/check-js-slim-candidate.mjs','packages/kit/test/portable-parser-dependency-closure.test.mjs',
  'packages/kit/package.json','package-lock.json'];
const sources={};for(const p of sourceFiles){const b=await readFile(join(root,p));sources[p]=sha256(b);await writeFile(join(out,'maintainer-sources',p.replaceAll('/','__')),b);}
const report={status:'PASS_LOCAL_PARSER_DEPENDENCY_CLOSURE',identity,baseline:build.baseline,tarball:build.tarball,sha256:build.tarballSha256,
  compressedBytes:build.compressedBytes,unpackedBytes:build.unpackedBytes,
  dependencies:{beforePackages:dependencySizes.before.packages,afterPackages:dependencySizes.after.packages,
    beforeBytes:dependencySizes.before.bytes,afterBytes:dependencySizes.after.bytes,savedBytes:dependencySizes.before.bytes-dependencySizes.after.bytes},
  changes:build.changed,checks:{focusedTests:testCount,cleanConsumer:true,publicTypecheck:true,publicTypesUnchanged:true,
    parserParity:parity.formats,controlledOperations:lifecycle.summary.length,alternatingRounds:lifecycle.rounds,hermesCompile:true},
  unchanged:{algorithms:true,publicExports:true,validations:true,nativeWasm:true,transactionRaws:true,httpSequence:true,approvalAndSignerCounts:true},
  maintainerSources:sources,published:false,pushed:false,deviceAcceptance:false,realBroadcast:false,
  limitations:['Offline clean-consumer, controlled parity and Hermes compile evidence, not new device or chain acceptance.',
    'Saved dependency bytes are node_modules disk footprint, not App or npm tarball savings.',
    'The pinned upstream tbc-lib-js remains a development-only source for reproducing the existing private parser copy; source notices are retained.']};
await writeFile(join(out,'acceptance.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,out,version:identity.version,dependencies:report.dependencies,checks:report.checks},null,2));
