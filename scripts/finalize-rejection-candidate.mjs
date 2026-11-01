// Seal a tested candidate only; no publish, commit, broadcast or accepted-file writes.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {sha256,fileInventory} from '../source/packages/kit/scripts/platform-resources.mjs';
const repo=resolve(import.meta.dirname,'..'),[outArg,protectedArg]=process.argv.slice(2);
assert(protectedArg,'CANDIDATE PROTECTED_MANIFEST');const out=resolve(outArg);
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const put=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
const lock=await json(join(out,'delivery-lock.json')),build=await json(join(out,'evidence/build.json'));
const installed=await json(join(out,'evidence/installed-check.json')),native=await json(join(out,'evidence/native-consumers.json'));
assert.equal(installed.status,'PASS');assert.equal(native.status,'PASS');assert.deepEqual(installed.kit,lock.kit);
assert.equal(native.sdkVersion,lock.sdkVersion);
const stage=(await json(join(out,'evidence/stage.json'))).stage;
assert.deepEqual(await fileInventory(stage),build.stagedFiles,'Staging changed after packaging');
for(const [p,h]of Object.entries(build.sourceFiles))assert.equal(sha256(await readFile(join(repo,p))),h,'Source drift: '+p);
const baseline=Object.values(lock.baseline);
for(const a of baseline)assert.equal(sha256(await readFile(join(repo,a.file))),a.sha256,'Frozen archive: '+a.file);
const frozen=await json(resolve(protectedArg));
for(const [p,h]of Object.entries(frozen))assert.equal(sha256(await readFile(p)),h,'Protected delivery: '+p);
const testCounts={};
for(const f of ['source-targeted-final.tap','core-targeted.tap','nft-targeted.tap','installed-business-tests.tap']){
  const s=await readFile(join(out,'evidence',f),'utf8');assert.match(s,/# fail 0(?:\r?\n|$)/);
  testCounts[f]=Number(s.match(/# pass (\d+)/)[1]);
}
assert.match(await readFile(join(out,'evidence/rust-amm.log'),'utf8'),/test result: ok\. 13 passed; 0 failed/);
const resources=Object.values(lock.resources).map(g=>({file:g.archive,sha256:g.archiveSha256}));
for(const a of [lock.kit,...Object.values(lock.pairedNative),...resources])assert.equal(sha256(await readFile(join(out,a.file))),a.sha256,a.file);
assert.equal(execFileSync('git',['diff','--name-only','HEAD','--','artifacts','packages/kit','release/current.json','release/native-sdk-lock.json'],{cwd:repo,encoding:'utf8'}),'');
const checked={status:'PASS',protectedFiles:Object.keys(frozen).length,frozenArchives:baseline.length,
  sourceFiles:Object.keys(build.sourceFiles).length,testCounts,rustAmmTests:13,nativeVectors:native.vectors,
  currentReleaseChanged:false,partnerDeliveryChanged:false,realBroadcasts:0,deviceRuntimeAcceptance:false};
await put(join(out,'evidence/protected-after.json'),checked);

const names=execFileSync('git',['ls-files','-c','-o','--exclude-standard','-z','source','scripts','LICENSE'],{cwd:repo,encoding:'utf8',maxBuffer:8e6}).split('\0').filter(Boolean);
// Source archive deliberately excludes old prebuilt artifacts, caches and root
// accepted packages. Exact installable bytes are the separately hashed SDKs.
const files=[...new Set(names)].filter(p=>!/(^|\/)(artifacts|dist|node_modules|target|\.verify)(\/|$)/.test(p)).sort();
const manifest={};for(const p of files){assert((await lstat(join(repo,p))).isFile(),p);manifest[p]=sha256(await readFile(join(repo,p)));}
await put(join(out,'source-manifest.json'),{schema:1,kitVersion:lock.kitVersion,baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
  sourceDigest:build.sourceDigest,excludedPrebuiltResources:true,files:manifest});
const temp=await mkdtemp(join(repo,'.verify/rc23-source-')),list=join(temp,'files.txt');await writeFile(list,files.join('\n')+'\n');
const archive='tbc-kit-source.tgz';execFileSync('tar',['--no-mac-metadata','-czf',join(out,archive),'-T',list],{cwd:repo,env:{...process.env,COPYFILE_DISABLE:'1'}});
assert.deepEqual(execFileSync('tar',['-tzf',join(out,archive)],{encoding:'utf8',maxBuffer:8e6}).trim().split('\n').sort(),files);
const bytes=await readFile(join(out,archive));await put(join(out,'source-archive.json'),{file:archive,bytes:bytes.length,sha256:sha256(bytes),files:files.length});
const downloads=['tbc-kit.tgz','ios-sdk.tgz','android-sdk.tgz',...resources.map(r=>r.file),archive,
  'delivery-lock.json','native-sdk-lock.json','source-manifest.json','source-archive.json','README.md','REPORT.md'];
const evidence=await fileInventory(join(out,'evidence'));
await put(join(out,'evidence-manifest.json'),{schema:1,files:evidence});downloads.push('evidence-manifest.json');
await writeFile(join(out,'DOWNLOADS.SHA256'),(await Promise.all(downloads.map(async p=>`${sha256(await readFile(join(out,p)))}  ${p}`))).join('\n')+'\n');
console.log(JSON.stringify({...checked,sourceBytes:bytes.length,downloads}));
