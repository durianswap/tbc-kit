// Public SDK vectors only. Source Native/WASM primitive evidence, not Host,
// custody, frozen-candidate support or a real-network acceptance claim.
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
const adapter=await loadHolderInstalledHarness({consumer,archive,expectedVersion:'0.1.0-candidate.218',
 expectedSha:'69d70258a00deaa139ef8ad9e4b1e8465705adcea546f71c0e636e796824c12f'});
const directory=await mkdtemp(join(tmpdir(),'tbc-reviewed-admin-source-')),vectorsPath=join(directory,'public-vectors.json');
const run=execFileSync('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','reviewed_coin_admin'],{
 cwd:join(root,'packages/tbc-engine/rust'),env:{...process.env,TBC_REVIEWED_ADMIN_OUTPUT:vectorsPath},encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
const vectorsBytes=await readFile(vectorsPath),vectors=JSON.parse(vectorsBytes);
assert.equal(vectors.fixtureOnly,true);assert.equal(vectors.network,false);assert.equal(vectors.rows.length,3);
const wasmPath=join(root,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm'),wasmBytes=await readFile(wasmPath);
const engine=await adapter.kit.createWasmTbcKeylessEngine(wasmBytes);
const require=createRequire(join(root,'package.json')),tbc=require('tbc-lib-js'),oracle=await loadTokenUnlockSdkOracle(resolve(upstream),require);
globalThis.fetch=()=>{throw Error('External network forbidden');};
let vmInputs=0,sdkInputs=0,negativeCases=0;const rows=[];
for(const row of vectors.rows){
 const stage=JSON.parse(await engine.execute('prepareReviewedStage',JSON.stringify(row.prepare)));assert.deepEqual(stage,row.stage);
 const result=JSON.parse(await engine.execute('finalizeReviewedStage',JSON.stringify(row.finalize)));assert.deepEqual(result,row.result);
 const tx=new tbc.Transaction(result.txraw),unsigned=new tbc.Transaction(stage.txraw);
 // Every source/child input spends the public SDK parent supplied by Coin
 // material. Check P2PKH fee inputs too, not just a single covenant input.
 const parents=new Map(stage.inputs.filter(i=>i.preTx).map(i=>{const p=new tbc.Transaction(i.preTx);return[p.id,p];}));
 for(const [i,input]of tx.inputs.entries()){
  const p=parents.get(input.prevTxId.toString('hex'));assert.ok(p);input.output=p.outputs[input.outputIndex];unsigned.inputs[i].output=input.output;
  assert.equal(tx.verifyScript(i).success,true,`${row.id}/${i}`);vmInputs++;
  if(stage.inputs[i].scriptSigType==='tbc20-stablecoin'){
   const item=stage.inputs[i],ancestry=new Map(item.ancestorTransactions.map(raw=>{const p=new tbc.Transaction(raw);return[p.id,p];})),groups=[];
   for(let n=0;n<tx.outputs.length;n++){if(tx.outputs[n].satoshis===500){groups.push({codeVout:n,tapeVout:n+1});n++;}else groups.push({codeVout:n});}
   const script=oracle.coin({currentTx:unsigned,inputIndex:i,preTx:p,preTxVout:input.outputIndex,ancestorTransactions:ancestry,
    outputGroups:groups,signature:Buffer.from(result.sigs[i],'hex'),publicKey:Buffer.from(stage.signingTasks[i].publicKey,'hex')});
   assert.equal(script.toHex(),input.script.toHex(),`${row.id}/${i} SDK proof`);sdkInputs++;
  }
 }
 for(const field of ['inputIndex','digest','publicKey','algorithm']){
  const bad=structuredClone(row.finalize);bad.stage.signingTasks[0][field]=field==='inputIndex'?99:field==='digest'?'11'.repeat(32):field==='publicKey'?stage.publicKey:'secp256k1-ecdsa';
  await assert.rejects(engine.execute('finalizeReviewedStage',JSON.stringify(bad)));negativeCases++;
 }
 const missing=structuredClone(row.finalize);delete missing.stage.signingTasks;
 await assert.rejects(engine.execute('finalizeReviewedStage',JSON.stringify(missing)));negativeCases++;
 const signature=structuredClone(row.finalize);signature.signatures[0]='00'.repeat(65);
 await assert.rejects(engine.execute('finalizeReviewedStage',JSON.stringify(signature)));negativeCases++;
 rows.push({id:row.id,txid:tx.id,rawSha256:sha(Buffer.from(result.txraw,'hex')),inputs:tx.inputs.length,
  algorithms:stage.signingTasks.map(t=>t.algorithm)});
}
assert.equal(vmInputs,7);assert.equal(sdkInputs,4);assert.equal(negativeCases,18);
const files=['packages/tbc-engine/rust/crates/tbc-keyless-core/src/reviewed.rs',
 'packages/tbc-engine/rust/crates/tbc-keyless-core/src/reviewed/current_token.rs',
 'packages/tbc-engine/rust/crates/tbc-keyless-core/tests/reviewed_coin_admin.rs',
 'packages/tbc-engine/rust/fixtures/coin-admin-proof.json','packages/tbc-engine/scripts/check-reviewed-admin-source.mjs'];
const report={status:'PASS_SOURCE_REVIEWED_COIN_ADMIN',at:new Date().toISOString(),
 sourceHashes:Object.fromEntries(await Promise.all(files.map(async p=>[p,sha(await readFile(join(root,p)))]))),
 wasm:{path:wasmPath,sha256:sha(wasmBytes)},loader:adapter.evidence,sourceEngineOverridesFrozenLoader:true,
 vectorsPath,vectorsSha256:sha(vectorsBytes),nativeTestOutputSha256:sha(run),rows,vmInputs,sdkInputs,negativeCases,
 sdk:{commit:oracle.commit,files:oracle.files},actualHttp:0,broadcast:0,goalComplete:false,
 limitations:['No shared Schema/Core/Kit/Host permission wiring for these new Reviewed task fields yet',
  'No new immutable Native/WASM candidate, installed wallet, UI or real chain evidence',
  'Raw detached and contract controller role matrix not completed']};
const body=JSON.stringify(report,null,2)+'\n',path=join(directory,'report.json');await writeFile(path,body,{flag:'wx'});
console.log(JSON.stringify({status:report.status,path,sha256:sha(body),vmInputs,sdkInputs,negativeCases}));
