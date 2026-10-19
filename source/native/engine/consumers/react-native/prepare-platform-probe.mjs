// Fresh Expo consumer of an exact packed Kit and paired SDK. Synthetic only.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha256} from '../../../../packages/kit/scripts/platform-resources.mjs';
import {verifiedKitCandidate} from '../../../flutter/scripts/candidate-inputs.mjs';

const [candidateArg, sdkArg, coreReportArg, keylessReportArg, appArg, resume] = process.argv.slice(2);
assert.ok(resume === undefined || resume === '--resume');
assert.ok(appArg, 'CANDIDATE SDK CORE_REPORT KEYLESS_REPORT NEW_APP');
const [candidate, sdk, coreReportPath, keylessReportPath, app] =
  [candidateArg, sdkArg, coreReportArg, keylessReportArg, appArg].map(p => resolve(p));
const json = async p => JSON.parse(await readFile(p));
const build = await json(join(candidate, 'candidate.json'));
const archive = join(candidate, build.tarball);
assert.equal(sha256(await readFile(archive)), build.tarballSha256);
const core = await json(coreReportPath), keylessReport = await json(keylessReportPath);
const identity = await json(join(sdk, 'identity.json'));
for (const r of [core, keylessReport]) {
  assert.equal(r.status, 'PASS'); assert.equal(r.artifactSetId, identity.artifactSetId);
}
if (resume) {
  const existing = await json(join(app,'package.json'));
  assert.equal(existing.name,'tbc-platform-slim-rn-probe');
  assert.equal(existing.dependencies['@tbc/kit'],'file:'+archive);
} else await mkdir(app);
const manifest = {name: 'tbc-platform-slim-rn-probe', version: '1.0.0', private: true, main: 'index.js',
  dependencies: {'@tbc/kit': 'file:'+archive, expo: '54.0.37', react: '19.1.0',
    'react-native': '0.81.5', 'expo-file-system': '19.0.24'}};
await writeFile(join(app, 'package.json'), JSON.stringify(manifest, null, 2)+'\n');
const bundleId = 'org.tbc.kit.platformslimprobe';
await writeFile(join(app, 'app.json'), JSON.stringify({expo: {name: 'TBCPlatformSlimProbe',
  slug: 'tbc-platform-slim-probe', version: '1.0.0', newArchEnabled: true,
  ios: {bundleIdentifier: bundleId}, android: {package: bundleId}}}, null, 2)+'\n');
await writeFile(join(app, 'index.js'), "import {registerRootComponent} from 'expo';\nimport App from './App';\nregisterRootComponent(App);\n");
const run = (cmd,args) => execFileSync(cmd,args,{cwd: app, stdio:'inherit', timeout:300000});
run('npm', ['install','--ignore-scripts','--prefer-offline','--no-audit','--no-fund']);
const kit = join(app,'node_modules/@tbc/kit');
const verified = await verifiedKitCandidate(kit);
assert.equal(verified.artifactId, build.artifactId);
run(process.execPath,[join(kit,'examples/react-native-engine/install.mjs'),app,sdk]);
await copyFile(join(kit,'examples/react-native-engine/babel.config.js.example'), join(app,'babel.config.js'));
await copyFile(join(import.meta.dirname,'KeylessProbe.tsx'),join(app,'App.tsx'));
const coreBytes = await readFile(join(resolve(coreReportPath,'..'),'vectors.json'));
assert.equal(JSON.parse(coreBytes).length,8);
const keylessBytes = await readFile(join(resolve(keylessReportPath,'..'),'vectors.json'));
assert.equal(sha256(keylessBytes),keylessReport.vectorsSha256);
const vectors = JSON.parse(keylessBytes);
assert.ok(vectors.every(v => !/preimage/i.test(v.input)), 'No claim secret fixture in this probe');
const {createWasmTbcKeylessEngine} = await import(pathToFileURL(join(kit,'dist/esm/wallet.js')));
const oracle = await createWasmTbcKeylessEngine(await readFile(join(kit,'artifacts/wasm/tbc_keyless_wasm.wasm')));
for (const method of ['inspectLopMaterial','inspectTokenMaterial']) {
  let expected;
  try { await oracle.execute(method,'{}'); } catch(e) { expected = JSON.stringify({error:e.message}); }
  assert.ok(expected); vectors.push({method,input:'{}',expected});
}
await writeFile(join(app,'vectors.json'),coreBytes);
await writeFile(join(app,'keyless-vectors.json'),JSON.stringify(vectors));
const templateHashes = {};
for (const file of ['src/index.ts','src/backend.ts','scripts/sync-native.mjs','native-sdk-lock.json',
  'ios/TbcKitEngineModule.swift','android/src/main/java/expo/modules/tbckitengine/TbcKitEngineModule.kt','TbcKitEngine.podspec']) {
  templateHashes[file] = sha256(await readFile(join(kit,'examples/react-native-engine/module',file)));
  assert.equal(sha256(await readFile(join(app,'modules/tbc-kit-engine',file))),templateHashes[file]);
}
const proof = {kitSha256: build.tarballSha256, kitArtifactId: build.artifactId,
  sdkArtifactSetId:identity.artifactSetId, templatePatch:'none-installed-platform-slim', templateHashes,
  appSourceSha256:sha256(await readFile(join(app,'App.tsx'))), coreVectorsSha256:sha256(coreBytes),
  keylessVectorsSha256:sha256(JSON.stringify(vectors)), keylessVectors:vectors.length,
  keylessPositive:vectors.filter(v => !JSON.parse(v.expected).error).length, bundleId};
await writeFile(join(app,'probe-provenance.json'),JSON.stringify(proof,null,2)+'\n');
run('npx',['--no-install','expo','prebuild','--no-install']);
// Xcode can canonicalize /private/tmp as /tmp. Keep the Expo entry relative
// to the verified project root so Metro does not resolve outside that root.
await writeFile(join(app,'ios/.xcode.env.local'),
  `export NODE_BINARY=${JSON.stringify(process.execPath)}\nexport PROJECT_ROOT=${JSON.stringify(app)}\nexport ENTRY_FILE=index.js\n`);
console.log(JSON.stringify({app,sdk,phase:'PREPARED_NOT_BUILT',proof}));
