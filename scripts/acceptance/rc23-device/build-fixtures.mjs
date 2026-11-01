// Builds test-only WebView resources from the frozen rc.23 package and existing
// targeted regression fixtures. Never changes the accepted package or a wallet.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../../..');
const require=createRequire(join(root,'source/package.json'));
const {build}=require('esbuild'),tbc=require('tbc-lib-js');
const repro=process.env.TBC_RC23_REPRO==='1';
const out=join(root,repro?'.verify/rc23-mint100-repro':'.verify/rc23-device-app');await mkdir(out,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
const tar=await readFile(join(root,'release/candidates/unexpected-rejections-rc23/tbc-kit.tgz'));
assert.equal(sha(tar),'14fa77b6af1248edb5fc89c3dd7104d525c0c07a1529dc3dc0f6d6527d62b88b');
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const script=tbc.Script.buildPublicKeyHashOut(address).toHex();
function rawWithOutputs(outputs){const tx=new tbc.Transaction().from({txId:'ab'.repeat(32),outputIndex:0,script,satoshis:10000000});tx.version=10;for(const o of outputs)tx.addOutput(new tbc.Transaction.Output(o));return tx.uncheckedSerialize();}
const collections={};for(const supply of [30,100,125,...(repro?[300]:[])])collections[supply]=rawWithOutputs([{satoshis:0,script:tbc.Script.buildSafeDataOut([Buffer.from(JSON.stringify({collectionName:'Batch fixture',description:'public synthetic',supply,file:''})),Buffer.from('NTape')])},...Array.from({length:supply},()=>({satoshis:100,script:tbc.Script.fromHex(script+'6a0d5630204d696e74204e486f6c64')}))]);
const nftFunding=rawWithOutputs([{satoshis:9000000,script:tbc.Script.fromHex(script)}]);
const funding=new tbc.Transaction().from({txId:'aa'.repeat(32),outputIndex:0,script,satoshis:1001000}).to(address,1000000);funding.version=10;
const wide=new tbc.Transaction().from({txId:'bb'.repeat(32),outputIndex:0,script,satoshis:300000000});wide.version=10;for(let i=0;i<257;i++)wide.to(address,1000000);
const fixture=JSON.parse(await readFile(join(root,'source/packages/tbc-engine/rust/fixtures/amm-explicit173-lifecycle.json')));
const tokenFixture=JSON.parse(await readFile(join(root,'source/packages/tbc-engine/rust/fixtures/tbc20-standard-transfer.json')));
const sourceFiles=['source/packages/kit/test/host-port-business-errors.test.mjs','source/packages/kit/test/nft-material-batching.test.mjs'];
const [host,nft]=await Promise.all(sourceFiles.map(p=>readFile(join(root,p),'utf8')));
const between=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b));
let setup=between(host,'function permission(','const zeroBusiness =');
setup=setup.replace('tokenMode = false, zeros = false','networkOverride = undefined, tokenMode = false, zeros = false');
setup=setup.replace('return network.resolveChainData(params, active);','return networkOverride ? networkOverride.resolveChainData(params,active) : network.resolveChainData(params, active);');
setup=setup.replace('return network.resolvePolicy(params);','return networkOverride ? networkOverride.resolvePolicy(params) : network.resolvePolicy(params);');
// Record counts only; never persist raw transactions or signing material.
setup=setup.replace('wallet, trace, ports, accepted, session, tokenId',`wallet, trace, ports, accepted,
    session: {close(){metrics.push({test:activeTest,reads:[...trace],ports:[...ports],approvals,signatures,accepted:accepted.length});session.close();}}, tokenId`);
if(repro){
  setup=setup.replace('return { wallet,','return { rawSession:session, wallet,');
  setup=setup.replace('networkOverride = undefined,','clockOverride = undefined, broadcastHook = undefined, networkOverride = undefined,');
  setup=setup.replace('clock: now,','clock: () => clockOverride?.() ?? now(),');
  setup=setup.replace('accepted.push(params.transaction); return', 'accepted.push(params.transaction); if(broadcastHook) await broadcastHook(params,accepted); return');
}
let amm=between(host,'const controllerHashes=','test(\'TBC20 recipient capacity');
amm=amm.replace(between(amm,"test('LOP 1/128/256", "test('AMM controller permutations"),'');
const lp=between(host,"for (const method of ['lock','unlock'])",'const tokenModeFor =');
let nh=between(nft,"const address=",'const slotsFrom=');
nh=nh.replace("const now=Date.parse('2026-10-27T12:00:00Z');","const now=nowMs;");
nh=nh.replace(between(nh,'function rawWithOutputs(', 'function harness('),'');
nh=nh.replace(between(nh,'  const raw=rawWithOutputs(', '  const calls='),`  const raw=nftFixtures.collections[supply], collectionId=turingTransactionId(raw), funding=nftFixtures.funding,fundingId=turingTransactionId(funding);
`);
nh=nh.replace('setImmediate(resolve)','setTimeout(resolve,0)');
nh=nh.replace('  return{raw,collectionId',`  nftMetrics.push({test:activeTest,calls,batches,state});
  return{raw,collectionId`);
const nt1=between(nft,"test('NFT fee alternatives", "test('public resolver splits");
const nt2=between(nft,"test('failures, missing rows", "test('each chunk rejects");
let portable=await readFile(join(import.meta.dirname,'portable.mjs'),'utf8');
portable=portable.replace('/*FIXTURES*/',`const fixture=${JSON.stringify(fixture)},tokenFixture=${JSON.stringify(tokenFixture)};
const fundingRaw=${JSON.stringify(funding.uncheckedSerialize())},fundingId=${JSON.stringify(funding.id)},wideFundingRaw=${JSON.stringify(wide.uncheckedSerialize())},wideFundingId=${JSON.stringify(wide.id)};
const nftFixtures=${JSON.stringify({collections,funding:nftFunding})};`);
portable=portable.replace('/*HOST_TESTS*/',setup+'\n'+amm+'\n'+lp);
portable=portable.replace('/*NFT_TESTS*/',nh+'\nconst slotsFrom=result=>result.payload.utxos.filter(u=>u.classification===\'collection-slot\').map(u=>u.vout);\n'+nt1+nt2+await readFile(join(import.meta.dirname,'nft-native.mjs'),'utf8'));
if(repro){
  const extra=await readFile(join(root,'scripts/diagnostics/rc23-mint100/cases.mjs'),'utf8');
  portable=portable.replace('\n}\nasync function main()', '\n'+extra+'\n}\nasync function main()');
  portable=portable.replace('tests.push({name,fn})',"if(name.startsWith('REPRO:'))tests.push({name,fn})");
  portable=portable.replace('const report={status:', 'const report={diagnostics:globalThis.rc23Diagnostics, status:');
}
const artifactSetId=JSON.parse(await readFile(join(root,'.verify/rc23-native/sdk/identity.json'))).artifactSetId;
const result=await build({stdin:{contents:portable,resolveDir:root,sourcefile:'rc23-device-portable.mjs'},bundle:true,write:false,platform:'browser',format:'iife',target:'es2022',alias:{'@frozen/client':join(root,'packages/kit/dist/esm/index.js'),'@frozen/wallet':join(root,'packages/kit/dist/esm/wallet.js'),'@frozen/engine':join(root,'packages/kit/dist/esm/engine.js'),'@frozen/api':join(root,'packages/kit/dist/esm/api.js'),'buffer':require.resolve('buffer/'),'@fixture/signer':join(root,'source/packages/kit/examples/shared/controlled-signer.mjs'),'@noble/curves/secp256k1.js':require.resolve('@noble/curves/secp256k1.js')},logLevel:'warning'});
await writeFile(join(out,'suite.js'),result.outputFiles[0].contents);
await writeFile(join(out,'index.html'),'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'unsafe-inline\'; connect-src \'none\'"><title>rc.23 targeted acceptance</title><body style="font:16px system-ui;padding:24px"><h2>rc.23 targeted acceptance</h2><p>Public fixtures · no network / no broadcast</p><pre id="status">Starting</pre><script src="suite.js"></script></body>');
await writeFile(join(out,'build.json'),JSON.stringify({kitVersion:'0.1.0-rc.23',nativeVersion:'0.1.0-rc.23.native.2',artifactSetId,kitSha256:sha(tar),bundleSha256:sha(result.outputFiles[0].contents),fixtureSources:Object.fromEntries(sourceFiles.map((p,i)=>[p,sha([host,nft][i])])),controlled:true,broadcasts:0},null,2));
console.log(out);
