import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile, mkdtemp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import Ajv2020 from 'ajv/dist/2020.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
async function source(name,component='kit') {
  const result=await build({entryPoints:[join(root,`packages/${component}/src`,`${name}.ts`)],bundle:true,write:false,
    platform:'node',format:'esm',logLevel:'silent',
    banner:{js:`import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(import.meta.url)});`},
    plugins:[{name:'portable-parser',setup(b){b.onResolve({filter:/^\.\/vendor\/tbc-tx-parser\/index\.js$/},()=>({
      path:join(root,'packages/kit/dist/esm/vendor/tbc-tx-parser/index.js')}));}}]});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const {normalizeTbcReviewedTransactionMaterial:normalize}=await source('standard-workflow-capabilities');
const {materializeAssociatedReviewRequest:materialize}=await source('reviewed-transaction-reviewer');
const {parseTbcTransaction:parse}=await source('testnet-validation');
const {createWasmTbcKeylessEngine}=await source('keyless');
const {validateSignReviewedTransactionRequest:coreValid}=await source('generated/validators','core');
const {params_tbc_signReviewedTransaction:providerValid}=await source('generated/validators','provider');
const ajv=new Ajv2020({strict:true,allErrors:true});
ajv.addFormat('uri',/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/u);
ajv.addFormat('date-time',/^\d{4}-\d\d-\d\dT/u);
for(const name of ['common','reviewed-transaction'])ajv.addSchema(JSON.parse(await readFile(join(root,`schemas/${name}.schema.json`))));
const valid=ajv.getSchema('https://turingbitchain.io/tws/1.0/schemas/reviewed-transaction.schema.json');
function publicValid(request) {
  const result=valid(request),envelope={version:'1.0',chainId:'tbc:testnet',from:'1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',request};
  assert.equal(coreValid(envelope),result,JSON.stringify(coreValid.errors));
  assert.equal(providerValid(envelope),result,JSON.stringify(providerValid.errors));
  return result;
}
const directory=await mkdtemp(join(tmpdir(),'tbc-associated-material-'));
const vectorsPath=join(directory,'public-vectors.json');
execFileSync('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','reviewed_current_token'],{
  cwd:join(root,'packages/tbc-engine/rust'),env:{...process.env,TBC_CURRENT_ASSOCIATED_OUTPUT:vectorsPath},stdio:'pipe',timeout:60000});
const vectors=JSON.parse(await readFile(vectorsPath));
const wasm=await createWasmTbcKeylessEngine(await readFile(join(root,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm')));
function input(i) {
  const out={outputIndex:i.outputIndex,signingProfile:i.scriptSigType};
  for(const [from,to] of [['txId','txid'],['script','scriptPubKey'],['preTx','previousTransaction'],['ancestorTransactions','ancestorTransactions']]){
    if(Object.hasOwn(i,from))out[to]=structuredClone(i[from]);
  }
  if(Object.hasOwn(i,'satoshis'))out.satoshis=String(i.satoshis);
  return out;
}
function standard(r) {return {payload:{format:'associated',sourceTransaction:r.sourceTxraw,sourceInputs:r.sourceUtxos.map(input),
  children:r.inputs.map((row,n)=>({inputs:row.map(input),outputs:r.outputs[n].map(o=>({satoshis:String(o.satoshis),scriptPubKey:o.script}))}))}};}

test('public current profiles preserve all proof bytes through Kit normalization, including child material',()=>{
  for(const row of vectors.rows){
    const request=standard(row.prepare.request);
    assert.equal(publicValid(request),true,JSON.stringify(valid.errors));
    const result=normalize(request);
    assert.equal(result.format,'associated');
    assert.deepEqual(result.request,row.prepare.request);
    for(const i of result.request.sourceUtxos)if(i.ancestorTransactions)assert.ok(Object.isFrozen(i.ancestorTransactions));
    const original=JSON.stringify(result);
    const first=[request.payload.sourceInputs,...request.payload.children.map(c=>c.inputs)].flat().find(i=>i.ancestorTransactions);
    first.ancestorTransactions.push('00');
    assert.equal(JSON.stringify(result),original,'normalization must snapshot proof arrays');
  }
});

test('public schema and direct normalizer reject missing, oversized and cross-profile proof material',()=>{
  const base=standard(vectors.rows[0].prepare.request);
  const target=r=>r.payload.sourceInputs.find(i=>i.signingProfile==='tbc20-stablecoin');
  const mutations=[
    ...['satoshis','scriptPubKey','previousTransaction','ancestorTransactions'].map(k=>r=>{delete target(r)[k];}),
    ...['previousOutputContext','contractTransaction','unlockingScriptTemplate'].map(k=>r=>{target(r)[k]='00';}),
    r=>{target(r).contractVersion=1;},r=>{target(r).ancestorTransactions=Array(7).fill('00');},
    r=>{target(r).ancestorTransactions=['00','00'];},r=>{target(r).ancestorTransactions=['xyz'];},
    r=>{target(r).previousTransaction='00'.repeat(1_048_577);},r=>{target(r).ancestorTransactions=['00'.repeat(1_048_577)];},
    r=>{target(r).signingProfile='p2pkh';},r=>{target(r).signingProfile='tbc20_coin';},
  ];
  for(const change of mutations){const r=structuredClone(base);change(r);assert.equal(publicValid(r),false);assert.throws(()=>normalize(r));}
  const caseDuplicate=structuredClone(base);target(caseDuplicate).ancestorTransactions=['aabb','AABB'];
  assert.throws(()=>normalize(caseDuplicate),/Duplicate/);
  const local=standard(vectors.rows.find(r=>r.prepare.request.inputs.length).prepare.request);
  const child=local.payload.children[0].inputs.find(i=>i.signingProfile==='tbc20-stablecoin');
  child.previousTransaction='00';assert.equal(publicValid(local),false);assert.throws(()=>normalize(local),/must omit/);
});

test('source previews preserve parent header and match Rust child sequence, prevout selection and output shape',()=>{
  for(const row of vectors.rows){
    const request=normalize(standard(row.prepare.request)).request,preview=materialize(request);
    assert.equal(preview.txraws[0],request.sourceTxraw);
    const index=row.prepare.transactionIndex??0;
    if(index===0)continue;
    const shown=parse(preview.txraws[index]),actual=parse(row.stage.txraw);
    assert.equal(shown.version,actual.version);assert.equal(shown.locktime,actual.locktime);
    assert.deepEqual(shown.outputs,actual.outputs);
    assert.deepEqual(shown.inputs.map(i=>[i.vout,i.sequence]),actual.inputs.map(i=>[i.vout,i.sequence]));
    // Final signatures change parent txids, never its bound outputs or sequence.
    assert.ok(shown.inputs.some((input,i)=>input.txid!==actual.inputs[i].txid));
  }
});

test('Coin child locks derive from local or hash-bound external Tape without a new input field',()=>{
  for(const domain of ['height','time']){
    const row=vectors.rows.find(r=>r.id===`coin-lock-${domain}-child-false`);
    const request=structuredClone(row.prepare.request);
    const expected=parse(row.stage.txraw).locktime;
    assert.ok(expected>0);
    assert.equal(parse(materialize(request).txraws[1]).locktime,expected);
    // The same selected outputs are also legal explicit parent material.
    request.inputs[0]=structuredClone(row.stage.inputs);
    assert.equal(parse(materialize(request).txraws[1]).locktime,expected);
    const coin=request.inputs[0].find(i=>i.scriptSigType==='tbc20-stablecoin');
    coin.txId='00'.repeat(32);
    assert.throws(()=>materialize(request),/parent identity mismatch/);
  }
  const mixed=vectors.failures.find(r=>r.label==='coin-child-mixed-lock-domains');
  assert.throws(()=>materialize(mixed.input.request),/mix height and timestamp/);
});

test('Schema and Kit normalized current requests reach the real source WASM with Native-identical stages and signed results',async()=>{
  for(const row of vectors.rows){
    const request=standard(row.prepare.request);
    assert.equal(publicValid(request),true);
    const mapped=normalize(request).request;
    const stage=JSON.parse(await wasm.execute('prepareReviewedStage',JSON.stringify({...row.prepare,request:mapped})));
    assert.deepEqual(stage,row.stage);
    const result=JSON.parse(await wasm.execute('finalizeReviewedStage',JSON.stringify({...row.finalize,stage})));
    assert.deepEqual(result,row.result);
  }
});

test('historical profile mapping stays unchanged and does not acquire current proof fields',()=>{
  for(const [profile,privateName] of [['p2pkh','p2pkh'],['ft','tbc20'],['ft-contract','tbc20_contract'],['contract-template','other'],['tbc-lop-match','tbc_lop_match']]){
    const r={payload:{format:'associated',sourceTransaction:'00',sourceInputs:[{outputIndex:0,signingProfile:profile}],children:[]}};
    assert.equal(publicValid(r),true,JSON.stringify(valid.errors));
    assert.deepEqual(normalize(r).request.sourceUtxos,[{outputIndex:0,scriptSigType:privateName}]);
  }
});
