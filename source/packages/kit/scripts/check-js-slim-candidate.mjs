import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {gzipSync} from 'node:zlib';
import {fileInventory,platformCatalog,sha256} from './platform-resources.mjs';
import {verifiedKitCandidate} from '../../../native/flutter/scripts/candidate-inputs.mjs';

const [baseArg,candidateArg,outArg]=process.argv.slice(2);
assert.ok(outArg,'BASE_KIT CANDIDATE_DIRECTORY NEW_EVIDENCE_DIRECTORY');
const root=resolve(import.meta.dirname,'../../..');
const base=resolve(baseArg),candidate=resolve(candidateArg),out=resolve(outArg);
await mkdir(out);
const candidateReport=JSON.parse(await readFile(join(candidate,'candidate.json')));
const tarball=join(candidate,candidateReport.tarball);
assert.equal(sha256(await readFile(tarball)),candidateReport.tarballSha256);
const consumer=join(out,'consumer');await mkdir(consumer);
await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@tbc/kit':`file:${tarball}`}},null,2)+'\n');
execFileSync('npm',['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:consumer,stdio:'pipe',timeout:120000});
const installed=join(consumer,'node_modules/@tbc/kit');
const identity=await verifiedKitCandidate(installed);
await platformCatalog(installed);
const inventory=await fileInventory(installed);
assert.ok(!Object.keys(inventory).some(p=>p.endsWith('.map')));
const manifest=JSON.parse(await readFile(join(installed,'package.json')));
const oldManifest=JSON.parse(await readFile(join(base,'package.json')));
assert.deepEqual(manifest.exports,oldManifest.exports);
assert.equal(manifest.dependencies['tbc-contract'],undefined);
assert.equal(manifest.dependencies['tbc-tx-parser'],undefined);
if (!manifest.dependencies['tbc-lib-js']) {
  const lock=JSON.parse(await readFile(join(consumer,'package-lock.json')));
  assert.ok(!Object.keys(lock.packages).some(p=>/(?:^|\/)node_modules\/(?:tbc-lib-js|tbc-contract|tbc-tx-parser)$/.test(p)),
    'Clean install must not pull full TBC SDKs transitively');
}
for(const p of ['artifacts/wasm/tbc_engine_wasm.wasm','artifacts/wasm/tbc_keyless_wasm.wasm','examples/react-native-engine/module/native-sdk-lock.json'])
  assert.equal(sha256(await readFile(join(installed,p))),sha256(await readFile(join(base,p))),p);
// Exact public exports on the independently installed artifact, not the
// checkout's node_modules. No source aliases rescue a missing runtime dep.
const probe=`import assert from 'node:assert/strict';import{createRequire}from'node:module';const require=createRequire(import.meta.url);let results=[];for(const p of ['','/wallet','/engine','/api','/rpc','/sqlite','/testing']){const esm=await import('@tbc/kit'+p);const cjs=require('@tbc/kit'+p);assert.deepEqual(Object.keys(esm).sort(),Object.keys(cjs).sort());results.push({entry:p||'.',exports:Object.keys(esm).length});}const parser=await import('./node_modules/@tbc/kit/dist/esm/vendor/tbc-tx-parser/index.js');assert.equal(typeof parser.decodeTxRaw,'function');console.log(JSON.stringify(results));`;
await writeFile(join(consumer,'probe.mjs'),probe);
const exports=JSON.parse(execFileSync(process.execPath,['probe.mjs'],{cwd:consumer,encoding:'utf8'}));
const bundles={};
const cases={
  api:`export {createTbcOfficialApi} from '@tbc/kit/api';`,
  rpc:`export * from '@tbc/kit/rpc';`,
  connect:`export {createTbcClient,getTbcWallets} from '@tbc/kit';`,
  preparedEngine:`export{prepareTbcTransaction}from'@tbc/kit';export{createTbcEngine}from'@tbc/kit/engine';`,
  webviewProvider:`export{createTbcClient,createTbcKitWebViewPageProvider,createTbcProvider}from'@tbc/kit';`,
  wallet:`export * from '@tbc/kit/wallet';`,
};
for(const [name,source]of Object.entries(cases)){
  const r=await build({stdin:{contents:source,resolveDir:consumer,sourcefile:name+'.mjs'},bundle:true,platform:'browser',format:'esm',target:'es2020',splitting:true,minify:true,write:false,metafile:true,outdir:join(out,'bundles',name),logLevel:'silent'});
  bundles[name]={bytes:r.outputFiles.reduce((n,f)=>n+f.contents.length,0),gzipBytes:r.outputFiles.reduce((n,f)=>n+gzipSync(f.contents).length,0),files:r.outputFiles.length};
  for(const f of r.outputFiles){await mkdir(resolve(f.path,'..'),{recursive:true});await writeFile(f.path,f.contents);}
  await writeFile(join(out,name+'-metafile.json'),JSON.stringify(r.metafile,null,2)+'\n');
}
// Native parser input closure must stay free of Node-only APIs as before.
const rn=await build({stdin:{contents:`export * from '@tbc/kit/wallet';`,resolveDir:consumer},bundle:true,platform:'neutral',conditions:['react-native'],mainFields:['react-native','browser','module','main'],format:'esm',target:'es2020',write:false,metafile:true,logLevel:'silent'});
assert.ok(!Object.values(rn.metafile.inputs).some(v=>v.imports.some(i=>i.path.startsWith('node:'))));
// Harness-only fixtures are installed after the clean consumer proof. These
// are never packed or copied into the delivery archive.
await cp(join(root,'packages/kit/test'),join(installed,'test'),{recursive:true});
await cp(join(root,'packages/kit/scripts'),join(installed,'scripts'),{recursive:true});
await cp(join(root,'packages/kit/src'),join(installed,'src'),{recursive:true});
await cp(join(root,'test-vectors'),join(consumer,'node_modules/test-vectors'),{recursive:true});
for(const name of ['esbuild','ajv','tbc-contract'])
  await symlink(join(root,'node_modules',name),join(consumer,'node_modules',name));
await mkdir(join(consumer,'node_modules/@tbc-wallet'));
await mkdir(join(consumer,'packages'));
await symlink(installed,join(consumer,'packages/kit'));
await symlink(join(consumer,'packages'),join(consumer,'node_modules/packages'));
for (const p of ['schemas','registry']) await symlink(join(root,p),join(consumer,'node_modules',p));
for(const name of ['core','host','provider','tbc-engine','wallet-standard']) {
  await symlink(join(root,'packages',name),join(consumer,'node_modules/@tbc-wallet',name));
  await symlink(join(root,'packages',name),join(consumer,'node_modules/@tbc',name));
  await symlink(join(root,'packages',name),join(consumer,'packages',name));
}
const focused=[
 'bundle-module-identity','recoverable-signature-identity','api-rpc-bundle-isolation','metro-wallet-parse',
 'legacy-raw-reviewer-no-global-buffer','request-preparation','engine-network-profile',
 'cross-chain-accounts','wallet-discovery-authority','keyless-platform-loading',
 'optimized-chain-data','chain-data-read-scope','default-broadcast','unified-tbc-client','webview-page-provider',
 'wallet-webview-native','legacy-mapping','legacy-ft-transfer-intent','legacy-stablecoin-intent','network-context',
 'tbc20-standard-client-prepared','unified-fungible-requirements','fungible-business-route','reviewed-token','reviewed-issuance-policy',
];
const tests=focused.map(n=>join(installed,'test',n+'.test.mjs'));
if (!manifest.dependencies['tbc-lib-js']) {
  focused.push('portable-parser-dependency-closure');
  tests.push(join(installed,'test/portable-parser-dependency-closure.test.mjs'));
}
if (JSON.parse(await readFile(join(installed,'artifacts/provenance.json'))).onDemandDelivery) {
  focused.push('react-native-engine-template');
  tests.push(join(installed,'test/react-native-engine-template.test.mjs'));
}
let passed=true;
try { await writeFile(join(out,'focused.tap'),execFileSync(process.execPath,['--test','--test-concurrency=1',...tests],{cwd:consumer,encoding:'utf8',maxBuffer:12*1024*1024,timeout:120000})); }
catch(error){passed=false;await writeFile(join(out,'focused.tap'),String(error.stdout??'')+String(error.stderr??''));}
const report={status:passed?'PASS_CLEAN_INSTALL_AND_FOCUSED':'FOCUSED_FAILURE',identity,exports,bundles,
  reactNativeBundleBytes:rn.outputFiles[0].contents.length,tests:focused,wasmUnchanged:true,
  nativeSdkLockUnchanged:true,realChain:false,deviceAcceptance:false,published:false};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(!passed)process.exitCode=1;
