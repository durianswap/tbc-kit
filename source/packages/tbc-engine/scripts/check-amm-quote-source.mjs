// Current-source, public fixture only: no accounts, HTTP, signing or broadcast.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const root=resolve(import.meta.dirname,'../../..'),rust=join(root,'packages/tbc-engine/rust');
const args=process.argv.slice(2);
assert.ok(args.length===0||(args.length===2&&args[0]==='--consumer'),'Usage: [--consumer INSTALLED_CONSUMER]');
const installed=args.length?resolve(args[1],'node_modules/@tbc/kit'):undefined;
const native=spawnSync('cargo',['test','--locked','--offline','-p','tbc-keyless-core','--test','amm_material',
 'public_quote_matches_fixed_sdk_next_pool_without_an_account_or_network','--','--exact','--nocapture'],
 {cwd:rust,env:{...process.env,AMM_MATERIAL_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
assert.equal(native.status,0,'Native public quote generation failed');
const rows=native.stdout.split('\n').filter(l=>l.startsWith('AMM_MATERIAL_WIRE:')).map(l=>JSON.parse(l.slice('AMM_MATERIAL_WIRE:'.length)));
const quotes=rows.filter(r=>r.input.phase==='quote');assert.equal(quotes.length,16);
let kit;
if(installed){
 kit=await import(pathToFileURL(join(installed,'dist/esm/index.js')));
 assert.equal(typeof kit.quoteTbcAmm,'function','Installed root must export quoteTbcAmm');
 for(const entry of ['index.native','wallet'])assert.equal(typeof(await import(pathToFileURL(join(installed,`dist/esm/${entry}.js`)))).quoteTbcAmm,'function',entry);
}else{
const compiled=await build({stdin:{contents:`
 export {quoteTbcAmm} from './packages/kit/src/amm-quote.ts';
 export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';`,resolveDir:root,loader:'ts'},
 bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
kit=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
}
const wasm=await kit.createWasmTbcKeylessEngine(readFileSync(installed?join(installed,'artifacts/wasm/tbc_keyless_wasm.wasm'):join(rust,'target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm')));
const oldFetch=globalThis.fetch;let fetches=0,calls=0;
globalThis.fetch=async()=>{fetches++;throw new Error('A pure quote must not fetch');};
const engine={execute:async(method,request)=>{calls++;assert.equal(method,'inspectAmmMaterial');return wasm.execute(method,request);}};
let negatives=0;
try{
 for(const {input,result}of quotes){
  const {phase,...request}=input;
  const actual=await kit.quoteTbcAmm(request,{engine});assert.deepEqual(actual,result);
  assert.ok(Object.isFrozen(actual)&&Object.isFrozen(actual.quote)&&Object.isFrozen(actual.quote.nextState));
 }
 const {phase,...request}=quotes.find(r=>r.input.action.kind==='buy').input;
 const addFt=await kit.quoteTbcAmm({...request,action:{kind:'addFt',amount:'2000'}},{engine});
 assert.equal(addFt.kind,'addFt');assert.equal(addFt.quote.tbcIncrementSat,'1000');assert.equal(addFt.quote.ftAIncrementRaw,'2000');
 for(const invalid of ['0','01','-1','1.1','9223372036854775808',10000]){
  await assert.rejects(kit.quoteTbcAmm({...request,action:{kind:'buy',amount:invalid}},{engine}));negatives++;
 }
 for(const extra of [{feePolicy:{totalFeeBps:0}},{privateKey:'public-test-rejection-only'}]){
  const before=calls;await assert.rejects(kit.quoteTbcAmm({...request,...extra},{engine}));assert.equal(calls,before);negatives++;
 }
 const mutable=structuredClone(request),pending=kit.quoteTbcAmm(mutable,{engine});
 mutable.pool.txid='00'.repeat(32);mutable.action.amount='1';
 assert.equal((await pending).poolOutpoint.txid,request.pool.txid);
 const correct=quotes.find(r=>r.input.action.kind==='buy').result;
 for(const issue of ['identity','kind','unsafe-number','overflow','fees']){
  const changed=structuredClone(correct);
  if(issue==='identity')changed.poolOutpoint.txid='00'.repeat(32);
  if(issue==='kind')changed.kind='sell';
  if(issue==='unsafe-number')changed.quote.nextState.ftAAmount=9007199254740992;
  if(issue==='overflow')changed.quote.nextState.ftAAmount='9223372036854775808';
  if(issue==='fees')changed.quote.fees.totalFeeSat='-1';
  await assert.rejects(kit.quoteTbcAmm(request,{engine:{execute:async()=>JSON.stringify(changed)}}));negatives++;
 }
 const large=structuredClone(correct);large.quote.nextState.ftAAmount='9007199254740993';
 assert.equal((await kit.quoteTbcAmm(request,{engine:{execute:async()=>JSON.stringify(large)}})).quote.nextState.ftAAmount,'9007199254740993');
 assert.equal(fetches,0);
 console.log(JSON.stringify({status:'PASS',nativeWasmQuoteCases:16,addFtCases:1,sdkNextStateCases:16,negativeCases:negatives,
  inputSnapshot:true,atomicStrings:true,networkRequests:fetches,signatures:0,broadcasts:0,installedCandidate:!!installed,
  version:installed?JSON.parse(readFileSync(join(installed,'package.json'),'utf8')).version:undefined}));
}finally{globalThis.fetch=oldFetch;}
