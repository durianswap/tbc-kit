import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {loadHolderInstalledHarness} from './lib/holder-installed-harness.mjs';

const [consumer,archive]=process.argv.slice(2);assert.ok(consumer&&archive&&process.argv.length===4);
const root=fileURLToPath(new URL('../../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const expectedSha='d55790f48f761316672f3e256cf24a50ccf0381753a9a0db014e541d77317eb0';
const installed=await realpath(join(resolve(consumer),'node_modules/@tbc/kit'));
const harness=await loadHolderInstalledHarness({consumer,archive,expectedSha,entry:'browser'});
const req=createRequire(join(root,'package.json')),tbc=req('tbc-lib-js'),signer=new tbc.PrivateKey(new tbc.crypto.BN(1));
const fixture=JSON.parse(await readFile(harness.fixtureRoot+'packages/tbc-engine/rust/fixtures/coin-proof.json'));
const ft=JSON.parse(await readFile(harness.fixtureRoot+'packages/tbc-engine/rust/fixtures/tbc20-standard-transfer.json'));
const originals=[...fixture.vectors,...ft.stages.slice(2).map((s,i)=>({id:'tbc20-'+s.id,signedRaw:s.signedRaw,parentRaw:ft.stages[i+1].signedRaw,
 ancestorsRaw:ft.stages.slice(0,i+1).map(p=>p.signedRaw),publicKeyHex:ft.request.publicKeyHex,contractId:ft.stages[0].txid}))];
const vectors=[];
for(const vector of originals){
 const parents=new Map([vector.parentRaw,...vector.ancestorsRaw].map(raw=>{const p=new tbc.Transaction(raw);return [p.id,p];}));
 const tx=new tbc.Transaction(vector.signedRaw);tx.inputs.forEach(i=>i.setScript(tbc.Script.empty()));
 const inputs=tx.inputs.map(i=>{const o=parents.get(i.prevTxId.toString('hex')).outputs[i.outputIndex];i.output=o;return {satoshis:o.satoshis,script:o.script.toHex()};});
 const codes=JSON.parse(await harness.native.execute('inspectTokenMaterial',JSON.stringify({phase:'inspectCodes',scripts:inputs.map(i=>i.script)}))).codes;
 const selected=codes.findIndex(Boolean);assert.ok(selected>=0);
 vectors.push({id:vector.id,request:{txraws:[tx.uncheckedSerialize()],utxos_satoshis:[inputs.map(i=>i.satoshis)],script_pubkeys:[inputs.map(i=>i.script)]},
  txid:tx.id,assetId:vector.contractId??new tbc.Transaction(vector.ancestorsRaw[0]).id,assetScript:inputs[selected].script,
  protocol:codes[selected].standardId==='tbc20-stablecoin'?'stablecoin':'ft',
  parents:Object.fromEntries([...parents].map(([id,p])=>[id,p.outputs.map(o=>({value:String(o.satoshis),script:o.script.toHex()}))])),
  expectedSignatures:tx.inputs.map((_,i)=>tx.getSignature(i,signer)),host:vector.id==='first-0'||vector.id==='tbc20-transfer',
  account:{chainId:'tbc:testnet',accountId:'tbc:testnet:'+signer.toAddress(),address:signer.toAddress().toString(),publicKey:vector.publicKeyHex}});
}
const entry=join(root,'packages/tbc-engine/scripts/lib/holder-browser-entry.mjs');
const buildRoot=await realpath(root);
const result=await build({absWorkingDir:buildRoot,entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'browser',metafile:true,logLevel:'silent',
 alias:{'@tbc/kit':join(installed,'dist/esm/index.js'),'@tbc/kit/wallet':join(installed,'dist/esm/wallet.js'),
  '@tbc/kit/engine':join(installed,'dist/esm/engine.js'),'node:assert/strict':join(root,'packages/tbc-engine/scripts/lib/browser-test-assert.mjs')}});
// esbuild records browser:false virtual modules as '(disabled):path'; these
// are empty replacements, not files under a path containing that namespace.
const disabledModules=Object.entries(result.metafile.inputs).filter(([p])=>p.startsWith('(disabled):'));
for(const [,meta]of disabledModules){assert.equal(meta.bytes,0);assert.equal(meta.imports.length,0);}
const inputs=Object.keys(result.metafile.inputs).filter(p=>!p.startsWith('(disabled):')).map(p=>resolve(buildRoot,p));
assert.ok(inputs.some(p=>p.startsWith(join(installed,'dist'))));
assert.ok(!inputs.some(p=>p.startsWith(join(root,'packages/kit/src'))||p.startsWith(join(root,'packages/core/src'))||p.startsWith(join(root,'packages/host/src'))));
const bundleInputHashes=Object.fromEntries(await Promise.all(inputs.map(async p=>[p,sha(await readFile(p))])));
const directory=await mkdtemp(join(tmpdir(),'tbc-holder214-browser-'));
const fixtureBody=JSON.stringify({vectors}),wasm=await readFile(join(installed,'artifacts/wasm/tbc_keyless_wasm.wasm'));
const html='<!doctype html><meta charset="utf-8"><pre id="result">PENDING</pre><script type="module" src="/entry.js"></script>';
const routes=new Map([['/',{type:'text/html',body:html}],['/entry.js',{type:'text/javascript',body:result.outputFiles[0].contents}],
 ['/fixture.json',{type:'application/json',body:fixtureBody}],['/engine.wasm',{type:'application/wasm',body:wasm}]]);
const requests=[];const server=createServer((request,response)=>{
 requests.push({method:request.method,path:request.url});const route=routes.get(request.url);
 if(request.method!=='GET'||!route){response.writeHead(404);response.end();return;}
 response.writeHead(200,{'Content-Type':route.type,'Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'"});response.end(route.body);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browserReport,chromeVersion;
try{
 const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',run=promisify(execFile);
 chromeVersion=(await run(chrome,['--version'])).stdout.trim();
 const {stdout}=await run(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking',
  '--disable-component-update','--disable-sync','--disable-extensions',`--user-data-dir=${join(directory,'chrome-profile')}`,
  '--virtual-time-budget=30000','--dump-dom',`http://127.0.0.1:${server.address().port}/`],{timeout:55000,maxBuffer:8*1024*1024});
 const match=stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/);assert.ok(match,'Missing browser result');
 browserReport=JSON.parse(match[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'));
 assert.equal(browserReport.status,'PASS_BROWSER_214_HOLDER',JSON.stringify(browserReport));
}finally{await new Promise(r=>server.close(r));}
// Independently verify the actual browser signatures in the reference witness.
let vmInputs=0;
for(let n=0;n<originals.length;n++){
 const tx=new tbc.Transaction(originals[n].signedRaw),row=browserReport.rows[n];assert.equal(row.id,originals[n].id);
 assert.deepEqual(row.sigs,vectors[n].expectedSignatures);
 tx.inputs.forEach((input,i)=>{
  const parent=vectors[n].parents[input.prevTxId.toString('hex')][input.outputIndex];
  input.output=new tbc.Transaction.Output({satoshis:Number(parent.value),script:tbc.Script.fromHex(parent.script)});
  let found=0;const script=new tbc.Script();for(const chunk of input.script.chunks){
   if(chunk.buf?.toString('hex')===row.sigs[i]){script.add(Buffer.from(row.sigs[i],'hex'));found++;}else script.add(chunk);
  }assert.equal(found,1);input.setScript(script);assert.equal(tx.verifyScript(i).success,true);vmInputs++;
 });
}
assert.equal(vmInputs,15);assert.equal(browserReport.hostRows.length,12);
assert.ok(requests.every(r=>r.method==='GET'&&routes.has(r.path)));assert.equal(requests.length,4);
const report={status:'PASS_ACTUAL_CHROME_214_HOLDER',at:new Date().toISOString(),installed:harness.evidence,chromeVersion,
 browserReport,vmInputs,requests,bundleSha256:sha(result.outputFiles[0].contents),fixtureSha256:sha(fixtureBody),
 wasmSha256:sha(wasm),bundleInputHashes,disabledModules:disabledModules.map(([p])=>p),
 actualChainHttp:0,broadcast:0,goalComplete:false,limitations:['Headless Chrome synthetic signer; not custody/UI or extension MV3','Not React Native, iOS or Android runtime','Reference witnesses; SDK assembly separately proven in 4IM']};
const body=JSON.stringify(report,null,2)+'\n',path=join(directory,'report.json');await writeFile(path,body,{flag:'wx'});
console.log(JSON.stringify({status:report.status,path,sha256:sha(body),chromeVersion,vmInputs,hostScenarios:browserReport.hostRows.length,browserElapsedMs:browserReport.elapsedMs}));
