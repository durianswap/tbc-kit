import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';

export async function loadHolderInstalledHarness({consumer,archive,expectedSha,expectedVersion='0.1.0-candidate.214',entry='node',backend='wasm'}){
 assert.ok(consumer&&archive&&/^[a-f0-9]{64}$/.test(expectedSha));
 assert.ok(['node','browser','react-native','cjs'].includes(entry));assert.ok(['wasm','native'].includes(backend));
 const sha=b=>createHash('sha256').update(b).digest('hex'),installed=join(resolve(consumer),'node_modules/@tbc/kit');
 assert.equal(sha(await readFile(archive)),expectedSha);
 const work=await mkdtemp(join(tmpdir(),'tbc-holder-installed-'));
 execFileSync('tar',['-xzf',resolve(archive),'-C',work,'package/dist','package/package.json','package/artifacts/provenance.json']);
 const files=['package.json','artifacts/provenance.json'];
 async function scan(p){for(const e of await readdir(join(work,'package',p),{withFileTypes:true})){
  const f=join(p,e.name);if(e.isDirectory())await scan(f);else {assert.ok(e.isFile());files.push(f);}
 }}await scan('dist');
 for(const p of files)assert.equal(sha(await readFile(join(installed,p))),sha(await readFile(join(work,'package',p))),p);
 const manifest=JSON.parse(await readFile(join(installed,'package.json'))),provenance=JSON.parse(await readFile(join(installed,'artifacts/provenance.json')));
 assert.equal(manifest.version,expectedVersion);assert.equal(provenance.package,'@tbc/kit@'+manifest.version);
 for(const a of provenance.artifacts)assert.equal(sha(await readFile(join(installed,a.path))),a.sha256,a.path);
 const req=createRequire(join(installed,'package.json')),kit={};
 for(const name of ['index','wallet','engine','api']){
  const p=entry==='cjs'?`dist/cjs/${name}.cjs`:name==='index'?`dist/esm/index${entry==='node'?'.node':entry==='react-native'?'.native':''}.js`:
   `dist/esm/${name}${entry==='node'&&['wallet','engine'].includes(name)?'.node':''}.js`;
  Object.assign(kit,entry==='cjs'?req(join(installed,p)):await import(pathToFileURL(join(installed,p))));
 }
 assert.equal(kit.TWS_RELEASE_FINGERPRINT,provenance.protocolFingerprint);
 const fixtureRoot='/private/tmp/tbc213-source.1qvplz',snapshotBytes=await readFile(join(fixtureRoot,'source-snapshot.json'));
 assert.equal(sha(snapshotBytes),'4801a0578eae12ed3440ed32dc25d26bf4c4960dfe34748ea82d5e409a77c967');
 const fixtureSources={},snapshot=JSON.parse(snapshotBytes);
 for(const name of ['coin-proof.json','tbc20-standard-transfer.json']){
  const p='packages/tbc-engine/rust/fixtures/'+name;fixtureSources[p]=sha(await readFile(join(fixtureRoot,p)));
  assert.equal(fixtureSources[p],snapshot.hashes[p]);
 }
 let native;
 if(backend==='wasm')native=await kit.createWasmTbcKeylessEngine(await readFile(join(installed,'artifacts/wasm/tbc_keyless_wasm.wasm')));
 else {
  assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
  const dir=join(installed,'artifacts/keyless-native/aarch64-apple-darwin'),runner=join(work,'runner');
  execFileSync('cc',[resolve(import.meta.dirname,'../keyless-native-runner.c'),`-I${dir}`,join(dir,'libtbc_keyless_native.dylib'),`-Wl,-rpath,${dir}`,'-o',runner]);
  // Only synthetic public Coin/Token fixtures enter this runner; no real raw,
  // custody, nonce or HTLC preimage may be supplied by this acceptance script.
  native=kit.createNativeTbcKeylessEngine(async(op,json)=>execFileSync(runner,[op,json],{encoding:'utf8',maxBuffer:8*1024*1024}));
 }
 return {kit:Object.freeze(kit),native,fixtureRoot:fixtureRoot+'/',evidence:{candidate:manifest.version,tarSha256:expectedSha,comparedFiles:files.length,
  protocolFingerprint:provenance.protocolFingerprint,entry,backend,fixtureSources,executionFromInstalledPackage:true,sourceRuntimeImports:0}};
}
