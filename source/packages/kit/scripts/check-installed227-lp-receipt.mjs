// Replay unchanged receipt tests against an independently installed final227.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,cp,symlink,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const repo=resolve(import.meta.dirname,'../../..'),[rootArg,consumerArg]=process.argv.slice(2);
assert.ok(rootArg&&consumerArg);
const root=resolve(rootArg),consumer=resolve(consumerArg),installed=join(consumer,'node_modules/@tbc/kit');
const sha=b=>createHash('sha256').update(b).digest('hex');
const final=JSON.parse(await readFile(join(root,'candidate227-delivery.json')));
assert.equal(final.candidate,'0.1.0-candidate.227');assert.equal(sha(await readFile(final.tar)),final.sha256);
assert.equal(JSON.parse(await readFile(join(installed,'package.json'))).version,final.candidate);
const archive=await mkdtemp(join(tmpdir(),'tbc227-installed-reference-'));
execFileSync('tar',['-xzf',final.tar,'-C',archive]);
let installedFiles=0;
async function compare(path=''){
 for(const entry of await readdir(join(archive,'package',path),{withFileTypes:true})){
  const p=join(path,entry.name);
  // Compare the actual npm file allowlist, not excluded maintainer evidence.
  if(entry.isDirectory())await compare(p);
  else {assert.equal(entry.isFile(),true,p);
   assert.equal(sha(await readFile(join(installed,p))),sha(await readFile(join(archive,'package',p))),p);installedFiles++;}
 }
}
await compare();assert.equal(installedFiles,final.entryCount);
const scratch=await mkdtemp(join(tmpdir(),'tbc227-lp-installed-'));
await mkdir(join(scratch,'packages/kit/test'),{recursive:true});
await mkdir(join(scratch,'packages/tbc-engine/rust/fixtures'),{recursive:true});
await symlink(join(installed,'dist'),join(scratch,'packages/kit/dist'));
await symlink(join(installed,'artifacts'),join(scratch,'packages/kit/artifacts'));
await symlink(join(repo,'node_modules'),join(scratch,'node_modules'));
await writeFile(join(scratch,'package.json'),JSON.stringify({private:true,type:'module'}));
const inputs=['lp-receipt.test.mjs','receipt-verification.test.mjs','receipt-types.test.mjs',
 'tsconfig.receipt-public.json','types/receipt-public-consumer.ts','fixtures/controlled-pool.json'];
const hashes={};
for(const name of inputs){const p='packages/kit/test/'+name;
 await cp(join(root,p),join(scratch,p));hashes[p]=sha(await readFile(join(root,p)));}
const fixture='packages/tbc-engine/rust/fixtures/amm-pool-proof.json';
await cp(join(root,fixture),join(scratch,fixture));hashes[fixture]=sha(await readFile(join(root,fixture)));
const env={...process.env};delete env.TBC_LP_RECEIPT_WASM;
const tap=execFileSync(process.execPath,['--test',...inputs.filter(p=>p.endsWith('.test.mjs')).map(p=>'packages/kit/test/'+p)],
 {cwd:scratch,env,encoding:'utf8',maxBuffer:8*1024*1024});
assert.match(tap,/# tests 18\n/);assert.match(tap,/# pass 18\n/);assert.match(tap,/# fail 0\n/);
const evidence=join(repo,'docs/distribution/candidate227-lp-receipt');await mkdir(evidence);
await writeFile(join(evidence,'installed.tap'),tap,{flag:'wx'});
for(const [name,path] of [['build-input.json',join(root,'build-input.json')],['candidate227-delivery.json',join(root,'candidate227-delivery.json')],
 ['source-snapshot.json',join(root,'source-snapshot.json')],['native-consumer.json',final.nativeSdkConsumerReport],['native-platform.json',final.nativeSdkPlatformReport]])
 await writeFile(join(evidence,name),await readFile(path),{flag:'wx'});
const delivery=join(repo,'native/engine/delivery/candidate227-complete'),manifest=JSON.parse(await readFile(join(delivery,'delivery.json')));
assert.equal(manifest.kitSha256,final.sha256);assert.equal(manifest.assets.length,4);
for(const asset of manifest.assets)assert.equal(sha(await readFile(join(delivery,asset.file))),asset.sha256,asset.file);
const report={status:'PASS_INSTALLED227_LP_RECEIPT',at:new Date().toISOString(),candidate:final.candidate,kitSha256:final.sha256,
 installed,installedFiles,sourceTestHashes:hashes,tests:18,tapSha256:sha(tap),toolSha256:sha(await readFile(import.meta.filename)),
 delivery,deliveryManifestSha256:sha(await readFile(join(delivery,'delivery.json'))),scratch,
 boundaries:{realChainAcceptance:false,networkRequests:0,signing:0,broadcasts:0,oldMethodsDeleted:false,mobileChanged:false,published:false},goalComplete:false};
await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report));
