// Orchestration boundaries; exact Rust codecs and actual Host execution have a
// separate source-WASM gate. These mocks never claim contract or chain proof.
import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const built=await build({entryPoints:[`${root}packages/kit/src/lop-material.ts`],alias:{'@tbc-wallet/core':`${root}packages/core/src/index.ts`},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {resolveLopMaterial}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const id='11'.repeat(32),fee='22'.repeat(32),owner='33'.repeat(20),script=`76a914${owner}88ac`;
function setup(){
  const reads=[];let rows=[{txid:id,index:'0',value:'10000',height:'1',spent:false,scriptPubKey:'51'}];
  const parent={txid:id,rawTransaction:'00',inputs:[],outputs:[{vout:0,satoshis:'10000',scriptPubKey:'51'}]};
  const input={requirement:{intentType:'tbc-lop-cancel',includeAncestry:true,assets:[{kind:'native'},{kind:'lop'}],targetOutpoints:[{txid:id,vout:0}]},
    address:'account',ownerScript:script,minimumConfirmations:'0',maxInputs:128,
    client:{async getUtxos(){reads.push('native');return{tip:{height:'10',hash:'44'.repeat(32)},utxos:[{txid:fee,vout:0,satoshis:'1000',height:'1'}]}},
      api:{async txoStatus(){reads.push('status');return{txos:rows}}}},
    native:{async execute(operation,request){assert.equal(operation,'inspectLopMaterial');assert.equal(JSON.parse(request).phase,'inspectOrder');return JSON.stringify({standardId:'tbc-lop',txid:id,vout:0,side:'sell',market:'native-token',ownerHash:owner,escrow:null})}},
    async readHistory(txid){reads.push(`raw:${txid}`);assert.equal(txid,id,'Never query unrelated quote asset or native fee raw');return parent},
    async readDecoded(){reads.push('decoded');return{...parent,confirmations:'10'}}};
  return{input,reads,get rows(){return rows},set rows(v){rows=v}};
}
test('native sell cancellation fetches exact order/status plus funding, never quote assets',async()=>{
  const s=setup(),result=await resolveLopMaterial(s.input);
  assert.equal(result.utxos.length,2);assert.deepEqual(result.contracts,[]);assert.equal(result.parents.length,1);
  assert.deepEqual(s.reads.slice().sort(),['native',`raw:${id}`,'status'].sort());
});
test('availability, amount, script, height and duplicates fail closed',async()=>{
  for(const kind of ['spent','amount','script','height','duplicate','missing','foreign']){
    const s=setup();switch(kind){
      case 'spent':s.rows[0].spent=true;break;case 'amount':s.rows[0].value='9999';break;
      case 'script':s.rows[0].scriptPubKey='52';break;case 'height':s.rows[0].height='11';break;
      case 'duplicate':s.rows.push({...s.rows[0]});break;case 'missing':s.rows=[];break;
      case 'foreign':s.rows[0].txid=fee;break;
    }
    await assert.rejects(resolveLopMaterial(s.input),undefined,kind);
    assert.equal(s.reads.includes('decoded'),false);
  }
});
test('unknown heights only cause a fresh read when confirmation policy needs it',async()=>{
  for(const floor of ['0','1']){
    const s=setup();delete s.rows[0].height;s.input.minimumConfirmations=floor;
    const value=await resolveLopMaterial(s.input);
    assert.equal(s.reads.filter(v=>v==='decoded').length,floor==='0'?0:1);
    assert.equal(value.utxos.find(u=>u.classification==='lop').confirmations,floor==='0'?undefined:'10');
  }
  const s=setup();delete s.rows[0].height;s.input.minimumConfirmations='1';s.input.readDecoded=async()=>({txid:id,rawTransaction:'different',confirmations:'10'});
  await assert.rejects(resolveLopMaterial(s.input),/fresh parent differs/);
});
test('invalid LOP selectors fail before any network read',async()=>{
  for(const change of [r=>r.targetOutpoints=[],r=>r.targetOutpoints=[r.targetOutpoints[0],r.targetOutpoints[0]],
    r=>r.assets[1]={kind:'ft'},r=>r.certificateOutpoint={txid:id,vout:0}]){
    const s=setup();change(s.input.requirement);await assert.rejects(resolveLopMaterial(s.input));assert.deepEqual(s.reads,[]);
  }
});

test('cold confirmation target uses one decode; warm known height adds no query',async()=>{
  for(const warm of [false,true]){
    const s=setup();s.input.minimumConfirmations='1';s.input.hasHistory=()=>warm;
    if(!warm)delete s.rows[0].height;
    const result=await resolveLopMaterial(s.input);
    assert.equal(result.utxos.length,2);
    assert.equal(s.reads.filter(v=>v==='decoded').length,warm?0:1);
    assert.equal(s.reads.filter(v=>v===`raw:${id}`).length,warm?1:0);
    assert.equal(s.reads.filter(v=>v==='status').length,1);
  }
});
