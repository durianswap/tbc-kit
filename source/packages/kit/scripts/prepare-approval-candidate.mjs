// A source-built, allowlisted approval candidate. Never changes current release.
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildKitRuntime} from './runtime-build.mjs';
import {pairApprovalEngine} from './pair-approval-engine.mjs';

const repo=resolve(import.meta.dirname,'../../../..'),source=join(repo,'source');
// HEAD advances when the candidate is committed; frozen pairing must not.
const frozenSourceCommit='23ab0bd5294dd19f4746011215c8b3e9c76a1470';
const out=resolve(process.argv[2]??''),version=process.argv[3];
const compute=process.argv[4]?resolve(process.argv[4]):null;
assert(process.argv[2]&&/^0\.1\.0-rc\.\d+$/.test(version),'NEW_OUTPUT NEW_RC_VERSION');
assert(!repo.startsWith(out+'/')&&out!==repo);
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const save=async(p,v)=>{await mkdir(dirname(p),{recursive:true});await writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2)+'\n');};
async function inventory(dir,prefix=''){
 const entries={};
 for(const e of (await readdir(join(dir,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  assert(!e.isSymbolicLink(),`No package symlinks: ${prefix}/${e.name}`);
  const p=join(prefix,e.name);
  if(e.isDirectory())Object.assign(entries,await inventory(dir,p));
  else entries[p]=sha(await readFile(join(dir,p)));
 }
 return entries;
}
const current=await json(join(repo,'release/current.json'));
assert.notEqual(current.pairing.kitVersion,version);
const protectedPaths=[...current.artifacts.map(a=>join(repo,a.path)),join(repo,'release/current.json'),
 join(repo,'SHA256SUMS'),join(repo,'release/source-files.json'),'/Users/alex/Downloads/tbc-wallet-integration.zip'];
const protectedBefore=Object.fromEntries(await Promise.all(protectedPaths.map(async p=>[p,sha(await readFile(p))])));
const kitBase=join(repo,'packages/kit'),flutterBase=join(repo,'packages/flutter');
const kitBefore=await inventory(kitBase),flutterBefore=await inventory(flutterBase);
await mkdir(out); // refuse to overwrite any prior candidate
await save(join(out,'protected-before.json'),protectedBefore);
const kit=join(out,'package'),flutter=join(out,'tbc_kit_flutter_dart');
await cp(kitBase,kit,{recursive:true});await cp(flutterBase,flutter,{recursive:true});
const sources={},overrides=new Map();
// Other ongoing work belongs to the user. This candidate uses committed code
// for it, and retains the frozen native/WASM multisig implementations.
for(const p of ['keyless.ts','multisig.ts']){
 const path=join(source,'packages/kit/src',p);
 const value=execFileSync('git',['show',`${frozenSourceCommit}:source/packages/kit/src/${p}`],{cwd:repo,encoding:'utf8'});
 overrides.set(path,value);sources[`${frozenSourceCommit}:source/packages/kit/src/${p}`]=sha(value);
}
for(const format of ['esm','cjs'])for(const name of await readdir(join(kit,'dist',format))){
 if(name==='vendor')continue;
 // Only inside the new copy, never source, baseline or frozen packages.
 await rm(join(kit,'dist',format,name),{recursive:true});
}
await buildKitRuntime({root:source,packageRoot:kit,minifyWhitespace:true,sourceOverrides:overrides});
execFileSync(process.execPath,[join(source,'node_modules/typescript/bin/tsc'),'-p',join(source,'packages/kit/tsconfig.json'),
 '--declarationDir',join(out,'generated-types'),'--declarationMap','false'],{cwd:repo,stdio:'inherit'});
// The only changed public TS model; keep the already self-contained closure.
await cp(join(out,'generated-types/approval-presentation.d.ts'),join(kit,'dist/types/approval-presentation.d.ts'));
await cp(join(out,'generated-types/wallet.d.ts'),join(kit,'dist/types/wallet.d.ts'));
async function overlay(from,to){
 const bytes=await readFile(join(repo,from));sources[from]=sha(bytes);
 await mkdir(dirname(to),{recursive:true});await writeFile(to,bytes);
}
await overlay('source/packages/kit/docs/reference/approval-presentation-coverage.md',join(kit,'docs/reference/approval-presentation-coverage.md'));
for(const f of ['README.md','renderer.mjs'])await overlay('source/packages/kit/examples/approval-presentation/'+f,join(kit,'examples/approval-presentation',f));
for(const [from,to]of [
 ['platform/ios/Classes/NativeCustody.swift','ios/Classes/NativeCustody.swift'],
 ['platform/android/src/main/kotlin/io/tbc/kit/dart/NativeCustody.kt','android/src/main/kotlin/io/tbc/kit/dart/NativeCustody.kt'],
 ['examples/approval/PartnerApprovalPresenter.swift','example/ios/PartnerApprovalPresenter.swift'],
 ['examples/approval/PartnerApprovalPresenter.kt','example/android/PartnerApprovalPresenter.kt'],
 ['docs/approval-presentation.md','docs/approval-presentation.md']]){
 if(from.startsWith('platform/')){
  const head=execFileSync('git',['show',`${frozenSourceCommit}:source/native/flutter-dart-kit/${from}`],{cwd:repo});
  assert.equal(sha(head),flutterBefore[to],`Frozen native baseline mismatch: ${to}`);
 }
 await overlay('source/native/flutter-dart-kit/'+from,join(flutter,to));
}
for(const p of ['source/packages/kit/src/approval-presentation.ts','source/packages/kit/src/wallet.ts','source/packages/kit/src/vendor/tbc-tx-parser/index.d.ts',
 'source/scripts/generate-provider-validators.mjs','source/packages/provider/src/generated/validators.ts',
 'source/packages/kit/scripts/runtime-build.mjs','source/packages/kit/scripts/prepare-approval-candidate.mjs'])
 sources[p]=sha(await readFile(join(repo,p)));
// Compiler maps are useful for maintainers, not the installation archive.
async function removeMaps(dir){
 for(const e of await readdir(dir,{withFileTypes:true})){
  const p=join(dir,e.name);if(e.isDirectory()){if(e.name!=='vendor')await removeMaps(p);continue;}
  if(e.name.endsWith('.map'))await rm(p);
  else if(/\.(js|cjs|ts)$/.test(e.name)){
   const text=await readFile(p,'utf8');
   await writeFile(p,text.replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n|$)/g,'\n'));
  }
 }
}
await removeMaps(join(kit,'dist/esm'));
await removeMaps(join(kit,'dist/cjs'));
// The optional multisig entry is outside this patch. Verify regenerated code,
// then retain the original bytes (including its harmless trailing newlines).
for(const p of ['dist/esm/multisig.js','dist/cjs/multisig.cjs']){
 assert.equal((await readFile(join(kit,p),'utf8')).trim(),(await readFile(join(kitBase,p),'utf8')).trim(),p);
 await cp(join(kitBase,p),join(kit,p));
}
const pkg=await json(join(kit,'package.json'));pkg.version=version;await save(join(kit,'package.json'),pkg);
const pairing=compute?await pairApprovalEngine({repo,out,kit,flutter,compute,version}):null;
const parent=await json(join(kit,'artifacts/distribution.json')),provenance=await json(join(kit,'artifacts/provenance.json'));
provenance.package=`@tbc/kit@${version}`;
provenance.approvalDisplay={parentArtifactId:parent.artifactId,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
 sources,nativeAndWasmChanged:!!pairing,newNetworkReads:0,published:false,
 sourceBuild:'Committed JS source plus listed approval changes. Uncommitted multisig changes excluded.',
 inheritedSourceCheck:'Core/Provider decoded crypto byte-budget validation is already committed but absent from the frozen JS; covered by targeted candidate tests.'};
provenance.approvalDisplay.providerInteropFix='Generated named validate export, same validation function and schema; fixes CommonJS default-import wrapping.';
const catalog=await json(join(kit,'artifacts/platform-resources.json'));catalog.package=provenance.package;
await save(join(kit,'artifacts/platform-resources.json'),catalog);
provenance.platformResources.sha256=sha(await readFile(join(kit,'artifacts/platform-resources.json')));
await save(join(kit,'artifacts/provenance.json'),provenance);
const identity={...parent,version,...(pairing?{protocolFingerprint:pairing.fingerprint,rustSourceSha256:pairing.sourceSha256}:{}),files:await inventory(kit)};delete identity.artifactId;delete identity.files['artifacts/distribution.json'];
await save(join(kit,'artifacts/distribution.json'),{artifactId:sha(JSON.stringify(identity)),...identity});
await save(join(flutter,'pubspec.yaml'),(await readFile(join(flutter,'pubspec.yaml'),'utf8')).replace(/^version: .+$/m,`version: ${version}`));
await save(join(flutter,'android/build.gradle'),(await readFile(join(flutter,'android/build.gradle'),'utf8')).replace(/^version ['"].+['"]$/m,`version '${version}'`));
await save(join(flutter,'README.md'),(await readFile(join(flutter,'README.md'),'utf8'))+
 '\n## Approval presentation\n\nUse the [shared approval model and native adapters](docs/approval-presentation.md) to show each step and update bound details without a second approval.\n');
const nativeManifest=await json(join(flutter,'distribution.json'));
nativeManifest.approvalDisplay={version,parentPackageSha256:protectedBefore[join(repo,'artifacts/tbc-kit-flutter.tgz')],sources:Object.fromEntries(Object.entries(sources).filter(([p])=>p.startsWith('source/native/'))),nativeLibrariesChanged:!!pairing};
if(pairing){const manifest=await json(join(kit,'artifacts/distribution.json'));nativeManifest.kitIdentity={...nativeManifest.kitIdentity,artifactId:manifest.artifactId,manifestSha256:sha(await readFile(join(kit,'artifacts/distribution.json')))};}
for(const p of ['platform/ios/Classes/NativeCustody.swift','platform/android/src/main/kotlin/io/tbc/kit/dart/NativeCustody.kt'])
 nativeManifest.sourceHashes[p]=sources['source/native/flutter-dart-kit/'+p];
for(const p of ['distribution.json','ios/Resources/distribution.json','android/src/main/assets/tbc-kit/distribution.json'])await save(join(flutter,p),nativeManifest);
const flutterFiles=await inventory(flutter);delete flutterFiles['package-files.json'];
let bytes=0;for(const p of Object.keys(flutterFiles))bytes+=(await readFile(join(flutter,p))).length;
await save(join(flutter,'package-files.json'),{schema:1,files:flutterFiles,bytes});
const kitAfter=await inventory(kit),flutterAfter=await inventory(flutter);
for(const[p,h]of Object.entries(kitBefore))if((p.includes('/vendor/')||p.startsWith('artifacts/wasm/')||p.includes('/multisig.'))&&!pairing?.allowedKit.includes(p))assert.equal(kitAfter[p],h,`Frozen parser/WASM/multisig changed: ${p}`);
for(const[p,h]of Object.entries(flutterBefore))if((p.startsWith('lib/')||/\.(so|a|js)$/.test(p)||p.includes('/Frameworks/'))&&!pairing?.allowedFlutter.includes(p))assert.equal(flutterAfter[p],h,`Frozen Dart/binary/page changed: ${p}`);
const artifacts=[...(pairing?.archives??[])];
for(const[name,top]of [['tbc-kit.tgz','package'],['tbc-kit-flutter.tgz','tbc_kit_flutter_dart']]){
 const path=join(out,name);execFileSync('tar',['--no-xattrs','-czf',path,'-C',out,top],{env:{...process.env,COPYFILE_DISABLE:'1'}});
 const b=await readFile(path);artifacts.push({name,bytes:b.length,sha256:sha(b)});
}
for(const[p,h]of Object.entries(protectedBefore))assert.equal(sha(await readFile(p)),h,p);
assert.deepEqual(await inventory(kitBase),kitBefore);assert.deepEqual(await inventory(flutterBase),flutterBefore);
const report={status:'BUILT_PENDING_DIRECTED_ACCEPTANCE',version,artifacts,sources,protectedUnchanged:true,
 parserRuntimeUnchanged:true,nativeAndWasmUnchanged:!pairing,dartExecutorAndPageUnchanged:true,realBroadcast:false,published:false,pairing};
await save(join(out,'candidate.json'),report);
console.log(JSON.stringify(report,null,2));
