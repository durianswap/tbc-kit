// Isolated rc.23 assembly. This never promotes, publishes or changes accepted packages.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,readdir,rename,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildKitRuntime} from '../source/packages/kit/scripts/runtime-build.mjs';
import {omitEmbeddedSources} from '../source/packages/kit/scripts/source-map-policy.mjs';
import {stripWasmNameSection} from '../source/packages/kit/scripts/wasm-metadata.mjs';
import {fileInventory,sha256,platformCatalog,verifiedResourceRoot} from '../source/packages/kit/scripts/platform-resources.mjs';
const repo=resolve(import.meta.dirname,'..'),root=join(repo,'source');
const [mode,outArg,buildArg,baselineResourcesArg,companionArg]=process.argv.slice(2);
assert(companionArg,'prepare|sdk|seal CANDIDATE BUILD BASELINE_RESOURCES KEYLESS_COMPANION');
const out=resolve(outArg),build=resolve(buildArg),baseline=resolve(baselineResourcesArg),companion=resolve(companionArg);
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const put=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
const stage=(await json(join(out,'evidence/stage.json'))).stage,resources=join(build,'resources'),sdk=join(build,'sdk');
const run=(cmd,args,cwd=repo)=>execFileSync(cmd,args,{cwd,encoding:'utf8',maxBuffer:32*1024*1024,env:{...process.env,COPYFILE_DISABLE:'1'}});
const nativeScript=name=>join(root,'native/engine/scripts',name);
async function refreshTypes() {
  const typeRoot=join(build,'kit-types');
  run(join(root,'node_modules/.bin/tsc'),['-p',join(root,'packages/kit/tsconfig.json'),'--declarationDir',typeRoot,'--declarationMap','false']);
  for(const f of await readdir(typeRoot))if(f.endsWith('.d.ts')) {
    let s=await readFile(join(typeRoot,f),'utf8');
    for(const [a,b]of [['host/sqlite','host/sqlite'],['core','core/index'],['host','host/index'],['provider','provider/index']])s=s.replaceAll(`"@tbc-wallet/${a}"`,`"./internal/${b}.js"`);
    await writeFile(join(stage,'dist/types',f),s);
  }
}
const pack=async(dir,dest,name)=>{const [p]=JSON.parse(run('npm',['pack',dir,'--ignore-scripts','--json','--pack-destination',dest]));
  await rename(join(dest,p.filename),join(dest,name));return{file:name,bytes:p.size,unpackedBytes:p.unpackedSize,sha256:sha256(await readFile(join(dest,name)))};};
if(mode==='prepare') {
  const report=await json(join(build,'build.json'));assert.equal(report.status,'BUILT_NOT_DEVICE_ACCEPTED');
  assert.deepEqual(await fileInventory(join(build,'rust')),report.files);
  // Authenticate all reused platform/header/keyless bytes against rc.22 catalog.
  await mkdir(resources,{recursive:true});
  const catalog=await json(join(repo,'packages/kit/artifacts/platform-resources.json'));
  for(const g of Object.values(catalog.platforms))for(const p of Object.keys(g.files)) {
    const candidates=[join(baseline,p),join(build,'frozen-resources/resources',p),
      join(repo,'.verify/zero-balance-check-0cHKDP/ios-sdk/apple/Artifacts',p.replace('artifacts/native/ios/','')),
      join(dirname(companion),'native-sdk/android/engine/src/main',p.replace('artifacts/native/android/',''))];
    let selected;
    for(const f of candidates){try{if(sha256(await readFile(f))===g.files[p]){selected=f;break;}}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;}}
    assert(selected,`No byte-identical frozen resource: ${p}`);
    await mkdir(dirname(join(resources,p)),{recursive:true});await cp(selected,join(resources,p));
  }
  await verifiedResourceRoot(join(repo,'packages/kit'),resources,['ios','android','macos-arm64']);
  const mapping={
    'aarch64-apple-darwin':'aarch64-apple-darwin/libtbc_engine_native.dylib',
    'aarch64-apple-ios':'ios/TbcEngineNative.xcframework/ios-arm64/libtbc_engine_native.a',
    'aarch64-apple-ios-sim':'ios/TbcEngineNative.xcframework/ios-arm64-simulator/libtbc_engine_native.a',
    'aarch64-linux-android':'android/jniLibs/arm64-v8a/libtbc_engine_native.so',
    'armv7-linux-androideabi':'android/jniLibs/armeabi-v7a/libtbc_engine_native.so',
    'x86_64-linux-android':'android/jniLibs/x86_64/libtbc_engine_native.so',
  };
  for(const a of report.artifacts){assert.equal(sha256(await readFile(a.path)),a.sha256);
    if(mapping[a.target])await cp(a.path,join(resources,'artifacts/native',mapping[a.target]));
    else {assert.equal(a.target,'wasm32-unknown-unknown');await writeFile(join(stage,'artifacts/wasm/tbc_engine_wasm.wasm'),stripWasmNameSection(await readFile(a.path)));}}
  await buildKitRuntime({root,packageRoot:stage});await omitEmbeddedSources(join(stage,'dist'));
  await refreshTypes();
  await cp(join(root,'packages/kit/docs/transaction-capacity.md'),join(stage,'docs/transaction-capacity.md'));
  await cp(join(root,'packages/kit/SUPPORT.md'),join(stage,'SUPPORT.md'));
  const pkg=await json(join(stage,'package.json')),provenance=await json(join(stage,'artifacts/provenance.json'));
  provenance.package=catalog.package=`${pkg.name}@${pkg.version}`;
  for(const [platform,g]of Object.entries(catalog.platforms)) {
    for(const p of Object.keys(g.files))g.files[p]=sha256(await readFile(join(resources,p)));
    const list=join(build,platform+'-files.txt');await writeFile(list,Object.keys(g.files).map(p=>'resources/'+p).join('\n')+'\n');
    const archive=g.archive;run('tar',['--no-mac-metadata','-czf',join(out,archive),'-T',list],build);
    const b=await readFile(join(out,archive));g.archiveSha256=sha256(b);g.archiveBytes=b.length;
  }
  await put(join(stage,'artifacts/platform-resources.json'),catalog);
  provenance.platformResources.sha256=sha256(await readFile(join(stage,'artifacts/platform-resources.json')));
  for(const a of provenance.artifacts)a.sha256=sha256(await readFile(join(stage,a.path)));
  for(const a of provenance.externalArtifacts??[])a.sha256=sha256(await readFile(join(resources,a.path)));
  provenance.distribution={kind:'isolated-source-built-candidate',baselineVersion:'0.1.0-rc.22',
    nativeSdkVersion:pkg.version+'.native.2',rustSourceDigest:report.sourceDigest,
    changes:['AMM controller canonicalization','NFT funding-candidate budget','safe business rejection classification'],
    keylessUnchanged:true,protocolUnchanged:true,deviceAcceptance:false,realBroadcasts:0};
  if(provenance.publicMerge?.nativeDelivery){const d=provenance.publicMerge.nativeDelivery;
    d.iosArm64Sha256=catalog.platforms.ios.files['artifacts/native/ios/TbcEngineNative.xcframework/ios-arm64/libtbc_engine_native.a'];
    d.iosSimulatorArm64Sha256=catalog.platforms.ios.files['artifacts/native/ios/TbcEngineNative.xcframework/ios-arm64-simulator/libtbc_engine_native.a'];
    d.wasmSha256=sha256(await readFile(join(stage,'artifacts/wasm/tbc_engine_wasm.wasm')));}
  await put(join(stage,'artifacts/provenance.json'),provenance);await platformCatalog(stage);
  await mkdir(join(build,'bootstrap'),{recursive:true});const bootstrap=await pack(stage,join(build,'bootstrap'),'tbc-kit.tgz');
  await put(join(out,'evidence/bootstrap.json'),bootstrap);
  const log=run(process.execPath,[nativeScript('prepare-full-native-engine.mjs'),join(build,'bootstrap',bootstrap.file),bootstrap.sha256,companion,sdk,'--resources-root',resources]);
  await writeFile(join(out,'evidence/native-prepare.log'),log);
  console.log('CANDIDATE_STAGED_WITH_REBUILT_ENGINE');
} else if(mode==='sdk') {
  const gradle='/Users/alex/.gradle/wrapper/dists/gradle-8.14.3-bin/cv11ve7ro1n3o1j4so8xd9n66/gradle-8.14.3/bin/gradle';
  const args=[nativeScript('check-native-engine-consumers.mjs'),sdk,gradle,'/Users/alex/Library/Android/sdk','--resources-root',resources,
    '--vectors',join(out,'evidence/controller-native-vectors.json')];
  let log;try{log=run(process.execPath,args);}catch(e){await writeFile(join(out,'evidence/native-consumers.log'),String(e.stdout??'')+'\n'+String(e.stderr??''));throw Error('Native consumer check failed; see evidence');}
  await writeFile(join(out,'evidence/native-consumers.log'),log);
  const checks=(await readdir(sdk)).filter(f=>f.startsWith('consumer-check-'));assert.equal(checks.length,1);
  const report=join(sdk,checks[0],'report.json');await cp(report,join(out,'evidence/native-consumers.json'));
  run(process.execPath,[nativeScript('write-native-sdk-lock.mjs'),sdk,report,stage,join(out,'native-sdk-lock.json')]);
  console.log('NATIVE_CONSUMERS_PASS');
} else if(mode==='seal') {
  const report=await json(join(out,'evidence/native-consumers.json'));assert.equal(report.status,'PASS');
  // Only delete generated top-level staging outputs; retain pinned vendor files.
  // Repeated builds otherwise leave obsolete content-addressed chunks in npm.
  for(const format of ['esm','cjs'])for(const entry of await readdir(join(stage,'dist',format),{withFileTypes:true}))
    if(entry.isFile())await rm(join(stage,'dist',format,entry.name));
  await buildKitRuntime({root,packageRoot:stage});await omitEmbeddedSources(join(stage,'dist'));
  await refreshTypes();
  await cp(join(root,'packages/kit/docs/transaction-capacity.md'),join(stage,'docs/transaction-capacity.md'));
  await cp(join(out,'native-sdk-lock.json'),join(stage,'examples/react-native-engine/module/native-sdk-lock.json'));
  const names=run('git',['ls-files','-c','-o','--exclude-standard','-z','source']).split('\0').filter(Boolean).sort();
  const sourceFiles={};for(const p of [...new Set(names)])sourceFiles[p]=sha256(await readFile(join(repo,p)));
  const sourceDigest=sha256(JSON.stringify(sourceFiles)),rustBuild=await json(join(build,'build.json'));
  for(const [p,h]of Object.entries(rustBuild.files))assert.equal(sha256(await readFile(join(root,'packages/tbc-engine/rust',p))),h.sha256,'Rust changed after Native build: '+p);
  const provenance=await json(join(stage,'artifacts/provenance.json'));
  provenance.distribution.sourceDigest=sourceDigest;
  provenance.distribution.changes.push('LOP token funding-alternative budget and exact-set check','safe spent/unavailable/budget/empty-slot reasons');
  provenance.distribution.changes=[...new Set(provenance.distribution.changes)];
  await put(join(stage,'artifacts/provenance.json'),provenance);
  const output=await fileInventory(stage);
  await put(join(stage,'artifacts/source-build.json'),{schemaVersion:1,version:'0.1.0-rc.23',
    status:'source-built-js-and-native-not-device-or-chain-accepted',sourceDigest,rustSourceDigest:rustBuild.sourceDigest,
    nativeSdkVersion:'0.1.0-rc.23.native.2',baselineArchiveSha256:(await json(join(out,'evidence/stage.json'))).baseline.find(a=>a.id==='kit').sha256,
    outputDigest:sha256(JSON.stringify(Object.fromEntries(Object.entries(output).filter(([p])=>p!=='artifacts/source-build.json'))))});
  await put(join(out,'evidence/build.json'),{status:'PASS',sourceDigest,sourceFiles,rustSourceDigest:rustBuild.sourceDigest,
    stagedFiles:await fileInventory(stage),realBroadcasts:0,deviceAcceptance:false});
  const kit=await pack(stage,out,'tbc-kit.tgz'),identity=await json(join(sdk,'identity.json'));
  const sdkLock=await json(join(out,'native-sdk-lock.json'));assert.equal(sdkLock.artifactSetId,identity.artifactSetId);
  for(const [p,h]of Object.entries(sdkLock.files))assert.equal(sha256(await readFile(join(sdk,p))),h,p);
  await cp(join(out,'native-sdk-lock.json'),join(sdk,'native-sdk-lock.json'));
  await cp(join(sdk,'identity.json'),join(sdk,'native-sdk-identity.json'));
  await cp(join(sdk,'apple/LICENSE'),join(sdk,'LICENSE'));
  const pairedNative={};
  for(const platform of ['ios','android']) {
    const prefix=platform==='ios'?'apple/':'maven-repository/';
    const paths=['identity.json','native-sdk-identity.json','native-sdk-lock.json','LICENSE',
      ...Object.keys(sdkLock.files).filter(p=>p.startsWith(prefix))];
    if(platform==='android') {
      // Include the buildable Android source template, never build/cache directories.
      const androidFiles=await fileInventory(join(sdk,'android'));
      for(const p of Object.keys(androidFiles))if(['LICENSE','identity.json','build.gradle','settings.gradle','gradle.properties',
        'engine/build.gradle','engine/consumer-rules.pro'].includes(p)||p.startsWith('engine/src/'))paths.push('android/'+p);
    }
    assert(paths.some(p=>platform==='ios'?p.endsWith('.a'):p.endsWith('.aar')),'Missing platform binaries');
    const list=join(build,platform+'-sdk-files.txt');await writeFile(list,paths.join('\n')+'\n');
    const file=platform+'-sdk.tgz';run('tar',['--no-mac-metadata','-czf',join(out,file),'-T',list],sdk);
    const b=await readFile(join(out,file));pairedNative[platform]={file,bytes:b.length,sha256:sha256(b),version:identity.sdkVersion};
  }
  const before=await json(join(out,'evidence/stage.json'));
  await put(join(out,'delivery-lock.json'),{schema:1,kitVersion:'0.1.0-rc.23',sdkVersion:identity.sdkVersion,
    protocolFingerprint:identity.protocolFingerprint,sdkArtifactSetId:identity.artifactSetId,kit,pairedNative,
    nativeBuildInput:await json(join(out,'evidence/bootstrap.json')),resources:(await platformCatalog(stage)).platforms,
    baseline:Object.fromEntries(before.baseline.map(a=>[a.id,{...a,file:a.path}])),partnerDeliveryChanged:false,currentReleaseChanged:false});
  console.log(JSON.stringify({status:'PACKED_NOT_PROMOTED',kit,pairedNative}));
} else throw Error('Unknown phase');
