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
const [consumer,archive,profile]=process.argv.slice(2);
assert.ok(consumer&&archive&&(profile===undefined||profile==='--candidate218')&&process.argv.length<=5);
const withLocks=profile==='--candidate218',candidateNumber=withLocks?218:216;
const root=fileURLToPath(new URL('../../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const expectedSha=withLocks?'69d70258a00deaa139ef8ad9e4b1e8465705adcea546f71c0e636e796824c12f':'5ba6f188d98cff322882a72fb93e786f94b330f03da2227711af24d614182622';
const installed=await realpath(join(resolve(consumer),'node_modules/@tbc/kit'));
const harness=await loadHolderInstalledHarness({consumer,archive,expectedSha,expectedVersion:'0.1.0-candidate.'+candidateNumber,entry:'browser'});
const bytes=await readFile(withLocks
 ?'/var/folders/3b/09dp91rj013g4w55jfnwsq0c0000gn/T/tbc-associated-host-NvR4QZ/public-vectors.json'
 :'/var/folders/3b/09dp91rj013g4w55jfnwsq0c0000gn/T/tbc-associated-host-jJheGH/public-vectors.json');
assert.equal(sha(bytes),withLocks?'9185ccab854d38cda5af0ed653373237d2ab15c73af7906de9b8ce3e09c1fe4e':'6673561b11d62e12d85d0c83427821c33a01f881fffb05743fa4c99380848122');
const all=JSON.parse(bytes),originals=[...all.rows.slice(0,6),...all.rows.filter(r=>r.id.endsWith('-parent-false')),
 ...(withLocks?all.rows.filter(r=>/^coin-lock-(height|time)-source-false$|^coin-external-(height|time)-source$/.test(r.id)):[])];
assert.equal(originals.length,withLocks?12:8);
const req=createRequire(join(root,'package.json')),tbc=req('tbc-lib-js'),key=new tbc.PrivateKey(new tbc.crypto.BN(1));
const address=key.toAddress().toString(),account={chainId:'tbc:testnet',accountId:'tbc:testnet:'+address,address,publicKey:key.publicKey.toString()};
function publicInput(i){const o={outputIndex:i.outputIndex,signingProfile:i.scriptSigType};
 for(const [a,b]of [['txId','txid'],['script','scriptPubKey'],['preTx','previousTransaction'],['ancestorTransactions','ancestorTransactions']])if(Object.hasOwn(i,a))o[b]=i[a];
 if(Object.hasOwn(i,'satoshis'))o.satoshis=String(i.satoshis);return o;
}
const vectors=[];
for(const row of originals){const original=row.prepare.request,parents=new Map(row.parents.map(raw=>{const tx=new tbc.Transaction(raw);return[tx.id,tx];}));
 const allInputs=[original.sourceUtxos,...original.inputs].flat().filter(i=>i.script);
 const codes=JSON.parse(await harness.native.execute('inspectTokenMaterial',JSON.stringify({phase:'inspectCodes',scripts:allInputs.map(i=>i.script)}))).codes;
 const selected=codes.findIndex(Boolean);assert.ok(selected>=0);
 vectors.push({id:row.id,account,original,selected,assetScript:allInputs[selected].script,assetId:codes[selected].originalOutpoint?.txid??'ab'.repeat(32),
  parents:Object.fromEntries([...parents].map(([id,p])=>[id,p.outputs.map(o=>({value:String(o.satoshis),script:o.script.toHex()}))])),
  request:{payload:{format:'associated',sourceTransaction:original.sourceTxraw,sourceInputs:original.sourceUtxos.map(publicInput),
   children:original.inputs.map((inputs,n)=>({inputs:inputs.map(publicInput),outputs:original.outputs[n].map(o=>({satoshis:String(o.satoshis),scriptPubKey:o.script}))}))}}});
}
const entry=join(root,'packages/tbc-engine/scripts/lib/associated-browser-entry.mjs'),buildRoot=await realpath(root);
const bundled=await build({absWorkingDir:buildRoot,entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'browser',metafile:true,logLevel:'silent',
 alias:{'@tbc/kit':join(installed,'dist/esm/index.js'),'@tbc/kit/wallet':join(installed,'dist/esm/wallet.js')}});
const inputs=Object.keys(bundled.metafile.inputs).filter(p=>!p.startsWith('(disabled):')).map(p=>resolve(buildRoot,p));
assert.ok(inputs.some(p=>p.startsWith(join(installed,'dist'))));
assert.ok(!inputs.some(p=>/\/packages\/(kit|core|host)\/src\//.test(p)));
for(const [p,meta]of Object.entries(bundled.metafile.inputs))if(p.startsWith('(disabled):')){assert.equal(meta.bytes,0);assert.equal(meta.imports.length,0);}
const inputHashes=Object.fromEntries(await Promise.all(inputs.map(async p=>[p,sha(await readFile(p))])));
const directory=await mkdtemp(join(tmpdir(),'tbc-associated'+candidateNumber+'-browser-'));
const fixture=JSON.stringify({vectors,candidateNumber,expectedRows:originals.length*8,expectedRejections:originals.length*2});
const wasm=await readFile(join(installed,'artifacts/wasm/tbc_keyless_wasm.wasm'));
const routes=new Map([['/',{type:'text/html',body:'<!doctype html><meta charset="utf-8"><pre id="result">PENDING</pre><script type="module" src="/entry.js"></script>'}],
 ['/entry.js',{type:'text/javascript',body:bundled.outputFiles[0].contents}],['/fixture.json',{type:'application/json',body:fixture}],['/engine.wasm',{type:'application/wasm',body:wasm}]]);
const requests=[];let resolveReport,rejectReport;
const completed=new Promise((res,rej)=>{resolveReport=res;rejectReport=rej;});
const server=createServer((request,response)=>{
 requests.push({method:request.method,path:request.url});
 if(request.method==='POST'&&request.url==='/result'){
  let size=0;const chunks=[];request.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){request.destroy();rejectReport(Error('Oversize fixture report'));}else chunks.push(chunk);});
  request.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks));response.writeHead(204);response.end();resolveReport(result);}catch(e){rejectReport(e);response.writeHead(400);response.end();}});return;
 }
 const route=routes.get(request.url);if(request.method!=='GET'||!route){response.writeHead(404);response.end();return;}
 response.writeHead(200,{'Content-Type':route.type,'Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'none'"});response.end(route.body);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',chromeVersion=execFileSync(chrome,['--version'],{encoding:'utf8'}).trim();
const child=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync',
 '--disable-extensions',`--user-data-dir=${join(directory,'chrome-profile')}`,`http://127.0.0.1:${server.address().port}/`],{stdio:'ignore'});
const exit=new Promise(r=>child.once('exit',r));child.once('error',rejectReport);
const timer=setTimeout(()=>rejectReport(Error('Browser report timeout')),45000);let browserReport;
try{browserReport=await completed;assert.equal(browserReport.status,`PASS_BROWSER_${candidateNumber}_ASSOCIATED`,JSON.stringify(browserReport));}
finally{clearTimeout(timer);child.kill('SIGTERM');await exit;server.closeAllConnections();await new Promise(r=>server.close(r));}
// Check the browser's actual finalized raw transactions, not expected signatures alone.
let vmInputs=0;const seen=new Set();
for(const row of browserReport.rows){assert.equal(row.reads,4);assert.equal(row.postApprovalReads,0);
 const identity=row.id+':'+row.workflow+':'+row.decision;assert.ok(!seen.has(identity));seen.add(identity);
 if(row.decision!=='approve'){assert.equal(row.finalRaws.length,0);continue;}
 const original=originals.find(v=>v.id===row.id);assert.ok(original);assert.equal(row.finalRaws.length,original.prepare.request.inputs.length+1);
 const known=new Map(original.parents.map(raw=>{const tx=new tbc.Transaction(raw);return[tx.id,tx];}));
 for(const raw of row.finalRaws){const tx=new tbc.Transaction(raw);tx.inputs.forEach((i,n)=>{
  i.output=known.get(i.prevTxId.toString('hex'))?.outputs[i.outputIndex];assert.ok(i.output,'Unknown signed parent');
  assert.equal(tx.verifyScript(n).success,true,`${row.id} input ${n}`);vmInputs++;
 });known.set(tx.id,tx);}
}
assert.equal(vmInputs,withLocks?86:50);assert.equal(seen.size,originals.length*8);assert.equal(browserReport.rejections.length,originals.length*2);
assert.equal(requests.filter(r=>r.method==='POST'&&r.path==='/result').length,1);
assert.equal(requests.filter(r=>r.method==='GET'&&routes.has(r.path)).length,4);
assert.ok(requests.every(r=>(r.method==='GET'&&(routes.has(r.path)||r.path==='/favicon.ico'))||(r.method==='POST'&&r.path==='/result')));
const report={status:`PASS_ACTUAL_CHROME_${candidateNumber}_ASSOCIATED`,at:new Date().toISOString(),installed:harness.evidence,chromeVersion,browserReport,vmInputs,requests,
 fixtureSha256:sha(fixture),wasmSha256:sha(wasm),bundleSha256:sha(bundled.outputFiles[0].contents),inputHashes,
 timing:'Actual performance.now, no virtual-time flags; synthetic local fixture, not wallet E2E benchmark',
 actualChainHttp:0,broadcast:0,goalComplete:false,limitations:['Headless Chrome; not MV3 extension','Public synthetic signer, not custody/biometric UI','No iOS/Android/Hermes runtime','Holder associated only']};
const body=JSON.stringify(report,null,2)+'\n',path=join(directory,'report.json');await writeFile(path,body,{flag:'wx'});
console.log(JSON.stringify({status:report.status,path,sha256:sha(body),chromeVersion,vmInputs,hostScenarios:browserReport.rows.length,elapsedMs:browserReport.elapsedMs}));
