// Isolated final227 consumer, public vectors only. Never modifies Mobile.
import assert from 'node:assert/strict';
import {readFile,writeFile,cp,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const repo=resolve(import.meta.dirname,'../../../..'),root=resolve(process.argv[2]);
const sha=b=>createHash('sha256').update(b).digest('hex');
const final=JSON.parse(await readFile(join(root,'candidate227-delivery.json')));
assert.equal(final.candidate,'0.1.0-candidate.227');assert.equal(sha(await readFile(final.tar)),final.sha256);
const sdk=final.nativeSdk,prior='/private/tmp/tbc225-rn-keyless.Tch39J';
const app=await mkdtemp('/private/tmp/tbc227-rn-keyless.');console.log(JSON.stringify({phase:'created',app}));
const manifest=JSON.parse(await readFile(join(prior,'package.json')));
manifest.name='tbc227-rn-keyless-probe';manifest.dependencies['@tbc/kit']='file:'+final.tar;
await writeFile(join(app,'package.json'),JSON.stringify(manifest,null,2)+'\n');
const config=JSON.parse(await readFile(join(prior,'app.json')));
config.expo.slug='tbc-keyless-rn227-probe';config.expo.ios.bundleIdentifier='org.tbc.kit.keyless227probe';config.expo.android.package='org.tbc.kit.keyless227probe';
await writeFile(join(app,'app.json'),JSON.stringify(config,null,2)+'\n');
await cp(join(prior,'index.js'),join(app,'index.js'));
const run=(cmd,args)=>execFileSync(cmd,args,{cwd:app,stdio:'inherit',timeout:300000});
run('npm',['install','--ignore-scripts','--no-audit','--no-fund']);
const kit=join(app,'node_modules/@tbc/kit');
run(process.execPath,[join(kit,'examples/react-native-engine/install.mjs'),app,sdk]);
await cp(join(kit,'examples/react-native-engine/babel.config.js.example'),join(app,'babel.config.js'));
const corePath=join(resolve(final.nativeSdkConsumerReport,'..'),'vectors.json');
const keylessPath=join(resolve(final.nativeSdkPlatformReport,'..'),'vectors.json');
const coreBytes=await readFile(corePath),keylessBytes=await readFile(keylessPath);
const platform=JSON.parse(await readFile(final.nativeSdkPlatformReport));
assert.equal(sha(keylessBytes),platform.vectorsSha256);assert.equal(JSON.parse(coreBytes).length,8);
const keyless=JSON.parse(keylessBytes);assert.equal(keyless.length,37);
assert.ok(keyless.every(v=>!/preimage/i.test(v.input)),'Never include claim-secret fixtures');
const {createWasmTbcKeylessEngine}=await import(join(kit,'dist/esm/index.js'));
const oracle=await createWasmTbcKeylessEngine(await readFile(join(kit,'artifacts/wasm/tbc_keyless_wasm.wasm')));
for(const method of ['inspectLopMaterial','inspectTokenMaterial']){
 let expected;try{await oracle.execute(method,'{}');}catch(e){expected=JSON.stringify({error:e.message});}
 assert.ok(expected);keyless.push({method,input:'{}',expected});
}
await cp(join(import.meta.dirname,'KeylessProbe.tsx'),join(app,'App.tsx'));
await writeFile(join(app,'vectors.json'),coreBytes,{flag:'wx'});
const wire=JSON.stringify(keyless);await writeFile(join(app,'keyless-vectors.json'),wire,{flag:'wx'});
const templateHashes={};for(const file of ['src/index.ts','src/backend.ts','ios/TbcKitEngineModule.swift',
 'android/src/main/java/expo/modules/tbckitengine/TbcKitEngineModule.kt','TbcKitEngine.podspec']){
 const bytes=await readFile(join(kit,'examples/react-native-engine/module',file));
 assert.equal(sha(bytes),sha(await readFile(join(app,'modules/tbc-kit-engine',file))));templateHashes[file]=sha(bytes);
}
const proof={kitSha256:final.sha256,sdkArtifactSetId:platform.artifactSetId,templateHashes,appSourceSha256:sha(await readFile(join(app,'App.tsx'))),
 coreVectorsSha256:sha(coreBytes),keylessVectorsSha256:sha(wire),sourceKeylessVectorsSha256:sha(keylessBytes),templatePatch:'none-installed227',
 lpReceiptVectors:21,keylessVectors:39,keylessPositive:22,keylessErrorRejections:17};
await writeFile(join(app,'probe-provenance.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
run('npx',['expo','prebuild','--no-install']);
console.log(JSON.stringify({app,sdk,phase:'PREPARED_NOT_BUILT',proof}));
