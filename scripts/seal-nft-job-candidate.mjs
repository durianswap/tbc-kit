// Seal tested candidate and source snapshot; never mutate release/current or partner archives.
import assert from 'node:assert/strict';
import {readFile,writeFile,lstat,mkdtemp,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const repo=resolve(import.meta.dirname,'..'),[outArg,protectedArg]=process.argv.slice(2);assert(protectedArg);
const out=resolve(outArg),hash=b=>createHash('sha256').update(b).digest('hex');
const json=async p=>JSON.parse(await readFile(p,'utf8')),put=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
const lock=await json(join(out,'delivery-lock.json')),build=await json(join(out,'evidence/build.json')),checks=await json(join(out,'evidence/installed-check.json'));
assert.equal(checks.status,'PASS');assert.equal(hash(await readFile(join(out,'tbc-kit.tgz'))),checks.kitSha256);assert.equal(checks.kitSha256,lock.kit.sha256);
for(const [p,h]of Object.entries(build.sourceFiles))assert.equal(hash(await readFile(join(repo,p))),h,'Build source changed: '+p);
const frozen=await json(resolve(protectedArg));for(const [p,h]of Object.entries(frozen))assert.equal(hash(await readFile(p)),h,p);
for(const a of Object.values(lock.baseline))assert.equal(hash(await readFile(join(repo,a.path))),a.sha256,a.path);
const listed=execFileSync('git',['ls-files','-c','-o','--exclude-standard','-z','source','scripts'],{cwd:repo}).toString().split('\0').filter(Boolean);
// Sources and tooling only. Frozen binaries, private accounts and generated targets are not source.
const files=[...new Set(listed)].filter(p=>!/(^|\/)(node_modules|target|\.git|\.verify)(\/|$)/.test(p)).sort(),manifest={};
for(const p of files){assert(!(await lstat(join(repo,p))).isSymbolicLink(),p);manifest[p]=hash(await readFile(join(repo,p)));}
await put(join(out,'source-manifest.json'),{kitVersion:lock.kitVersion,baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),files:manifest});
const scratch=await mkdtemp(join(repo,'.verify/nft-job-source-')),list=join(scratch,'files.txt');await writeFile(list,files.join('\n')+'\n');
execFileSync('tar',['--no-mac-metadata','-czf',join(out,'tbc-kit-source.tgz'),'-T',list],{cwd:repo,env:{...process.env,COPYFILE_DISABLE:'1'}});
const archiveList=execFileSync('tar',['-tzf',join(out,'tbc-kit-source.tgz')],{encoding:'utf8',maxBuffer:16e6}).trim().split('\n').sort();assert.deepEqual(archiveList,files);
const source=await readFile(join(out,'tbc-kit-source.tgz'));await put(join(out,'source-archive.json'),{file:'tbc-kit-source.tgz',sha256:hash(source),bytes:source.length,files:files.length});
await put(join(out,'evidence/protected-after.json'),{status:'PASS',files:Object.keys(frozen).length,frozenArchives:Object.keys(lock.baseline).length,currentReleaseChanged:false,partnerDeliveryChanged:false,realBroadcasts:0});
const evidenceFiles={};for(const name of (await readdir(join(out,'evidence'))).sort())evidenceFiles[name]=hash(await readFile(join(out,'evidence',name)));
await put(join(out,'evidence-manifest.json'),{files:evidenceFiles});
execFileSync('tar',['--no-mac-metadata','-czf',join(out,'validation-evidence.tgz'),'evidence','evidence-manifest.json'],{cwd:out,env:{...process.env,COPYFILE_DISABLE:'1'}});
const names=['tbc-kit.tgz','tbc-kit-source.tgz','validation-evidence.tgz','evidence-manifest.json','delivery-lock.json','native-sdk-lock.json','source-manifest.json','source-archive.json','README.md','REPORT.md','evidence/installed-check.json','evidence/protected-after.json'];
const sums=[];for(const p of names)sums.push(`${hash(await readFile(join(out,p)))}  ${p}`);await writeFile(join(out,'DOWNLOADS.SHA256'),sums.join('\n')+'\n');
console.log(JSON.stringify({status:'PASS',kit:lock.kit,sourceBytes:source.length,sourceFiles:files.length,protectedUnchanged:Object.keys(frozen).length}));
