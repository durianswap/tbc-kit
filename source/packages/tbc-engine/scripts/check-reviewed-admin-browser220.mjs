// Immutable installed-package browser acceptance. Public synthetic keys only.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {loadHolderInstalledHarness} from './lib/holder-installed-harness.mjs';
const [consumer,archive]=process.argv.slice(2);assert.ok(consumer&&archive&&process.argv.length===4);
const root=fileURLToPath(new URL('../../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const expectedSha='aa89521d74d08884fe369782b4a17a797586c1fa632dda0ae36fb235591f7500';
const installed=await realpath(join(resolve(consumer),'node_modules/@tbc/kit'));
const harness=await loadHolderInstalledHarness({consumer,archive,expectedSha,expectedVersion:'0.1.0-candidate.220',entry:'browser'});
const bytes=await readFile('/var/folders/3b/09dp91rj013g4w55jfnwsq0c0000gn/T/tbc-reviewed-admin-host-IiQVVO/public-vectors.json');
assert.equal(sha(bytes),'b4cead2356dde917b033dafa26df66644ef6a1136b0d2706cbed21a775197d33');
const originals=JSON.parse(bytes).rows;assert.equal(originals.length,3);
const req=createRequire(join(root,'package.json')),tbc=req('tbc-lib-js');
const identity=publicKey=>{const address=new tbc.PublicKey(publicKey).toAddress().toString();return {chainId:'tbc:testnet',address,accountId:`tbc:testnet:${address}`,publicKey};};
const originalFee=identity(originals[0].prepare.publicKey),admin=identity('02'+originals[0].stage.signingTasks[0].publicKey);
function sameAccountRequest(value){
 const r=structuredClone(value),source=new tbc.Transaction(r.sourceTxraw),parents=new Map();
 for(const i of [r.sourceUtxos,...r.inputs].flat())for(const raw of [i.preTx,...(i.ancestorTransactions??[])].filter(Boolean)){
  const tx=new tbc.Transaction(raw);parents.set(tx.id,raw);
 }
 const oldScript=tbc.Script.buildPublicKeyHashOut(originalFee.address).toHex(),newScript=tbc.Script.buildPublicKeyHashOut(admin.address).toHex();
 r.sourceUtxos.forEach((input,index)=>{
  if(input.scriptSigType!=='p2pkh')return;
  const raw=input.preTx??parents.get(input.txId);assert.ok(raw);
  const parent=new tbc.Transaction(raw);parent.outputs[input.outputIndex].setScript(tbc.Script.fromHex(newScript));
  input.preTx=parent.toString();input.txId=parent.id;input.script=newScript;source.inputs[index].prevTxId=Buffer.from(parent.id,'hex');
 });
 for(const o of source.outputs)if(o.script.toHex()===oldScript)o.setScript(tbc.Script.fromHex(newScript));
 r.sourceTxraw=source.toString();for(const o of r.outputs.flat())if(o.script===oldScript)o.script=newScript;
 return r;
}
const publicInput=i=>({outputIndex:i.outputIndex,signingProfile:i.scriptSigType,
 ...Object.fromEntries([['txId','txid'],['script','scriptPubKey'],['preTx','previousTransaction'],['ancestorTransactions','ancestorTransactions']].filter(([a])=>Object.hasOwn(i,a)).map(([a,b])=>[b,i[a]])),
 ...(Object.hasOwn(i,'satoshis')?{satoshis:String(i.satoshis)}:{}),...(i.signingPublicKey?{signingRole:'coin-admin'}:{})});
const vectors=[],knownParents=new Map();
for(const [vectorIndex,row] of originals.entries())for(const sameAccount of [false,true]){
 const original=sameAccount?sameAccountRequest(row.prepare.request):row.prepare.request,parents=new Map();
 for(const i of [original.sourceUtxos,...original.inputs].flat())for(const raw of [i.preTx,...(i.ancestorTransactions??[])].filter(Boolean)){
  const tx=new tbc.Transaction(raw);parents.set(tx.id,tx);
 }
 const request={payload:{format:'associated',sourceTransaction:original.sourceTxraw,sourceInputs:original.sourceUtxos.map(publicInput),
  children:original.inputs.map((inputs,n)=>({inputs:inputs.map(publicInput),outputs:original.outputs[n].map(o=>({satoshis:String(o.satoshis),scriptPubKey:o.script}))}))}};
 vectors.push({vectorIndex,sameAccount,id:row.id,fee:sameAccount?admin:originalFee,admin,original,request,assetId:'bc'.repeat(32),
  code:original.sourceUtxos.find(i=>i.scriptSigType==='tbc20-stablecoin').script,
  parents:Object.fromEntries([...parents].map(([id,p])=>[id,p.outputs.map(o=>({satoshis:String(o.satoshis),script:o.script.toHex()}))]))});
 knownParents.set(`${vectorIndex}:${sameAccount}`,parents);
}
const entry=join(root,'packages/tbc-engine/scripts/lib/reviewed-admin-browser-entry.mjs'),buildRoot=await realpath(root);
const bundled=await build({absWorkingDir:buildRoot,entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'browser',metafile:true,logLevel:'silent',
 alias:{'@tbc/kit':join(installed,'dist/esm/index.js'),'@tbc/kit/wallet':join(installed,'dist/esm/wallet.js')}});
const inputs=Object.keys(bundled.metafile.inputs).filter(p=>!p.startsWith('(disabled):')).map(p=>resolve(buildRoot,p));
assert.ok(inputs.some(p=>p.startsWith(join(installed,'dist'))));assert.ok(!inputs.some(p=>/\/packages\/(kit|core|host)\/src\//.test(p)));
for(const [p,m] of Object.entries(bundled.metafile.inputs))if(p.startsWith('(disabled):')){assert.equal(m.bytes,0);assert.equal(m.imports.length,0);}
const inputHashes=Object.fromEntries(await Promise.all(inputs.map(async p=>[p,sha(await readFile(p))])));
const directory=await mkdtemp(join(tmpdir(),'tbc-reviewed220-browser-')),fixture=JSON.stringify({vectors});
const wasm=await readFile(join(installed,'artifacts/wasm/tbc_keyless_wasm.wasm'));
const routes=new Map([['/',{type:'text/html',body:'<!doctype html><meta charset="utf-8"><pre id="result">PENDING</pre><script type="module" src="/entry.js"></script>'}],
 ['/entry.js',{type:'text/javascript',body:bundled.outputFiles[0].contents}],['/fixture.json',{type:'application/json',body:fixture}],['/engine.wasm',{type:'application/wasm',body:wasm}]]);
const requests=[];let resolveReport,rejectReport;
const completed=new Promise((res,rej)=>{resolveReport=res;rejectReport=rej;});
const server=createServer((request,response)=>{
 requests.push({method:request.method,path:request.url});
 if(request.method==='POST'&&request.url==='/result'){
  let size=0;const chunks=[];
  request.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){request.destroy();rejectReport(Error('Oversize report'));}else chunks.push(chunk);});
  request.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks));response.writeHead(204);response.end();resolveReport(result);}catch(e){rejectReport(e);response.writeHead(400);response.end();}});return;
 }
 const route=routes.get(request.url);if(request.method!=='GET'||!route){response.writeHead(404);response.end();return;}
 response.writeHead(200,{'Content-Type':route.type,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'none'"});response.end(route.body);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',chromeVersion=execFileSync(chrome,['--version'],{encoding:'utf8'}).trim();
const child=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync',
 '--disable-extensions',`--user-data-dir=${join(directory,'chrome-profile')}`,`http://127.0.0.1:${server.address().port}/`],{stdio:'ignore'});
const exited=new Promise(r=>child.once('exit',r));child.once('error',rejectReport);
const timer=setTimeout(()=>rejectReport(Error('Browser report timeout')),45000);let browserReport;
try{browserReport=await completed;await writeFile(join(directory,'browser-result.json'),JSON.stringify(browserReport,null,2)+'\n',{flag:'wx'});
 assert.equal(browserReport.status,'PASS_BROWSER_220_REVIEWED_ADMIN',JSON.stringify(browserReport));
}finally{clearTimeout(timer);child.kill('SIGTERM');await exited;server.closeAllConnections();await new Promise(r=>server.close(r));}
let vmInputs=0;const seen=new Set();
for(const row of browserReport.rows){
 assert.equal(row.reads,4);assert.equal(row.postApprovalReads,0);
 const id=`${row.vectorIndex}:${row.sameAccount}`,identity=`${id}:${row.method}:${row.decision}`;assert.ok(!seen.has(identity));seen.add(identity);
 if(row.decision!=='approve'){assert.equal(row.finalRaws.length,0);assert.equal(row.signs,0);continue;}
 const known=new Map(knownParents.get(id));assert.ok(known.size);
 for(const raw of row.finalRaws){const tx=new tbc.Transaction(raw);tx.inputs.forEach((i,n)=>{
  i.output=known.get(i.prevTxId.toString('hex'))?.outputs[i.outputIndex];assert.ok(i.output,'Unknown signed parent');
  assert.equal(tx.verifyScript(n).success,true,`${identity} input ${n}`);vmInputs++;
 });known.set(tx.id,tx);}
}
assert.equal(vmInputs,60);assert.equal(seen.size,42);assert.equal(browserReport.replayChecks,36);assert.equal(browserReport.materialChecks,66);
assert.equal(requests.filter(r=>r.method==='POST'&&r.path==='/result').length,1);
assert.equal(requests.filter(r=>r.method==='GET'&&routes.has(r.path)).length,4);
assert.ok(requests.every(r=>(r.method==='GET'&&(routes.has(r.path)||r.path==='/favicon.ico'))||(r.method==='POST'&&r.path==='/result')));
const report={status:'PASS_ACTUAL_CHROME_220_REVIEWED_ADMIN',at:new Date().toISOString(),installed:harness.evidence,chromeVersion,browserReport,vmInputs,requests,
 acceptanceScriptSha256:sha(await readFile(fileURLToPath(import.meta.url))),fixtureSha256:sha(fixture),sourceVectorsSha256:sha(bytes),wasmSha256:sha(wasm),bundleSha256:sha(bundled.outputFiles[0].contents),inputHashes,
 timing:'Actual performance.now; synthetic local fixture, not wallet E2E benchmark',actualChainHttp:0,broadcast:0,goalComplete:false,
 limitations:['Headless Chrome; not MV3 extension','Public synthetic signer; no real custody or biometric UI','No iOS/Android/Hermes runtime','Reviewed Coin administrator scope only']};
const body=JSON.stringify(report,null,2)+'\n',path=join(directory,'report.json');await writeFile(path,body,{flag:'wx'});
console.log(JSON.stringify({status:report.status,path,sha256:sha(body),chromeVersion,vmInputs,hostScenarios:browserReport.rows.length,elapsedMs:browserReport.elapsedMs}));
