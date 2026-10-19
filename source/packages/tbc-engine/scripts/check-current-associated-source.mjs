// Source-Rust evidence only. An immutable JS adapter loads the NEW source
// WASM explicitly; this does not upgrade or modify any installed candidate.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadTokenUnlockSdkOracle} from './lib/token-unlock-sdk-oracle.mjs';
import {loadHolderInstalledHarness} from './lib/holder-installed-harness.mjs';

const [consumer,archive,upstream]=process.argv.slice(2);assert.ok(consumer&&archive&&upstream&&process.argv.length===5);
const root=fileURLToPath(new URL('../../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const expectedVersion=process.env.TBC_ASSOCIATED_LOADER_VERSION??'0.1.0-candidate.214';
const loaderHashes={'0.1.0-candidate.214':'d55790f48f761316672f3e256cf24a50ccf0381753a9a0db014e541d77317eb0',
 '0.1.0-candidate.217':'3cdc59bde62856736dd684ab7ecce66a06f16850a730e6ec059d6b12536f808a'};
assert.ok(Object.hasOwn(loaderHashes,expectedVersion));
const adapter=await loadHolderInstalledHarness({consumer,archive,expectedVersion,expectedSha:loaderHashes[expectedVersion]});
const directory=await mkdtemp(join(tmpdir(),'tbc-current-associated-source-')),vectorsPath=join(directory,'public-vectors.json');
const run=execFileSync('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','reviewed_current_token'],{
 cwd:join(root,'packages/tbc-engine/rust'),env:{...process.env,TBC_CURRENT_ASSOCIATED_OUTPUT:vectorsPath},encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
const vectorsBytes=await readFile(vectorsPath),vectors=JSON.parse(vectorsBytes);
assert.equal(vectors.status,'PASS_NATIVE_CURRENT_ASSOCIATED');assert.equal(vectors.rows.length,26);assert.equal(vectors.failures.length,105);
const wasmPath=join(root,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm'),wasmBytes=await readFile(wasmPath);
const native=await adapter.kit.createWasmTbcKeylessEngine(wasmBytes);
const require=createRequire(join(root,'package.json')),tbc=require('tbc-lib-js'),oracle=await loadTokenUnlockSdkOracle(resolve(upstream),require);
globalThis.fetch=()=>{throw Error('External network forbidden');};
let vmInputs=0,sdkInputs=0,parityOperations=0;const rows=[];
for(const row of vectors.rows){
 const stage=JSON.parse(await native.execute('prepareReviewedStage',JSON.stringify(row.prepare)));assert.deepEqual(stage,row.stage);parityOperations++;
 const result=JSON.parse(await native.execute('finalizeReviewedStage',JSON.stringify(row.finalize)));assert.deepEqual(result,row.result);parityOperations++;
 const tx=new tbc.Transaction(result.txraw),unsigned=new tbc.Transaction(stage.txraw);
 const parents=new Map(row.parents.map(raw=>{const p=new tbc.Transaction(raw);return[p.id,p];}));
 const codes=JSON.parse(await native.execute('inspectTokenMaterial',JSON.stringify({phase:'inspectCodes',scripts:stage.inputs.map(i=>i.script)}))).codes;
 for(const [i,input]of tx.inputs.entries()){
  const p=parents.get(input.prevTxId.toString('hex'));assert.ok(p);input.output=p.outputs[input.outputIndex];unsigned.inputs[i].output=input.output;
  assert.equal(tx.verifyScript(i).success,true,`${row.id}/${i}`);vmInputs++;
  if(codes[i]){
   const material=stage.inputs[i],ancestry=new Map(material.ancestorTransactions.map(raw=>{const p=new tbc.Transaction(raw);return[p.id,p];}));
   const parent=new tbc.Transaction(material.preTx),groups=[];
   for(let n=0;n<tx.outputs.length;n++){if(tx.outputs[n].satoshis===500){groups.push({codeVout:n,tapeVout:n+1});n++;}else groups.push({codeVout:n});}
   const builder=codes[i].standardId==='tbc20-stablecoin'?oracle.coin:oracle.token;
   const script=builder({currentTx:unsigned,inputIndex:i,preTx:parent,preTxVout:input.outputIndex,ancestorTransactions:ancestry,
    outputGroups:groups,signature:Buffer.from(result.sigs[i],'hex'),publicKey:Buffer.from(stage.publicKey,'hex')});
   assert.equal(script.toHex(),input.script.toHex(),`${row.id}/${i} SDK proof`);sdkInputs++;
  }
 }
 rows.push({id:row.id,inputs:tx.inputs.length,txid:tx.id,rawSha256:sha(Buffer.from(result.txraw,'hex'))});
}
for(const item of vectors.failures){
 let error;try{await native.execute(item.operation,JSON.stringify(item.input));}catch(e){error=String(e.message);}
 assert.ok(error?.includes(item.error),item.label);parityOperations++;
}
assert.equal(vmInputs,63);assert.equal(sdkInputs,37);
const files=['packages/tbc-engine/rust/crates/tbc-keyless-core/src/reviewed.rs',
 'packages/tbc-engine/rust/crates/tbc-keyless-core/src/reviewed/current_token.rs',
 'packages/tbc-engine/rust/crates/tbc-engine-core/src/protocols/coin.rs',
 'packages/tbc-engine/rust/crates/tbc-engine-core/src/protocols/coin_transfer.rs',
 'packages/tbc-engine/rust/crates/tbc-keyless-core/tests/reviewed_current_token.rs',
 'packages/tbc-engine/scripts/check-current-associated-source.mjs'];
const report={status:'PASS_SOURCE_CURRENT_ASSOCIATED_PROOFS',at:new Date().toISOString(),sourceHashes:Object.fromEntries(await Promise.all(files.map(async p=>[p,sha(await readFile(join(root,p)))]))),
 wasm:{path:wasmPath,sha256:sha(wasmBytes)},adapter:adapter.evidence,scope:'NEW source Rust/WASM with frozen JS loader; not frozen candidate feature support',
 vectorsPath,vectorsSha256:sha(vectorsBytes),nativeTestOutputSha256:sha(run),rows,vmInputs,sdkInputs,parityOperations,negativeCases:vectors.failures.length,
 sdk:{commit:oracle.commit,files:oracle.files},actualHttp:0,broadcast:0,goalComplete:false,
 limitations:['This report does not execute public Host/approval entries','No new immutable Native/WASM delivery or device runtime','Address-held fixtures; administrator/multiple accounts/controller not covered','Nonzero locks prove script predicates, not chain maturity']};
const body=JSON.stringify(report,null,2)+'\n',path=join(directory,'report.json');await writeFile(path,body,{flag:'wx'});
console.log(JSON.stringify({status:report.status,path,sha256:sha(body),wasmSha256:report.wasm.sha256,vmInputs,sdkInputs,parityOperations,negativeCases:report.negativeCases}));
