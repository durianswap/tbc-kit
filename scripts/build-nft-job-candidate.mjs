// Isolated JS candidate. No network, native rebuild, release replacement or broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,mkdtemp,readdir,rm,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildKitRuntime} from '../source/packages/kit/scripts/runtime-build.mjs';
import {omitEmbeddedSources} from '../source/packages/kit/scripts/source-map-policy.mjs';
import {fileInventory,sha256,platformCatalog} from '../source/packages/kit/scripts/platform-resources.mjs';
const repo=resolve(import.meta.dirname,'..'),root=join(repo,'source');
const [outArg,protectedArg]=process.argv.slice(2);assert(protectedArg,'NEW_CANDIDATE PROTECTED_MANIFEST');
const out=resolve(outArg),json=async p=>JSON.parse(await readFile(p,'utf8'));
const put=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
const run=(cmd,args,cwd=repo)=>execFileSync(cmd,args,{cwd,encoding:'utf8',maxBuffer:32e6,env:{...process.env,COPYFILE_DISABLE:'1'}});
const release=await json(join(repo,'release/current.json')),pkg=await json(join(root,'packages/kit/package.json'));
assert.ok(['0.1.0-rc.24','0.1.0-rc.25','0.1.0-rc.26'].includes(pkg.version));assert.equal(release.pairing.kitVersion,'0.1.0-rc.23');
const protectedFiles=await json(resolve(protectedArg)),frozen={};
for(const [p,h]of Object.entries(protectedFiles))assert.equal(sha256(await readFile(p)),h,p);
for(const a of release.artifacts){assert.equal(sha256(await readFile(join(repo,a.path))),a.sha256,a.path);frozen[a.id]=a;}
for(const p of ['source/packages/tbc-engine','source/native','source/schemas','source/registry'])assert.equal(run('git',['diff','HEAD','--',p]),'',p);
await mkdir(out);await mkdir(join(out,'evidence'));const scratch=await mkdtemp(join(repo,'.verify/nft-job-rc24-')),stage=join(scratch,'package');
run('tar',['-xzf',join(repo,frozen.kit.path),'-C',scratch]);const before=await fileInventory(stage);
for(const format of ['esm','cjs'])for(const e of await readdir(join(stage,'dist',format),{withFileTypes:true}))if(e.isFile())await rm(join(stage,'dist',format,e.name));
await buildKitRuntime({root,packageRoot:stage});await omitEmbeddedSources(join(stage,'dist'));
const types=join(scratch,'types');run(join(root,'node_modules/.bin/tsc'),['-p',join(root,'packages/kit/tsconfig.json'),'--declarationDir',types,'--declarationMap','false']);
for(const f of await readdir(types))if(f.endsWith('.d.ts')){let s=await readFile(join(types,f),'utf8');
 for(const [a,b]of [['host/sqlite','host/sqlite'],['core','core/index'],['host','host/index'],['provider','provider/index']])s=s.replaceAll(`"@tbc-wallet/${a}"`,`"./internal/${b}.js"`);
 await writeFile(join(stage,'dist/types',f),s);}
await cp(join(root,'packages/kit/docs'),join(stage,'docs'),{recursive:true});await cp(join(root,'packages/kit/examples'),join(stage,'examples'),{recursive:true});await put(join(stage,'package.json'),pkg);
const provenance=await json(join(stage,'artifacts/provenance.json')),catalog=await json(join(stage,'artifacts/platform-resources.json'));
provenance.package=catalog.package=`${pkg.name}@${pkg.version}`;await put(join(stage,'artifacts/platform-resources.json'),catalog);
provenance.platformResources.sha256=sha256(await readFile(join(stage,'artifacts/platform-resources.json')));
provenance.distribution={kind:'source-built-js-with-verified-frozen-native',baselineVersion:release.pairing.kitVersion,
 baselineArchiveSha256:frozen.kit.sha256,nativeSdkVersion:release.pairing.sdkVersion,
 changes:['unified bounded NFT mint job','typed expiry and partial progress','preserve existing reconciliation and post-deadline outcome accounting',...(['0.1.0-rc.25','0.1.0-rc.26'].includes(pkg.version)?['typed permission and session commit expiry']:[]),...(pkg.version==='0.1.0-rc.26'?['refresh trusted clock after rejected native job approval','preserve invalid consent rejection','document private Hermes native SHA integration without changing checks']:[])],realBroadcasts:0};
await put(join(stage,'artifacts/provenance.json'),provenance);await platformCatalog(stage);
const after=await fileInventory(stage),preserved=Object.keys(before).filter(p=>/^artifacts\/wasm\//.test(p)||/^dist\/(esm|cjs)\/vendor\//.test(p));
for(const p of preserved)assert.deepEqual(after[p],before[p],p);
const sourceFiles={};for(const p of [...new Set(run('git',['ls-files','-c','-o','--exclude-standard','-z','source','scripts/build-nft-job-candidate.mjs']).split('\0').filter(Boolean))].sort())sourceFiles[p]=sha256(await readFile(join(repo,p)));
await put(join(stage,'artifacts/source-build.json'),{schemaVersion:1,version:pkg.version,status:'source-built-js-frozen-native-not-device-or-chain-accepted',sourceDigest:sha256(JSON.stringify(sourceFiles)),baselineArchiveSha256:frozen.kit.sha256});
const [pack]=JSON.parse(run('npm',['pack',stage,'--ignore-scripts','--json','--pack-destination',out],scratch));await rename(join(out,pack.filename),join(out,'tbc-kit.tgz'));
await cp(join(repo,'release/native-sdk-lock.json'),join(out,'native-sdk-lock.json'));
const lock={schemaVersion:1,kitVersion:pkg.version,sdkVersion:release.pairing.sdkVersion,protocolFingerprint:release.pairing.protocolFingerprint,sdkArtifactSetId:release.pairing.sdkArtifactSetId,
 kit:{file:'tbc-kit.tgz',sha256:sha256(await readFile(join(out,'tbc-kit.tgz'))),bytes:pack.size,unpackedBytes:pack.unpackedSize},
 pairedNative:{ios:frozen['sdk-ios'],android:frozen['sdk-android']},platformResources:catalog.platforms,baseline:frozen,currentReleaseChanged:false,partnerDeliveryChanged:false};
await put(join(out,'delivery-lock.json'),lock);
await put(join(out,'evidence/build.json'),{status:'PASS',stage,scratch,sourceFiles,preservedComputeAndParserFiles:preserved.length,protectedFiles:Object.keys(protectedFiles).length,realBroadcasts:0});
console.log(JSON.stringify({out,stage,kit:lock.kit,sdkVersion:lock.sdkVersion,protectedUnchanged:Object.keys(protectedFiles).length}));
