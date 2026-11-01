// Device-only fault injection. Frozen Kit/Native code remains unchanged.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../../..'),req=createRequire(join(root,'source/package.json'));
const {build}=req('esbuild'),tbc=req('tbc-lib-js');
const installed=join(root,'.verify/nft-job-install-f1sefH/node_modules/@tbc/kit');
const sha=b=>createHash('sha256').update(b).digest('hex');
const tar=await readFile(join(root,'release/candidates/kit-stress-rc25/tbc-kit.tgz'));
assert.equal(sha(tar),'035364a3251415107cdd14500a84e8b99551f4674a46a65373b5171b14dab746');
assert.equal(JSON.parse(await readFile(join(installed,'package.json'))).version,'0.1.0-rc.25');
const out=join(root,'.verify/rc25-device-app');await mkdir(out,{recursive:true});
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',script=tbc.Script.buildPublicKeyHashOut(address).toHex();
function raw(outputs){const tx=new tbc.Transaction().from({txId:'ab'.repeat(32),outputIndex:0,script,satoshis:10000000});tx.version=10;for(const o of outputs)tx.addOutput(new tbc.Transaction.Output(o));return tx.uncheckedSerialize();}
const collections={};for(const n of [2,4,11,12,101])collections[n]=raw([{satoshis:0,script:tbc.Script.buildSafeDataOut([Buffer.from(JSON.stringify({collectionName:'Stress',description:'public synthetic',supply:n,file:''})),Buffer.from('NTape')])},...Array.from({length:n},()=>({satoshis:100,script:tbc.Script.fromHex(script+'6a0d5630204d696e74204e486f6c64')}))]);
const funding=raw([{satoshis:9000000,script:tbc.Script.fromHex(script)}]);
let h=await readFile(join(root,'source/packages/kit/test/nft-job-stress-fixture.mjs'),'utf8');
h=h.slice(h.indexOf("const address='1Bg"),h.indexOf('\nexport {'));
h=h.replace(h.slice(h.indexOf('function raw('),h.indexOf('async function harness(')),'');
h=h.replace(h.slice(h.indexOf(' const collection=raw('),h.indexOf(' const unused=')),` const collection=fixtures.collections[count],funding=fixtures.funding,collectionId=kit.turingTransactionId(collection),fundingId=kit.turingTransactionId(funding);\n`);
h=h.replaceAll('if(process.env.TBC_STRESS_DIAG)','if(false)');
h=h.replace('close(){provider.destroy();session.close()}','close(){metrics.push({test:activeTest,...this.stats(),reads:{...calls},accepted:accepted.length,dispatched:dispatched.length,uniqueDispatched:new Set(dispatched).size,formal:formal.length});provider.destroy();session.close()}');
let portable=await readFile(join(root,'scripts/acceptance/rc23-device/portable.mjs'),'utf8');
portable=portable.slice(0,portable.indexOf('/*FIXTURES*/'))+`const fixtures=${JSON.stringify({collections,funding})};\n`+h+'\n'+await readFile(join(import.meta.dirname,'controlled-cases.mjs'),'utf8')+portable.slice(portable.indexOf('async function main()'));
portable=portable.replace("kit:'0.1.0-rc.23'","kit:'0.1.0-rc.25'");
portable=portable.replace('const kit={...clientKit,...walletKit,...engineKit};','const kit={...clientKit,...walletKit,...engineKit,assertTestnetAddress,turingTransactionId,inspectTbcTransaction};');
const result=await build({stdin:{contents:portable,resolveDir:root,sourcefile:'rc25-native-controlled.mjs'},bundle:true,write:false,platform:'browser',format:'iife',target:'es2022',alias:{'@frozen/client':join(installed,'dist/esm/index.js'),'@frozen/wallet':join(installed,'dist/esm/wallet.js'),'@frozen/engine':join(installed,'dist/esm/engine.js'),'@frozen/api':join(installed,'dist/esm/api.js'),'buffer':req.resolve('buffer/'),'@fixture/signer':join(root,'source/packages/kit/examples/shared/controlled-signer.mjs'),'@noble/curves/secp256k1.js':req.resolve('@noble/curves/secp256k1.js')},logLevel:'warning'});
await writeFile(join(out,'suite.js'),result.outputFiles[0].contents);
await writeFile(join(out,'index.html'),`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'"><title>rc.25 NFT targeted checks</title><body style="font:16px system-ui;padding:24px"><h2>rc.25 NFT targeted checks</h2><p>Controlled public fixtures; no network or broadcast</p><pre id="status">Starting</pre><script src="suite.js"></script>`);
for(const f of ['Probe.swift','MainActivity.kt','build-apps.mjs']){
 let s=await readFile(join(root,'scripts/acceptance/rc23-device',f),'utf8');
 s=s.replaceAll('rc23','rc25').replaceAll('Rc23','Rc25').replaceAll('RC23','RC25').replace(".verify/rc25-native/sdk",".verify/rc23-native/sdk");
 await writeFile(join(import.meta.dirname,f),s);
}
await writeFile(join(out,'build.json'),JSON.stringify({kit:'0.1.0-rc.25',native:'0.1.0-rc.23.native.2',kitSha256:sha(tar),bundleSha256:sha(result.outputFiles[0].contents),fixtureHarnessSha256:sha(h),controlled:true,broadcasts:0},null,2));
console.log(out);
