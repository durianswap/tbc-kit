// Source primitive acceptance only. Public SDK fixtures; no custody or HTTP.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadHolderInstalledHarness} from './lib/holder-installed-harness.mjs';
import {loadTokenUnlockSdkOracle} from './lib/token-unlock-sdk-oracle.mjs';
const [consumer,archive,upstream]=process.argv.slice(2);assert.ok(consumer&&archive&&upstream&&process.argv.length===5);
const root=fileURLToPath(new URL('../../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const adapter=await loadHolderInstalledHarness({consumer,archive,expectedVersion:'0.1.0-candidate.221',
 expectedSha:'791b1f1360801632ba1a377f18e8c8526f6a7b7ca3216973fc4d19c8bf6c19b9'});
const directory=await mkdtemp(join(tmpdir(),'tbc-reviewed-raw-admin-source-')),vectorsPath=join(directory,'public-vectors.json');
const output=execFileSync('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','reviewed_coin_admin',
 'reviewed_raw_coin_admin_returns_bound_detached_signatures_without_changing_raw','--','--exact'],{
 cwd:join(root,'packages/tbc-engine/rust'),env:{...process.env,TBC_REVIEWED_RAW_ADMIN_OUTPUT:vectorsPath},encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']});
assert.match(output,/1 passed; 0 failed/);
const vectorsBytes=await readFile(vectorsPath),vectors=JSON.parse(vectorsBytes);
assert.equal(vectors.fixtureOnly,true);assert.equal(vectors.network,false);assert.equal(vectors.rows.length,2);
const wasmPath=join(root,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm'),wasmBytes=await readFile(wasmPath);
const engine=await adapter.kit.createWasmTbcKeylessEngine(wasmBytes);
const require=createRequire(join(root,'package.json')),tbc=require('tbc-lib-js'),oracle=await loadTokenUnlockSdkOracle(resolve(upstream),require);
globalThis.fetch=()=>{throw Error('External network forbidden');};
let vmInputs=0,sdkInputs=0,negativeCases=0;const rows=[];
for(const row of vectors.rows){
 const stage=JSON.parse(await engine.execute('prepareReviewedStage',JSON.stringify(row.prepare)));assert.deepEqual(stage,row.stage);
 const result=JSON.parse(await engine.execute('finalizeReviewedStage',JSON.stringify(row.finalize)));assert.deepEqual(result,row.result);
 assert.deepEqual(JSON.parse(await engine.execute('finalizeReviewedStage',JSON.stringify(row.compact))),result);
 assert.equal(result.txraw,stage.txraw);
 const tx=new tbc.Transaction(result.txraw),unsigned=new tbc.Transaction(stage.txraw),items=row.associated.request.sourceUtxos;
 const parents=new Map(items.filter(i=>i.preTx).map(i=>{const p=new tbc.Transaction(i.preTx);return[p.id,p];}));
 for(const [i,input]of tx.inputs.entries()){
  const p=parents.get(input.prevTxId.toString('hex'));assert.ok(p);input.output=p.outputs[input.outputIndex];unsigned.inputs[i].output=input.output;
  const item=items[i];
  if(item.scriptSigType==='tbc20-stablecoin'){
   const ancestry=new Map(item.ancestorTransactions.map(raw=>{const p=new tbc.Transaction(raw);return[p.id,p];})),groups=[];
   for(let n=0;n<tx.outputs.length;n++){if(tx.outputs[n].satoshis===500){groups.push({codeVout:n,tapeVout:n+1});n++;}else groups.push({codeVout:n});}
   input.setScript(oracle.coin({currentTx:unsigned,inputIndex:i,preTx:p,preTxVout:input.outputIndex,ancestorTransactions:ancestry,
    outputGroups:groups,signature:Buffer.from(result.sigs[i],'hex'),publicKey:Buffer.from(stage.signingTasks[i].publicKey,'hex')}));sdkInputs++;
  }else input.setScript(tbc.Script.fromASM(`${result.sigs[i]} ${stage.publicKey}`));
 }
 assert.equal(tx.toString(),row.referenceRaw,'Independent caller assembly must match fixed SDK transaction');
 for(let i=0;i<tx.inputs.length;i++){assert.equal(tx.verifyScript(i).success,true,`${row.id}/${i}`);vmInputs++;}
 for(const field of ['inputIndex','digest','publicKey','algorithm']){
  const bad=structuredClone(row.finalize);bad.stage.signingTasks[0][field]=field==='inputIndex'?99:'tampered';
  await assert.rejects(engine.execute('finalizeReviewedStage',JSON.stringify(bad)));negativeCases++;
 }
 for(const kind of ['missing-tasks','bad-signature','wrong-key','wrong-format']){
  const bad=structuredClone(row.finalize);
  if(kind==='missing-tasks')delete bad.stage.signingTasks;
  if(kind==='bad-signature')bad.signatures[0]='00'.repeat(65);
  if(kind==='wrong-key')bad.stage.inputs[0].signingPublicKey=stage.publicKey;
  if(kind==='wrong-format')bad.stage.format='associated';
  await assert.rejects(engine.execute('finalizeReviewedStage',JSON.stringify(bad)));negativeCases++;
 }
 rows.push({id:row.id,txid:tx.id,rawSha256:sha(Buffer.from(tx.toString(),'hex')),inputs:tx.inputs.length,
  rawUnchanged:true,algorithms:stage.signingTasks.map(t=>t.algorithm)});
}
assert.equal(vmInputs,5);assert.equal(sdkInputs,3);assert.equal(negativeCases,16);
const files=['packages/tbc-engine/rust/crates/tbc-keyless-core/src/reviewed.rs',
 'packages/tbc-engine/rust/crates/tbc-keyless-core/src/reviewed/current_token.rs',
 'packages/tbc-engine/rust/crates/tbc-keyless-core/tests/reviewed_coin_admin.rs',
 'packages/tbc-engine/rust/crates/tbc-engine-core/src/protocols/covenant_signature.rs',
 'packages/tbc-engine/rust/crates/tbc-engine-core/src/protocols/mod.rs',
 'packages/tbc-engine/rust/fixtures/coin-admin-proof.json','packages/tbc-engine/scripts/check-reviewed-raw-admin-source.mjs'];
const report={status:'PASS_SOURCE_REVIEWED_RAW_ADMIN',at:new Date().toISOString(),
 sourceHashes:Object.fromEntries(await Promise.all(files.map(async p=>[p,sha(await readFile(join(root,p)))]))),
 wasm:{path:wasmPath,sha256:sha(wasmBytes)},loader:adapter.evidence,sourceEngineOverridesFrozenLoader:true,
 vectorsPath,vectorsSha256:sha(vectorsBytes),nativeRustTestOutputSha256:sha(output),rows,vmInputs,sdkInputs,negativeCases,
 sdk:{commit:oracle.commit,files:oracle.files},actualHttp:0,broadcast:0,goalComplete:false,
 limitations:['Native Rust unit execution and source WASM, not native ABI/device acceptance',
  'This primitive runner does not exercise public Schema/Core/Kit approval or native custody wiring',
  'No new frozen candidate or live chain evidence; controller role matrix remains pending']};
const body=JSON.stringify(report,null,2)+'\n',path=join(directory,'report.json');await writeFile(path,body,{flag:'wx'});
console.log(JSON.stringify({status:report.status,path,sha256:sha(body),vmInputs,sdkInputs,negativeCases}));
